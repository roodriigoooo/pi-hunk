import { getSettingsListTheme, type ExtensionCommandContext, type Theme } from "@earendil-works/pi-coding-agent";
import {
	Key,
	SelectList,
	SettingsList,
	matchesKey,
	truncateToWidth,
	type Component,
	type SelectItem,
	type SelectListTheme,
	type SettingItem,
	type SettingsListTheme,
} from "@earendil-works/pi-tui";
import fs from "node:fs/promises";
import path from "node:path";
import { type HunkConfig } from "./config";
import { choicesForSpec, descriptionForSpec, hunkConfigGroups, isHexColor, normalizeHex, type Choice } from "./config-spec";
import { type Highlighter, createDiffView } from "./diff-view";

const HUNK_CONFIG_SAMPLE_PATCH = [
	"--- a/preview.ts",
	"+++ b/preview.ts",
	"@@ -1,22 +1,23 @@",
	" import { palette } from \"./theme\";",
	" import { titleCase } from \"./text\";",
	" ",
	" const CHANNEL = \"alpha\";",
	" const RETRIES = 2;",
	" const TIMEOUT_MS = 1200;",
	" ",
	" export function greet(name: string) {",
	"-  const message = `hello ${name}`;",
	"-  return { message, excited: false };",
	"+  const displayName = titleCase(name.trim());",
	"+  const message = `hi ${displayName}`;",
	"+  return { message, tone: palette.accent, excited: true };",
	" }",
	" ",
	" export function retryDelay(attempt: number) {",
	"   return Math.min(attempt * TIMEOUT_MS, 8000);",
	" }",
	" ",
	" export const FLAGS = { compact: true, preview: true };",
	" export const OWNER = \"hunk\";",
	" export const STATUS = \"draft\";",
	" ",
	"-export const VERSION = \"0.1.0\";",
	"+export const VERSION = \"0.2.0\";",
	"+export const RELEASE = `${CHANNEL}-preview`;",
].join("\n");

function cloneConfig(config: HunkConfig): HunkConfig {
	return { ...config, colors: { ...config.colors }, symbols: { ...config.symbols }, hunk: { ...config.hunk } };
}

async function saveProjectHunkConfig(cwd: string, config: HunkConfig): Promise<void> {
	const dir = path.join(cwd, ".pi");
	await fs.mkdir(dir, { recursive: true });
	const filePath = path.join(dir, "hunk.json");
	await fs.writeFile(filePath, JSON.stringify(config, null, 2) + "\n", "utf8");
}

function hunkSettingsHint(text: string): string {
	return text.replace("Enter/Space to change", "Enter/Space open picker").replace("Esc to cancel", "Esc to save");
}

function settingsListThemeFromUi(theme: Theme): SettingsListTheme {
	return {
		label: (text, selected) => (selected ? theme.fg("accent", theme.bold(text)) : theme.fg("muted", text)),
		value: (text, selected) => (selected ? theme.fg("toolTitle", theme.bold(text)) : theme.fg("dim", text)),
		description: (text) => theme.fg("dim", text),
		cursor: theme.fg("accent", "› "),
		hint: (text) => theme.fg("dim", hunkSettingsHint(text)),
	};
}

function resolveSettingsListTheme(theme: Theme): SettingsListTheme {
	try {
		const base = getSettingsListTheme();
		return { ...base, hint: (text) => base.hint(hunkSettingsHint(text)) };
	} catch {
		return settingsListThemeFromUi(theme);
	}
}

function selectListThemeFromUi(theme: Theme): SelectListTheme {
	return {
		selectedPrefix: (text) => theme.fg("accent", text),
		selectedText: (text) => theme.fg("accent", theme.bold(text)),
		description: (text) => theme.fg("dim", text),
		scrollInfo: (text) => theme.fg("dim", text),
		noMatch: (text) => theme.fg("warning", text),
	};
}

class StaticLines implements Component {
	constructor(private readonly getLines: () => string[]) {}
	render(width: number): string[] {
		return this.getLines().map((line) => truncateToWidth(line, width));
	}
	invalidate(): void {}
}

class ChoicePicker implements Component {
	private readonly list: SelectList;
	private filter = "";

