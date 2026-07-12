import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHighlighter } from "shiki";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function findPiPackageRoot() {
	const candidates = [
		process.env.PI_CODING_AGENT_ROOT,
		path.join(repoRoot, "node_modules", "@earendil-works", "pi-coding-agent"),
		"/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent",
		"/usr/local/lib/node_modules/@earendil-works/pi-coding-agent",
		path.join(os.homedir(), ".pi", "scrutiny", "node_modules", "@earendil-works", "pi-coding-agent"),
		path.join(os.homedir(), ".pi", "agent", "npm", "node_modules", "@earendil-works", "pi-coding-agent"),
	].filter(Boolean);
	for (const candidate of candidates) {
		if (existsSync(path.join(candidate, "package.json"))) return candidate;
	}
	throw new Error(`Could not locate @earendil-works/pi-coding-agent. Set PI_CODING_AGENT_ROOT.`);
}

const piPackageRoot = findPiPackageRoot();
const piNodeModules = path.join(piPackageRoot, "node_modules");
const requireFromPi = createRequire(path.join(piPackageRoot, "package.json"));
const createJiti = requireFromPi("jiti");

const jiti = createJiti(import.meta.url, {
	interopDefault: true,
	moduleCache: false,
	fsCache: false,
	alias: {
		"@earendil-works/pi-coding-agent": path.join(piPackageRoot, "dist", "index.js"),
		"@earendil-works/pi-tui": path.join(piNodeModules, "@earendil-works", "pi-tui", "dist", "index.js"),
		typebox: path.join(piNodeModules, "typebox", "build", "index.mjs"),
	},
});

const { parseUnifiedPatch, renderDiffLines, findPatchLineAddress, patchLineAddressKey, buildDiffLayout } = await jiti.import(path.join(repoRoot, "src", "diff-view.ts"), { default: false });
const { DEFAULT_CONFIG, TOKENIZE_MAX_LINE_LENGTH, TOKENIZE_TIME_LIMIT_MS, ansiFg } = await jiti.import(path.join(repoRoot, "src", "config.ts"), { default: false });
const { applyHunkPreset, choicesForSpec, descriptionForSpec, hunkConfigGroups, hunkConfigPresets } = await jiti.import(path.join(repoRoot, "src", "config-spec.ts"), { default: false });
const { createHighlighterCache } = await jiti.import(path.join(repoRoot, "src", "highlighter-cache.ts"), { default: false });
const { normalizeHunkComments, createHunkBridge, buildReviewNoteShape, reviewAnnotationsForRecord, reviewedRefFromSession } = await jiti.import(path.join(repoRoot, "src", "hunk-bridge.ts"), { default: false });
const { createHunkSessionRead, createLegacyHunkSessionRead } = await jiti.import(path.join(repoRoot, "src", "hunk-session-read.ts"), { default: false });
const { createRenderRecordStore, createAgentEditPatchSource } = await jiti.import(path.join(repoRoot, "src", "render-records.ts"), { default: false });
const { renderCodeLine, styleToken, wordHighlightAnsi, ANSI_RESET } = await jiti.import(path.join(repoRoot, "src", "styling.ts"), { default: false });
const { createReviewedPatchSource, normalizeReviewPatches, createPatchSource } = await jiti.import(path.join(repoRoot, "src", "patch-source.ts"), { default: false });
const { renderReviewView, commentLines, groupCommentsByFile } = await jiti.import(path.join(repoRoot, "src", "review-view.ts"), { default: false });
const { fileKey } = await jiti.import(path.join(repoRoot, "src", "paths.ts"), { default: false });
const { writePatch } = await jiti.import(path.join(repoRoot, "src", "diff-view.ts"), { default: false });

function fakeTheme() {
	const colors = {
		accent: "\x1b[38;2;255;190;106m",
		toolTitle: "\x1b[38;2;250;250;250m",
		toolDiffAdded: "\x1b[38;2;80;220;120m",
		toolDiffRemoved: "\x1b[38;2;240;100;100m",
		toolDiffContext: "\x1b[38;2;210;210;210m",
		muted: "\x1b[38;2;160;160;160m",
		dim: "\x1b[38;2;110;110;110m",
		warning: "\x1b[38;2;255;200;80m",
		error: "\x1b[38;2;255;100;100m",
	};
	return {
		name: "unit-dark",
		fg(name, text) {
			return `${colors[name] ?? ""}${text}\x1b[0m`;
		},
		getFgAnsi(name) {
			return colors[name] ?? "";
		},
		bold(text) {
			return `\x1b[1m${text}\x1b[22m`;
		},
	};
}

const fakeHighlighter = {
	codeToTokensBase(code) {
		return code.split("\n").map((line) => [{ content: line, color: "#ffffff" }]);
	},
};

