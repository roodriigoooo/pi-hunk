import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { HunkConfig } from "./config";
import { createSamplingLease, handoffToSpawnedHunk, type Clock, type HunkHandoffResult, type HunkSpawner, type SamplingLease } from "./hunk-handoff";
import type { HunkFailure, HunkResult, HunkSessionClient } from "./hunk-session-client";
import type { ReviewSnapshot } from "./review-export";

export type ReviewCoordinatorResult = HunkHandoffResult;

type LeaseState = { lease: SamplingLease; exited: boolean };

export interface ReviewCoordinator {
	review(ctx: ExtensionCommandContext, config: HunkConfig, target?: { file: string; hunk: number }): Promise<ReviewCoordinatorResult>;
	latest(): ReviewSnapshot | undefined;
	finalExport(): Promise<HunkResult<ReviewSnapshot>>;
	cancel(): void;
	shutdown(): void;
}

function result(mode: "reuse" | "spawn", snapshot: ReviewSnapshot | undefined, error?: HunkFailure): ReviewCoordinatorResult {
	return { mode, sessionId: snapshot?.sessionId, exportError: error, lastValidExport: snapshot, reviewedRef: snapshot?.reviewedRef, patchIdentity: snapshot?.reviewIdentity };
}

/** Coordinates review ownership. It never mutates Hunk comments or sends model messages. */
export function createReviewCoordinator(options: {
	client: HunkSessionClient;
	capture?: (snapshot: ReviewSnapshot, mode: "reuse" | "spawn") => void | Promise<void>;
	spawn?: HunkSpawner;
	clock?: Clock;
}): ReviewCoordinator {
	let leaseState: LeaseState | undefined;
	let last: ReviewSnapshot | undefined;

	const stopLease = () => {
		leaseState?.lease.stop();
		leaseState = undefined;
	};
	const retain = (snapshot: ReviewSnapshot | undefined) => {
		if (snapshot) last = snapshot;
		return snapshot;
	};
	const startLease = (mode: "reuse" | "spawn", cwd: string, config: HunkConfig, sessionId: string) => {
		stopLease();
		const state: LeaseState = {
			exited: false,
			lease: createSamplingLease({
				mode,
				client: options.client,
				cwd,
				config,
				sessionId,
				clock: options.clock,
				onSessionLoss: () => {
					state.exited = true;
					const snapshot = retain(state.lease.latest());
				},
			}),
		};
		leaseState = state;
		return state;
	};

	return {
		async review(ctx, config, target) {
			stopLease();
			const probe = await options.client.probe(ctx.cwd, config, ctx.signal);
			if (probe.ok) {
				const read = await options.client.readReview(ctx.cwd, config, probe.value.sessionId, ctx.signal);
				if (!read.ok) return result("reuse", undefined, read.error);
				const snapshot = retain(read.value.snapshot)!;
				await options.capture?.(snapshot, "reuse");
				const state = startLease("reuse", ctx.cwd, config, probe.value.sessionId);
				if (target) void options.client.navigate(ctx.cwd, config, probe.value.sessionId, target, ctx.signal);
				return { ...result("reuse", snapshot), sessionId: state.lease.sessionId };
			}
			if (probe.error.kind !== "session_disappeared") return result("spawn", undefined, probe.error);
			if (ctx.mode !== "tui") return result("spawn", undefined, { ...probe.error, message: "/hunk review needs TUI mode to launch Hunk. Start it externally with: hunk diff --watch --no-exclude-untracked" });

			let handoff: HunkHandoffResult = result("spawn", undefined);
			await ctx.ui.custom<void>((tui, _theme, _keys, done) => {
				void handoffToSpawnedHunk({
					client: options.client,
					cwd: ctx.cwd,
					config,
					tui,
					spawn: options.spawn,
					clock: options.clock,
					onSessionReady: (lease) => {
						stopLease();
						leaseState = { lease, exited: false };
						retain(lease.latest());
					},
				})
					.then(async (next) => {
						handoff = next;
						const snapshot = retain(next.lastValidExport);
						if (snapshot) await options.capture?.(snapshot, "spawn");
						if (leaseState) leaseState.exited = true;
					})
					.finally(() => done());
				return { render: () => [], invalidate() {} };
			});
			return handoff;
		},
		latest: () => leaseState?.lease.latest() ?? last,
		async finalExport() {
			const state = leaseState;
			if (!state) return last ? { ok: true, value: last } : { ok: false, error: { kind: "session_disappeared", message: "No Hunk review lease exists. Run /hunk review first.", args: [] } };
			const sampled = await state.lease.finalSample();
			const sampleError = state.lease.lastError();
			// Once either an owned or reused session has genuinely exited, its
			// last complete export is the authoritative handoff. While a session
			// is still live, malformed/unsupported reads remain hard refusals.
			if (sampleError && !state.exited) return { ok: false, error: sampleError };
			const retained = sampled ?? last;
			if (!retained) return { ok: false, error: sampleError ?? { kind: "session_disappeared", message: "No complete Hunk review export is available.", args: [] } };
			last = retained;
			return { ok: true, value: retained };
		},
		cancel: stopLease,
		shutdown: stopLease,
	};
}
