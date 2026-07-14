import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
function findPiPackageRoot() {
	for (const candidate of [process.env.PI_CODING_AGENT_ROOT, path.join(repoRoot, "node_modules", "@earendil-works", "pi-coding-agent"), "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent", "/usr/local/lib/node_modules/@earendil-works/pi-coding-agent", path.join(os.homedir(), ".pi", "agent", "npm", "node_modules", "@earendil-works", "pi-coding-agent")].filter(Boolean)) {
		if (existsSync(path.join(candidate, "package.json"))) return candidate;
	}
	throw new Error("Could not locate pi package.");
}
const piRoot = findPiPackageRoot();
const jiti = createRequire(path.join(piRoot, "package.json"))("jiti")(import.meta.url, {
	interopDefault: true,
	moduleCache: false,
	fsCache: false,
	alias: {
		"@earendil-works/pi-coding-agent": path.join(piRoot, "dist", "index.js"),
		"@earendil-works/pi-tui": path.join(piRoot, "node_modules", "@earendil-works", "pi-tui", "dist", "index.js"),
		typebox: path.join(piRoot, "node_modules", "typebox", "build", "index.mjs"),
	},
});

function theme() {
	const colors = { accent: "\x1b[38;2;255;190;106m", borderMuted: "\x1b[38;2;90;90;90m", toolTitle: "\x1b[38;2;250;250;250m", toolDiffAdded: "\x1b[38;2;80;220;120m", toolDiffRemoved: "\x1b[38;2;240;100;100m", toolDiffContext: "\x1b[38;2;210;210;210m", muted: "\x1b[38;2;160;160;160m", dim: "\x1b[38;2;110;110;110m", warning: "\x1b[38;2;255;200;80m" };
	return { name: "smoke", fg: (slot, text) => `${colors[slot] ?? ""}${text}\x1b[0m`, getFgAnsi: (slot) => colors[slot] ?? "", bold: (text) => `\x1b[1m${text}\x1b[22m` };
}
function stripAnsi(value) { return value.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, ""); }
function renderTool(tool, toolCallId, result, args, cwd) {
	return tool.renderResult(result, { expanded: true, isPartial: false }, theme(), {
		args, toolCallId, cwd, invalidate() {}, lastComponent: undefined, state: {}, executionStarted: true,
		argsComplete: true, isPartial: false, expanded: true, showImages: false, isError: false,
	}).render(100).join("\n");
}
function ctx(cwd, ui, entries, idle = true) {
	return {
		cwd, ui, mode: "tui", hasUI: true, signal: undefined, isIdle: () => idle,
		sessionManager: { getBranch: () => entries }, modelRegistry: {}, model: undefined,
		isProjectTrusted: () => true, abort() {}, hasPendingMessages: () => false, shutdown() {}, getContextUsage: () => undefined,
		compact() {}, getSystemPrompt: () => "", getSystemPromptOptions: () => ({}), waitForIdle: async () => {}, newSession: async () => ({ cancelled: false }), fork: async () => ({ cancelled: false }), navigateTree: async () => ({ cancelled: false }), switchSession: async () => ({ cancelled: false }), reload: async () => {},
	};
}

