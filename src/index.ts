import {
	createEditToolDefinition,
	createWriteToolDefinition,
	type EditToolDetails,
	type EditToolInput,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	type Theme,
	type ToolRenderContext,
	type WriteToolInput,
} from "@earendil-works/pi-coding-agent";
import { Key, Text, type AutocompleteItem } from "@earendil-works/pi-tui";
import fs from "node:fs/promises";
import type { ReviewCheckpoint } from "./checkpoint-store";
import { openHunkConfig } from "./configure";
import { compareHunkFingerprint, unknownReasonMessage } from "./changeset";
import { createDiffView, writePatch } from "./diff-view";
import { createExtensionState, type ExtensionState } from "./extension-state";
import { displayPath, resolveUserPath } from "./paths";
import { type RenderRecord } from "./render-records";

const HUNK_SUBCOMMANDS: AutocompleteItem[] = [
	{ value: "status", label: "status", description: "Show checkpoint and Hunk session status." },
	{ value: "review", label: "review", description: "Open Hunk review or attach its existing side pane." },
	{ value: "submit", label: "submit", description: "Submit checkpointed human review notes." },
	{ value: "abandon", label: "abandon", description: "Abandon active review checkpoint." },
	{ value: "configure", label: "configure", description: "Open configuration TUI." },
];

function hunkArgumentCompletions(prefix: string): AutocompleteItem[] {
	const trimmed = prefix.trim();
	return trimmed ? HUNK_SUBCOMMANDS.filter((item) => item.value.startsWith(trimmed)) : HUNK_SUBCOMMANDS;
}

function diagnostic(ctx: ExtensionContext, message: string, type: "info" | "warning" | "error" = "info"): void {
	if (ctx.mode === "print" || ctx.mode === "json") {
		process.stderr.write(`[pi-hunk] ${message}\n`);
		return;
	}
	ctx.ui.notify(message, type);
}

function submissionContent(checkpoint: ReviewCheckpoint): string {
	const snapshot = checkpoint.snapshot;
	const lines = [
		"Hunk human review submission:",
		`Checkpoint: ${checkpoint.id} revision ${checkpoint.revision}`,
		`Patch digest: ${snapshot.patchDigest}`,
		`Revision captured: ${checkpoint.revisionCapturedAt}`,
	];
	if (checkpoint.submittedAt) lines.push(`Submitted: ${checkpoint.submittedAt}`);
	if (snapshot.reviewedRef) lines.push(`Reviewed ref: ${snapshot.reviewedRef}`);
	for (const [index, note] of snapshot.notes.entries()) {
		lines.push("", `Note ${index + 1}:`, `File: ${note.file}`);
		if (note.id !== undefined) lines.push(`Note ID: ${note.id}`);
		if (note.title !== undefined) lines.push(`Title: ${note.title}`);
		if (note.hunk !== undefined) lines.push(`Hunk: ${JSON.stringify(note.hunk)}`);
		if (note.oldRange !== undefined) lines.push(`Old range: ${JSON.stringify(note.oldRange)}`);
		if (note.newRange !== undefined) lines.push(`New range: ${JSON.stringify(note.newRange)}`);
		if (note.author !== undefined) lines.push(`Author: ${JSON.stringify(note.author)}`);
		lines.push("Body:", note.body);
	}
	return lines.join("\n");
}

function freshnessLabel(state: ExtensionState): string {
	const freshness = state.freshness();
	if (!freshness) return "not checked";
	if (freshness.kind === "unknown") return `unknown · ${freshness.reason}`;
	return freshness.kind === "unchanged"
		? `unchanged · ${freshness.source}`
		: `changed · ${freshness.source}${freshness.unrendered ? " · unrendered" : ""}`;
}

function checkpointLabel(state: ExtensionState): string {
	const checkpoint = state.currentCheckpoint();
	if (!checkpoint) return "no checkpoint";
	return `${checkpoint.id} revision ${checkpoint.revision} · ${checkpoint.state} · ${checkpoint.snapshot.notes.length} user note${checkpoint.snapshot.notes.length === 1 ? "" : "s"}`;
}

