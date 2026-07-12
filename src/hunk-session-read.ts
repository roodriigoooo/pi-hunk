import { spawn } from "node:child_process";
import type { HunkConfig } from "./config";

// ============================================================================
// HunkSessionRead — one owner for CLI commands and review-fetch policy
// ============================================================================

type HunkExecResult = { stdout: string; stderr: string; code: number };

export type HunkJsonExec = (
	cwd: string,
	args: string[],
	config: HunkConfig,
	timeout?: number,
	signal?: AbortSignal,
) => Promise<any | undefined>;

export type HunkSessionReadResult = {
	/** Session metadata. On the one-call path this is the review export itself. */
	session: any;
	/** Payload carrying reviewed file patches, when the live Hunk supports it. */
	patch?: any;
	/** Payload carrying human review notes. Undefined means the note fetch failed. */
	notes?: any;
	/** Which command policy produced this result. */
	source: "review" | "legacy";
};

export interface HunkSessionRead {
	/** Cheap live-session probe used by status/footer state. */
	probe(cwd: string, config: HunkConfig, signal?: AbortSignal): Promise<any | undefined>;
	/** Fetch the session, reviewed patch, and notes under one policy boundary. */
	read(cwd: string, config: HunkConfig, signal?: AbortSignal): Promise<HunkSessionReadResult | undefined>;
}

async function hunkExec(cwd: string, command: string, args: string[], timeout = 20_000, signal?: AbortSignal): Promise<HunkExecResult> {
	return await new Promise<HunkExecResult>((resolve) => {
		const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		let settled = false;
		const finish = (result: HunkExecResult) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			resolve(result);
		};
		const timer = setTimeout(() => child.kill("SIGTERM"), timeout);
		const onAbort = () => child.kill("SIGTERM");
		signal?.addEventListener("abort", onAbort, { once: true });
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (data) => (stdout += data));
		child.stderr.on("data", (data) => (stderr += data));
		child.on("close", (code) => finish({ stdout, stderr, code: code ?? 1 }));
		child.on("error", (error) => finish({ stdout, stderr: String(error), code: 1 }));
	});
}

/** Run a `hunk` CLI subcommand and parse its JSON stdout. */
export async function runHunkJson(cwd: string, args: string[], config: HunkConfig, timeout = 20_000, signal?: AbortSignal): Promise<any | undefined> {
	const execResult = await hunkExec(cwd, config.hunk.binary, args, timeout, signal);
	if (execResult.code !== 0) return undefined;
	try {
		return JSON.parse(execResult.stdout);
	} catch {
		return undefined;
	}
}

function sessionGetArgs(cwd: string): string[] {
	return ["session", "get", "--repo", cwd, "--json"];
}

function commentListArgs(cwd: string): string[] {
	return ["session", "comment", "list", "--repo", cwd, "--type", "user", "--json"];
}

function sessionReviewArgs(cwd: string): string[] {
	return ["session", "review", "--repo", cwd, "--include-patch", "--include-notes", "--json"];
}

function isObject(value: unknown): value is Record<string, any> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Accept both Hunk's current bare review object and a possible `{review}` wrapper. */
function unwrapReview(payload: any): any | undefined {
	const review = isObject(payload?.review) ? payload.review : payload;
	if (!isObject(review)) return undefined;
	const sessionId = review.sessionId ?? review.id ?? review.session?.id;
	if (sessionId !== undefined || Array.isArray(review.files)) return review;
	return undefined;
}

/** The current Hunk path: patch + notes + session metadata in one round trip. */
function createReviewExportRead(exec: HunkJsonExec): Pick<HunkSessionRead, "read"> {
	return {
		async read(cwd, config, signal) {
			const payload = await exec(cwd, sessionReviewArgs(cwd), config, 20_000, signal);
			const review = unwrapReview(payload);
			if (!review) return undefined;
			return { session: review, patch: review, notes: review, source: "review" };
		},
	};
}

/** The compatibility path: today's session probe followed by a user-note list. */
export function createLegacyHunkSessionRead(exec: HunkJsonExec = runHunkJson): HunkSessionRead {
	const probe: HunkSessionRead["probe"] = (cwd, config, signal) => exec(cwd, sessionGetArgs(cwd), config, 5_000, signal);
	return {
		probe,
		async read(cwd, config, signal) {
			const session = await probe(cwd, config, signal);
			if (!session) return undefined;
			const notes = await exec(cwd, commentListArgs(cwd), config, 20_000, signal);
			return { session, notes, source: "legacy" };
		},
	};
}

/** Prefer Hunk's one-call review export; fall back to the two-call legacy path
 * when that command is unavailable or returns no recognizable review model. */
export function createHunkSessionRead(exec: HunkJsonExec = runHunkJson): HunkSessionRead {
	const review = createReviewExportRead(exec);
	const legacy = createLegacyHunkSessionRead(exec);
	return {
		probe: legacy.probe.bind(legacy),
		async read(cwd, config, signal) {
			return (await review.read(cwd, config, signal)) ?? legacy.read(cwd, config, signal);
		},
	};
}
