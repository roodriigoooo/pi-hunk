import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createHighlighter } from "shiki";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
function findPiPackageRoot() {
	for (const candidate of [process.env.PI_CODING_AGENT_ROOT, path.join(repoRoot, "node_modules", "@earendil-works", "pi-coding-agent"), "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent", "/usr/local/lib/node_modules/@earendil-works/pi-coding-agent", path.join(os.homedir(), ".pi", "agent", "npm", "node_modules", "@earendil-works", "pi-coding-agent")].filter(Boolean)) {
		if (existsSync(path.join(candidate, "package.json"))) return candidate;
	}
	throw new Error("Could not locate @earendil-works/pi-coding-agent.");
}
const piRoot = findPiPackageRoot();
const requireFromPi = createRequire(path.join(piRoot, "package.json"));
const jiti = requireFromPi("jiti")(import.meta.url, {
	interopDefault: true,
	moduleCache: false,
	fsCache: false,
	alias: {
		"@earendil-works/pi-coding-agent": path.join(piRoot, "dist", "index.js"),
		"@earendil-works/pi-tui": path.join(piRoot, "node_modules", "@earendil-works", "pi-tui", "dist", "index.js"),
		typebox: path.join(piRoot, "node_modules", "typebox", "build", "index.mjs"),
	},
});
const { DEFAULT_CONFIG, TOKENIZE_MAX_LINE_LENGTH, TOKENIZE_TIME_LIMIT_MS, ansiFg } = await jiti.import(path.join(repoRoot, "src/config.ts"), { default: false });
const { parseUnifiedPatch, renderDiffLines, patchLineAddressKey, findPatchLineAddress, buildDiffLayout } = await jiti.import(path.join(repoRoot, "src/diff-view.ts"), { default: false });
const { applyHunkPreset, choicesForSpec, descriptionForSpec, hunkConfigGroups, hunkConfigPresets } = await jiti.import(path.join(repoRoot, "src/config-spec.ts"), { default: false });
const { createHighlighterCache } = await jiti.import(path.join(repoRoot, "src/highlighter-cache.ts"), { default: false });
const { renderCodeLine, styleToken, wordHighlightAnsi } = await jiti.import(path.join(repoRoot, "src/styling.ts"), { default: false });
const { normalizeReviewExport, patchDigest, sameSnapshot } = await jiti.import(path.join(repoRoot, "src/review-export.ts"), { default: false });
const { createChangesetBaseline, changesetDigest, compareGitFingerprint, compareHunkFingerprint, gitFingerprint, isDefaultGitWorkingTreeReview } = await jiti.import(path.join(repoRoot, "src/changeset.ts"), { default: false });
const { createGitChangesetAdapter } = await jiti.import(path.join(repoRoot, "src/git-changeset.ts"), { default: false });
const { presentHunk } = await jiti.import(path.join(repoRoot, "src/hunk-presentation.ts"), { default: false });
const { createCheckpointStore } = await jiti.import(path.join(repoRoot, "src/checkpoint-store.ts"), { default: false });
const { createHunkSessionClient } = await jiti.import(path.join(repoRoot, "src/hunk-session-client.ts"), { default: false });
const { createSamplingLease, handoffToSpawnedHunk } = await jiti.import(path.join(repoRoot, "src/hunk-handoff.ts"), { default: false });
const { createReviewCoordinator } = await jiti.import(path.join(repoRoot, "src/review-coordinator.ts"), { default: false });

function fakeTheme() {
	const colors = {
		accent: "\x1b[38;2;255;190;106m",
		borderMuted: "\x1b[38;2;90;90;90m",
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
		fg(name, text) { return `${colors[name] ?? ""}${text}\x1b[0m`; },
		getFgAnsi(name) { return colors[name] ?? ""; },
		bold(text) { return `\x1b[1m${text}\x1b[22m`; },
	};
}
const fakeHighlighter = { codeToTokensBase: (code) => code.split("\n").map((line) => [{ content: line, color: "#ffffff" }]) };
function stripAnsi(value) { return value.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, ""); }
const patchA = ["--- a/a.ts", "+++ b/a.ts", "@@ -1,1 +1,1 @@", "-old", "+new"].join("\n");
const patchB = ["--- a/b.ts", "+++ b/b.ts", "@@ -2,1 +2,1 @@", "-before", "+after"].join("\n");

function review({ notes = [{ source: "user", filePath: "a.ts", newRange: [1, 1], hunk: 1, body: "keep\nexact body", author: "human", createdAt: "2026-01-01T00:00:00.000Z" }], firstPatch = patchA } = {}) {
	return {
		sessionId: "session-1",
		title: "pi-hunk main...topic",
		sourceLabel: "/pi-hunk",
		repoRoot: "/pi-hunk",
		inputKind: "vcs",
		files: [
			{ id: "file-a", path: "a.ts", patch: firstPatch, additions: 1, deletions: 1, hunkCount: 1, hunks: [{ oldStart: 1, newStart: 1 }] },
			{ path: "b.ts", previousPath: "old-b.ts", patch: patchB, additions: 1, deletions: 1, hunkCount: 1, hunks: [{ oldStart: 2, newStart: 2 }] },
		],
		reviewNotes: notes,
	};
}

// Diff renderer remains generic; checkpoint code adds no review renderer.
{
	const parsed = parseUnifiedPatch(patchA);
	const address = findPatchLineAddress(parsed, { filePath: "a.ts", newLine: 1 }, repoRoot);
	assert.ok(address);
	const lines = renderDiffLines({ patch: patchA, filePath: "a.ts", cwd: repoRoot, title: "unit", config: { ...DEFAULT_CONFIG, lineNumbers: false, compactUnchanged: false }, highlighter: fakeHighlighter, theme: fakeTheme(), annotations: new Map([[patchLineAddressKey(address), [{ text: "generic annotation" }]]]) });
	assert.ok(lines.join("\n").includes("generic annotation"));
}

