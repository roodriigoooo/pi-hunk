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
import { Text, type AutocompleteItem } from "@earendil-works/pi-tui";
import fs from "node:fs/promises";
import type { ReviewCheckpoint } from "./checkpoint-store";
import { openHunkConfig } from "./configure";
import { createDiffView, DiffComponent, writePatch } from "./diff-view";
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

function checkpointLabel(checkpoint: ReviewCheckpoint | undefined): string {
	if (!checkpoint) return "no checkpoint";
	return `${checkpoint.state} · ${checkpoint.id.slice(0, 8)} r${checkpoint.revision} · ${checkpoint.snapshot.notes.length} user note${checkpoint.snapshot.notes.length === 1 ? "" : "s"}`;
}

function hunkFailureMessage(message: string): string {
	return `${message} Run /hunk review after fixing Hunk session state.`;
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

function sameReviewedPatch(checkpoint: ReviewCheckpoint, snapshot: { reviewIdentity: string }): boolean {
	return checkpoint.snapshot.reviewIdentity === snapshot.reviewIdentity;
}

async function handleSubmit(ctx: ExtensionCommandContext, pi: ExtensionAPI, state: ExtensionState) {
	if (!ctx.isIdle()) {
		ctx.ui.notify("/hunk submit requires idle Pi. Wait for agent response to finish.", "warning");
		return;
	}
	await state.serial(async () => {
		const current = state.currentCheckpoint();
		if (!current || current.state !== "reviewing") {
			ctx.ui.notify("/hunk submit requires one reviewing checkpoint. Run /hunk review first.", "warning");
			return;
		}
		const live = await state.coordinator.finalExport();
		if (!live.ok) {
			ctx.ui.notify(hunkFailureMessage(live.error.message), "warning");
			return;
		}
		if (!sameReviewedPatch(current, live.value)) {
			const due = state.invalidateForAgentEdit();
			ctx.ui.notify(due.ok ? "Reviewed patch changed. Checkpoint is re-review due; run /hunk review again." : due.error.message, "warning");
			return;
		}
		const captured = state.capture(live.value);
		if (!captured.ok) {
			ctx.ui.notify(captured.error.message, "warning");
			return;
		}
		const submitted = state.submit();
		if (!submitted.ok) {
			ctx.ui.notify(submitted.error.message, "warning");
			return;
		}
		state.coordinator.cancel();
		if (!submitted.checkpoint.snapshot.notes.length) {
			ctx.ui.notify(`Review ${submitted.checkpoint.id.slice(0, 8)} r${submitted.checkpoint.revision} approved. No model turn started.`, "info");
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
		ctx.ui.notify(`Submitted ${submitted.checkpoint.snapshot.notes.length} Hunk note(s) as one follow-up turn.`, "info");
	});
}

async function handleHunkCommand(args: string, ctx: ExtensionCommandContext, pi: ExtensionAPI, state: ExtensionState) {
	const config = state.getConfig();
	const sub = args.trim().split(/\s+/).filter(Boolean)[0] ?? "status";
	if (!config.hunk.enabled && sub !== "status") {
		ctx.ui.notify("Hunk integration is disabled in config.", "warning");
		return;
	}
	if (sub === "status") {
		const probe = await state.sessionClient.probe(ctx.cwd, config, ctx.signal);
		state.setLiveSession(probe.ok);
		const diagnostics = state.checkpointDiagnostics();
		const session = probe.ok ? `Hunk session ${probe.value.sessionId}` : probe.error.message;
		const ignored = diagnostics.ignoredEntries ? ` · ${diagnostics.ignoredEntries} malformed checkpoint entry ignored` : "";
		ctx.ui.notify(`pi-hunk active. ${checkpointLabel(state.currentCheckpoint())}. ${session}.${ignored} Commands: /hunk status, /hunk review, /hunk submit, /hunk abandon, /hunk configure.`, probe.ok ? "info" : "warning");
		return;
	}
	if (sub === "review") {
		if (!ctx.isIdle()) {
			ctx.ui.notify("/hunk review requires idle Pi. Wait for agent response to finish.", "warning");
			return;
		}
		await state.serial(async () => {
			const recent = state.records.mostRecent();
			const handoff = await state.coordinator.review(ctx, config, recent ? { file: displayPath(recent.filePath, ctx.cwd), hunk: 1 } : undefined);
			state.setLiveSession(handoff.mode === "reuse" && !!handoff.sessionId);
			if (handoff.exportError && !handoff.lastValidExport) {
				ctx.ui.notify(handoff.exportError.message, "warning");
				return;
			}
			if (handoff.launchError || handoff.signal || (handoff.exitCode !== undefined && handoff.exitCode !== null && handoff.exitCode !== 0)) {
				const ending = handoff.launchError ?? (handoff.signal ? `Hunk ended by ${handoff.signal}.` : `Hunk exited with code ${handoff.exitCode}.`);
				ctx.ui.notify(handoff.lastValidExport ? `${ending} The last complete checkpoint was retained; use /hunk submit or /hunk abandon.` : ending, "warning");
				return;
			}
			if (handoff.exportError && handoff.lastValidExport) {
				ctx.ui.notify(`Hunk closed with a recoverable export warning: ${handoff.exportError.message} The last complete checkpoint was retained.`, "warning");
				return;
			}
			ctx.ui.notify(handoff.mode === "reuse" ? `Attached Hunk session ${handoff.sessionId}. Sampling stays local until /hunk submit.` : handoff.lastValidExport ? "Hunk closed. Final checkpoint captured; use /hunk submit or /hunk abandon." : "Hunk closed without a complete review export.", "info");
		});
		return;
	}
	if (sub === "submit") return handleSubmit(ctx, pi, state);
	if (sub === "abandon") {
		await state.serial(async () => {
			const abandoned = state.abandon();
			if (!abandoned.ok) {
				ctx.ui.notify(abandoned.error.message, "warning");
				return;
			}
			state.coordinator.cancel();
			ctx.ui.notify(`Abandoned checkpoint ${abandoned.checkpoint.id.slice(0, 8)} r${abandoned.checkpoint.revision}. No model turn started.`, "info");
		});
		return;
	}
	ctx.ui.notify("Unknown /hunk command. Use status, review, submit, abandon, or configure.", "warning");
}

export default async function (pi: ExtensionAPI) {
	const state = await createExtensionState(pi);
	const editBase = createEditToolDefinition(process.cwd());
	const writeBase = createWriteToolDefinition(process.cwd());

	pi.on("session_start", async (_event, ctx) => {
		await state.reloadConfig(ctx.cwd);
		state.rehydrate(ctx.sessionManager.getBranch());
		ctx.ui.setStatus("hunk", state.getConfig().enabled ? "hunk ✦" : undefined);
		state.sessionClient
			.probe(ctx.cwd, state.getConfig(), ctx.signal)
			.then((probe) => state.setLiveSession(probe.ok))
			.catch(() => state.setLiveSession(false));
	});
	pi.on("session_tree", (_event, ctx) => {
		state.coordinator.cancel();
		state.rehydrate(ctx.sessionManager.getBranch());
	});
	pi.on("session_shutdown", () => state.coordinator.shutdown());

	pi.registerCommand("hunk", {
		description: "pi-hunk diff renderer and explicit Hunk review checkpoints (/hunk status, /hunk review, /hunk submit, /hunk abandon, /hunk configure)",
		getArgumentCompletions: hunkArgumentCompletions,
		handler: async (args, ctx) => {
			const sub = args.trim().split(/\s+/).filter(Boolean)[0];
			if (sub === "configure") {
				if (!ctx.isIdle()) {
					ctx.ui.notify("/hunk configure cannot open while agent responds.", "warning");
					return;
				}
				await openHunkConfig(
					ctx,
					() => state.getConfig(),
					async (next) => {
						state.setConfig(next);
						await state.highlighters.refresh(next);
					},
					(next, invalidate) => state.highlighters.get(next, invalidate),
				);
				return;
			}
			await handleHunkCommand(args, ctx, pi, state);
		},
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
				state.invalidateForAgentEdit();
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
				liveSession: state.getLiveSession(),
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
			state.invalidateForAgentEdit();
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
				liveSession: state.getLiveSession(),
				invalidate: context.invalidate,
			});
		},
	});
}