async function submitLocked(ctx: ExtensionCommandContext, pi: ExtensionAPI, state: ExtensionState): Promise<void> {
	const current = state.currentCheckpoint();
	if (!current || current.state !== "reviewing") {
		diagnostic(ctx, "/hunk submit requires one reviewing checkpoint. Run /hunk review first.", "warning");
		return;
	}

	const freshness = await state.reconcileChangeset(ctx);
	if (freshness?.kind === "changed") {
		diagnostic(ctx, freshness.unrendered
			? "The changeset changed outside an inline diff. Checkpoint is re-review due; run /hunk review again."
			: "The reviewed changeset changed. Checkpoint is re-review due; run /hunk review again.", "warning");
		return;
	}
	if (freshness?.kind === "unknown") {
		diagnostic(ctx, `Freshness is unknown: ${unknownReasonMessage(freshness.reason)} Submission applies to the captured reviewed snapshot.`, "warning");
	}

	const live = await state.coordinator.finalExport();
	if (!live.ok) {
		diagnostic(ctx, `${live.error.message} Run /hunk review after fixing Hunk session state.`, "warning");
		return;
	}
	const finalComparison = compareHunkFingerprint(current.baseline, live.value);
	if (finalComparison.kind === "changed") {
		await state.reconcileChangeset(ctx);
		diagnostic(ctx, "The final Hunk export changed. Checkpoint is re-review due; run /hunk review again.", "warning");
		return;
	}

	const captured = state.captureDraft(live.value);
	if (!captured.ok) {
		diagnostic(ctx, captured.error.message, "warning");
		return;
	}
	const submitted = state.submit();
	if (!submitted.ok) {
		diagnostic(ctx, submitted.error.message, "warning");
		return;
	}
	state.coordinator.cancel();
	state.setLiveSession("none");
	state.refreshPresentation(ctx);
	if (!submitted.checkpoint.snapshot.notes.length) {
		diagnostic(ctx, `Review ${submitted.checkpoint.id.slice(0, 8)} r${submitted.checkpoint.revision} approved. No model turn started.`, "info");
		return;
	}
	pi.sendMessage(
		{
			customType: "hunk-review-submission",
			content: submissionContent(submitted.checkpoint),
			display: true,
			details: {
				checkpointId: submitted.checkpoint.id,
				revision: submitted.checkpoint.revision,
				revisionCapturedAt: submitted.checkpoint.revisionCapturedAt,
				submittedAt: submitted.checkpoint.submittedAt,
				reviewedRef: submitted.checkpoint.snapshot.reviewedRef,
				patchDigest: submitted.checkpoint.snapshot.patchDigest,
				notes: submitted.checkpoint.snapshot.notes,
			},
		},
		{ triggerTurn: true, deliverAs: "followUp" },
	);
	diagnostic(ctx, `Submitted ${submitted.checkpoint.snapshot.notes.length} Hunk note(s) as one follow-up turn.`, "info");
}

async function handleSubmit(ctx: ExtensionCommandContext, pi: ExtensionAPI, state: ExtensionState): Promise<void> {
	if (!ctx.isIdle()) {
		diagnostic(ctx, "/hunk submit requires idle Pi. Wait for agent response to finish.", "warning");
		return;
	}
	await state.serial(() => submitLocked(ctx, pi, state));
}

async function abandonLocked(ctx: ExtensionCommandContext, state: ExtensionState): Promise<void> {
	const abandoned = state.abandon();
	if (!abandoned.ok) {
		diagnostic(ctx, abandoned.error.message, "warning");
		return;
	}
	state.coordinator.cancel();
	state.setLiveSession("none");
	state.refreshPresentation(ctx);
	diagnostic(ctx, `Abandoned checkpoint ${abandoned.checkpoint.id.slice(0, 8)} r${abandoned.checkpoint.revision}. No model turn started.`, "info");
}