// Preserve the renderer's structural, word-emphasis, and annotation regressions.
{
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
	assert.deepEqual(hunk.lines.map((line) => line.kind), ["context", "remove", "add", "context"]);
	const removed = hunk.lines.find((line) => line.kind === "remove");
	const added = hunk.lines.find((line) => line.kind === "add");
	assert.equal(removed.oldLine, 2);
	assert.equal(added.newLine, 2);
	assert.ok(removed.removeRanges?.length && added.addRanges?.length, "paired word ranges computed");
	assert.equal(parseUnifiedPatch(`${patch}\n`).hunks[0].lines.length, hunk.lines.length, "no phantom trailing row");

	const address = findPatchLineAddress(parsed, { filePath: "a.ts", newLine: 2 }, repoRoot);
	assert.ok(address && address.kind === "add");
	const annotated = renderDiffLines({
		patch,
		filePath: "a.ts",
		cwd: repoRoot,
		title: "unit",
		config: { ...DEFAULT_CONFIG, lineNumbers: false, header: "minimal", compactUnchanged: false },
		highlighter: fakeHighlighter,
		theme: fakeTheme(),
		annotations: new Map([[patchLineAddressKey(address), [{ text: "tighten greeting", detail: "human rationale", author: "human" }]]]),
	});
	assert.match(stripAnsi(annotated.find((line) => stripAnsi(line).includes("tighten greeting"))), /hi.*note human: tighten greeting \(human rationale\)/);

	const struck = renderDiffLines({ patch, filePath: "a.ts", cwd: repoRoot, title: "unit", config: { ...DEFAULT_CONFIG, wordHighlight: "strike", lineHighlight: "tint" }, highlighter: fakeHighlighter, theme: fakeTheme() });
	const removedLine = struck.find((line) => stripAnsi(line).includes("hello"));
	const addedLine = struck.find((line) => stripAnsi(line).includes("hi"));
	assert.match(removedLine, /\x1b\[1;9m/, "removed words strike");
	assert.match(addedLine, /\x1b\[1;4m/, "added words underline in strike mode");
	assert.ok((addedLine.match(/\x1b\[48;2;26;44;28m/g) ?? []).length > 2, "tint survives token resets");
}

// Whole-hunk grammar state must survive across multiline syntax.
{
	const highlighter = await createHighlighter({ themes: ["github-dark"], langs: ["typescript"] });
	const patch = [
		"--- a/code.ts",
		"+++ b/code.ts",
		"@@ -1,4 +1,4 @@",
		" const a = 1;",
		"-const msg = `hello ${name}",
		"+const msg = `hi ${name}",
		"   world`;",
		" const b = 2;",
	].join("\n");
	const fullNew = ["const a = 1;", "const msg = `hi ${name}", "   world`;", "const b = 2;"].join("\n");
	const fullTokens = highlighter.codeToTokensBase(fullNew, { lang: "typescript", theme: "github-dark" });
	const expectedAnsi = ansiFg(fullTokens[2].find((token) => token.content.includes("world"))?.color);
	const isolatedAnsi = ansiFg(highlighter.codeToTokensBase("   world`;", { lang: "typescript", theme: "github-dark" })[0].find((token) => token.content.includes("world"))?.color);
	assert.ok(expectedAnsi && expectedAnsi !== isolatedAnsi, "fixture distinguishes full-side grammar state");
	const rendered = renderDiffLines({ patch, filePath: "code.ts", cwd: repoRoot, title: "unit", config: { ...DEFAULT_CONFIG, wordHighlight: "none", lineHighlight: "none", lineNumbers: false, header: "minimal", compactUnchanged: false }, highlighter, theme: fakeTheme() });
	const worldLine = rendered.find((line) => stripAnsi(line).includes("world"));
	assert.ok(worldLine?.includes(expectedAnsi));
	assert.ok(!worldLine?.includes(isolatedAnsi));
	await highlighter.dispose();
}

// Lazy grammar loading and Shiki guardrails remain covered.
{
	let invalidated = false;
	const highlighter = await createHighlighter({ themes: ["github-dark"], langs: ["typescript"] });
	const patch = "--- a/Main.hs\n+++ b/Main.hs\n@@ -1,1 +1,1 @@\n-main = putStrLn \"old\"\n+main = putStrLn \"new\"";
	const first = renderDiffLines({ patch, filePath: "Main.hs", cwd: repoRoot, title: "unit", config: { ...DEFAULT_CONFIG, wordHighlight: "none", lineHighlight: "none", lineNumbers: false, header: "minimal", compactUnchanged: false }, highlighter, theme: fakeTheme(), invalidate: () => (invalidated = true) });
	assert.ok(first.some((line) => stripAnsi(line).includes("putStrLn")));
	for (let i = 0; i < 40 && !highlighter.getLoadedLanguages().includes("haskell"); i++) await new Promise((resolve) => setTimeout(resolve, 25));
	assert.ok(highlighter.getLoadedLanguages().includes("haskell"));
	assert.equal(invalidated, true);
	await highlighter.dispose();

	let calls = 0;
	const guarded = {
		codeToTokensBase(_code, options) {
			calls++;
			assert.equal(options.tokenizeMaxLineLength, TOKENIZE_MAX_LINE_LENGTH);
			assert.equal(options.tokenizeTimeLimit, TOKENIZE_TIME_LIMIT_MS);
			return [[{ content: "const ok = true;", color: "#ffffff" }]];
		},
	};
	renderDiffLines({ patch: "--- a/a.ts\n+++ b/a.ts\n@@ -1,1 +1,1 @@\n-const ok = false;\n+const ok = true;", filePath: "a.ts", cwd: repoRoot, title: "unit", config: { ...DEFAULT_CONFIG, compactUnchanged: false }, highlighter: guarded, theme: fakeTheme() });
	assert.equal(calls, 2);
	const longLine = "x".repeat(TOKENIZE_MAX_LINE_LENGTH + 1);
	renderDiffLines({ patch: `--- a/a.ts\n+++ b/a.ts\n@@ -1,1 +1,1 @@\n-${longLine}\n+${longLine}`, filePath: "a.ts", cwd: repoRoot, title: "unit", config: { ...DEFAULT_CONFIG, compactUnchanged: false }, highlighter: guarded, theme: fakeTheme() });
	assert.equal(calls, 2, "oversized rows bypass tokenization");
}

// UTF-16 range accounting must not bleed emphasis past emoji or CJK changes.
for (const [filePath, changed] of [["emoji.ts", "🎉"], ["cjk.ts", "巴"]]) {
	const patch = `--- a/${filePath}\n+++ b/${filePath}\n@@ -1,1 +1,1 @@\n-a c\n+a${changed}c`;
	const rendered = renderDiffLines({ patch, filePath, cwd: repoRoot, title: "unit", config: { ...DEFAULT_CONFIG, wordHighlight: "bold", lineHighlight: "none", lineNumbers: false, header: "minimal", compactUnchanged: false }, highlighter: fakeHighlighter, theme: fakeTheme() });
	const added = rendered.find((line) => stripAnsi(line).includes(changed));
	assert.ok(added);
	assert.equal((added.match(/\x1b\[1m/g) ?? []).length, 1, `${changed} is the only bold run`);
}

// Complete export only: preserve raw patches, file order, exact note body; hide AI notes.
const normalized = normalizeReviewExport(review({ notes: [
	{ noteId: "note-1", source: "user", filePath: "a.ts", newRange: [1, 1], hunk: 1, title: "Exact note", body: "  exact\nbody  ", author: "human", createdAt: "now" },
	{ source: "agent", filePath: "a.ts", newRange: [1, 1], body: "hidden" },
] }));
assert.equal(normalized.ok, true);
const snapshot = normalized.snapshot;
assert.deepEqual(snapshot.files.map((file) => file.path), ["a.ts", "b.ts"]);
assert.equal(snapshot.files[0].patch, patchA);
assert.equal(snapshot.notes.length, 1);
assert.equal(snapshot.notes[0].body, "  exact\nbody  ");
assert.equal(snapshot.notes[0].id, "note-1");
assert.equal(snapshot.notes[0].title, "Exact note");
assert.equal(snapshot.files[0].id, "file-a");
assert.equal(snapshot.source.repoRoot, "/pi-hunk");
assert.equal(snapshot.source.inputKind, "vcs");
assert.equal(snapshot.reviewedRef, undefined, "display titles are not reviewed refs");
const nestedRef = normalizeReviewExport({ ...review(), title: undefined, input: { range: "main...nested", kind: "vcs" } }).snapshot;
assert.equal(nestedRef.reviewedRef, "main...nested", "nested Hunk review coordinates are preserved");
assert.deepEqual(nestedRef.source.input, { range: "main...nested", kind: "vcs" });
assert.equal(snapshot.patchDigest, patchDigest(snapshot.files));
assert.equal(snapshot.patchDigest, patchDigest([...snapshot.files].reverse()), "file order does not change canonical patch identity");
const reorderedPayload = review({ notes: [
	{ noteId: "note-1", source: "user", filePath: "a.ts", newRange: [1, 1], hunk: 1, title: "Exact note", body: "  exact\nbody  ", author: "human", createdAt: "now" },
	{ source: "agent", filePath: "a.ts", newRange: [1, 1], body: "hidden" },
] });
reorderedPayload.files.reverse();
assert.equal(sameSnapshot(snapshot, normalizeReviewExport(reorderedPayload).snapshot), true, "export ordering does not create a spurious revision");
assert.notEqual(snapshot.reviewIdentity, snapshot.patchDigest, "reviewed ref participates in identity");
assert.equal(normalizeReviewExport({ comments: [{ type: "user", body: "legacy" }] }).ok, false, "comment-list payload rejected");
assert.equal(normalizeReviewExport({ sessionId: "s", files: [{ path: "a", additions: 1 }], reviewNotes: [] }).ok, false, "missing patch rejected");
assert.equal(normalizeReviewExport(review({ notes: [{ source: "user", filePath: "a.ts", body: 4 }] })).ok, false, "malformed human note rejected");
assert.equal(normalizeReviewExport({ ...review(), files: [...review().files, review().files[0]] }).ok, false, "duplicate reviewed file paths rejected");

// Complete changeset fingerprints are order-independent, include untracked
// files, and never infer an unsupported target from a display title.
{
	const untrackedPatch = "--- /dev/null\n+++ b/untracked.ts\n@@ -0,0 +1,1 @@\n+new file";
	const withUntracked = normalizeReviewExport({
		...review({ notes: [] }),
		files: [...review({ notes: [] }).files.slice(0, 1), { path: "untracked.ts", patch: untrackedPatch, additions: 1, deletions: 0, hunkCount: 1, hunks: [{ oldStart: 0, newStart: 1 }] }],
	}).snapshot;
	assert.equal(changesetDigest(withUntracked.files), changesetDigest([...withUntracked.files].reverse()), "file reordering does not change the digest");
	assert.notEqual(changesetDigest(withUntracked.files), changesetDigest(withUntracked.files.map((file) => file.path === "a.ts" ? { ...file, patch: patchB } : file)), "tracked edits change the digest");
	assert.equal(isDefaultGitWorkingTreeReview(snapshot), true);
	assert.equal(isDefaultGitWorkingTreeReview(nestedRef), false, "explicit ranges do not get a Git fallback");

	const calls = [];
	let tracked = patchA;
	const adapter = createGitChangesetAdapter(async (args) => {
		calls.push(args);
		if (args[0] === "diff" && args[1] === "--no-index") {
			return { stdout: `diff --git a/untracked.ts b/untracked.ts\nnew file mode 100644\n${untrackedPatch}`, stderr: "", code: 1, signal: null };
		}
		if (args[0] === "diff") return { stdout: `diff --git a/a.ts b/a.ts\nindex 1..2 100644\n${tracked}`, stderr: "", code: 0, signal: null };
		return { stdout: "?? untracked.ts\0", stderr: "", code: 0, signal: null };
	});
	const fallback = await adapter.captureFallback("/repo", withUntracked);
	assert.ok(fallback.fingerprint);
	assert.ok(calls.some((args) => args.includes("--no-optional-locks")), "status uses no optional locks");
	assert.ok(calls.some((args) => args.includes("--no-index")), "untracked files use argument-array diff");
	const currentGit = await adapter.read("/repo");
	assert.equal(compareGitFingerprint({ hunk: { sessionId: "s", targetSignature: "", patchDigest: "h" }, git: fallback.fingerprint, renderRevision: 0 }, currentGit.value.fingerprint).kind, "unchanged");
	tracked = patchB;
	const changedGit = await adapter.read("/repo");
	assert.equal(compareGitFingerprint({ hunk: { sessionId: "s", targetSignature: "", patchDigest: "h" }, git: fallback.fingerprint, renderRevision: 0 }, changedGit.value.fingerprint).kind, "changed");
	assert.equal(calls[0][0], "diff");

	const missingGit = createGitChangesetAdapter(async () => ({ stdout: "", stderr: "", code: null, signal: null, launchError: Object.assign(new Error("missing"), { code: "ENOENT" }) }));
	assert.equal((await missingGit.read("/repo")).reason, "git_unavailable");
	const timedGit = createGitChangesetAdapter(async () => ({ stdout: "", stderr: "", code: null, signal: null, timedOut: true }));
	assert.equal((await timedGit.read("/repo")).reason, "git_timeout");
	const malformedGit = createGitChangesetAdapter(async (args) => args[0] === "diff" ? { stdout: "not a diff", stderr: "", code: 0, signal: null } : { stdout: "", stderr: "", code: 0, signal: null });
	assert.equal((await malformedGit.read("/repo")).reason, "git_malformed");
	const stagedGit = createGitChangesetAdapter(async (args) => args[0] === "diff" ? { stdout: "", stderr: "", code: 0, signal: null } : { stdout: "M  staged.ts\0", stderr: "", code: 0, signal: null });
	assert.equal((await stagedGit.read("/repo")).reason, "git_staged_target");
}

// Append-only state transitions and immutable revisions.
{
	const events = [];
	let ids = 0;
	let clockTick = 0;
	const now = () => new Date(Date.UTC(2026, 0, 1, 0, 0, clockTick++)).toISOString();
	const store = createCheckpointStore((event) => events.push(event), () => `checkpoint-${++ids}`, now);
	const one = store.capture(snapshot);
	assert.equal(one.ok, true);
	assert.equal(one.checkpoint.revision, 1);
	assert.equal(one.checkpoint.createdAt, "2026-01-01T00:00:00.000Z");
	assert.equal(one.checkpoint.revisionCapturedAt, one.checkpoint.createdAt);
	assert.equal(store.capture(snapshot).persisted, false, "identical draft is no-op");
	const changedNotes = normalizeReviewExport(review({ notes: [{ source: "user", filePath: "a.ts", newRange: [1, 1], body: "changed note" }] })).snapshot;
	const two = store.capture(changedNotes);
	assert.equal(two.checkpoint.revision, 2);
	assert.equal(two.checkpoint.createdAt, one.checkpoint.createdAt, "checkpoint creation time survives revisions");
	assert.notEqual(two.checkpoint.revisionCapturedAt, one.checkpoint.revisionCapturedAt);
	const prior = one.checkpoint.snapshot;
	assert.equal(prior.notes[0].body, "  exact\nbody  ", "prior revision stays immutable");
	const requested = store.submit().checkpoint;
	assert.equal(requested.state, "changes_requested");
	assert.equal(requested.submittedAt, requested.updatedAt);
	assert.equal(store.capture(changedNotes).ok, false, "submitted review cannot be recaptured before invalidation");
	assert.equal(store.reconcileChangeset({ kind: "changed", source: "hunk", unrendered: false }).checkpoint.state, "re_review_due");
	const empty = normalizeReviewExport(review({ notes: [] })).snapshot;
	assert.equal(store.beginReview(empty).checkpoint.revision, 3);
	const approved = store.submit().checkpoint;
	assert.equal(approved.state, "approved");
	assert.equal(approved.submittedAt, approved.updatedAt);
	assert.equal(store.submit().ok, false, "duplicate submission rejected");
	const newReview = store.capture(snapshot);
	assert.equal(newReview.checkpoint.revision, 1);
	assert.notEqual(newReview.checkpoint.id, one.checkpoint.id);
	const abandoned = store.abandon().checkpoint;
	assert.equal(abandoned.state, "abandoned");
	assert.equal(abandoned.abandonedAt, abandoned.updatedAt);
	assert.equal(events.filter((event) => event.kind === "capture").length, 4);
	assert.ok(events.every((event) => Number.isFinite(Date.parse(event.at))), "every journal event has an ISO timestamp");

	const branch = events.map((data) => ({ type: "custom", customType: "hunk-checkpoint", data }));
	const corruptSnapshot = { ...events.find((event) => event.kind === "capture"), snapshot: { ...snapshot, notes: [null] } };
	const restored = createCheckpointStore(() => {});
	restored.rehydrate([
		{ type: "custom", customType: "hunk-checkpoint", data: { version: 99 } },
		{ type: "custom", customType: "hunk-checkpoint", data: corruptSnapshot },
		...branch,
	]);
	assert.equal(restored.current().state, "abandoned", "branch journal folds to current branch state");
	assert.equal(restored.current().abandonedAt, abandoned.abandonedAt, "rehydration restores transition timestamps");
	assert.equal(restored.diagnostics().ignoredEntries, 2);

	const failedCapture = createCheckpointStore(() => { throw new Error("journal unavailable"); });
	assert.throws(() => failedCapture.capture(snapshot), /journal unavailable/);
	assert.equal(failedCapture.current(), undefined, "failed persistence cannot publish an in-memory checkpoint");
	const throwingTransition = createCheckpointStore(() => { throw new Error("journal unavailable"); }, () => "atomic", now);
	// Rehydrate gives the throwing store a valid current revision without asking
	// its persistence adapter to append it again.
	throwingTransition.rehydrate([{ type: "custom", customType: "hunk-checkpoint", data: events[0] }]);
	assert.throws(() => throwingTransition.submit(), /journal unavailable/);
	assert.equal(throwingTransition.current().state, "reviewing", "failed transition persistence leaves state unchanged");
}

// Changed/unknown reconciliation is monotonic, and explicit reviews remain
// allowed after a submitted or completed checkpoint.
{
	const events = [];
	const baseline = createChangesetBaseline(snapshot, 4);
	const store = createCheckpointStore((event) => events.push(event), () => "monotonic", () => "2026-01-01T00:00:00.000Z");
	const captured = store.beginReview(snapshot, baseline);
	assert.equal(captured.ok, true);
	const approved = store.submit();
	assert.equal(approved.checkpoint.state, "changes_requested", "notes request changes");
	const due = store.reconcileChangeset({ kind: "changed", source: "git", unrendered: true });
	assert.equal(due.checkpoint.state, "re_review_due");
	assert.equal(events.at(-1).reason, "changeset_changed");
	assert.equal(store.reconcileChangeset({ kind: "unchanged", source: "git" }).checkpoint.state, "re_review_due", "unchanged does not restore a review");
	const explicit = store.beginReview(snapshot, baseline);
	assert.equal(explicit.checkpoint.revision, 2, "unchanged explicit review creates a revision");
	const approvedEmpty = createCheckpointStore(() => {}, () => "approved-id", () => "2026-01-01T00:00:00.000Z");
	assert.equal(approvedEmpty.beginReview(normalizeReviewExport(review({ notes: [] })).snapshot, baseline).ok, true);
	assert.equal(approvedEmpty.submit().checkpoint.state, "approved");
	const nextCheckpoint = approvedEmpty.beginReview(normalizeReviewExport(review({ notes: [] })).snapshot, baseline).checkpoint;
	assert.equal(nextCheckpoint.revision, 1, "review after approval starts a new checkpoint");
	assert.equal(nextCheckpoint.id, "approved-id");

	const v1 = createCheckpointStore(() => {});
	v1.rehydrate([{ type: "custom", customType: "hunk-checkpoint", data: { version: 1, kind: "capture", checkpointId: "v1", revision: 1, at: "2026-01-01T00:00:00.000Z", snapshot } }]);
	assert.equal(v1.current().baseline.git, undefined, "v1 rehydration has no unsafe Git fallback");
	const malformed = createCheckpointStore(() => {});
	malformed.rehydrate([{ type: "custom", customType: "hunk-checkpoint", data: { version: 2, kind: "capture", checkpointId: "bad", revision: 1, at: "2026-01-01T00:00:00.000Z", snapshot, baseline: { hunk: {}, renderRevision: 0 } } }]);
	assert.equal(malformed.current(), undefined);
}

// Persistent status and inline hints are a pure state presentation seam.
{
	const checkpoint = createCheckpointStore(() => {}, () => "presentation-id", () => "2026-01-01T00:00:00.000Z");
	const reviewed = checkpoint.beginReview(snapshot).checkpoint;
	assert.deepEqual(presentHunk({ enabled: true, checkpoint: reviewed, liveSession: "none" }), { status: "hunk · reviewing · 1 note", hunkHint: "/hunk submit" });
	assert.equal(presentHunk({ enabled: true, checkpoint: reviewed, liveSession: "elsewhere" }).hunkHint, "review active elsewhere · /hunk submit");
	const external = checkpoint.reconcileChangeset({ kind: "changed", source: "git", unrendered: true }).checkpoint;
	assert.equal(presentHunk({ enabled: true, checkpoint: external, liveSession: "none", freshness: { kind: "changed", source: "git", unrendered: true } }).hunkHint, "changeset updated outside inline diff · /hunk review");
	assert.equal(presentHunk({ enabled: true, checkpoint: external, liveSession: "none", freshness: { kind: "unknown", reason: "missing_git_fallback" } }).hunkHint, "/hunk status");
	assert.deepEqual(presentHunk({ enabled: true, checkpoint: { ...external, state: "approved" }, liveSession: "none", freshness: { kind: "unchanged", source: "hunk" } }), { status: "hunk · approved" });
}

// Read-only client: exact review export command, no legacy comment API.
{
	const calls = [];
	const client = createHunkSessionClient(async (_binary, args) => {
		calls.push(args);
		if (args[1] === "get") return { stdout: JSON.stringify({ id: "session-1", pid: "4242" }), stderr: "", code: 0, signal: null };
		if (args[1] === "review") return { stdout: JSON.stringify(review()), stderr: "", code: 0, signal: null };
		return { stdout: "", stderr: "", code: 0, signal: null };
	});
	const probe = await client.probe("/repo", DEFAULT_CONFIG);
	assert.equal(probe.ok, true);
	assert.equal(probe.value.pid, 4242, "probe normalizes the owning process ID");
	const read = await client.readReview("/repo", DEFAULT_CONFIG, "session-1");
	assert.equal(read.ok, true);
	assert.deepEqual(calls[0], ["session", "get", "--repo", "/repo", "--json"]);
	assert.deepEqual(calls[1], ["session", "review", "session-1", "--include-patch", "--include-notes", "--json"]);
	await client.navigate("/repo", DEFAULT_CONFIG, "session-1", { file: "a.ts", hunk: 1 });
	assert.deepEqual(calls[2], ["session", "navigate", "session-1", "--file", "a.ts", "--hunk", "1"]);
	assert.equal(calls.some((args) => args.includes("comment") || args.includes("reload")), false);
	const unsupported = createHunkSessionClient(async () => ({ stdout: "", stderr: "unknown command", code: 1, signal: null }));
	assert.equal((await unsupported.readReview("/repo", DEFAULT_CONFIG)).error.kind, "unsupported_command");
	const malformed = createHunkSessionClient(async () => ({ stdout: "not json", stderr: "", code: 0, signal: null }));
	assert.equal((await malformed.readReview("/repo", DEFAULT_CONFIG)).error.kind, "malformed_json");
	const missing = createHunkSessionClient(async () => ({ stdout: "", stderr: "", code: null, signal: null, launchError: Object.assign(new Error("missing"), { code: "ENOENT" }) }));
	assert.equal((await missing.probe("/repo", DEFAULT_CONFIG)).error.kind, "missing_binary");
	const signalled = createHunkSessionClient(async () => ({ stdout: "", stderr: "", code: null, signal: "SIGTERM" }));
	assert.equal((await signalled.probe("/repo", DEFAULT_CONFIG)).error.kind, "signal");
	const timedOut = createHunkSessionClient(async () => ({ stdout: "", stderr: "", code: null, signal: null, timedOut: true }));
	assert.equal((await timedOut.probe("/repo", DEFAULT_CONFIG)).error.kind, "timeout");
}

// A spawned review locks onto its own registered process instead of attaching
// to a same-repository side pane that appears during launch.
{
	class FakeChild extends EventEmitter { pid = 45; kill() {} }
	const child = new FakeChild();
	let probes = 0;
	let scheduled;
	const clock = {
		setTimeout(fn) { scheduled = fn; return 1; },
		clearTimeout() {},
	};
	const client = {
		async probe() {
			probes++;
			return { ok: true, value: { sessionId: probes === 1 ? "other-session" : "owned-session", pid: probes === 1 ? 99 : 45, metadata: {} } };
		},
		async readReview() {
			const owned = normalizeReviewExport({ ...review(), sessionId: "owned-session" }).snapshot;
			return { ok: true, value: { sessionId: "owned-session", raw: review(), snapshot: owned } };
		},
	};
	const tui = { stop() {}, start() {}, requestRender() {} };
	const handoff = handoffToSpawnedHunk({ client, cwd: "/repo", config: DEFAULT_CONFIG, tui, spawn: () => child, clock });
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(probes, 1, "foreign session is not sampled");
	scheduled();
	await new Promise((resolve) => setImmediate(resolve));
	child.emit("close", 0, null);
	const result = await handoff;
	assert.equal(result.sessionId, "owned-session");
}

// Spawn handoff owns TUI lifecycle and samples retained final export.
{
	class FakeChild extends EventEmitter { pid = 42; kill() {} }
	const child = new FakeChild();
	const calls = [];
	const client = {
		async probe() { return { ok: true, value: { sessionId: "session-1", metadata: {} } }; },
		async readReview() { return { ok: true, value: { sessionId: "session-1", raw: review(), snapshot } }; },
		async navigate() { return { ok: true, value: undefined }; },
	};
	const tui = { stopped: 0, started: 0, redraws: 0, stop() { this.stopped++; }, start() { this.started++; }, requestRender() { this.redraws++; } };
	const handoff = handoffToSpawnedHunk({ client, cwd: "/repo", config: DEFAULT_CONFIG, tui, spawn: (_binary, args, options) => { calls.push({ args, options }); return child; } });
	await new Promise((resolve) => setImmediate(resolve));
	child.emit("close", 0, null);
	const result = await handoff;
	assert.deepEqual(calls[0].args, ["diff", "--watch", "--no-exclude-untracked"]);
	assert.equal(calls[0].options.shell, false);
	assert.equal(calls[0].options.stdio, "inherit");
	assert.equal(result.lastValidExport.patchDigest, snapshot.patchDigest);
	assert.deepEqual([tui.stopped, tui.started, tui.redraws], [1, 1, 1]);
}

// A normal owned-process exit retains its last export without reporting the
// expected daemon unregister as a failed handoff.
{
	class FakeChild extends EventEmitter { pid = 43; kill() {} }
	const child = new FakeChild();
	let reads = 0;
	const client = {
		async probe() { return { ok: true, value: { sessionId: "session-1", metadata: {} } }; },
		async readReview() {
			reads++;
			return reads === 1 ? { ok: true, value: { sessionId: "session-1", raw: review(), snapshot } } : { ok: false, error: { kind: "session_disappeared", message: "gone", args: [] } };
		},
		async navigate() { return { ok: true, value: undefined }; },
	};
	const tui = { stopped: 0, started: 0, redraws: 0, stop() { this.stopped++; }, start() { this.started++; }, requestRender() { this.redraws++; } };
	const handoff = handoffToSpawnedHunk({ client, cwd: "/repo", config: DEFAULT_CONFIG, tui, spawn: () => child });
	await new Promise((resolve) => setImmediate(resolve));
	child.emit("close", 0, null);
	const result = await handoff;
	assert.ok(result.lastValidExport);
	assert.equal(result.exportError, undefined, "normal process exit does not surface session disappearance");
	assert.deepEqual([tui.stopped, tui.started, tui.redraws], [1, 1, 1]);
}

// Launch errors and signals always restore Pi's terminal lifecycle.
{
	const absentClient = { async probe() { return { ok: false, error: { kind: "session_disappeared", message: "none", args: [] } }; } };
	const tui = { stopped: 0, started: 0, redraws: 0, stop() { this.stopped++; }, start() { this.started++; }, requestRender() { this.redraws++; } };
	const failed = await handoffToSpawnedHunk({ client: absentClient, cwd: "/repo", config: DEFAULT_CONFIG, tui, spawn: () => { throw new Error("launch failed"); } });
	assert.match(failed.launchError, /launch failed/);
	assert.deepEqual([tui.stopped, tui.started, tui.redraws], [1, 1, 1]);

	class FakeChild extends EventEmitter { pid = 44; kill() {} }
	const child = new FakeChild();
	const liveClient = { async probe() { return { ok: true, value: { sessionId: "session-1", metadata: {} } }; }, async readReview() { return { ok: true, value: { sessionId: "session-1", raw: review(), snapshot } }; } };
	const tui2 = { stopped: 0, started: 0, redraws: 0, stop() { this.stopped++; }, start() { this.started++; }, requestRender() { this.redraws++; } };
	const signalled = handoffToSpawnedHunk({ client: liveClient, cwd: "/repo", config: DEFAULT_CONFIG, tui: tui2, spawn: () => child });
	await new Promise((resolve) => setImmediate(resolve));
	child.emit("close", null, "SIGINT");
	assert.equal((await signalled).signal, "SIGINT");
	assert.deepEqual([tui2.stopped, tui2.started, tui2.redraws], [1, 1, 1]);

	const failedChild = new FakeChild();
	const tui3 = { stopped: 0, started: 0, redraws: 0, stop() { this.stopped++; }, start() { this.started++; }, requestRender() { this.redraws++; } };
	const nonzero = handoffToSpawnedHunk({ client: liveClient, cwd: "/repo", config: DEFAULT_CONFIG, tui: tui3, spawn: () => failedChild });
	await new Promise((resolve) => setImmediate(resolve));
	failedChild.emit("close", 7, null);
	assert.equal((await nonzero).exitCode, 7);
	assert.deepEqual([tui3.stopped, tui3.started, tui3.redraws], [1, 1, 1]);
}

// Bad samples never overwrite the most recent complete export.
{
	let reads = 0;
	const client = {
		async readReview() {
			reads++;
			return reads === 1 ? { ok: true, value: { sessionId: "session-1", raw: review(), snapshot } } : { ok: false, error: { kind: "malformed_export", message: "bad", args: [] } };
		},
	};
	const lease = createSamplingLease({ mode: "reuse", client, cwd: "/repo", config: DEFAULT_CONFIG, sessionId: "session-1" });
	await lease.ready();
	await lease.finalSample();
	assert.equal(lease.latest(), snapshot);
	assert.equal(lease.lastError().kind, "malformed_export");
	lease.stop();
}

// Cancelling a lease suppresses an in-flight result and its session-loss
// callback, so abandon/session switches cannot resurrect a checkpoint.
{
	let resolveRead;
	let losses = 0;
	const lease = createSamplingLease({
		mode: "reuse",
		client: { readReview: () => new Promise((resolve) => (resolveRead = resolve)) },
		cwd: "/repo",
		config: DEFAULT_CONFIG,
		sessionId: "session-1",
		onSessionLoss: () => losses++,
	});
	await new Promise((resolve) => setImmediate(resolve));
	lease.stop();
	resolveRead({ ok: false, error: { kind: "session_disappeared", message: "gone", args: [] } });
	await lease.ready();
	assert.equal(losses, 0);
}

// A human-owned side pane may disappear before submit; its last complete
// export remains authoritative, while malformed reads from a still-live pane
// remain a hard refusal.
{
	const ctx = { cwd: "/repo", signal: undefined, mode: "tui" };
	let reads = 0;
	const lostClient = {
		async probe() { return { ok: true, value: { sessionId: "session-1", metadata: {} } }; },
		async readReview() {
			reads++;
			return reads <= 2 ? { ok: true, value: { sessionId: "session-1", raw: review(), snapshot } } : { ok: false, error: { kind: "session_disappeared", message: "gone", args: [] } };
		},
		async navigate() { return { ok: true, value: undefined }; },
	};
	const retained = createReviewCoordinator({ client: lostClient, capture() {} });
	await retained.review(ctx, DEFAULT_CONFIG);
	await new Promise((resolve) => setImmediate(resolve));
	const final = await retained.finalExport();
	assert.equal(final.ok, true);
	assert.equal(final.value, snapshot);
	retained.cancel();

	reads = 0;
	const malformedClient = {
		...lostClient,
		async readReview() {
			reads++;
			return reads <= 2 ? { ok: true, value: { sessionId: "session-1", raw: review(), snapshot } } : { ok: false, error: { kind: "malformed_export", message: "bad live export", args: [] } };
		},
	};
	const refused = createReviewCoordinator({ client: malformedClient, capture() {} });
	await refused.review(ctx, DEFAULT_CONFIG);
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal((await refused.finalExport()).ok, false, "malformed export from live reused session refuses submit");
	refused.cancel();
}

// Highlighter refreshes remain keyed, single-flight, and stale-serving.
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
	assert.equal(cache.get(configA).id, "theme-a");
	const refreshB = cache.refresh(configB);
	assert.equal(cache.get(configB).id, "theme-a", "stale highlighter served while replacement loads");
	assert.equal(cache.refresh(configB), refreshB, "same-key refreshes coalesce");
	assert.deepEqual(calls, ["theme-a", "theme-b"]);
	releaseB();
	await refreshB;
	assert.equal(cache.get(configB).id, "theme-b");
}

// Configure's pure spec model still covers every active setting and no removed
// implicit-delivery switch survives in defaults or UI.
{
	const groups = hunkConfigGroups();
	const specs = groups.flatMap((group) => group.specs);
	const ids = specs.map((spec) => spec.id);
	assert.equal(new Set(ids).size, ids.length);
	assert.deepEqual(ids, [
		"wordHighlight", "colors.add", "colors.remove", "colors.context",
		"lineHighlight", "colors.gutter", "symbols.gutter", "symbols.add", "symbols.remove",
		"header", "lineNumbers", "colors.header", "colors.lineNo", "colors.meta",
		"symbols.context", "symbols.fold", "compactUnchanged", "contextRadius", "maxRenderedLines",
		"diffTheme", "shikiDarkTheme", "shikiLightTheme", "enabled", "showHunkHint", "hunk.enabled",
	]);
	assert.equal("reviewTool" in DEFAULT_CONFIG.hunk, false);
	assert.equal("autoReviewNotes" in DEFAULT_CONFIG.hunk, false);
	assert.equal("autoReviewNotesMin" in DEFAULT_CONFIG.hunk, false);
	for (const spec of specs) {
		const draft = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
		const current = spec.get(draft);
		const choices = choicesForSpec(spec, draft, fakeTheme());
		assert.ok(choices.some((choice) => choice.value === current), `${spec.id} includes current choice`);
		const next = choices.find((choice) => choice.value !== current)?.value ?? current;
		spec.set(draft, next);
		assert.equal(spec.get(draft), next, `${spec.id} round-trips`);
		assert.match(descriptionForSpec(spec, draft, fakeTheme()), /^Current:/);
	}
	const presets = hunkConfigPresets();
	assert.deepEqual(presets.map((preset) => preset.id), ["pi-native", "high-contrast-mono", "warm-editorial", "syntax-only"]);
	const warm = applyHunkPreset(JSON.parse(JSON.stringify(DEFAULT_CONFIG)), presets.find((preset) => preset.id === "warm-editorial"));
	assert.equal(warm.wordHighlight, "underline");
	assert.equal(warm.header, "compact");
	const syntaxOnly = applyHunkPreset(JSON.parse(JSON.stringify(DEFAULT_CONFIG)), presets.find((preset) => preset.id === "syntax-only"));
	assert.equal(syntaxOnly.wordHighlight, "none");
	assert.equal(syntaxOnly.lineHighlight, "none");
	const gutter = specs.find((spec) => spec.id === "symbols.gutter");
	const addColor = specs.find((spec) => spec.id === "colors.add");
	assert.match(stripAnsi(choicesForSpec(gutter, DEFAULT_CONFIG, fakeTheme())[0].label), /\+\s+const x = 1;/);
	assert.match(stripAnsi(choicesForSpec(addColor, DEFAULT_CONFIG, fakeTheme())[0].label), /\+ const tone = vivid/);
}

// The styling adapter must reapply side tint after every Shiki reset.
{
	const theme = fakeTheme();
	const config = { ...DEFAULT_CONFIG, wordHighlight: "bold", lineHighlight: "tint" };
	const sideAnsi = "\x1b[48;2;26;44;28m\x1b[38;2;80;220;120m";
	const rendered = renderCodeLine("hi world", [{ content: "hi", color: "#ffaaaa" }, { content: "world", color: "#aaffaa" }], theme, config, "add", [{ start: 0, end: 2 }], sideAnsi);
	const resets = [...rendered.matchAll(/\x1b\[0m/g)].map((match) => match.index);
	assert.ok(resets.length >= 2);
	for (let i = 0; i < resets.length - 1; i++) assert.equal(rendered.slice(resets[i] + 4, resets[i] + 4 + sideAnsi.length), sideAnsi);
	assert.equal(wordHighlightAnsi("strike", "remove", theme), "\x1b[1;9m");
	assert.equal(wordHighlightAnsi("strike", "add", theme), "\x1b[1;4m");
	assert.equal(wordHighlightAnsi("none", "add", theme), "");
	assert.equal(styleToken("x", undefined, false, "add", config, theme, sideAnsi), "x");
	assert.ok(styleToken("y", "#ffffff", true, "add", config, theme, sideAnsi).endsWith(sideAnsi));
}

// DiffView's reusable row layout keeps folding, addressing, and truncation.
{
	const patch = [
		"--- a/layout.ts", "+++ b/layout.ts", "@@ -1,8 +1,8 @@",
		" line1", " line2", " line3", "-old4", "+new4", " line5", " line6", " line7", " line8",
	].join("\n");
	const config = { ...DEFAULT_CONFIG, lineNumbers: false, header: "minimal", compactUnchanged: true, contextRadius: 1, maxRenderedLines: 260 };
	const layout = buildDiffLayout({ patch, filePath: "layout.ts", cwd: repoRoot, title: "unit", config, highlighter: fakeHighlighter, theme: fakeTheme(), hunkHint: undefined });
	assert.equal(layout.stats.added, 1);
	assert.equal(layout.stats.removed, 1);
	assert.equal(layout.stats.files, 1);
	assert.equal(layout.stats.hunks, 1);
	assert.equal(layout.rows[0].kind, "hunkCaption");
	assert.ok(layout.rows.some((row) => row.kind === "fold"));
	const added = layout.rows.find((row) => row.kind === "code" && stripAnsi(row.text).includes("new4"));
	assert.equal(added.hunkIndex, 0);
	assert.equal(added.lineIndex, 4);
	const tiny = buildDiffLayout({ patch, filePath: "layout.ts", cwd: repoRoot, title: "unit", config: { ...config, maxRenderedLines: 2 }, highlighter: fakeHighlighter, theme: fakeTheme(), hunkHint: undefined });
	assert.equal(tiny.truncated, true);
	assert.ok(tiny.rows.length <= 2);
	const rendered = renderDiffLines({ patch, filePath: "layout.ts", cwd: repoRoot, title: "unit", config, highlighter: fakeHighlighter, theme: fakeTheme(), hunkHint: undefined });
	assert.match(rendered.map(stripAnsi).join("\n"), /layout\.ts[\s\S]*new4/);
}

console.log("pi-hunk units ok");
