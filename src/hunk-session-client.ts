import { spawn, type ChildProcess } from "node:child_process";
import type { HunkConfig } from "./config";
import { normalizeReviewExport, type ReviewSnapshot } from "./review-export";

export type HunkFailureKind = "missing_binary" | "unsupported_command" | "timeout" | "malformed_json" | "nonzero_exit" | "signal" | "session_disappeared" | "malformed_export";
export type HunkFailure = Readonly<{ kind: HunkFailureKind; message: string; args: readonly string[]; code?: number; signal?: string; stderr?: string }>;
export type HunkResult<T> = Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; error: HunkFailure }>;

export type HunkCommandResult = Readonly<{ stdout: string; stderr: string; code: number | null; signal: string | null; timedOut?: boolean; launchError?: NodeJS.ErrnoException }>;
export type HunkCommandRunner = (binary: string, args: string[], options: { cwd: string; timeout: number; signal?: AbortSignal }) => Promise<HunkCommandResult>;

export type HunkProbe = Readonly<{ sessionId: string; pid?: number; metadata: unknown }>;
export type HunkReview = Readonly<{ sessionId: string; raw: unknown; snapshot: ReviewSnapshot }>;

export interface HunkSessionClient {
	probe(cwd: string, config: HunkConfig, signal?: AbortSignal): Promise<HunkResult<HunkProbe>>;
	readReview(cwd: string, config: HunkConfig, sessionId?: string, signal?: AbortSignal): Promise<HunkResult<HunkReview>>;
	navigate(cwd: string, config: HunkConfig, sessionId: string, target: { file: string; hunk?: number; oldLine?: number; newLine?: number }, signal?: AbortSignal): Promise<HunkResult<void>>;
}