async function runReview(ctx: ExtensionContext, pi: ExtensionAPI, state: ExtensionState): Promise<void> {
	if (!ctx.isIdle()) {
		diagnostic(ctx, "/hunk review requires idle Pi. Wait for agent response to finish.", "warning");
		return;
	}
	const config = state.getConfig();
	if (!config.hunk.enabled) {
		diagnostic(ctx, "Hunk integration is disabled in config.", "warning");
		return;
	}

	await state.serial(async () => {
		await state.reconcileChangeset(ctx);
		const recent = state.records.mostRecent();
		const handoff = await state.coordinator.review(ctx as ExtensionCommandContext, config, recent ? { file: displayPath(recent.filePath, ctx.cwd), hunk: 1 } : undefined);
		const snapshot = handoff.lastValidExport;

		if (handoff.mode === "reuse") {
			if (!snapshot) {
				state.setLiveSession("none");
				state.refreshPresentation(ctx);
				diagnostic(ctx, handoff.exportError?.message ?? "The existing Hunk session did not provide a complete review export.", "error");
				return;
			}
			state.setLiveSession("elsewhere");
			const captured = await state.beginReview(snapshot, { cwd: ctx.cwd, allowGitFallback: false, signal: ctx.signal });
			if (!captured.ok) {
				diagnostic(ctx, captured.error.message, "warning");
				return;
			}
			state.refreshPresentation(ctx);
			diagnostic(ctx, "Review is active elsewhere; use /hunk submit here when the Hunk pane is ready.", "info");
			return;
		}

		state.setLiveSession("none");
		if (!snapshot) {
			diagnostic(ctx, handoff.exportError?.message ?? handoff.launchError ?? (handoff.signal ? `Hunk ended by ${handoff.signal}.` : handoff.exitCode ? `Hunk exited with code ${handoff.exitCode}.` : "Hunk closed without a complete review export."), "error");
			state.refreshPresentation(ctx);
			return;
		}

		const captured = await state.beginReview(snapshot, { cwd: ctx.cwd, allowGitFallback: true, signal: ctx.signal });
		if (!captured.ok) {
			diagnostic(ctx, captured.error.message, "warning");
			return;
		}
		state.refreshPresentation(ctx);

		const recoverableWarning = handoff.exportError?.message
			?? handoff.launchError
			?? (handoff.signal ? `Hunk ended by ${handoff.signal}.` : handoff.exitCode !== undefined && handoff.exitCode !== null && handoff.exitCode !== 0 ? `Hunk exited with code ${handoff.exitCode}.` : undefined);
		if (recoverableWarning) diagnostic(ctx, `Hunk closed with a recoverable warning: ${recoverableWarning} The complete checkpoint was retained.`, "warning");

		const choice = ctx.mode === "tui" && typeof ctx.ui.select === "function"
			? await ctx.ui.select("Hunk review", ["Submit now", "Keep for later", "Abandon"])
			: undefined;
		if (choice === "Submit now") {
			if (!ctx.isIdle()) {
				diagnostic(ctx, "Submit now requires idle Pi; the checkpoint was kept for later.", "warning");
				return;
			}
			await submitLocked(ctx as ExtensionCommandContext, pi, state);
		} else if (choice === "Abandon") {
			await abandonLocked(ctx as ExtensionCommandContext, state);
		} else {
			diagnostic(ctx, "Review kept for later. Use /hunk submit or /hunk abandon.", "info");
		}
	});
}