	constructor(
		private readonly title: string,
		private readonly choices: Choice[],
		private readonly theme: Theme,
		private readonly done: (selectedValue?: string) => void,
		private readonly originalValue: string,
		private readonly allowHex: boolean,
		private readonly onPreview: (value: string) => void,
	) {
		const items: SelectItem[] = choices.map((choice) => ({ value: choice.value, label: choice.label ?? choice.value, description: choice.description }));
		this.list = new SelectList(items, Math.min(items.length, 8), selectListThemeFromUi(theme), { minPrimaryColumnWidth: 28, maxPrimaryColumnWidth: 42 });
		const selected = choices.findIndex((choice) => choice.value === originalValue);
		this.list.setSelectedIndex(selected === -1 ? 0 : selected);
		this.list.onSelectionChange = (item) => this.onPreview(item.value);
		this.list.onSelect = (item) => {
			this.onPreview(item.value);
			this.done(item.value);
		};
		this.list.onCancel = () => {
			this.onPreview(this.originalValue);
			this.done(undefined);
		};
	}

	render(width: number): string[] {
		const lines: string[] = [];
		lines.push(this.theme.fg("accent", this.theme.bold(this.title)));
		lines.push(this.theme.fg("dim", this.allowHex ? "Type to filter; #RRGGBB + Enter accepts custom truecolor." : "Type to filter by value."));
		if (this.filter) lines.push(this.theme.fg("muted", `filter: ${this.filter}`));
		lines.push("");
		lines.push(...this.list.render(width));
		if (this.allowHex && this.isCustomHex()) lines.push(this.theme.fg("accent", `  use custom ${normalizeHex(this.filter)}`));
		lines.push("");
		lines.push(this.theme.fg("dim", "↑↓ move · Enter select · type filter · Backspace edit · Esc back"));
		return lines.map((line) => truncateToWidth(line, width));
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape)) {
			if (this.filter) {
				this.setFilter("");
				return;
			}
			this.onPreview(this.originalValue);
			this.done(undefined);
			return;
		}
		if (matchesKey(data, Key.backspace)) {
			this.setFilter(this.filter.slice(0, -1));
			return;
		}
		if (matchesKey(data, Key.enter) || data === " ") {
			if (this.allowHex && this.isCustomHex()) {
				const value = normalizeHex(this.filter);
				this.onPreview(value);
				this.done(value);
				return;
			}
			const selected = this.list.getSelectedItem();
			if (selected) {
				this.onPreview(selected.value);
				this.done(selected.value);
			}
			return;
		}
		if (matchesKey(data, Key.up) || matchesKey(data, Key.down)) {
			this.list.handleInput(data);
			return;
		}
		if (data.length === 1 && data >= "!" && data <= "~") {
			this.setFilter(this.filter + data);
		}
	}

	invalidate(): void {
		this.list.invalidate();
	}

	private setFilter(next: string): void {
		this.filter = next;
		this.list.setFilter(next);
		if (this.allowHex && this.isCustomHex()) {
			this.onPreview(normalizeHex(this.filter));
			return;
		}
		this.onPreview(this.list.getSelectedItem()?.value ?? this.originalValue);
	}

	private isCustomHex(): boolean {
		const normalized = normalizeHex(this.filter);
		return isHexColor(normalized) && !this.choices.some((choice) => choice.value.toLowerCase() === normalized);
	}
}

/** Open the `/hunk configure` live-preview TUI. Two-level nav: group list →
 *  per-group settings. Esc inside a group returns to the group list; Esc on the
 *  group list saves to `.pi/hunk.json` and closes. */
