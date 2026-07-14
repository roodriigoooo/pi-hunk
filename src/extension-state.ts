import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createCheckpointStore, type CheckpointDiagnostics, type CheckpointResult, type CheckpointStore, type ReviewCheckpoint } from "./checkpoint-store";
import { applyRenderBoundary, compareGitFingerprint, compareHunkFingerprint, createChangesetBaseline, isDefaultGitWorkingTreeReview, type ChangesetComparison } from "./changeset";
import { type HunkConfig, loadConfig } from "./config";
import { createGitChangesetAdapter, type GitChangesetResult } from "./git-changeset";
import { createHighlighterCache, type HighlighterCache } from "./highlighter-cache";
import { createHunkSessionClient, type HunkSessionClient } from "./hunk-session-client";
import { presentHunk, type HunkLiveSession, type HunkPresentation } from "./hunk-presentation";
import { createRenderRecordStore, type RenderRecordStore } from "./render-records";
import { createReviewCoordinator, type ReviewCoordinator } from "./review-coordinator";
import type { ReviewSnapshot } from "./review-export";

export interface ExtensionState {
	getConfig(): HunkConfig;
	setConfig(next: HunkConfig): void;
	getLiveSession(): HunkLiveSession;
	setLiveSession(live: HunkLiveSession | boolean): void;
	presentation(): HunkPresentation;
	getHunkHint(): string | undefined;
	refreshPresentation(ctx: ExtensionContext): void;
	currentCheckpoint(): ReviewCheckpoint | undefined;
	checkpointDiagnostics(): CheckpointDiagnostics;
	beginReview(snapshot: ReviewSnapshot, options: { cwd: string; allowGitFallback: boolean; signal?: AbortSignal }): Promise<CheckpointResult>;
	captureDraft(snapshot: ReviewSnapshot): CheckpointResult;
	submit(): CheckpointResult;
	abandon(): CheckpointResult;
	rehydrate(entries: readonly unknown[]): void;
	freshness(): ChangesetComparison | undefined;
	reconcileChangeset(ctx: ExtensionContext): Promise<ChangesetComparison | undefined>;
	serial<T>(operation: () => Promise<T>): Promise<T>;
	readonly highlighters: HighlighterCache;
	readonly records: RenderRecordStore;
	readonly sessionClient: HunkSessionClient;
	readonly coordinator: ReviewCoordinator;
	reloadConfig(cwd: string): Promise<HunkConfig>;
}

function hunkFailureReason(kind: string): "hunk_session_unavailable" | "hunk_export_unavailable" {
	return kind === "session_disappeared" ? "hunk_session_unavailable" : "hunk_export_unavailable";
}

export async function createExtensionState(pi: ExtensionAPI): Promise<ExtensionState> {
	let config = await loadConfig(process.cwd());
	let liveSession: HunkLiveSession = "none";
	let lastFreshness: ChangesetComparison | undefined;
	let queue = Promise.resolve();
	const highlighters = createHighlighterCache();
	const records = createRenderRecordStore();
	const checkpoints: CheckpointStore = createCheckpointStore((event) => pi.appendEntry("hunk-checkpoint", event));
	const sessionClient = createHunkSessionClient();
	const git = createGitChangesetAdapter();
	const coordinator = createReviewCoordinator({ client: sessionClient });
	await highlighters.refresh(config);

	const state: ExtensionState = {
		getConfig: () => config,
		setConfig: (next) => {
			config = next;
		},
		getLiveSession: () => liveSession,
		setLiveSession: (live) => {
			liveSession = typeof live === "boolean" ? (live ? "elsewhere" : "none") : live;
		},
		presentation: () => presentHunk({ enabled: config.hunk.enabled, checkpoint: checkpoints.current(), liveSession, freshness: lastFreshness }),
		getHunkHint: () => state.presentation().hunkHint,
		refreshPresentation(ctx) {
			const model = state.presentation();
			ctx.ui.setStatus("hunk", model.status);
		},
		currentCheckpoint: () => checkpoints.current(),
		checkpointDiagnostics: () => checkpoints.diagnostics(),
		beginReview: async (snapshot, options) => {
			const fallback = options.allowGitFallback
				? await git.captureFallback(options.cwd, snapshot, options.signal)
				: undefined;
			const baseline = createChangesetBaseline(snapshot, records.revision(), fallback?.fingerprint);
			const result = checkpoints.beginReview(snapshot, baseline);
			if (result.ok) lastFreshness = undefined;
			return result;
		},
		captureDraft: (snapshot) => checkpoints.captureDraft(snapshot),
		submit: () => checkpoints.submit(),
		abandon: () => checkpoints.abandon(),
		rehydrate: (entries) => {
			checkpoints.rehydrate(entries);
			lastFreshness = undefined;
		},
		freshness: () => lastFreshness,
		async reconcileChangeset(ctx) {
			const current = checkpoints.current();
			if (!current || current.state === "abandoned") return undefined;

			const read = await sessionClient.readReview(ctx.cwd, config, current.baseline.hunk.sessionId, ctx.signal);
			let comparison: ChangesetComparison;
			if (read.ok) {
				comparison = compareHunkFingerprint(current.baseline, read.value.snapshot);
				if (comparison.kind === "unchanged" && current.state === "reviewing") checkpoints.captureDraft(read.value.snapshot, current.baseline);
			} else if (read.error.kind === "session_disappeared") {
				if (!current.baseline.git) {
					comparison = {
						kind: "unknown",
						reason: isDefaultGitWorkingTreeReview(current.snapshot) ? "missing_git_fallback" : "hunk_target_unsupported",
					};
				} else {
					const currentGit: GitChangesetResult = await git.read(ctx.cwd, ctx.signal);
					comparison = currentGit.ok ? compareGitFingerprint(current.baseline, currentGit.value.fingerprint) : { kind: "unknown", reason: currentGit.reason };
				}
			} else {
				comparison = { kind: "unknown", reason: hunkFailureReason(read.error.kind) };
			}
			lastFreshness = applyRenderBoundary(comparison, current.baseline, records.revision());
			checkpoints.reconcileChangeset(lastFreshness);
			state.refreshPresentation(ctx);
			return lastFreshness;
		},
		serial<T>(operation: () => Promise<T>): Promise<T> {
			const next = queue.then(operation, operation);
			queue = next.then(() => undefined, () => undefined);
			return next;
		},
		highlighters,
		records,
		sessionClient,
		coordinator,
		async reloadConfig(cwd) {
			config = await loadConfig(cwd);
			await highlighters.refresh(config);
			return config;
		},
	};
	return state;
}
