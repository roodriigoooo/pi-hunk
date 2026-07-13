import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createCheckpointStore, type CheckpointDiagnostics, type CheckpointResult, type CheckpointStore, type ReviewCheckpoint } from "./checkpoint-store";
import { type HunkConfig, loadConfig } from "./config";
import { createHighlighterCache, type HighlighterCache } from "./highlighter-cache";
import { createHunkSessionClient, type HunkSessionClient } from "./hunk-session-client";
import { createRenderRecordStore, type RenderRecordStore } from "./render-records";
import { createReviewCoordinator, type ReviewCoordinator } from "./review-coordinator";
import type { ReviewSnapshot } from "./review-export";

export interface ExtensionState {
	getConfig(): HunkConfig;
	setConfig(next: HunkConfig): void;
	getLiveSession(): boolean;
	setLiveSession(live: boolean): void;
	currentCheckpoint(): ReviewCheckpoint | undefined;
	checkpointDiagnostics(): CheckpointDiagnostics;
	capture(snapshot: ReviewSnapshot): CheckpointResult;
	submit(): CheckpointResult;
	invalidateForAgentEdit(): CheckpointResult;
	abandon(): CheckpointResult;
	rehydrate(entries: readonly unknown[]): void;
	serial<T>(operation: () => Promise<T>): Promise<T>;
	readonly highlighters: HighlighterCache;
	readonly records: RenderRecordStore;
	readonly sessionClient: HunkSessionClient;
	readonly coordinator: ReviewCoordinator;
	reloadConfig(cwd: string): Promise<HunkConfig>;
}

export async function createExtensionState(pi: ExtensionAPI): Promise<ExtensionState> {
	let config = await loadConfig(process.cwd());
	let liveSession = false;
	let queue = Promise.resolve();
	const highlighters = createHighlighterCache();
	const records = createRenderRecordStore();
	const checkpoints: CheckpointStore = createCheckpointStore((event) => pi.appendEntry("hunk-checkpoint", event));
	const sessionClient = createHunkSessionClient();
	const coordinator = createReviewCoordinator({
		client: sessionClient,
		capture: (snapshot) => checkpoints.capture(snapshot),
	});
	await highlighters.refresh(config);

	return {
		getConfig: () => config,
		setConfig: (next) => {
			config = next;
		},
		getLiveSession: () => liveSession,
		setLiveSession: (live) => {
			liveSession = live;
		},
		currentCheckpoint: () => checkpoints.current(),
		checkpointDiagnostics: () => checkpoints.diagnostics(),
		capture: (snapshot) => checkpoints.capture(snapshot),
		submit: () => checkpoints.submit(),
		invalidateForAgentEdit: () => checkpoints.invalidateForAgentEdit(),
		abandon: () => checkpoints.abandon(),
		rehydrate: (entries) => checkpoints.rehydrate(entries),
		serial(operation) {
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
}