export async function openHunkConfig(
	ctx: ExtensionCommandContext,
	getConfig: () => HunkConfig,
	applyConfig: (next: HunkConfig) => Promise<void>,
	getHighlighter: (config: HunkConfig, invalidate?: () => void) => Highlighter | undefined,
) {
	if (ctx.mode !== "tui") {
		ctx.ui.notify("/hunk configure requires TUI mode.", "error");
		return;
	}
	const draft = cloneConfig(getConfig());
	const groups = hunkConfigGroups();
	let theme = ctx.ui.theme;
	let requestPreviewRender: (() => void) | undefined;
	let closeDone: ((value?: void) => void) | undefined;

	function buildPreview(): Component {
		if (!draft.enabled) {
			return new StaticLines(() => [
				theme.fg("muted", "pi-hunk renderer disabled."),
				theme.fg("dim", "Pi will use default tool rendering until enabled again."),
			]);
		}
		return createDiffView({
			patch: HUNK_CONFIG_SAMPLE_PATCH,
			filePath: "preview.ts",
			cwd: ctx.cwd,
			title: "preview",
			config: draft,
			highlighter: getHighlighter(draft, requestPreviewRender),
			theme,
			liveSession: true,
		});
	}

	let preview = buildPreview();
	function rebuildPreview() {
		preview = buildPreview();
	}

	const settingsTheme = resolveSettingsListTheme(theme);

	let currentGroup = -1;

	const groupNav = new SelectList(
		groups.map((g, i) => ({ value: String(i), label: g.label, description: g.description })),
		Math.min(groups.length, 8),
		selectListThemeFromUi(theme),
	);
	groupNav.onSelect = (item) => {
		currentGroup = Number(item.value);
	};
	groupNav.onCancel = () => {
		saveProjectHunkConfig(ctx.cwd, draft)
			.then(() => applyConfig(draft))
			.then(() => ctx.ui.notify("Saved Hunk config to .pi/hunk.json.", "info"))
			.catch((error) => ctx.ui.notify(`Failed to save Hunk config: ${String(error)}`, "error"))
			.finally(() => closeDone?.());
	};

	const groupLists = groups.map((group) => {
		const items: SettingItem[] = group.specs.map((spec) => {
			const item: SettingItem = {
				id: spec.id,
				label: spec.label,
				currentValue: spec.get(draft),
				description: descriptionForSpec(spec, draft, theme),
			};
			item.submenu = (currentValue, done) =>
				new ChoicePicker(spec.label, choicesForSpec(spec, draft, theme), theme, done, currentValue, spec.id.startsWith("colors."), (value) => {
					spec.set(draft, value);
					item.currentValue = spec.get(draft);
					item.description = descriptionForSpec(spec, draft, theme);
					rebuildPreview();
				});
			return item;
		});
		return new SettingsList(
			items,
			Math.min(items.length, 8),
			settingsTheme,
			(id, newValue) => {
				const spec = group.specs.find((s) => s.id === id);
				if (!spec) return;
				spec.set(draft, newValue);
				const item = items.find((i) => i.id === id);
				if (item) {
					item.currentValue = spec.get(draft);
					item.description = descriptionForSpec(spec, draft, theme);
				}
				rebuildPreview();
			},
			() => {
				currentGroup = -1;
			},
			{ enableSearch: true },
		);
	});

	await ctx.ui.custom<void>((tui, nextTheme, _kb, done) => {
		theme = nextTheme;
		requestPreviewRender = () => {
			rebuildPreview();
			preview.invalidate();
			tui.requestRender();
		};
		closeDone = done as ((value?: void) => void) | undefined;
		return {
			render(width: number): string[] {
				const out: string[] = [];
				out.push(`${theme.fg("accent", theme.bold("Hunk Configuration"))} ${theme.fg("dim", "· live Shiki preview")}`);
				if (currentGroup === -1) {
					out.push(theme.fg("dim", "Enter opens group · Esc saves & closes"));
				} else {
					out.push(`${theme.fg("dim", "Esc back to groups")} ${theme.fg("dim", "·")} ${theme.fg("muted", groups[currentGroup].label)}`);
				}
				out.push("");
				if (currentGroup === -1) {
					out.push(...groupNav.render(width));
				} else {
					out.push(...groupLists[currentGroup].render(width));
				}
				out.push("");
				out.push(`${theme.fg("accent", "✦")} ${theme.fg("toolTitle", theme.bold("Preview"))}`);
				out.push(...preview.render(Math.max(40, width)));
				return out;
			},
			invalidate() {
				groupNav.invalidate();
				groupLists.forEach((g) => g.invalidate());
				preview.invalidate();
			},
			handleInput(data: string) {
				if (currentGroup === -1) {
					groupNav.handleInput(data);
				} else {
					groupLists[currentGroup].handleInput(data);
				}
				tui.requestRender();
			},
		};
	});
}
