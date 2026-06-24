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
import { bundledThemesInfo } from "shiki";
import {
	BOOL_VALUES,
	HEADER_VALUES,
	type HuffConfig,
	LINE_HIGHLIGHT_VALUES,
	LINE_NUMBERS_VALUES,
	resolveColorAnsi,
	type ColorSlots,
	type SymbolSlots,
	WORD_HIGHLIGHT_VALUES,
} from "./config";
import { type Highlighter, createDiffView } from "./diff-view";

const HUFF_CONFIG_SAMPLE_PATCH = [
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
	" export const OWNER = \"huff\";",
	" export const STATUS = \"draft\";",
	" ",
	"-export const VERSION = \"0.1.0\";",
	"+export const VERSION = \"0.2.0\";",
	"+export const RELEASE = `${CHANNEL}-preview`;",
].join("\n");

const ANSI_RESET = "\x1b[0m";
const HEX_COLOR_RE = /^#?[0-9a-f]{6}$/i;

const SYMBOL_PRESETS: Record<keyof SymbolSlots, string[]> = {
	add: ["+", "▶", "•", "*"],
	remove: ["−", "◀", "✕", "-"],
	context: [" ", "·"],
	fold: ["⋯", "…", "··"],
	gutter: ["▎", "│", "║", " "],
};

const COLOR_FALLBACKS: Record<keyof ColorSlots, string> = {
	add: "toolDiffAdded",
	remove: "toolDiffRemoved",
	context: "toolDiffContext",
	meta: "dim",
	header: "toolTitle",
	gutter: "toolDiffAdded",
	lineNo: "dim",
};

type Choice = { value: string; label?: string; description?: string };
type ChoiceFactory = (config: HuffConfig, theme: Theme) => Choice[];
type ConfigSpec = {
	id: string;
	label: string;
	values?: string[];
	choices?: Choice[] | ChoiceFactory;
	get: (c: HuffConfig) => string;
	set: (c: HuffConfig, v: string) => void;
	describe?: (value: string, config: HuffConfig, theme: Theme) => string;
};

type ConfigGroup = {
	id: string;
	label: string;
	description: string;
	specs: ConfigSpec[];
};

function normalizeHex(value: string): string {
	const hex = value.startsWith("#") ? value : `#${value}`;
	return hex.toLowerCase();
}

function boolSpec(id: string, label: string, get: (c: HuffConfig) => boolean, set: (c: HuffConfig, v: boolean) => void, detail?: string): ConfigSpec {
	return {
		id,
		label,
		values: BOOL_VALUES,
		get: (c) => (get(c) ? "true" : "false"),
		set: (c, v) => set(c, v === "true"),
		describe: (value) => `${value === "true" ? "enabled" : "disabled"}${detail ? ` — ${detail}` : ""}`,
	};
}

function numSpec(id: string, label: string, values: string[], get: (c: HuffConfig) => number, set: (c: HuffConfig, v: number) => void, detail: string): ConfigSpec {
	return { id, label, values, get: (c) => String(get(c)), set: (c, v) => set(c, Number(v)), describe: () => detail };
}

function choiceSpec(id: string, label: string, choices: Choice[] | ChoiceFactory, get: (c: HuffConfig) => string, set: (c: HuffConfig, v: string) => void, detail?: string): ConfigSpec {
	return {
		id,
		label,
		choices,
		get,
		set,
		describe: (value, config, theme) => choiceDescription(choicesForSpec({ choices, get }, config, theme), value) ?? detail ?? "Enter opens choices with descriptions.",
	};
}

function colorSpec(id: string, label: string, slot: keyof ColorSlots): ConfigSpec {
	return {
		id,
		label,
		choices: (_config, theme) => colorChoices(slot, theme),
		get: (c) => c.colors[slot],
		set: (c, v) => (c.colors[slot] = v),
		describe: (value, _config, theme) => colorDescription(slot, value, theme),
	};
}

function symbolSpec(id: string, label: string, slot: keyof SymbolSlots): ConfigSpec {
	return {
		id,
		label,
		values: SYMBOL_PRESETS[slot],
		get: (c) => c.symbols[slot],
		set: (c, v) => (c.symbols[slot] = v),
		describe: () => `Cycles glyphs used for ${slot} rows.`,
	};
}

const DIFF_MODE_CHOICES: Choice[] = [
	{ value: "auto", label: "auto · follow pi theme", description: "Use light Shiki theme in light pi themes, dark Shiki theme otherwise." },
	{ value: "dark", label: "dark · force dark", description: "Always use the configured dark Shiki theme." },
	{ value: "light", label: "light · force light", description: "Always use the configured light Shiki theme." },
];

