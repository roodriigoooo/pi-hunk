import { getSettingsListTheme, type ExtensionCommandContext, type Theme } from "@earendil-works/pi-coding-agent";
import { SettingsList, type SettingItem, type SettingsListTheme } from "@earendil-works/pi-tui";
import fs from "node:fs/promises";
import path from "node:path";
import {
	BOOL_VALUES,
	COLOR_VALUES,
	HEADER_VALUES,
	type HuffConfig,
	LINE_HIGHLIGHT_VALUES,
	LINE_NUMBERS_VALUES,
	mergeConfig,
	readJsonFile,
	type ColorSlots,
	type SymbolSlots,
	WORD_HIGHLIGHT_VALUES,
} from "./config";
import { type Highlighter, createDiffView } from "./diff-view";

const HUFF_CONFIG_SAMPLE_PATCH = [
	"--- a/preview.ts",
	"+++ b/preview.ts",
	"@@ -1,4 +1,4 @@",
	" export function greet(name: string) {",
	"-  return `hello ${name}`;",
	"+  return `hi ${name}`;",
	" }",
	"-export const VERSION = \"0.1.0\";",
	"+export const VERSION = \"0.2.0\";",
].join("\n");

const SHIKI_DARK_PRESETS = ["github-dark", "github-dark-dimmed", "vitesse-dark", "night-owl", "one-dark-pro"];
const SHIKI_LIGHT_PRESETS = ["github-light", "vitesse-light", "one-light", "min-light"];
const SYMBOL_PRESETS: Record<keyof SymbolSlots, string[]> = {
	add: ["+", "▶", "•", "*"],
	remove: ["−", "◀", "✕", "-"],
	context: [" ", "·"],
	fold: ["⋯", "…", "··"],
	gutter: ["▎", "│", "║", " "],
};

type ConfigSpec = { id: string; label: string; values: string[]; get: (c: HuffConfig) => string; set: (c: HuffConfig, v: string) => void };

function boolSpec(id: string, label: string, get: (c: HuffConfig) => boolean, set: (c: HuffConfig, v: boolean) => void): ConfigSpec {
	return { id, label, values: BOOL_VALUES, get: (c) => (get(c) ? "true" : "false"), set: (c, v) => set(c, v === "true") };
}

function numSpec(id: string, label: string, values: string[], get: (c: HuffConfig) => number, set: (c: HuffConfig, v: number) => void): ConfigSpec {
	return { id, label, values, get: (c) => String(get(c)), set: (c, v) => set(c, Number(v)) };
}

function colorSpec(id: string, label: string, slot: keyof ColorSlots): ConfigSpec {
	return { id, label, values: COLOR_VALUES, get: (c) => c.colors[slot], set: (c, v) => (c.colors[slot] = v) };
}

function symbolSpec(id: string, label: string, slot: keyof SymbolSlots): ConfigSpec {
	return { id, label, values: SYMBOL_PRESETS[slot], get: (c) => c.symbols[slot], set: (c, v) => (c.symbols[slot] = v) };
}

function huffConfigSpecs(): ConfigSpec[] {
	return [
		{ id: "diffTheme", label: "theme · diff mode", values: ["auto", "dark", "light"], get: (c) => c.diffTheme, set: (c, v) => (c.diffTheme = v as any) },
		{ id: "shikiDarkTheme", label: "theme · shiki dark", values: SHIKI_DARK_PRESETS, get: (c) => c.shikiDarkTheme, set: (c, v) => (c.shikiDarkTheme = v) },
		{ id: "shikiLightTheme", label: "theme · shiki light", values: SHIKI_LIGHT_PRESETS, get: (c) => c.shikiLightTheme, set: (c, v) => (c.shikiLightTheme = v) },
		{ id: "header", label: "layout · header", values: HEADER_VALUES, get: (c) => c.header, set: (c, v) => (c.header = v as any) },
		{ id: "lineNumbers", label: "layout · line numbers", values: LINE_NUMBERS_VALUES, get: (c) => String(c.lineNumbers), set: (c, v) => (c.lineNumbers = v === "true" ? true : v === "false" ? false : "changed") },
		boolSpec("compactUnchanged", "layout · compact unchanged", (c) => c.compactUnchanged, (c, v) => (c.compactUnchanged = v)),
		boolSpec("showHunkHint", "layout · hunk hint", (c) => c.showHunkHint, (c, v) => (c.showHunkHint = v)),
		{ id: "lineHighlight", label: "lines · highlight", values: LINE_HIGHLIGHT_VALUES, get: (c) => c.lineHighlight, set: (c, v) => (c.lineHighlight = v as any) },
		{ id: "wordHighlight", label: "words · highlight", values: WORD_HIGHLIGHT_VALUES, get: (c) => c.wordHighlight, set: (c, v) => (c.wordHighlight = v as any) },
		colorSpec("colors.add", "colors · add", "add"),
		colorSpec("colors.remove", "colors · remove", "remove"),
		colorSpec("colors.context", "colors · context", "context"),
		colorSpec("colors.meta", "colors · meta", "meta"),
		colorSpec("colors.header", "colors · header", "header"),
		colorSpec("colors.gutter", "colors · gutter", "gutter"),
		colorSpec("colors.lineNo", "colors · line no", "lineNo"),
		symbolSpec("symbols.add", "symbols · add", "add"),
		symbolSpec("symbols.remove", "symbols · remove", "remove"),
		symbolSpec("symbols.context", "symbols · context", "context"),
		symbolSpec("symbols.fold", "symbols · fold", "fold"),
		symbolSpec("symbols.gutter", "symbols · gutter", "gutter"),
		numSpec("maxRenderedLines", "limits · max rows", ["60", "120", "260", "500", "1000"], (c) => c.maxRenderedLines, (c, v) => (c.maxRenderedLines = v)),
		numSpec("contextRadius", "limits · context radius", ["2", "3", "6", "10"], (c) => c.contextRadius, (c, v) => (c.contextRadius = v)),
		boolSpec("hunk.reviewTool", "hunk · review tool", (c) => c.hunk.reviewTool, (c, v) => (c.hunk.reviewTool = v)),
		boolSpec("hunk.autoReviewNotes", "hunk · auto pickup", (c) => c.hunk.autoReviewNotes, (c, v) => (c.hunk.autoReviewNotes = v)),
	];
}

