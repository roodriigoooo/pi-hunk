import { spawn, type ChildProcess } from "node:child_process";
import type { TUI } from "@earendil-works/pi-tui";
import type { HunkConfig } from "./config";
import type { HunkFailure, HunkSessionClient } from "./hunk-session-client";
import type { ReviewSnapshot } from "./review-export";

export type HunkHandoffResult = Readonly<{
	mode: "reuse" | "spawn";
	sessionId?: string;
	pid?: number;
	exitCode?: number | null;
	signal?: string | null;
	launchError?: string;
	exportError?: HunkFailure;
	lastValidExport?: ReviewSnapshot;
	reviewedRef?: string;
	patchIdentity?: string;
}>;

export type HunkChild = Pick<ChildProcess, "pid" | "kill" | "on">;
export type HunkSpawner = (binary: string, args: string[], options: { cwd: string; shell: false; stdio: "inherit" }) => HunkChild;
export type Clock = Readonly<{ setTimeout(fn: () => void, ms: number): ReturnType<typeof setTimeout>; clearTimeout(id: ReturnType<typeof setTimeout>): void }>;

export type SamplingLease = Readonly<{
	mode: "reuse" | "spawn";
	sessionId: string;
	latest(): ReviewSnapshot | undefined;
	lastError(): HunkFailure | undefined;
	ready(): Promise<ReviewSnapshot | undefined>;
	finalSample(): Promise<ReviewSnapshot | undefined>;
	stop(): void;
}>;

const systemClock: Clock = { setTimeout, clearTimeout };
const systemSpawn: HunkSpawner = (binary, args, options) => spawn(binary, args, options);

function sleep(clock: Clock, ms: number): Promise<void> {
	return new Promise((resolve) => clock.setTimeout(resolve, ms));
}

function disappeared(error: HunkFailure): boolean {
	return error.kind === "session_disappeared";
}

/** Serial, read-only sampling. Bad samples never replace a last known export. */
export function createSamplingLease(options: {
	mode: "reuse" | "spawn";
	client: HunkSessionClient;
	cwd: string;
	config: HunkConfig;
	sessionId: string;
	clock?: Clock;
	onSessionLoss?: () => void;
}): SamplingLease {
	const clock = options.clock ?? systemClock;
	let latest: ReviewSnapshot | undefined;
	let error: HunkFailure | undefined;
	let stopped = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let serial = Promise.resolve<ReviewSnapshot | undefined>(undefined);

	const sample = async (): Promise<ReviewSnapshot | undefined> => {
		if (stopped) return latest;
		const read = await options.client.readReview(options.cwd, options.config, options.sessionId);
		if (stopped) return latest;
		if (read.ok) {
			latest = read.value.snapshot;
			error = undefined;
			return latest;
		}
		error = read.error;
		if (disappeared(read.error)) {
			stopped = true;
			if (timer) clock.clearTimeout(timer);
			options.onSessionLoss?.();
		}
		return latest;
	};
	const enqueue = () => {
		const next = serial.then(sample, sample);
		serial = next;
		return next;
	};
	const tick = () => {
		void enqueue().finally(() => {
			if (!stopped) timer = clock.setTimeout(tick, 500);
		});
	};
	const initial = enqueue().finally(() => {
		if (!stopped) timer = clock.setTimeout(tick, 500);
	});

	return {
		mode: options.mode,
		sessionId: options.sessionId,
		latest: () => latest,
		lastError: () => error,
		ready: () => initial,
		finalSample: enqueue,
		stop() {
			stopped = true;
			if (timer) clock.clearTimeout(timer);
		},
	};
}

function childClosed(child: HunkChild): Promise<{ code: number | null; signal: string | null; launchError?: string }> {
	return new Promise((resolve) => {
		let done = false;
		const finish = (value: { code: number | null; signal: string | null; launchError?: string }) => {
			if (done) return;
			done = true;
			resolve(value);
		};
		child.on("error", (error: Error) => finish({ code: null, signal: null, launchError: error.message }));
		child.on("close", (code: number | null, signal: NodeJS.Signals | null) => finish({ code, signal }));
	});
}

/** Owns only child/TUI lifecycle. Reused sessions are never spawned or killed. */
export async function handoffToSpawnedHunk(options: {
	client: HunkSessionClient;
	cwd: string;
	config: HunkConfig;
	tui: Pick<TUI, "stop" | "start" | "requestRender">;
	spawn?: HunkSpawner;
	clock?: Clock;
	onSessionReady?: (lease: SamplingLease) => void;
}): Promise<HunkHandoffResult> {
	const clock = options.clock ?? systemClock;
	const launch = options.spawn ?? systemSpawn;
	let child: HunkChild | undefined;
	let lease: SamplingLease | undefined;
	let lastError: HunkFailure | undefined;
	let stoppedTui = false;
	try {
		options.tui.stop();
		stoppedTui = true;
		child = launch(options.config.hunk.binary, ["diff", "--watch", "--no-exclude-untracked"], { cwd: options.cwd, shell: false, stdio: "inherit" });
		const closed = childClosed(child);
		let processDone = false;
		void closed.then(() => (processDone = true));
		while (!processDone) {
			const probe = await options.client.probe(options.cwd, options.config);
			const pidMismatch = probe.ok && child.pid !== undefined && probe.value.pid !== undefined && probe.value.pid !== child.pid;
			if (probe.ok && !pidMismatch) {
				lease = createSamplingLease({ mode: "spawn", client: options.client, cwd: options.cwd, config: options.config, sessionId: probe.value.sessionId, clock });
				await lease.ready();
				lastError = lease.lastError();
				options.onSessionReady?.(lease);
				break;
			}
			lastError = probe.ok
				? { kind: "session_disappeared", message: "Waiting for the launched Hunk process to register its own session.", args: ["session", "get", "--repo", options.cwd, "--json"] }
				: probe.error;
			if (!probe.ok && (probe.error.kind === "missing_binary" || probe.error.kind === "unsupported_command")) break;
			await sleep(clock, 500);
		}
		const exit = await closed;
		if (lease) {
			await lease.finalSample(); // one bounded final read; preserves latest on failure
			const finalError = lease.lastError();
			const retained = lease.latest();
			// A launched Hunk unregisters its session as it exits. That expected
			// disappearance must not turn a valid retained export into a failed
			// handoff; malformed/unsupported final samples remain visible warnings.
			lastError = finalError?.kind === "session_disappeared" && retained ? undefined : (finalError ?? lastError);
			lease.stop();
		}
		const snapshot = lease?.latest();
		return {
			mode: "spawn",
			sessionId: lease?.sessionId,
			pid: child.pid,
			exitCode: exit.code,
			signal: exit.signal,
			launchError: exit.launchError,
			exportError: lastError,
			lastValidExport: snapshot,
			reviewedRef: snapshot?.reviewedRef,
			patchIdentity: snapshot?.reviewIdentity,
		};
	} catch (error) {
		return { mode: "spawn", pid: child?.pid, launchError: String(error), exportError: lastError, lastValidExport: lease?.latest(), reviewedRef: lease?.latest()?.reviewedRef, patchIdentity: lease?.latest()?.reviewIdentity };
	} finally {
		lease?.stop();
		if (stoppedTui) {
			options.tui.start();
			options.tui.requestRender(true);
		}
	}
}