const HEADER_CHOICES: Choice[] = HEADER_VALUES.map((value) => ({
	value,
	label: value === "box" ? "box · framed" : value === "compact" ? "compact · single row" : "minimal · path only",
	description: value === "box" ? "Three-line title with stats; strongest scan target." : value === "compact" ? "One-line title, path, and stats; best default density." : "Smallest possible header for narrow terminals.",
}));

const LINE_NUMBER_CHOICES: Choice[] = LINE_NUMBERS_VALUES.map((value) => ({
	value,
	label: value === "true" ? "true · old + new" : value === "changed" ? "changed · changed rows only" : "false · hidden",
	description: value === "true" ? "Show old and new line numbers on every rendered row." : value === "changed" ? "Reserve the column but only show numbers beside additions/removals." : "Hide line number columns entirely.",
}));

const LINE_HIGHLIGHT_DETAILS: Record<string, Omit<Choice, "value">> = {
	gutter: { label: "gutter · slim change rail", description: "Colored glyph in the left rail. Elegant, quiet, readable." },
	bar: { label: "bar · structural marker", description: "Vertical bar beside changed rows. Stronger than gutter, still low-noise." },
	tint: { label: "tint · soft row wash", description: "Background tint behind changed code while preserving Shiki token colors." },
	none: { label: "none · syntax only", description: "No line-level marker; word and side colors carry the diff." },
};
const LINE_HIGHLIGHT_CHOICES: Choice[] = LINE_HIGHLIGHT_VALUES.map((value) => ({ value, ...LINE_HIGHLIGHT_DETAILS[value] }));

const WORD_HIGHLIGHT_DETAILS: Record<string, Omit<Choice, "value">> = {
	bold: { label: "bold · editorial mark", description: "Bold changed words on both sides. Good default." },
	none: { label: "none · side color only", description: "Disable word-level decorations; keep line-level diff colors." },
	underline: { label: "underline · precise mark", description: "Underline changed words without changing foreground color." },
	inverse: { label: "inverse · high contrast", description: "Invert changed words for maximum contrast." },
	strike: { label: "strike · deletion-aware", description: "Strike removed words; underline added words so insertions stay readable." },
	color: { label: "color · semantic accent", description: "Use accent for inserted words and warning/error for removed words." },
};
const WORD_HIGHLIGHT_CHOICES: Choice[] = WORD_HIGHLIGHT_VALUES.map((value) => ({ value, ...WORD_HIGHLIGHT_DETAILS[value] }));

function shikiThemeChoices(type: "dark" | "light"): Choice[] {
	return bundledThemesInfo
		.filter((info) => info.type === type)
		.map((info) => ({ value: info.id, label: `${info.displayName} · ${info.id}`, description: `Bundled Shiki ${type} theme.` }));
}

function swatch(ref: string, fallbackSlot: string, theme: Theme, label: string): string {
	const ansi = resolveColorAnsi(ref, fallbackSlot, theme) || theme.getFgAnsi("muted") || "";
	return `${ansi}●${ANSI_RESET} ${label}`;
}

/** Per-slot color choices: auto (follow role) + six UI-semantic colors + freeform hex.
 *  Cross-role diff colors and theme-slot duplicates are intentionally omitted —
 *  `auto` already follows the role, and custom hex covers anything else. */
function colorChoices(slot: keyof ColorSlots, theme: Theme): Choice[] {
	const fallback = COLOR_FALLBACKS[slot];
	const autoDescription = slot === "gutter" ? "Follow the current row side: add, remove, or context." : `Follow pi theme slot ${fallback}.`;
	const semantic: Array<[string, string]> = [
		["accent", "Primary pi accent color."],
		["muted", "Secondary UI text; calm neutral."],
		["dim", "Tertiary UI text; lowest contrast."],
		["title", "Tool title foreground."],
		["warning", "Warning/yellow emphasis."],
		["error", "Error/red emphasis."],
	];
	return [
		{ value: "auto", label: swatch("auto", fallback, theme, "auto"), description: autoDescription },
		...semantic.map(([value, description]) => ({ value, label: swatch(value, fallback, theme, value), description })),
	];
}

function choiceDescription(choices: Choice[], value: string): string | undefined {
	return choices.find((choice) => choice.value === value)?.description;
}

function colorDescription(slot: keyof ColorSlots, value: string, theme: Theme): string {
	if (value === "auto") return slot === "gutter" ? "Auto follows add/remove/context side color." : `Auto follows ${COLOR_FALLBACKS[slot]}.`;
	if (value.startsWith("theme:")) return `Uses pi theme slot ${value.slice(6)}.`;
	if (HEX_COLOR_RE.test(value)) return `Custom truecolor ${normalizeHex(value)}.`;
	return choiceDescription(colorChoices(slot, theme), value) ?? "Resolved as a pi theme color name if present.";
}