export async function runHunkCommand(binary: string, args: string[], options: { cwd: string; timeout: number; signal?: AbortSignal }): Promise<HunkCommandResult> {
	return new Promise((resolve) => {
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		let settled = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let abort = () => {};
		const finish = (result: HunkCommandResult) => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			options.signal?.removeEventListener("abort", abort);
			resolve(result);
		};
		let child: ChildProcess;
		try {
			child = spawn(binary, args, { cwd: options.cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
		} catch (launchError) {
			finish({ stdout, stderr, code: null, signal: null, launchError: launchError as NodeJS.ErrnoException });
			return;
		}
		const stop = () => child.kill("SIGTERM");
		abort = () => stop();
		child.stdout?.setEncoding("utf8");
		child.stderr?.setEncoding("utf8");
		child.stdout?.on("data", (data) => (stdout += data));
		child.stderr?.on("data", (data) => (stderr += data));
		child.on("error", (launchError: NodeJS.ErrnoException) => finish({ stdout, stderr, code: null, signal: null, timedOut, launchError }));
		child.on("close", (code, signal) => finish({ stdout, stderr, code, signal, timedOut }));
		timer = setTimeout(() => {
			timedOut = true;
			stop();
		}, options.timeout);
		if (options.signal?.aborted) abort();
		else options.signal?.addEventListener("abort", abort, { once: true });
	});
}

function sessionId(value: unknown): string | undefined {
	if (!value || typeof value !== "object") return undefined;
	const record = value as Record<string, unknown>;
	const nested = record.session && typeof record.session === "object" ? record.session as Record<string, unknown> : undefined;
	for (const candidate of [record.sessionId, record.id, nested?.id, nested?.sessionId]) if (typeof candidate === "string" && candidate.length) return candidate;
	return undefined;
}

function sessionPid(value: unknown): number | undefined {
	if (!value || typeof value !== "object") return undefined;
	const record = value as Record<string, unknown>;
	const nested = record.session && typeof record.session === "object" ? record.session as Record<string, unknown> : undefined;
	for (const candidate of [record.pid, record.processId, nested?.pid, nested?.processId]) {
		const parsed = typeof candidate === "string" && /^\d+$/.test(candidate) ? Number(candidate) : candidate;
		if (typeof parsed === "number" && Number.isSafeInteger(parsed) && parsed > 0) return parsed;
	}
	return undefined;
}

function failure(result: HunkCommandResult, args: string[]): HunkFailure {
	const text = `${result.stderr}\n${result.stdout}`;
	if (result.launchError?.code === "ENOENT") return { kind: "missing_binary", message: `Hunk binary was not found: ${result.launchError.message}`, args, stderr: result.stderr };
	if (result.launchError) return { kind: "nonzero_exit", message: `Could not launch Hunk: ${result.launchError.message}`, args, stderr: result.stderr };
	if (result.timedOut) return { kind: "timeout", message: "Hunk session command timed out.", args, stderr: result.stderr };
	if (result.signal) return { kind: "signal", message: `Hunk session command ended by ${result.signal}.`, args, signal: result.signal, stderr: result.stderr };
	if (/unknown command|unsupported command|unknown option|include-patch/i.test(text)) return { kind: "unsupported_command", message: "Hunk lacks session review --include-patch --include-notes support. Upgrade Hunk to 0.15.3 or newer.", args, code: result.code ?? undefined, stderr: result.stderr };
	if (/no active hunk session|no active hunk sessions|session.*not found|no .*session.*match/i.test(text)) return { kind: "session_disappeared", message: "Hunk session disappeared.", args, code: result.code ?? undefined, stderr: result.stderr };
	return { kind: "nonzero_exit", message: `Hunk session command exited with code ${result.code ?? "unknown"}.`, args, code: result.code ?? undefined, stderr: result.stderr };
}

async function json(runner: HunkCommandRunner, cwd: string, config: HunkConfig, args: string[], timeout: number, signal?: AbortSignal): Promise<HunkResult<unknown>> {
	const result = await runner(config.hunk.binary, args, { cwd, timeout, signal });
	if (result.code !== 0 || result.signal || result.timedOut || result.launchError) return { ok: false, error: failure(result, args) };
	try {
		return { ok: true, value: JSON.parse(result.stdout) };
	} catch {
		return { ok: false, error: { kind: "malformed_json", message: "Hunk session command returned malformed JSON.", args, stderr: result.stderr } };
	}
}

export function createHunkSessionClient(runner: HunkCommandRunner = runHunkCommand): HunkSessionClient {
	return {
		async probe(cwd, config, signal) {
			const args = ["session", "get", "--repo", cwd, "--json"];
			const result = await json(runner, cwd, config, args, 5_000, signal);
			if (!result.ok) return result;
			const id = sessionId(result.value);
			return id ? { ok: true, value: { sessionId: id, pid: sessionPid(result.value), metadata: result.value } } : { ok: false, error: { kind: "session_disappeared", message: "Hunk returned no active session ID.", args } };
		},
		async readReview(cwd, config, lockedSessionId, signal) {
			const args = lockedSessionId
				? ["session", "review", lockedSessionId, "--include-patch", "--include-notes", "--json"]
				: ["session", "review", "--repo", cwd, "--include-patch", "--include-notes", "--json"];
			const result = await json(runner, cwd, config, args, 5_000, signal);
			if (!result.ok) return result;
			const normalized = normalizeReviewExport(result.value);
			if (!normalized.ok) return { ok: false, error: { kind: "malformed_export", message: normalized.error.message, args } };
			if (lockedSessionId && normalized.snapshot.sessionId !== lockedSessionId) return { ok: false, error: { kind: "session_disappeared", message: "Hunk session changed while reviewing.", args } };
			return { ok: true, value: { sessionId: normalized.snapshot.sessionId, raw: result.value, snapshot: normalized.snapshot } };
		},
		async navigate(cwd, config, lockedSessionId, target, signal) {
			const focus = [target.hunk !== undefined ? ["--hunk", String(target.hunk)] : undefined, target.oldLine !== undefined ? ["--old-line", String(target.oldLine)] : undefined, target.newLine !== undefined ? ["--new-line", String(target.newLine)] : undefined].filter((part): part is string[] => !!part);
			if (focus.length !== 1) return { ok: false, error: { kind: "malformed_export", message: "Hunk navigation requires one hunk or line target.", args: [] } };
			const args = ["session", "navigate", lockedSessionId, "--file", target.file, ...focus[0]];
			const result = await runner(config.hunk.binary, args, { cwd, timeout: 5_000, signal });
			if (result.code !== 0 || result.signal || result.timedOut || result.launchError) return { ok: false, error: failure(result, args) };
			return { ok: true, value: undefined };
		},
	};
}