function cloneConfig(config: HuffConfig): HuffConfig {
	return { ...config, colors: { ...config.colors }, symbols: { ...config.symbols }, hunk: { ...config.hunk } };
}

async function saveProjectHuffConfig(cwd: string, config: HuffConfig): Promise<void> {
	const dir = path.join(cwd, ".pi");
	await fs.mkdir(dir, { recursive: true });
	const filePath = path.join(dir, "huff.json");
	const existing = await readJsonFile(filePath);
	const merged = mergeConfig(config, existing);
	await fs.writeFile(filePath, JSON.stringify(merged, null, 2) + "\n", "utf8");
}

function settingsListThemeFromUi(theme: Theme): SettingsListTheme {
	return {
		label: (text, selected) => (selected ? theme.fg("accent", theme.bold(text)) : theme.fg("muted", text)),
		value: (text, selected) => (selected ? theme.fg("toolTitle", theme.bold(text)) : theme.fg("dim", text)),
		description: (text) => theme.fg("dim", text),
		cursor: theme.fg("accent", "› "),
		hint: (text) => theme.fg("dim", text),
	};
}

function resolveSettingsListTheme(theme: Theme): SettingsListTheme {
	try {
		return getSettingsListTheme();
	} catch {
		return settingsListThemeFromUi(theme);
	}
}

/** Open the `/huff configure` live-preview TUI. Esc saves to `.pi/huff.json`. */
export async function openHuffConfig(
	ctx: ExtensionCommandContext,
	getConfig: () => HuffConfig,
	applyConfig: (next: HuffConfig) => Promise<void>,
	getHighlighter: () => Highlighter | undefined,
) {
	if (ctx.mode !== "tui") {
		ctx.ui.notify("/huff configure requires TUI mode.", "error");
		return;
	}
	const theme = ctx.ui.theme;
	const draft = cloneConfig(getConfig());
	const specs = huffConfigSpecs();
	let preview = createDiffView({
		patch: HUFF_CONFIG_SAMPLE_PATCH,
		filePath: "preview.ts",
		cwd: ctx.cwd,
		title: "preview",
		config: draft,
		highlighter: getHighlighter(),
		theme,
		liveSession: false,
	});

	const items: SettingItem[] = specs.map((spec) => ({
		id: spec.id,
		label: spec.label,
		currentValue: spec.get(draft),
		values: spec.values,
		description: `Current: ${spec.get(draft)}`,
	}));

	const settingsTheme = resolveSettingsListTheme(theme);
	let closeDone: ((value?: void) => void) | undefined;
	const settingsList = new SettingsList(
		items,
		Math.min(items.length + 2, 14),
		settingsTheme,
		(id, newValue) => {
			const spec = specs.find((s) => s.id === id);
			if (!spec) return;
			spec.set(draft, newValue);
			const item = items.find((i) => i.id === id);
			if (item) item.description = `Current: ${newValue}`;
			preview = createDiffView({
				patch: HUFF_CONFIG_SAMPLE_PATCH,
				filePath: "preview.ts",
				cwd: ctx.cwd,
				title: "preview",
				config: draft,
				highlighter: getHighlighter(),
				theme,
				liveSession: false,
			});
		},
		() => {
			saveProjectHuffConfig(ctx.cwd, draft)
				.then(() => applyConfig(draft))
				.then(() => ctx.ui.notify("Saved Huff config to .pi/huff.json.", "info"))
				.catch((error) => ctx.ui.notify(`Failed to save Huff config: ${String(error)}`, "error"))
				.finally(() => closeDone?.());
		},
		{ enableSearch: true },
	);

	await ctx.ui.custom<void>((tui, _theme, _kb, done) => {
		closeDone = done as ((value?: void) => void) | undefined;
		return {
			render(width: number): string[] {
				const out: string[] = [];
				out.push(`${theme.fg("accent", theme.bold("Huff Configuration"))} ${theme.fg("dim", "· live preview")}`);
				out.push("");
				out.push(...settingsList.render(width));
				out.push("");
				out.push(`${theme.fg("accent", "✦")} ${theme.fg("toolTitle", theme.bold("Preview"))}`);
				out.push(...preview.render(Math.max(40, width)));
				return out;
			},
			invalidate() {
				settingsList.invalidate();
				preview.invalidate();
			},
			handleInput(data: string) {
				settingsList.handleInput(data);
				tui.requestRender();
			},
		};
	});
}