function choicesForSpec(spec: Pick<ConfigSpec, "choices" | "values" | "get" | "describe">, config: HuffConfig, theme: Theme): Choice[] {
	const choices = spec.choices
		? typeof spec.choices === "function"
			? spec.choices(config, theme)
			: spec.choices
		: (spec.values ?? []).map((value) => ({ value, label: value, description: spec.describe?.(value, config, theme) }));
	const current = spec.get(config);
	if (choices.some((choice) => choice.value === current)) return choices;
	return [{ value: current, label: `${current} · current custom value`, description: "Current value from config; not in the built-in picker list." }, ...choices];
}

function descriptionForSpec(spec: ConfigSpec, config: HuffConfig, theme: Theme): string {
	const value = spec.get(config);
	const detail = spec.describe?.(value, config, theme) ?? choiceDescription(choicesForSpec(spec, config, theme), value);
	return detail ? `Current: ${value} — ${detail}` : `Current: ${value}`;
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
		return HEX_COLOR_RE.test(normalized) && !this.choices.some((choice) => choice.value.toLowerCase() === normalized);
	}
}

/** All config specs grouped by what the user sees, not by config key. */
function huffConfigGroups(): ConfigGroup[] {
	return [
		{
			id: "words",
			label: "Side colors & words",
			description: "Word emphasis style and add/remove/context colors.",
			specs: [
				choiceSpec("wordHighlight", "word emphasis", WORD_HIGHLIGHT_CHOICES, (c) => c.wordHighlight, (c, v) => (c.wordHighlight = v as any)),
				colorSpec("colors.add", "add color", "add"),
				colorSpec("colors.remove", "remove color", "remove"),
				colorSpec("colors.context", "context color", "context"),
			],
		},
		{
			id: "rail",
			label: "Change rail",
			description: "Left-edge markers: line highlight, gutter, add/remove signs.",
			specs: [
				choiceSpec("lineHighlight", "line marker", LINE_HIGHLIGHT_CHOICES, (c) => c.lineHighlight, (c, v) => (c.lineHighlight = v as any)),
				colorSpec("colors.gutter", "gutter color", "gutter"),
				symbolSpec("symbols.gutter", "gutter glyph", "gutter"),
				symbolSpec("symbols.add", "add sign", "add"),
				symbolSpec("symbols.remove", "remove sign", "remove"),
			],
		},
		{
			id: "header",
			label: "Header & line numbers",
			description: "File header style, line numbers, and chrome colors.",
			specs: [
				choiceSpec("header", "header style", HEADER_CHOICES, (c) => c.header, (c, v) => (c.header = v as any)),
				choiceSpec("lineNumbers", "line numbers", LINE_NUMBER_CHOICES, (c) => String(c.lineNumbers), (c, v) => (c.lineNumbers = v === "true" ? true : v === "false" ? false : "changed")),
				colorSpec("colors.header", "header color", "header"),
				colorSpec("colors.lineNo", "line number color", "lineNo"),
				colorSpec("colors.meta", "meta color", "meta"),
			],
		},
		{
			id: "symbols",
			label: "Symbols",
			description: "Glyphs for context and folded rows.",
			specs: [
				symbolSpec("symbols.context", "context glyph", "context"),
				symbolSpec("symbols.fold", "fold glyph", "fold"),
			],
		},
		{
			id: "folding",
			label: "Folding & limits",
			description: "Compact unchanged regions, context radius, max rows.",
			specs: [
				boolSpec("compactUnchanged", "compact unchanged", (c) => c.compactUnchanged, (c, v) => (c.compactUnchanged = v), "Fold unchanged regions around edits."),
				numSpec("contextRadius", "context radius", ["2", "3", "6", "10"], (c) => c.contextRadius, (c, v) => (c.contextRadius = v), "Unchanged lines kept around each change when compaction is on."),
				numSpec("maxRenderedLines", "max rows", ["12", "24", "60", "120", "260", "500", "1000"], (c) => c.maxRenderedLines, (c, v) => (c.maxRenderedLines = v), "Maximum rendered diff rows before truncation."),
			],
		},
		{
			id: "shiki",
			label: "Shiki theme",
			description: "Dark/light Shiki themes and auto mode.",
			specs: [
				choiceSpec("diffTheme", "diff mode", DIFF_MODE_CHOICES, (c) => c.diffTheme, (c, v) => (c.diffTheme = v as any)),
				choiceSpec("shikiDarkTheme", "dark theme", () => shikiThemeChoices("dark"), (c) => c.shikiDarkTheme, (c, v) => (c.shikiDarkTheme = v), "Enter opens bundled dark Shiki themes."),
				choiceSpec("shikiLightTheme", "light theme", () => shikiThemeChoices("light"), (c) => c.shikiLightTheme, (c, v) => (c.shikiLightTheme = v), "Enter opens bundled light Shiki themes."),
			],
		},
		{
			id: "bridge",
			label: "Renderer & Hunk bridge",
			description: "Master toggle, hunk hint, and read-only Hunk integration.",
			specs: [
				boolSpec("enabled", "renderer", (c) => c.enabled, (c, v) => (c.enabled = v), "Turn Huff diff rendering on/off."),
				boolSpec("showHunkHint", "hunk hint", (c) => c.showHunkHint, (c, v) => (c.showHunkHint = v), "Show /huff send hint when a live Hunk session exists."),
				boolSpec("hunk.enabled", "hunk bridge", (c) => c.hunk.enabled, (c, v) => (c.hunk.enabled = v), "Enable read-only Hunk session integration."),
				boolSpec("hunk.reviewTool", "review tool", (c) => c.hunk.reviewTool, (c, v) => (c.hunk.reviewTool = v), "Expose huff_review_notes to the model."),
				boolSpec("hunk.autoReviewNotes", "auto pickup", (c) => c.hunk.autoReviewNotes, (c, v) => (c.hunk.autoReviewNotes = v), "Inject new human notes before agent turns."),
				numSpec("hunk.autoReviewNotesMin", "auto min notes", ["1", "2", "3", "5"], (c) => c.hunk.autoReviewNotesMin, (c, v) => (c.hunk.autoReviewNotesMin = v), "Minimum user notes required for automatic pickup."),
			],
		},
	];
}