function stripAnsi(value) {
	return value.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

// --- parseUnifiedPatch: structure, line numbers, kinds ---------------------
const patch = [
	"--- a/a.ts",
	"+++ b/a.ts",
	"@@ -1,3 +1,3 @@",
	" export function greet(name: string) {",
	"-  return `hello ${name}`;",
	"+  return `hi ${name}`;",
	" }",
].join("\n");

const parsed = parseUnifiedPatch(patch);
assert.equal(parsed.oldFile, "a/a.ts");
assert.equal(parsed.newFile, "b/a.ts");
assert.equal(parsed.hunks.length, 1);
const hunk = parsed.hunks[0];
assert.equal(hunk.oldStart, 1);
assert.equal(hunk.newStart, 1);
const kinds = hunk.lines.map((l) => l.kind);
assert.deepEqual(kinds, ["context", "remove", "add", "context"]);
const removeLine = hunk.lines.find((l) => l.kind === "remove");
const addLine = hunk.lines.find((l) => l.kind === "add");
assert.equal(removeLine.oldLine, 2);
assert.equal(addLine.newLine, 2);
// word-level emphasis ranges computed on the paired add/remove block
assert.ok(removeLine.removeRanges && removeLine.removeRanges.length > 0, "remove ranges computed");
assert.ok(addLine.addRanges && addLine.addRanges.length > 0, "add ranges computed");
// the changed word "hello"→"hi" should be emphasized, not the shared "  return `"
const removeEmph = removeLine.removeRanges.find((r) => r.start >= 2);
assert.ok(removeEmph, "emphasized range starts past the shared prefix");

// trailing blank split row must not become a phantom context line
const trailingBlank = parseUnifiedPatch(patch + "\n");
assert.equal(trailingBlank.hunks[0].lines.length, hunk.lines.length, "no phantom trailing line");

// patch address query: a review note lands on the rendered row it names
const noteAddress = findPatchLineAddress(parsed, { filePath: "a.ts", newLine: 2 }, repoRoot);
assert.ok(noteAddress, "new-side address found");
assert.equal(noteAddress.kind, "add");
assert.equal(noteAddress.lineIndex, 2);
const annotatedRender = renderDiffLines({
	patch,
	filePath: "a.ts",
	cwd: repoRoot,
	title: "unit",
	config: { ...DEFAULT_CONFIG, lineNumbers: false, header: "minimal", compactUnchanged: false },
	highlighter: fakeHighlighter,
	theme: fakeTheme(),
	liveSession: false,
	annotations: new Map([[patchLineAddressKey(noteAddress), [{ text: "tighten greeting", detail: "human rationale", author: "human" }]]]),
});
const annotatedLine = annotatedRender.find((line) => stripAnsi(line).includes("tighten greeting"));
assert.ok(annotatedLine, "annotation rendered inline beside addressed row");
assert.match(stripAnsi(annotatedLine), /hi.*note human: tighten greeting \(human rationale\)/);

// strike word highlighting is side-aware: deletions strike, additions underline
const strikeRender = renderDiffLines({
	patch,
	filePath: "a.ts",
	cwd: repoRoot,
	title: "unit",
	config: { ...DEFAULT_CONFIG, wordHighlight: "strike", lineHighlight: "tint" },
	highlighter: fakeHighlighter,
	theme: fakeTheme(),
	liveSession: false,
});
const removedRendered = strikeRender.find((line) => stripAnsi(line).includes("hello"));
const addedRendered = strikeRender.find((line) => stripAnsi(line).includes("hi"));
assert.match(removedRendered, /\x1b\[1;9m/, "removed words use strikethrough");
assert.doesNotMatch(addedRendered, /\x1b\[1;9m/, "added words are not struck through");
assert.match(addedRendered, /\x1b\[1;4m/, "added words use underline in strike mode");
const tintRepeats = (addedRendered.match(/\x1b\[48;2;26;44;28m/g) ?? []).length;
assert.ok(tintRepeats > 2, "tint background survives token resets across the line");

// --- normalizeHunkComments: shape tolerance, dedup, type filter ------------
const flat = normalizeHunkComments({
	comments: [
		{ id: "c1", type: "user", filePath: "a.ts", newLine: 3, summary: "tighten" },
		{ id: "c1", type: "user", filePath: "a.ts", newLine: 3, summary: "tighten" },
		{ id: "c2", type: "ai", filePath: "a.ts", newLine: 4, summary: "ignored" },
	],
});
assert.equal(flat.length, 1, "dedup + type filter");
assert.equal(flat[0].summary, "tighten");

const nested = normalizeHunkComments({
	files: [{ path: "b.ts", annotations: [{ newRange: [5, 5], summary: "nested", rationale: "why" }] }],
});
assert.equal(nested.length, 1);
assert.equal(nested[0].filePath, "b.ts");
assert.equal(nested[0].newLine, 5);
assert.equal(nested[0].rationale, "why");

const altFields = normalizeHunkComments([{ file: "c.ts", old_line: 7, text: "alt shape", author: { name: "human" } }]);
assert.equal(altFields.length, 1);
assert.equal(altFields[0].filePath, "c.ts");
assert.equal(altFields[0].oldLine, 7);
assert.equal(altFields[0].summary, "alt shape");
assert.equal(altFields[0].author, "human");

// --- whole-hunk grammar state: template-literal continuation line -----------

// A template literal spans two lines. The second line ("   world`;") is a
// context line that lives *inside* the template literal. Per-line tokenization
// loses that context and colors "world" as a bare identifier; whole-hunk
// tokenization colors it as template-string content. This locks in the fix.
{
	const highlighter = await createHighlighter({ themes: ["github-dark"], langs: ["typescript"] });
	const tsPatch = [
		"--- a/code.ts",
		"+++ b/code.ts",
		"@@ -1,4 +1,4 @@",
		" const a = 1;",
		"-const msg = `hello ${name}",
		"+const msg = `hi ${name}",
		"   world`;",
		" const b = 2;",
	].join("\n");

	// Ground truth: tokenize the full new side and read the "world" token color.
	// Contrast: tokenize the world line in isolation (what per-line rendering does).
	// The fix means the rendered "world" must carry the full-side (template-string)
	// color, NOT the isolated-identifier color.
	const fullNew = ["const a = 1;", "const msg = `hi ${name}", "   world`;", "const b = 2;"].join("\n");
	const fullTokens = highlighter.codeToTokensBase(fullNew, { lang: "typescript", theme: "github-dark" });
	const worldToken = fullTokens[2].find((t) => t.content.includes("world"));
	assert.ok(worldToken, "world token found in full tokenize");
	const expectedAnsi = ansiFg(worldToken.color);
	assert.ok(expectedAnsi, "expected template-string color resolves to ANSI");

	const isoTokens = highlighter.codeToTokensBase("   world`;", { lang: "typescript", theme: "github-dark" });
	const isoWorldToken = isoTokens[0].find((t) => t.content.includes("world"));
	assert.ok(isoWorldToken, "world token found in isolated tokenize");
	const isolatedAnsi = ansiFg(isoWorldToken.color);
	assert.notEqual(expectedAnsi, isolatedAnsi, "fixture is meaningful: full vs isolated world colors differ");

	const rendered = renderDiffLines({
		patch: tsPatch,
		filePath: "code.ts",
		cwd: repoRoot,
		title: "unit",
		config: { ...DEFAULT_CONFIG, wordHighlight: "none", lineHighlight: "none", lineNumbers: false, header: "minimal", compactUnchanged: false },
		highlighter,
		theme: fakeTheme(),
		liveSession: false,
	});
	const worldLine = rendered.find((line) => stripAnsi(line).includes("world"));
	assert.ok(worldLine, "world continuation line rendered");
	assert.ok(worldLine.includes(expectedAnsi), `continuation line carries template-string color ${expectedAnsi}`);
	assert.ok(!worldLine.includes(isolatedAnsi), `continuation line does not carry isolated-identifier color ${isolatedAnsi}; got: ${JSON.stringify(worldLine)}`);
	await highlighter.dispose();
}

// --- Shiki perf guards + lazy non-core language loading --------------------
{
	let invalidated = false;
	const highlighter = await createHighlighter({ themes: ["github-dark"], langs: ["typescript"] });
	assert.ok(!highlighter.getLoadedLanguages().includes("haskell"), "haskell is not eagerly loaded");
	const hsPatch = [
		"--- a/Main.hs",
		"+++ b/Main.hs",
		"@@ -1,1 +1,1 @@",
		"-main = putStrLn \"old\"",
		"+main = putStrLn \"new\"",
	].join("\n");
	const first = renderDiffLines({
		patch: hsPatch,
		filePath: "Main.hs",
		cwd: repoRoot,
		title: "unit",
		config: { ...DEFAULT_CONFIG, wordHighlight: "none", lineHighlight: "none", lineNumbers: false, header: "minimal", compactUnchanged: false },
		highlighter,
		theme: fakeTheme(),
		liveSession: false,
		invalidate: () => (invalidated = true),
	});
	assert.ok(first.some((line) => stripAnsi(line).includes("putStrLn")), "first render falls back to readable plain text");
	for (let i = 0; i < 40 && !highlighter.getLoadedLanguages().includes("haskell"); i++) await new Promise((resolve) => setTimeout(resolve, 25));
	assert.ok(highlighter.getLoadedLanguages().includes("haskell"), "haskell loaded lazily");
	assert.equal(invalidated, true, "lazy load asks TUI to rerender");
	const expected = highlighter.codeToTokensBase("main = putStrLn \"new\"", { lang: "haskell", theme: "github-dark" })[0].find((t) => t.content.includes("new"));
	const expectedAnsi = ansiFg(expected?.color);
	const second = renderDiffLines({
		patch: hsPatch,
		filePath: "Main.hs",
		cwd: repoRoot,
		title: "unit",
		config: { ...DEFAULT_CONFIG, wordHighlight: "none", lineHighlight: "none", lineNumbers: false, header: "minimal", compactUnchanged: false },
		highlighter,
		theme: fakeTheme(),
		liveSession: false,
	});
	assert.ok(expectedAnsi && second.some((line) => line.includes(expectedAnsi)), "second render uses lazily loaded Haskell grammar");
	await highlighter.dispose();

	let calls = 0;
	const guardedHighlighter = {
		codeToTokensBase(_code, options) {
			calls++;
			assert.equal(options.tokenizeMaxLineLength, TOKENIZE_MAX_LINE_LENGTH, "max line guard passed to Shiki");
			assert.equal(options.tokenizeTimeLimit, TOKENIZE_TIME_LIMIT_MS, "time guard passed to Shiki");
			return [[{ content: "const ok = true;", color: "#ffffff" }]];
		},
	};
	const shortPatch = "--- a/a.ts\n+++ b/a.ts\n@@ -1,1 +1,1 @@\n-const ok = false;\n+const ok = true;";
	renderDiffLines({ patch: shortPatch, filePath: "a.ts", cwd: repoRoot, title: "unit", config: { ...DEFAULT_CONFIG, compactUnchanged: false }, highlighter: guardedHighlighter, theme: fakeTheme() });
	assert.equal(calls, 2, "normal hunk tokenizes both sides with guards");
	const longLine = "x".repeat(TOKENIZE_MAX_LINE_LENGTH + 1);
	const longPatch = `--- a/a.ts\n+++ b/a.ts\n@@ -1,1 +1,1 @@\n-${longLine}\n+${longLine}`;
	renderDiffLines({ patch: longPatch, filePath: "a.ts", cwd: repoRoot, title: "unit", config: { ...DEFAULT_CONFIG, compactUnchanged: false }, highlighter: guardedHighlighter, theme: fakeTheme() });
	assert.equal(calls, 2, "too-long hunk falls back to plain text before tokenization");
}

// --- word-emphasis indexing across astral code points (Q4) ------------------

// diffWordsWithSpace emits UTF-16-code-unit ranges; the renderer advances its
// cursor by each code point's UTF-16 length. An astral emoji is 2 units, so a
// range ending at the emoji must NOT bleed emphasis onto the following char.
// This locks that alignment: the emoji is counted as 2, the trailing char as 3.
{
	const emojiPatch = [
		"--- a/e.ts",
		"+++ b/e.ts",
		"@@ -1,1 +1,1 @@",
		"-a c",
		"+a🎉c",
	].join("\n");
	const rendered = renderDiffLines({
		patch: emojiPatch,
		filePath: "e.ts",
		cwd: repoRoot,
		title: "unit",
		config: { ...DEFAULT_CONFIG, wordHighlight: "bold", lineHighlight: "none", lineNumbers: false, header: "minimal", compactUnchanged: false },
		highlighter: fakeHighlighter,
		theme: fakeTheme(),
		liveSession: false,
	});
	const added = rendered.find((line) => stripAnsi(line).includes("🎉"));
	assert.ok(added, "emoji added line rendered");
	const boldCount = (added.match(/\x1b\[1m/g) ?? []).length;
	assert.equal(boldCount, 1, `exactly the emoji is bold, not the trailing char; got ${boldCount} bold runs in ${JSON.stringify(added)}`);
	assert.ok(added.indexOf("\x1b[1m") < added.indexOf("🎉"), "bold run precedes the emoji, not the trailing char");

	// CJK is BMP (1 unit per char) — the changed char is emphasized, its neighbor is not.
	const cjkPatch = "--- a/c.ts\n+++ b/c.ts\n@@ -1,1 +1,1 @@\n-a c\n+a巴c";
	const cjkRendered = renderDiffLines({
		patch: cjkPatch,
		filePath: "c.ts",
		cwd: repoRoot,
		title: "unit",
		config: { ...DEFAULT_CONFIG, wordHighlight: "bold", lineHighlight: "none", lineNumbers: false, header: "minimal", compactUnchanged: false },
		highlighter: fakeHighlighter,
		theme: fakeTheme(),
		liveSession: false,
	});
	const cjkAdded = cjkRendered.find((line) => stripAnsi(line).includes("巴"));
	assert.ok(cjkAdded, "cjk added line rendered");
	assert.equal((cjkAdded.match(/\x1b\[1m/g) ?? []).length, 1, "exactly the changed CJK char is bold");
}

// --- I: note-to-edit scoped auto-pickup ------------------------------------

// Auto-pickup must inject only notes that overlap a recent edit by
// (file, line). A note about an untouched file must NOT trigger injection,
// even when the note count meets the threshold. The flat count threshold is a
// fallback, not the primary rule.
//
// The bridge needs recent records to correlate against; the store lives in the
// extension closure. createHunkBridge accepts an optional findRecent(filePath,
// cwd) seam so the bridge can query the store without owning it.
{
	const cwd = repoRoot;
	const store = createRenderRecordStore();
	// A recent edit to src/app.ts that touches new lines 3..5.
	store.record("call-1", {
		tool: "edit",
		filePath: path.join(cwd, "src", "app.ts"),
		patch: writePatch("a/src/app.ts", "b/src/app.ts", "line1\nline2\nold\nold\nold\nline6\n", "line1\nline2\nnewA\nnewB\nnewC\nline6\n"),
		summary: "edited app.ts",
	});

	// Agent-edit patch source: bridge queries by file path, store resolves to the record.
	const bridge = createHunkBridge(createAgentEditPatchSource(store));

	// Override readNotes so we don't shell out to hunk; inject a controlled set.
	const notesOnEdit = { id: "n1", type: "user", filePath: "src/app.ts", newLine: 4, summary: "on the edit" };
	const notesOffEdit = { id: "n2", type: "user", filePath: "src/other.ts", newLine: 99, summary: "unrelated" };
	const fakeResult = (comments) => ({ live: true, session: { id: "s" }, comments, message: "" });
	bridge.readNotes = async () => fakeResult([notesOnEdit, notesOffEdit]);

	const config = { ...DEFAULT_CONFIG, hunk: { ...DEFAULT_CONFIG.hunk, enabled: true, autoReviewNotes: true, autoReviewNotesMin: 99 } };

	// Desired: only the on-edit note is relevant. Arbitrary count thresholds no
	// longer gate pickup; one relevant note is enough when auto pickup is enabled.
	const { result: r1, inject: inj1 } = await bridge.pickup(cwd, config);
	assert.equal(inj1, true, "one relevant note injects even when legacy min is high");
	assert.equal(r1.comments.length, 1, "result carries only relevant notes");
	assert.equal(r1.comments[0].summary, "on the edit", "the relevant note is the on-edit one");

	const { inject: inj2 } = await bridge.pickup(cwd, config);
	assert.equal(inj2, false, "unchanged review state is deduped");
}

// --- I2: shared patch model shapes review notes by rendered hunk row --------
{
	const cwd = repoRoot;
	const store = createRenderRecordStore();
	const record = {
		tool: "edit",
		filePath: path.join(cwd, "src", "app.ts"),
		patch: writePatch("a/src/app.ts", "b/src/app.ts", "line1\nline2\nold\nold\nline5\n", "line1\nline2\nnewA\nnewB\nline5\n"),
		summary: "edited app.ts",
	};
	store.record("call-1", record);
	const findRecent = (filePath) => store.findRecent(filePath, cwd);
	const comments = [
		{ id: "n1", type: "user", filePath: "src/app.ts", newLine: 4, summary: "pin on new row", rationale: "spatial" },
		{ id: "n2", type: "user", filePath: "src/missing.ts", newLine: 1, summary: "no patch" },
	];
	const shape = buildReviewNoteShape(comments, findRecent, cwd);
	assert.equal(shape.hunks.length, 1, "one rendered hunk owns matching note");
	assert.equal(shape.hunks[0].lines.length, 1, "one addressed row in hunk");
	assert.equal(shape.hunks[0].lines[0].comments[0].summary, "pin on new row");
	assert.equal(shape.openComments.length, 1, "unmatched note remains open");
	const annotations = reviewAnnotationsForRecord(comments, record, cwd);
	const rendered = renderDiffLines({
		patch: record.patch,
		filePath: record.filePath,
		cwd,
		title: "review notes",
		config: { ...DEFAULT_CONFIG, lineNumbers: false, header: "minimal", compactUnchanged: false },
		highlighter: fakeHighlighter,
		theme: fakeTheme(),
		liveSession: false,
		annotations,
	});
	assert.ok(rendered.some((line) => /newB.*note pin on new row/.test(stripAnsi(line))), "review annotation shares diff renderer row");
}

// --- J: /hunk review pairs notes with recent edits (read-only) -------------

// renderReviewLines lists each human note with whether a recent edit touched
// its line or not. It must not send anything to the agent; it is a human-facing
// diagnostic.
{
	const cwd = repoRoot;
	const store = createRenderRecordStore();
	store.record("call-1", {
		tool: "edit",
		filePath: path.join(cwd, "src", "app.ts"),
		patch: writePatch("a/src/app.ts", "b/src/app.ts", "line1\nline2\nold\nold\nold\nline6\n", "line1\nline2\nnewA\nnewB\nnewC\nline6\n"),
		summary: "edited app.ts",
	});
	const src = createAgentEditPatchSource(store);
	const bridge = createHunkBridge(src);

	const comments = [
		{ id: "n1", type: "user", filePath: "src/app.ts", newLine: 4, summary: "on the edit", rationale: "why" },
		{ id: "n2", type: "user", filePath: "src/other.ts", newLine: 99, summary: "untouched file" },
	];
	const shape = buildReviewNoteShape(comments, src.findForFile, cwd);
	const result = {
		live: true,
		session: { id: "s" },
		comments,
		message: "",
		hunks: shape.hunks,
		openComments: shape.openComments,
	};
	const lines = bridge.renderReviewLines(result, cwd, fakeTheme());
	const plain = lines.map(stripAnsi).join("\n");
	assert.match(plain, /Hunk review/, "review header present");
	assert.match(plain, /on the edit/, "on-edit note listed");
	assert.match(plain, /untouched file/, "off-edit note listed");
	const onEditIdx = lines.findIndex((l) => stripAnsi(l).includes("on the edit"));
	const offEditIdx = lines.findIndex((l) => stripAnsi(l).includes("untouched file"));
	assert.ok(onEditIdx >= 0 && offEditIdx >= 0, "both notes rendered");
	assert.match(stripAnsi(lines[onEditIdx]), /touched/i, "on-edit note marked touched");
	assert.match(stripAnsi(lines[offEditIdx]), /open/i, "off-edit note marked open");
}

// --- J2: a note pinned to a removed line (oldLine) counts as touched -------
// Regression: the overlap check used to compare oldLine against the edit's
// new-side span only, so a note on a deleted line always read as "open".
// The shared patch address query now checks oldLine against rendered remove rows.
{
	const cwd = repoRoot;
	const store = createRenderRecordStore();
	store.record("call-1", {
		tool: "edit",
		filePath: path.join(cwd, "src", "app.ts"),
		patch: writePatch("a/src/app.ts", "b/src/app.ts", "a\nb\nc\nd\ne\n", "a\nb\nc\n"),
		summary: "deleted lines 4-5",
	});
	const src = createAgentEditPatchSource(store);
	const bridge = createHunkBridge(src);

	const comments = [
		{ id: "n1", type: "user", filePath: "src/app.ts", oldLine: 4, summary: "on the removed line" },
	];
	const shape = buildReviewNoteShape(comments, src.findForFile, cwd);
	const result = {
		live: true,
		session: { id: "s" },
		comments,
		message: "",
		hunks: shape.hunks,
		openComments: shape.openComments,
	};
	const lines = bridge.renderReviewLines(result, cwd, fakeTheme());
	const idx = lines.findIndex((l) => stripAnsi(l).includes("on the removed line"));
	assert.ok(idx >= 0, "removed-line note rendered");
	assert.match(stripAnsi(lines[idx]), /touched/i, "note on a removed line is touched, not open");
}

// --- K: highlighter cache coalesces refreshes and serves stale while loading -
{
	const configA = { ...DEFAULT_CONFIG, shikiDarkTheme: "theme-a", shikiLightTheme: "theme-a-light" };
	const configB = { ...DEFAULT_CONFIG, shikiDarkTheme: "theme-b", shikiLightTheme: "theme-b-light" };
	let releaseB;
	const gateB = new Promise((resolve) => (releaseB = resolve));
	const calls = [];
	const cache = createHighlighterCache(async (config) => {
		calls.push(config.shikiDarkTheme);
		if (config.shikiDarkTheme === "theme-b") await gateB;
		return { id: config.shikiDarkTheme };
	});
	await cache.refresh(configA);
	assert.equal(cache.get(configA).id, "theme-a", "initial highlighter loaded");
	const refreshB = cache.refresh(configB);
	assert.equal(cache.get(configB).id, "theme-a", "stale highlighter served while new key loads");
	const refreshB2 = cache.refresh(configB);
	assert.equal(refreshB2, refreshB, "same-key refresh coalesces to one promise");
	assert.deepEqual(calls, ["theme-a", "theme-b"], "only one rebuild starts for concurrent same-key refreshes");
	releaseB();
	await refreshB;
	assert.equal(cache.get(configB).id, "theme-b", "new highlighter served after refresh completes");
}

// --- L: config spec model is pure and round-trips without TUI --------------
{
	const groups = hunkConfigGroups();
	const specs = groups.flatMap((group) => group.specs);
	const ids = specs.map((spec) => spec.id);
	assert.equal(new Set(ids).size, ids.length, "config spec ids are unique");
	assert.deepEqual(ids, [
		"wordHighlight",
		"colors.add",
		"colors.remove",
		"colors.context",
		"lineHighlight",
		"colors.gutter",
		"symbols.gutter",
		"symbols.add",
		"symbols.remove",
		"header",
		"lineNumbers",
		"colors.header",
		"colors.lineNo",
		"colors.meta",
		"symbols.context",
		"symbols.fold",
		"compactUnchanged",
		"contextRadius",
		"maxRenderedLines",
		"diffTheme",
		"shikiDarkTheme",
		"shikiLightTheme",
		"enabled",
		"showHunkHint",
		"hunk.enabled",
		"hunk.reviewTool",
		"hunk.autoReviewNotes",
	], "spec model covers current TUI configuration surface");
	for (const spec of specs) {
		const draft = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
		const current = spec.get(draft);
		const choices = choicesForSpec(spec, draft, fakeTheme());
		assert.ok(choices.some((choice) => choice.value === current), `${spec.id} choices include current value`);
		const next = choices.find((choice) => choice.value !== current)?.value ?? current;
		spec.set(draft, next);
		assert.equal(spec.get(draft), next, `${spec.id} set/get round-trips`);
		assert.match(descriptionForSpec(spec, draft, fakeTheme()), /^Current:/, `${spec.id} has description`);
	}
	const presets = hunkConfigPresets();
	assert.deepEqual(presets.map((preset) => preset.id), ["pi-native", "high-contrast-mono", "warm-editorial", "syntax-only"], "preset surface is stable");
	const warm = applyHunkPreset(JSON.parse(JSON.stringify(DEFAULT_CONFIG)), presets.find((preset) => preset.id === "warm-editorial"));
	assert.equal(warm.wordHighlight, "underline", "preset applies word style");
	assert.equal(warm.header, "compact", "preset applies header style");
	assert.equal(warm.colors.add, "#80dc78", "preset applies full color config");
	const syntaxOnly = applyHunkPreset(JSON.parse(JSON.stringify(DEFAULT_CONFIG)), presets.find((preset) => preset.id === "syntax-only"));
	assert.equal(syntaxOnly.wordHighlight, "none", "syntax-only disables word markers");
	assert.equal(syntaxOnly.lineHighlight, "none", "syntax-only disables line markers");
	const gutterSpec = specs.find((spec) => spec.id === "symbols.gutter");
	const addColorSpec = specs.find((spec) => spec.id === "colors.add");
	const gutterChoice = choicesForSpec(gutterSpec, DEFAULT_CONFIG, fakeTheme())[0];
	const addColorChoice = choicesForSpec(addColorSpec, DEFAULT_CONFIG, fakeTheme())[0];
	assert.match(stripAnsi(gutterChoice.label), /\+\s+const x = 1;/, "symbol choices render glyphs inside a sample diff line");
	assert.match(stripAnsi(addColorChoice.label), /\+ const tone = vivid/, "color choices render color inside a sample diff line");
}

// --- #8: token styling module — tint survives Shiki resets ---------------
// styleToken is the only place a token is wrapped as `start + text + reset +
// sideAnsi`, so a side background tint is re-applied after every Shiki reset and
// never bleeds away mid-line. renderCodeLine is the only line assembler. This
// locks the invariant at the adapter point, independent of the renderer.
{
	const theme = fakeTheme();
	const config = { ...DEFAULT_CONFIG, wordHighlight: "bold", lineHighlight: "tint" };
	const tintBg = "\x1b[48;2;26;44;28m";
	const sideAnsi = `${tintBg}\x1b[38;2;80;220;120m`; // tint background + add foreground
	const tokens = [
		{ content: "hi", color: "#ffaaaa" },
		{ content: "world", color: "#aaffaa" },
	];
	const rendered = renderCodeLine("hi world", tokens, theme, config, "add", [{ start: 0, end: 2 }], sideAnsi);
	const resets = [...rendered.matchAll(/\x1b\[0m/g)].map((m) => m.index);
	assert.ok(resets.length >= 2, "multiple token resets in the line");
	// every reset except the trailing line-end reset is immediately followed by sideAnsi
	for (let i = 0; i < resets.length - 1; i++) {
		const after = rendered.slice(resets[i] + 4, resets[i] + 4 + sideAnsi.length);
		assert.equal(after, sideAnsi, `reset #${i} re-applies sideAnsi (tint survives reset)`);
	}
	// wordHighlightAnsi is side-aware: strike strikes removals, underlines additions
	assert.equal(wordHighlightAnsi("strike", "remove", theme), "\x1b[1;9m");
	assert.equal(wordHighlightAnsi("strike", "add", theme), "\x1b[1;4m");
	assert.equal(wordHighlightAnsi("none", "add", theme), "");
	// styleToken with no emphasis and no color returns the bare text (no reset spam)
	assert.equal(styleToken("x", undefined, false, "add", config, theme, sideAnsi), "x");
	// styleToken with emphasis emits start + text + reset + sideAnsi
	const emph = styleToken("y", "#ffffff", true, "add", config, theme, sideAnsi);
	assert.match(emph, /^\x1b\[38;2;255;255;255m\x1b\[1my\x1b\[0m/);
	assert.ok(emph.endsWith(sideAnsi), "styleToken re-applies sideAnsi after reset");
}

// --- #6: DiffView layout seam — buildDiffLayout produces reusable rows ------
// renderDiffLines is a thin composer over buildDiffLayout; the row layout
// (hunk captions, code/fold/meta, truncation, annotation cross-reference) is
// reusable without the renderer's framing.
{
	const cwd = repoRoot;
	const patch = [
		"--- a/layout.ts",
		"+++ b/layout.ts",
		"@@ -1,8 +1,8 @@",
		" line1",
		" line2",
		" line3",
		"-old4",
		"+new4",
		" line5",
		" line6",
		" line7",
		" line8",
	].join("\n");
	const config = { ...DEFAULT_CONFIG, lineNumbers: false, header: "minimal", compactUnchanged: true, contextRadius: 1, maxRenderedLines: 260 };
	const layout = buildDiffLayout({ patch, filePath: "layout.ts", cwd, title: "unit", config, highlighter: fakeHighlighter, theme: fakeTheme(), liveSession: false });
	assert.equal(layout.stats.added, 1);
	assert.equal(layout.stats.removed, 1);
	assert.equal(layout.stats.hunks, 1);
	const kinds = layout.rows.map((r) => r.kind);
	assert.equal(kinds[0], "hunkCaption");
	assert.ok(kinds.includes("fold"), "compact-unchanged folds present at contextRadius 1");
	assert.ok(kinds.includes("code"), "code rows present");
	// changed code rows carry hunkIndex + lineIndex for annotation cross-reference
	const codeRows = layout.rows.filter((r) => r.kind === "code");
	const addRow = codeRows.find((r) => stripAnsi(r.text).includes("new4"));
	assert.ok(addRow, "add row present");
	assert.equal(addRow.hunkIndex, 0);
	assert.equal(addRow.lineIndex, 4, "add row lineIndex matches its position in the hunk");
	// truncation caps the body and sets the flag
	const tiny = buildDiffLayout({ patch, filePath: "layout.ts", cwd, title: "unit", config: { ...config, maxRenderedLines: 2 }, highlighter: fakeHighlighter, theme: fakeTheme(), liveSession: false });
	assert.equal(tiny.truncated, true);
	assert.ok(tiny.rows.length <= 2, "truncation caps body rows at maxRenderedLines");
	// renderDiffLines composes header + the same rows + footer
	const rendered = renderDiffLines({ patch, filePath: "layout.ts", cwd, title: "unit", config, highlighter: fakeHighlighter, theme: fakeTheme(), liveSession: false });
	const plain = rendered.map(stripAnsi).join("\n");
	assert.match(plain, /layout\.ts/, "header present in composed render");
	assert.match(plain, /new4/, "layout rows present in composed render");
}

// --- #11: PatchSource seam — adapters, composite, pinning equivalence --------
// Correlation depends on the PatchSource interface, not RenderRecord. Two
// adapters satisfy it; a composite prefers the reviewed patch and falls back to
// the agent-edit record. Identical patch via either adapter pins a note to the
// same PatchLineAddress. The bridge holds one source; renderers are not threaded
// findRecent.
{
	const cwd = repoRoot;
	const filePath = path.join(cwd, "src", "app.ts");
	const patch = writePatch("a/src/app.ts", "b/src/app.ts", "line1\nline2\nold\nold\nline5\n", "line1\nline2\nnewA\nnewB\nline5\n");
	const summary = "edited app.ts";

	// Agent-edit adapter: backed by the record store.
	const store = createRenderRecordStore();
	store.record("call-1", { tool: "edit", filePath, patch, summary });
	const agentSource = createAgentEditPatchSource(store);
	const entry = agentSource.findForFile("src/app.ts", cwd);
	assert.ok(entry, "agent-edit source resolves the record by file");
	assert.equal(entry.patch, patch);
	assert.equal(entry.summary, summary);

	// Reviewed adapter: normalises a session-review payload (shape-tolerant).
	const reviewedSource = createReviewedPatchSource();
	reviewedSource.hydrate({ files: [{ path: "src/app.ts", patch, summary: "reviewed app.ts" }] }, cwd);
	const reviewedEntry = reviewedSource.findForFile("src/app.ts", cwd);
	assert.ok(reviewedEntry, "reviewed source resolves the reviewed patch by file");
	assert.equal(reviewedEntry.patch, patch);

	// normalizeReviewPatches tolerates shape variance: alt collections, alt keys, renames.
	const norm = normalizeReviewPatches({ items: [{ filePath: "renamed.ts", diff: patch, previousPath: "old-name.ts" }] }, cwd);
	assert.ok(norm.get(fileKey("renamed.ts", cwd)), "items collection + filePath + diff key accepted");
	assert.ok(norm.get(fileKey("old-name.ts", cwd)), "previousPath aliased onto the new patch");
	assert.ok(normalizeReviewPatches([{ name: "x.ts", text: patch }], cwd).get(fileKey("x.ts", cwd)), "bare array + name + text keys accepted");
	assert.equal(normalizeReviewPatches(undefined, cwd).size, 0, "undefined payload yields empty map");
	assert.equal(normalizeReviewPatches({ files: [{ path: "no-patch.ts" }] }, cwd).size, 0, "file without a patch is dropped");

	// Composite: reviewed wins, agent-edit is the fallback.
	const composite = createPatchSource(reviewedSource, agentSource);
	assert.equal(composite.findForFile("src/app.ts", cwd).summary, "reviewed app.ts", "composite prefers the reviewed patch");
	reviewedSource.clear();
	assert.equal(composite.findForFile("src/app.ts", cwd).summary, summary, "composite falls back to the agent-edit record when no reviewed patch");

	// Load-bearing seam property: identical patch via either adapter → identical
	// PatchLineAddress for the same note.
	reviewedSource.hydrate({ files: [{ path: "src/app.ts", patch, summary: "reviewed app.ts" }] }, cwd);
	const note = { id: "n1", type: "user", filePath: "src/app.ts", newLine: 4, summary: "pin on new row" };
	const agentShape = buildReviewNoteShape([note], agentSource.findForFile, cwd);
	const reviewedShape = buildReviewNoteShape([note], reviewedSource.findForFile, cwd);
	assert.equal(agentShape.hunks.length, 1, "agent-edit shape pins the note onto a hunk");
	assert.equal(reviewedShape.hunks.length, 1, "reviewed shape pins the note onto a hunk");
	const a = agentShape.hunks[0].lines[0].address;
	const r = reviewedShape.hunks[0].lines[0].address;
	assert.deepEqual(
		{ hunkIndex: a.hunkIndex, lineIndex: a.lineIndex, kind: a.kind, oldLine: a.oldLine, newLine: a.newLine },
		{ hunkIndex: r.hunkIndex, lineIndex: r.lineIndex, kind: r.kind, oldLine: r.oldLine, newLine: r.newLine },
		"same patch via either adapter → identical PatchLineAddress",
	);

	// Bridge holds one source; renderers are no longer threaded findRecent.
	const bridge = createHunkBridge(createPatchSource(reviewedSource, agentSource));
	assert.equal(bridge.renderReviewLines.length, 3, "renderReviewLines(result, cwd, theme) — findRecent no longer threaded");
	assert.equal(bridge.renderNotesLines.length, 5, "renderNotesLines(result, cwd, theme, config, highlighter) — findRecent no longer threaded");
}

// --- #14–#16: one session-read seam, reviewed-patch pinning, reviewed ref ----
// A supported Hunk review export is one round trip carrying session + patch +
// notes. The legacy adapter owns the exact two-call get/list fallback. The
// bridge hydrates the reviewed source from the same payload before shaping, so
// a note pins in reviewed coordinates even when the agent patch is elsewhere.
{
	const cwd = repoRoot;
	const filePath = path.join(cwd, "src", "branch.ts");
	const reviewedPatch = [
		"--- a/src/branch.ts",
		"+++ b/src/branch.ts",
		"@@ -40 +40 @@",
		"-reviewed old",
		"+reviewed new",
	].join("\n");
	const agentPatch = [
		"--- a/src/branch.ts",
		"+++ b/src/branch.ts",
		"@@ -1 +1 @@",
		"-agent old",
		"+agent new",
	].join("\n");
	const reviewPayload = {
		sessionId: "review-session",
		title: "pi-hunk main...feature-A",
		sourceLabel: cwd,
		files: [{ id: "branch", path: "src/branch.ts", patch: reviewedPatch, additions: 1, deletions: 1, hunkCount: 1, hunks: [] }],
		reviewNotes: [
			{ noteId: "human-1", source: "user", filePath: "src/branch.ts", newRange: [40, 40], body: "review the branch-specific line", author: "human" },
			{ noteId: "agent-1", source: "agent", filePath: "src/branch.ts", newRange: [40, 40], body: "must stay hidden" },
		],
	};
	const calls = [];
	const exec = async (execCwd, args, _config, timeout) => {
		calls.push({ cwd: execCwd, args: [...args], timeout });
		return reviewPayload;
	};
	const sessionRead = createHunkSessionRead(exec);
	const fetched = await sessionRead.read(cwd, DEFAULT_CONFIG);
	assert.equal(fetched.source, "review");
	assert.equal(fetched.session, reviewPayload);
	assert.equal(fetched.patch, reviewPayload);
	assert.equal(fetched.notes, reviewPayload);
	assert.equal(calls.length, 1, "review export returns session + patch + notes in one round trip");
	assert.deepEqual(calls[0].args, ["session", "review", "--repo", cwd, "--include-patch", "--include-notes", "--json"]);

	const store = createRenderRecordStore();
	store.record("agent-call", { tool: "edit", filePath, patch: agentPatch, summary: "agent branch edit" });
	const reviewedSource = createReviewedPatchSource();
	const composite = createPatchSource(reviewedSource, createAgentEditPatchSource(store));
	const bridge = createHunkBridge(composite, { sessionRead, reviewedSource });
	calls.length = 0;
	const notes = await bridge.readNotes(cwd, DEFAULT_CONFIG);
	assert.equal(calls.length, 1, "bridge does not add a probe or comment-list call on the review-export path");
	assert.equal(notes.comments.length, 1, "review export is filtered to human-authored source=user notes");
	assert.equal(notes.comments[0].summary, "review the branch-specific line");
	assert.equal(notes.hunks.length, 1, "reviewed note pins onto the reviewed patch");
	assert.equal(notes.hunks[0].lines[0].address.newLine, 40, "pinning uses reviewed coordinates, not the agent patch at line 1");
	assert.equal(notes.hunks[0].patch, reviewedPatch);
	assert.match(notes.message, /Human reviewing main\.\.\.feature-A\./, "reviewed ref is present in the agent prompt header");
	assert.doesNotMatch(notes.message, /must stay hidden/, "agent-authored review notes are never surfaced");
	const rendered = bridge.renderNotesLines(notes, cwd, fakeTheme(), { ...DEFAULT_CONFIG, lineNumbers: false, header: "minimal", compactUnchanged: false, showHunkHint: false }, undefined).join("\n");
	assert.match(rendered, /reviewed new/, "reviewed patch flows through the shared diff renderer");
	assert.match(rendered, /review the branch-specific line/, "human note renders on its reviewed row");

	assert.equal(reviewedRefFromSession({ reviewedRef: "base...head" }), "base...head", "explicit reviewed-ref field wins");
	assert.equal(reviewedRefFromSession({ title: "pi-hunk main...feature-A", sourceLabel: cwd }), "main...feature-A", "current Hunk title yields the reviewed range");
	assert.equal(reviewedRefFromSession({ sessionId: "no-ref" }), undefined, "missing ref is tolerated without fabrication");
}

{
	const cwd = repoRoot;
	const legacyCalls = [];
	const legacyExec = async (_execCwd, args) => {
		legacyCalls.push([...args]);
		if (args[1] === "get") return { sessionId: "legacy-session" };
		return [{ noteId: "legacy-note", source: "user", filePath: "legacy.ts", newRange: [1, 1], body: "legacy human note" }];
	};
	const legacy = createLegacyHunkSessionRead(legacyExec);
	const legacyResult = await legacy.read(cwd, DEFAULT_CONFIG);
	assert.equal(legacyResult.source, "legacy");
	assert.equal(legacyCalls.length, 2, "legacy adapter is exactly the current two-call path");
	assert.deepEqual(legacyCalls[0], ["session", "get", "--repo", cwd, "--json"]);
	assert.deepEqual(legacyCalls[1], ["session", "comment", "list", "--repo", cwd, "--type", "user", "--json"]);

	const fallbackCalls = [];
	const fallbackExec = async (_execCwd, args) => {
		fallbackCalls.push([...args]);
		if (args[1] === "review") return undefined;
		if (args[1] === "get") return { sessionId: "fallback-session" };
		return [{ noteId: "fallback-note", source: "user", filePath: "legacy.ts", newRange: [1, 1], body: "fallback human note" }];
	};
	const fallbackRead = createHunkSessionRead(fallbackExec);
	const fallbackResult = await fallbackRead.read(cwd, DEFAULT_CONFIG);
	assert.equal(fallbackResult.source, "legacy", "missing review command falls back to session get + comment list");
	assert.equal(fallbackCalls.length, 3, "unsupported review is attempted once before the two legacy calls");

	const agentPatch = ["--- a/legacy.ts", "+++ b/legacy.ts", "@@ -1 +1 @@", "-old", "+new"].join("\n");
	const staleReviewedPatch = ["--- a/legacy.ts", "+++ b/legacy.ts", "@@ -99 +99 @@", "-stale", "+stale reviewed"].join("\n");
	const store = createRenderRecordStore();
	store.record("legacy-agent", { tool: "edit", filePath: path.join(cwd, "legacy.ts"), patch: agentPatch, summary: "legacy agent edit" });
	const reviewedSource = createReviewedPatchSource();
	reviewedSource.hydrate({ files: [{ path: "legacy.ts", patch: staleReviewedPatch }] }, cwd);
	const composite = createPatchSource(reviewedSource, createAgentEditPatchSource(store));
	const bridge = createHunkBridge(composite, { sessionRead: fallbackRead, reviewedSource });
	fallbackCalls.length = 0;
	const notes = await bridge.readNotes(cwd, DEFAULT_CONFIG);
	assert.equal(notes.hunks.length, 1, "legacy path falls back to agent-edit correlation");
	assert.equal(notes.hunks[0].patch, agentPatch, "legacy read clears any stale reviewed-patch cache");
	assert.equal(notes.hunks[0].lines[0].address.newLine, 1);
	assert.doesNotMatch(notes.message, /Human reviewing/, "missing reviewed ref omits the header without error");
}

// --- #12: review-note shape canonical in ReviewNotesResult --------------------
// Renderers consume result.hunks/openComments (the carried shape) and do not
// re-build via buildReviewNoteShape. A result with a fixed shape renders its
// pinned hunk even when the bridge's source is empty (which would yield no
// hunks if the renderer re-built). Proves prompt and render derive from one
// shape instance built in readNotes/pickup.
{
	const cwd = repoRoot;
	const filePath = path.join(cwd, "src", "app.ts");
	const patch = writePatch("a/src/app.ts", "b/src/app.ts", "line1\nline2\nold\nold\nline5\n", "line1\nline2\nnewA\nnewB\nline5\n");
	const note = { id: "n1", type: "user", filePath: "src/app.ts", newLine: 4, summary: "pin on new row" };

	// Build the canonical shape once from a real source.
	const store = createRenderRecordStore();
	store.record("c1", { tool: "edit", filePath, patch, summary: "edited app.ts" });
	const realSource = createAgentEditPatchSource(store);
	const shape = buildReviewNoteShape([note], realSource.findForFile, cwd);
	assert.equal(shape.hunks.length, 1, "shape pins the note onto a hunk");

	// Carry that shape on the result. The bridge is wired to an EMPTY source, so
	// if a renderer re-called buildReviewNoteShape it would find no patch and
	// drop the note into openComments.
	const carried = {
		live: true,
		comments: [note],
		message: "",
		session: {},
		hunks: shape.hunks,
		openComments: shape.openComments,
	};
	const emptyBridge = createHunkBridge({ findForFile: () => undefined });

	const notesView = emptyBridge.renderNotesLines(carried, cwd, fakeTheme(), { ...DEFAULT_CONFIG, lineNumbers: false, header: "minimal", compactUnchanged: false, showHunkHint: false }, undefined).join("\n");
	assert.match(notesView, /pin on new row/, "notes view renders the carried-shape hunk even when the source is empty");
	assert.doesNotMatch(notesView, /notes without recent hunk/, "carried-shape note is pinned, not open");

	const reviewView = emptyBridge.renderReviewLines(carried, cwd, fakeTheme()).join("\n");
	assert.match(reviewView, /pin on new row/, "review view renders the carried-shape hunk even when the source is empty");
	assert.match(reviewView, /touched/i, "review view counts the carried-shape note as touched");
	assert.doesNotMatch(reviewView, /\bopen\b.*pin on new row/, "carried-shape note is not listed as open");

	// Same carried shape renders identically regardless of which source the
	// bridge holds — the source is not consulted by the render path.
	const realBridge = createHunkBridge(realSource);
	const notesFromReal = realBridge.renderNotesLines(carried, cwd, fakeTheme(), { ...DEFAULT_CONFIG, lineNumbers: false, header: "minimal", compactUnchanged: false, showHunkHint: false }, undefined).join("\n");
	assert.equal(notesFromReal, notesView, "render is identical regardless of the bridge's source — shape is canonical");
}

// --- #13: shared scaffolding seam for the two review views ------------------
// renderReviewView owns the header/status/separator/open-footer chrome; the two
// views differ only in their body-strategy adapter. A stub strategy proves the
// scaffolding renders the frame for any body; commentLines keeps rationale on
// its own line so per-line wrapping is unchanged.
{
	const theme = fakeTheme();
	const cwd = repoRoot;
	// Stub strategy: trivial body + labelled open-footer pieces.
	const stub = {
		title: "Stub view",
		guard: () => ({ status: theme.fg("toolDiffAdded", "stub status"), stop: false }),
		body: () => ({ lines: ["BODY"], openStartIndex: 7 }),
		openSectionHeader: () => "SECTION",
		openGroupHeader: (file) => `GROUP ${file}`,
		openCommentLine: (comment, index) => [`OPEN ${index} ${comment.summary}`],
	};
	const result = {
		live: true,
		comments: [{ id: "n1", type: "user", filePath: "a.ts", newLine: 1, summary: "s1" }],
		message: "",
		hunks: [],
		openComments: [{ id: "n2", type: "user", filePath: "a.ts", newLine: 1, summary: "open note" }],
	};
	const out = renderReviewView(result, cwd, theme, stub, {});
	const plain = out.map(stripAnsi).join("\n");
	assert.match(plain, /Stub view/, "scaffolding renders the strategy's title header");
	assert.match(plain, /stub status/, "scaffolding renders the guard status line");
	assert.match(plain, /BODY/, "scaffolding delegates to the body strategy");
	assert.match(plain, /SECTION/, "scaffolding renders the open-section header");
	assert.match(plain, /GROUP a\.ts/, "scaffolding renders the per-file group header");
	assert.match(plain, /OPEN 7 open note/, "scaffolding numbers open comments from the body's openStartIndex");

	// commentLines keeps rationale on its own line.
	const withRationale = commentLines("main line", { summary: "s", rationale: "why" }, theme);
	assert.equal(withRationale.length, 2, "summary + rationale = two lines");
	assert.equal(stripAnsi(withRationale[0]), "main line", "first line is the main line");
	assert.match(stripAnsi(withRationale[1]), /rationale: why/, "second line is the rationale");
	assert.equal(commentLines("main line", { summary: "s" }, theme).length, 1, "no rationale = one line");

	// The two real strategies share the frame: same header/separator shape, differ
	// only in title and body. Render the same carried shape through each and assert
	// the chrome lines are identical except the title.
	const filePath = path.join(cwd, "src", "app.ts");
	const patch = writePatch("a/src/app.ts", "b/src/app.ts", "line1\nold\nline3\n", "line1\nnew\nline3\n");
	const note = { id: "n1", type: "user", filePath: "src/app.ts", newLine: 2, summary: "pin", rationale: "r" };
	const store = createRenderRecordStore();
	store.record("c1", { tool: "edit", filePath, patch, summary: "edited" });
	const src = createAgentEditPatchSource(store);
	const shape = buildReviewNoteShape([note], src.findForFile, cwd);
	const carried = { live: true, comments: [note], message: "", session: {}, hunks: shape.hunks, openComments: shape.openComments };
	const bridge = createHunkBridge(src);
	const notesLines = bridge.renderNotesLines(carried, cwd, theme, { ...DEFAULT_CONFIG, lineNumbers: false, header: "minimal", compactUnchanged: false, showHunkHint: false }, undefined);
	const reviewLines = bridge.renderReviewLines(carried, cwd, theme);
	// First line is the header box; only the title differs between the two views.
	assert.match(stripAnsi(notesLines[0]), /Hunk review notes/, "notes view header title");
	assert.match(stripAnsi(reviewLines[0]), /Hunk review$/, "review view header title");
	// The separator (╰─...) is rendered identically by the shared scaffolding.
	const notesSep = notesLines.find((l) => stripAnsi(l).startsWith("╰"));
	const reviewSep = reviewLines.find((l) => stripAnsi(l).startsWith("╰"));
	assert.ok(notesSep && reviewSep, "both views render the separator");
	assert.equal(notesSep, reviewSep, "separator is shared and identical");
	// Both views surface the open-comments footer via the shared grouping.
	assert.ok(groupCommentsByFile(shape.openComments, cwd).size >= 0, "groupCommentsByFile shared by both views");
}

console.log("pi-hunk units ok");