async function handleHunkCommand(args: string, ctx: ExtensionCommandContext, pi: ExtensionAPI, state: ExtensionState): Promise<void> {
	const config = state.getConfig();
	const sub = args.trim().split(/\s+/).filter(Boolean)[0] ?? "status";
	if (!config.hunk.enabled && sub !== "status") {
		diagnostic(ctx, "Hunk integration is disabled in config.", "warning");
		return;
	}
	if (sub === "status") {
		const freshness = await state.reconcileChangeset(ctx);
		const probe = await state.sessionClient.probe(ctx.cwd, config, ctx.signal);
		state.setLiveSession(probe.ok ? (state.getLiveSession() === "local" ? "local" : "elsewhere") : "none");
		state.refreshPresentation(ctx);
		const diagnostics = state.checkpointDiagnostics();
		const session = probe.ok ? `live session ${probe.value.sessionId}` : `no live session (${probe.error.kind})`;
		const ignored = diagnostics.ignoredEntries
			? ` · ${diagnostics.ignoredEntries} malformed journal entr${diagnostics.ignoredEntries === 1 ? "y" : "ies"} ignored${diagnostics.lastError ? ` (${diagnostics.lastError})` : ""}`
			: "";
		const freshnessText = freshness ? (freshness.kind === "unknown" ? `unknown freshness (${freshness.reason})` : `${freshness.kind} freshness from ${freshness.source}`) : "freshness not checked";
		diagnostic(ctx, `pi-hunk: ${checkpointLabel(state)} · live ${state.getLiveSession()} · ${session} · ${freshnessText}${ignored}`, probe.ok ? "info" : "warning");
		return;
	}
	if (sub === "review") {
		await runReview(ctx, pi, state);
		return;
	}
	if (sub === "submit") {
		await handleSubmit(ctx, pi, state);
		return;
	}
	if (sub === "abandon") {
		if (!ctx.isIdle()) {
			diagnostic(ctx, "/hunk abandon requires idle Pi. Wait for agent response to finish.", "warning");
			return;
		}
		await state.serial(() => abandonLocked(ctx, state));
		return;
	}
	diagnostic(ctx, "Unknown /hunk command. Use status, review, submit, abandon, or configure.", "warning");
}