function cloneConfig(config: HuffConfig): HuffConfig {
	return { ...config, colors: { ...config.colors }, symbols: { ...config.symbols }, hunk: { ...config.hunk } };
}

async function saveProjectHuffConfig(cwd: string, config: HuffConfig): Promise<void> {
	const dir = path.join(cwd, ".pi");
	await fs.mkdir(dir, { recursive: true });
	const filePath = path.join(dir, "huff.json");
	await fs.writeFile(filePath, JSON.stringify(config, null, 2) + "\n", "utf8");
}

function huffSettingsHint(text: string): string {
	return text.replace("Enter/Space to change", "Enter/Space open picker").replace("Esc to cancel", "Esc to save");
}

function settingsListThemeFromUi(theme: Theme): SettingsListTheme {
	return {
		label: (text, selected) => (selected ? theme.fg("accent", theme.bold(text)) : theme.fg("muted", text)),
		value: (text, selected) => (selected ? theme.fg("toolTitle", theme.bold(text)) : theme.fg("dim", text)),
		description: (text) => theme.fg("dim", text),
		cursor: theme.fg("accent", "› "),
		hint: (text) => theme.fg("dim", huffSettingsHint(text)),
	};
}

function resolveSettingsListTheme(theme: Theme): SettingsListTheme {
	try {
		const base = getSettingsListTheme();
		return { ...base, hint: (text) => base.hint(huffSettingsHint(text)) };
	} catch {
		return settingsListThemeFromUi(theme);
	}
}

/** Open the `/huff configure` live-preview TUI. Two-level nav: group list →
 *  per-group settings. Esc inside a group returns to the group list; Esc on the
 *  group list saves to `.pi/huff.json` and closes. */
export async function openHuffConfig(
	ctx: ExtensionCommandContext,
	getConfig: () => HuffConfig,
	applyConfig: (next: HuffConfig) => Promise<void>,
	getHighlighter: (config: HuffConfig, invalidate?: () => void) => Highlighter | undefined,
) {
	if (ctx.mode !== "tui") {
		ctx.ui.notify("/huff configure requires TUI mode.", "error");
		return;
	}
	const draft = cloneConfig(getConfig());
	const groups = huffConfigGroups();
	let theme = ctx.ui.theme;
	let requestPreviewRender: (() => void) | undefined;
	let closeDone: ((value?: void) => void) | undefined;

	function buildPreview(): Component {
		if (!draft.enabled) {
			return new StaticLines(() => [
				theme.fg("muted", "Huff renderer disabled."),
				theme.fg("dim", "Pi will use default tool rendering until enabled again."),
			]);
		}
		return createDiffView({
			patch: HUFF_CONFIG_SAMPLE_PATCH,
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
		saveProjectHuffConfig(ctx.cwd, draft)
			.then(() => applyConfig(draft))
			.then(() => ctx.ui.notify("Saved Huff config to .pi/huff.json.", "info"))
			.catch((error) => ctx.ui.notify(`Failed to save Huff config: ${String(error)}`, "error"))
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
				out.push(`${theme.fg("accent", theme.bold("Huff Configuration"))} ${theme.fg("dim", "· live Shiki preview")}`);
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