const tmp = await mkdtemp(path.join(os.tmpdir(), "pi-hunk-smoke-"));
try {
	const binary = path.join(tmp, "fake-hunk.mjs");
	await writeFile(binary, `#!/usr/bin/env node
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const marker = ".fake-hunk-live";
const notesFile = ".fake-hunk-notes.json";
const patchFile = ".fake-hunk-patch";
const payload = () => ({
  sessionId: "smoke-session", title: "pi-hunk main...smoke", sourceLabel: process.cwd(),
  files: [{ path: "smoke.ts", patch: readFileSync(patchFile, "utf8"), additions: 1, deletions: 1, hunkCount: 1, hunks: [{ oldStart: 1, newStart: 1 }] }],
  reviewNotes: JSON.parse(readFileSync(notesFile, "utf8"))
});
if (args[0] === "diff" && args[1] === "--watch") {
  writeFileSync(".fake-hunk-args", args.join("\\n"));
  writeFileSync(marker, "live");
  setTimeout(() => { try { rmSync(marker); } catch {} process.exit(0); }, 700);
} else if (args[0] === "session" && args[1] === "get") {
  if (!existsSync(marker)) { console.error("No active Hunk sessions are registered"); process.exit(1); }
  console.log(JSON.stringify({ id: "smoke-session" }));
} else if (args[0] === "session" && args[1] === "review") {
  if (!existsSync(marker)) { console.error("No active Hunk sessions are registered"); process.exit(1); }
  if (!args.includes("--include-patch") || !args.includes("--include-notes") || !args.includes("--json")) process.exit(2);
  console.log(JSON.stringify(payload()));
} else if (args[0] === "session" && args[1] === "navigate") {
  process.exit(0);
} else process.exit(2);
`, "utf8");
	await chmod(binary, 0o755);
	await mkdir(path.join(tmp, ".pi"));
	await writeFile(path.join(tmp, ".pi", "hunk.json"), JSON.stringify({ hunk: { binary, reviewTool: true, autoReviewNotes: true, autoReviewNotesMin: 99 }, maxRenderedLines: 80 }));
	await writeFile(path.join(tmp, ".fake-hunk-notes.json"), JSON.stringify([{ source: "user", filePath: "smoke.ts", newRange: [1, 1], hunk: 1, body: "exact smoke note", author: "human" }]));
	const originalPatch = "--- a/smoke.ts\n+++ b/smoke.ts\n@@ -1,1 +1,1 @@\n-old\n+new";
	await writeFile(path.join(tmp, ".fake-hunk-patch"), originalPatch);

	const entries = [];
	const notifications = [];
	const sent = [];
	const statuses = new Map();
	const configureSnapshots = [];
	const selectors = [];
	const shortcuts = new Map();
	const tui = { stopped: 0, started: 0, redraws: 0, stop() { this.stopped++; }, start() { this.started++; }, requestRender() { this.redraws++; } };
	const ui = {
		theme: theme(), setStatus: (key, value) => statuses.set(key, value), notify: (message, type = "info") => notifications.push({ message, type }),
		select: async (title, options) => {
			selectors.push({ title, options });
			return "Keep for later";
		},
		custom: (factory) => new Promise((resolve, reject) => {
			let done = false;
			const finish = (value) => { if (!done) { done = true; resolve(value); } };
			Promise.resolve(factory(tui, theme(), {}, finish)).then((component) => {
				if (done || !component?.render) return;
				const first = stripAnsi(component.render(100).join("\n"));
				if (!first) return; // spawned-Hunk placeholder; its async owner calls done
				configureSnapshots.push(first);
				for (let i = 0; i < 4; i++) component.handleInput?.("\x1b[B");
				configureSnapshots.push(stripAnsi(component.render(100).join("\n")));
				component.handleInput?.("\r");
				configureSnapshots.push(stripAnsi(component.render(100).join("\n")));
				component.handleInput?.("\x1b");
				component.handleInput?.("\x1b");
				finish();
			}).catch(reject);
		}),
	};
	const tools = new Map();
	const commands = new Map();
	const handlers = new Map();
	const pi = {
		on(event, handler) { const list = handlers.get(event) ?? []; list.push(handler); handlers.set(event, list); },
		registerTool(tool) { tools.set(tool.name, tool); }, registerCommand(name, options) { commands.set(name, options); }, registerShortcut(key, options) { shortcuts.set(key, options); }, registerFlag() {}, getFlag() {}, registerMessageRenderer() {}, registerEntryRenderer() {},
		sendMessage(message, options) { sent.push({ message, options }); }, sendUserMessage() { throw new Error("legacy delivery must not run"); }, appendEntry(customType, data) { entries.push({ type: "custom", customType, data }); },
		setSessionName() {}, getSessionName() {}, setLabel() {}, exec: async () => ({ stdout: "", stderr: "", code: 0 }), getActiveTools: () => [...tools.keys()], getAllTools: () => [], setActiveTools() {}, getCommands: () => [], setModel: async () => true, getThinkingLevel: () => "high", setThinkingLevel() {}, registerProvider() {}, unregisterProvider() {}, events: { on() {}, emit() {} },
	};

	const extension = await jiti.import(path.join(repoRoot, "src", "index.ts"), { default: true });
	await extension(pi);
	assert.ok(tools.has("write") && tools.has("edit"), "diff tools remain");
	assert.equal(tools.has("hunk_review_notes"), false, "legacy review tool removed");
	assert.ok(commands.has("hunk"));
	assert.equal(shortcuts.get("ctrl+shift+h").description, "Open Hunk review checkpoint.");
	const command = commands.get("hunk");
	assert.deepEqual(command.getArgumentCompletions("").map((item) => item.value), ["status", "review", "submit", "abandon", "configure"]);
	assert.equal(handlers.has("before_agent_start"), false, "automatic pickup removed");

	const commandCtx = ctx(tmp, ui, entries);
	for (const handler of handlers.get("session_start") ?? []) await handler({ type: "session_start" }, commandCtx);
	assert.equal(statuses.get("hunk"), "hunk · ready");

	// Existing write/edit rendering and queued-write behavior remain intact.
	const writeTool = tools.get("write");
	const writeArgs = { path: "smoke.ts", content: "hello world\n" };
	const writeResult = await writeTool.execute("smoke-write", writeArgs, undefined, undefined, commandCtx);
	const writeView = renderTool(writeTool, "smoke-write", writeResult, writeArgs, tmp);
	const writePlain = stripAnsi(writeView);
	assert.match(writeView, /\x1b\[/, "write renderer produced ANSI");
	assert.match(writePlain, /created/);
	assert.match(writePlain, /smoke\.ts/);
	assert.match(writePlain, /\+1/);
	assert.match(writePlain, /▎/);

	const queuedA = { path: "queued.ts", content: "one\n" };
	const queuedB = { path: "queued.ts", content: "two\n" };
	const [queuedAResult, queuedBResult] = await Promise.all([
		writeTool.execute("queued-a", queuedA, undefined, undefined, commandCtx),
		writeTool.execute("queued-b", queuedB, undefined, undefined, commandCtx),
	]);
	assert.match(stripAnsi(renderTool(writeTool, "queued-a", queuedAResult, queuedA, tmp)), /created/);
	assert.match(stripAnsi(renderTool(writeTool, "queued-b", queuedBResult, queuedB, tmp)), /wrote/);
	assert.equal(await readFile(path.join(tmp, "queued.ts"), "utf8"), "two\n");

	const editTool = tools.get("edit");
	const editArgs = { path: "smoke.ts", edits: [{ oldText: "hello world\n", newText: "hello hunk\n" }] };
	const editResult = await editTool.execute("smoke-edit", editArgs, undefined, undefined, commandCtx);
	const editPlain = stripAnsi(renderTool(editTool, "smoke-edit", editResult, editArgs, tmp));
	assert.match(editPlain, /edited/);
	assert.match(editPlain, /hunk/);
	assert.match(editPlain, /@@/);

	// Existing side-pane: attach, capture, and submit exactly once.
	await writeFile(path.join(tmp, ".fake-hunk-live"), "live");
	await command.handler("review", commandCtx);
	assert.equal(tui.stopped, 0, "matching side-pane is reused without launching a competing Hunk");
	assert.equal(entries.filter((entry) => entry.customType === "hunk-checkpoint").length, 1, "capture persisted");
	await writeFile(path.join(tmp, ".fake-hunk-patch"), "--- a/smoke.ts\n+++ b/smoke.ts\n@@ -1,1 +1,1 @@\n-old\n+stale");
	await command.handler("submit", commandCtx);
	assert.equal(sent.length, 0, "stale patch starts no turn");
	assert.ok(notifications.some((notice) => notice.message.includes("re-review due")), "stale patch requires re-review");
	await writeFile(path.join(tmp, ".fake-hunk-patch"), originalPatch);
	await command.handler("review", commandCtx);
	await rm(path.join(tmp, ".fake-hunk-live"), { force: true });
	await new Promise((resolve) => setTimeout(resolve, 600));
	await command.handler("submit", commandCtx);
	assert.equal(sent.length, 1, "retained side-pane notes start one turn after Hunk exits");
	assert.equal(sent[0].options.triggerTurn, true);
	assert.equal(sent[0].options.deliverAs, "followUp");
	assert.match(sent[0].message.content, /exact smoke note/);
	assert.doesNotMatch(sent[0].message.content, /--- a\/smoke/);
	await command.handler("submit", commandCtx);
	assert.equal(sent.length, 1, "duplicate submit starts no turn");

	// Session entries fold after simulated reload; abandonment stays local.
	for (const handler of handlers.get("session_start") ?? []) await handler({ type: "session_start" }, commandCtx);
	await command.handler("abandon", commandCtx);
	assert.equal(sent.length, 1, "abandon starts no turn");

	// No session: extension owns one direct child/TUI handoff, restores once,
	// and an explicit empty submission approves without a model turn.
	await writeFile(path.join(tmp, ".fake-hunk-notes.json"), "[]");
	const noticeStart = notifications.length;
	await command.handler("review", commandCtx);
	assert.deepEqual([tui.stopped, tui.started, tui.redraws], [1, 1, 1], "spawn handoff restores Pi TUI once");
	assert.deepEqual(selectors.at(-1).options, ["Submit now", "Keep for later", "Abandon"]);
	assert.match(await readFile(path.join(tmp, ".fake-hunk-args"), "utf8"), /--no-exclude-untracked/);
	assert.equal(notifications.slice(noticeStart).some((notice) => notice.message === "Hunk session disappeared."), false, "normal q exit is not reported as failure");
	await command.handler("submit", commandCtx);
	assert.equal(sent.length, 1);
	assert.equal(entries.at(-1).data.state, "approved");
	assert.ok(notifications.some((notice) => /approved.*No model turn started/.test(notice.message)));
	assert.ok(entries.filter((entry) => entry.customType === "hunk-checkpoint").every((entry) => Number.isFinite(Date.parse(entry.data.at))), "checkpoint journal entries carry timestamps");

	// Approval is invalidated by a later complete Hunk changeset change.
	await writeFile(path.join(tmp, ".fake-hunk-live"), "live");
	await writeFile(path.join(tmp, ".fake-hunk-patch"), "--- a/smoke.ts\n+++ b/smoke.ts\n@@ -1,1 +1,1 @@\n-old\n+post-approval");
	for (const handler of handlers.get("agent_settled") ?? []) await handler({ type: "agent_settled" }, commandCtx);
	assert.equal(entries.at(-1).data.state, "re_review_due");
	await writeFile(path.join(tmp, ".fake-hunk-patch"), originalPatch);
	await rm(path.join(tmp, ".fake-hunk-live"), { force: true });

	const hunkDir = path.join(tmp, ".pi", "hunk");
	let sidecars = [];
	try { sidecars = await readdir(hunkDir); } catch {}
	assert.equal(sidecars.filter((name) => name.endsWith(".patch") || name.endsWith(".agent-context.json")).length, 0);
	assert.equal(await readFile(path.join(tmp, "smoke.ts"), "utf8"), "hello hunk\n");

	// Configure remains idle-only and retains its preset-first navigation.
	const blockedStart = configureSnapshots.length;
	await command.handler("configure", ctx(tmp, ui, entries, false));
	assert.equal(configureSnapshots.length, blockedStart);
	assert.ok(notifications.some((notice) => notice.type === "warning" && notice.message.includes("cannot open while agent responds")));
	await command.handler("configure", commandCtx);
	assert.ok(configureSnapshots.some((snapshot) => snapshot.includes("Hunk Configuration")));
	assert.ok(configureSnapshots.some((snapshot) => snapshot.includes("pi native")));
	assert.ok(configureSnapshots.some((snapshot) => snapshot.includes("Advanced")));

	console.log("pi-hunk smoke ok");
} finally {
	await rm(tmp, { recursive: true, force: true });
}