export default async function (pi: ExtensionAPI) {
	const state = await createExtensionState(pi);
	const editBase = createEditToolDefinition(process.cwd());
	const writeBase = createWriteToolDefinition(process.cwd());

	const refreshAfterSession = async (ctx: ExtensionContext) => {
		await state.reconcileChangeset(ctx);
		const probe = await state.sessionClient.probe(ctx.cwd, state.getConfig(), ctx.signal);
		state.setLiveSession(probe.ok ? "elsewhere" : "none");
		state.refreshPresentation(ctx);
	};

	pi.on("session_start", async (_event, ctx) => {
		await state.reloadConfig(ctx.cwd);
		state.rehydrate(ctx.sessionManager.getBranch());
		await refreshAfterSession(ctx);
	});
	pi.on("session_tree", async (_event, ctx) => {
		state.coordinator.cancel();
		state.rehydrate(ctx.sessionManager.getBranch());
		await refreshAfterSession(ctx);
	});
	pi.on("agent_settled", async (_event, ctx) => {
		await state.reconcileChangeset(ctx);
		state.refreshPresentation(ctx);
	});
	pi.on("session_shutdown", () => state.coordinator.shutdown());

	pi.registerCommand("hunk", {
		description: "pi-hunk diff renderer and explicit Hunk review checkpoints (/hunk status, /hunk review, /hunk submit, /hunk abandon, /hunk configure)",
		getArgumentCompletions: hunkArgumentCompletions,
		handler: async (args, ctx) => {
			const sub = args.trim().split(/\s+/).filter(Boolean)[0];
			if (sub === "configure") {
				if (!ctx.isIdle()) {
					diagnostic(ctx, "/hunk configure cannot open while agent responds.", "warning");
					return;
				}
				await openHunkConfig(
					ctx,
					() => state.getConfig(),
					async (next) => {
						state.setConfig(next);
						await state.highlighters.refresh(next);
						state.refreshPresentation(ctx);
					},
					(next, invalidate) => state.highlighters.get(next, invalidate),
				);
				state.refreshPresentation(ctx);
				return;
			}
			await handleHunkCommand(args, ctx, pi, state);
		},
	});

	pi.registerShortcut(Key.ctrlShift("h"), {
		description: "Open Hunk review checkpoint.",
		handler: async (ctx) => runReview(ctx, pi, state),
	});

	pi.registerTool({
		...editBase,
		name: "edit",
		label: "Edit ✦ Hunk",
		async execute(toolCallId, params: EditToolInput, signal, onUpdate, ctx: ExtensionContext) {
			const tool = createEditToolDefinition(ctx.cwd);
			const result = await tool.execute(toolCallId, params, signal, onUpdate, ctx);
			const details = result.details as EditToolDetails | undefined;
			if (details?.patch) {
				const filePath = resolveUserPath(params.path, ctx.cwd);
				state.records.record(toolCallId, {
					tool: "edit",
					filePath,
					patch: details.patch,
					summary: `Edited ${displayPath(filePath, ctx.cwd)} (${params.edits.length} replacement${params.edits.length === 1 ? "" : "s"})`,
				} satisfies RenderRecord);
			}
			return result;
		},
		renderCall(args: EditToolInput, theme: Theme) {
			return new Text(`${theme.fg("accent", "✦")} ${theme.fg("toolTitle", theme.bold("edit"))} ${theme.fg("muted", args.path)} ${theme.fg("dim", `· ${args.edits?.length ?? 0} block(s)`)}`, 0, 0);
		},
		renderResult(result, _options, theme: Theme, context: ToolRenderContext<any, EditToolInput>) {
			const config = state.getConfig();
			const details = result.details as EditToolDetails | undefined;
			const record = state.records.get(context.toolCallId);
			const patch = record?.patch ?? details?.patch;
			const filePath = record?.filePath ?? resolveUserPath(context.args.path, context.cwd);
			if (!config.enabled || !patch) return new Text(details?.diff ?? "Edited file", 0, 0);
			return createDiffView({
				patch,
				filePath,
				cwd: context.cwd,
				title: "edited",
				config,
				highlighter: state.highlighters.get(config, context.invalidate),
				theme,
				hunkHint: state.getHunkHint(),
				invalidate: context.invalidate,
			});
		},
	});

	pi.registerTool({
		...writeBase,
		name: "write",
		label: "Write ✦ Hunk",
		renderShell: "self",
		async execute(toolCallId, params: WriteToolInput, signal, onUpdate, ctx: ExtensionContext) {
			const filePath = resolveUserPath(params.path, ctx.cwd);
			let before = "";
			let existed = false;
			const tool = createWriteToolDefinition(ctx.cwd, {
				operations: {
					mkdir: async (dir) => {
						await fs.mkdir(dir, { recursive: true });
					},
					writeFile: async (absolutePath, content) => {
						try {
							before = await fs.readFile(absolutePath, "utf8");
							existed = true;
						} catch {
							before = "";
							existed = false;
						}
						await fs.writeFile(absolutePath, content, "utf8");
					},
				},
			});
			const result = await tool.execute(toolCallId, params, signal, onUpdate, ctx);
			const rel = displayPath(filePath, ctx.cwd);
			const patch = writePatch(existed ? `a/${rel}` : "/dev/null", `b/${rel}`, before, params.content);
			state.records.record(toolCallId, {
				tool: "write",
				filePath,
				patch,
				summary: `${existed ? "Rewrote" : "Created"} ${rel}`,
			} satisfies RenderRecord);
			return result;
		},
		renderCall(args: WriteToolInput, theme: Theme) {
			return new Text(`${theme.fg("accent", "✦")} ${theme.fg("toolTitle", theme.bold("write"))} ${theme.fg("muted", args.path)} ${theme.fg("dim", `· ${args.content?.split("\n").length ?? 0} line(s)`)}`, 0, 0);
		},
		renderResult(_result, _options, theme: Theme, context: ToolRenderContext<any, WriteToolInput>) {
			const config = state.getConfig();
			const record = state.records.get(context.toolCallId);
			if (!config.enabled || !record?.patch) return new Text("Wrote file", 0, 0);
			return createDiffView({
				patch: record.patch,
				filePath: record.filePath,
				cwd: context.cwd,
				title: record.summary.startsWith("Created") ? "created" : "wrote",
				config,
				highlighter: state.highlighters.get(config, context.invalidate),
				theme,
				hunkHint: state.getHunkHint(),
				invalidate: context.invalidate,
			});
		},
	});
}
