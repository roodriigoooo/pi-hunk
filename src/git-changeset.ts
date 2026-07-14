import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import {
	canonicalPatch,
	gitFingerprint,
	gitFingerprintMatchesSnapshot,
	isDefaultGitWorkingTreeReview,
	type ChangesetFile,
	type ChangesetUnknownReason,
	type GitFingerprint,
} from "./changeset";
import type { ReviewSnapshot } from "./review-export";

export type GitCommandResult = Readonly<{
	stdout: string;
	stderr: string;
	code: number | null;
	signal: string | null;
	timedOut?: boolean;
	launchError?: NodeJS.ErrnoException;
}>;

export type GitCommandRunner = (args: string[], options: { cwd: string; timeout: number; signal?: AbortSignal }) => Promise<GitCommandResult>;

export type GitChangeset = Readonly<{
	fingerprint: GitFingerprint;
	files: readonly ChangesetFile[];
}>;

export type GitChangesetResult =
	| Readonly<{ ok: true; value: GitChangeset }>
	| Readonly<{ ok: false; reason: ChangesetUnknownReason; message: string }>;

const DIFF_ARGS = ["diff", "--no-ext-diff", "--find-renames", "--no-color"];
const STATUS_ARGS = ["--no-optional-locks", "status", "--porcelain=v1", "--untracked-files=all", "-z"];

function runProcess(binary: string, args: string[], options: { cwd: string; timeout: number; signal?: AbortSignal }): Promise<GitCommandResult> {
	return new Promise((resolve) => {
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		let settled = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let abort = () => {};
		const finish = (result: GitCommandResult) => {
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
		abort = stop;
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

export const runGitCommand: GitCommandRunner = (args, options) => runProcess("git", args, options);

function commandFailure(result: GitCommandResult, operation: string): GitChangesetResult {
	if (result.launchError?.code === "ENOENT") return { ok: false, reason: "git_unavailable", message: "Git was not found." };
	if (result.timedOut) return { ok: false, reason: "git_timeout", message: `Git ${operation} timed out.` };
	if (result.launchError) return { ok: false, reason: "git_failed", message: `Git ${operation} could not start: ${result.launchError.message}` };
	return { ok: false, reason: "git_failed", message: `Git ${operation} exited with code ${result.code ?? "unknown"}.` };
}

function unquoteGitPath(value: string): string {
	const trimmed = value.trim();
	if (trimmed.startsWith("\"") && trimmed.endsWith("\"")) {
		try {
			return JSON.parse(trimmed) as string;
		} catch {
			return trimmed.slice(1, -1);
		}
	}
	return trimmed;
}

function stripPrefix(value: string): string {
	const unquoted = unquoteGitPath(value);
	if (unquoted === "/dev/null") return unquoted;
	return unquoted.replace(/^[ab]\//, "");
}

function headerPath(line: string, prefix: "--- " | "+++ "): string | undefined {
	if (!line.startsWith(prefix)) return undefined;
	return stripPrefix(line.slice(prefix.length).split("\t", 1)[0]);
}

function diffHeaderPaths(chunk: string): { oldPath?: string; newPath?: string } {
	const line = chunk.split("\n", 1)[0] ?? "";
	if (!line.startsWith("diff --git ")) return {};
	const rest = line.slice("diff --git ".length);
	const separator = rest.indexOf(" b/");
	if (separator < 0) return {};
	return { oldPath: stripPrefix(rest.slice(0, separator)), newPath: stripPrefix(rest.slice(separator + 1)) };
}

function normalizeChunk(chunk: string): ChangesetFile | undefined {
	const lines = chunk.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
	const fromHeader = diffHeaderPaths(chunk);
	const oldLine = lines.find((line) => line.startsWith("--- "));
	const newLine = lines.find((line) => line.startsWith("+++ "));
	const oldPath = oldLine ? headerPath(oldLine, "--- ") : fromHeader.oldPath;
	const newPath = newLine ? headerPath(newLine, "+++ ") : fromHeader.newPath;
	const filePath = newPath && newPath !== "/dev/null" ? newPath : oldPath && oldPath !== "/dev/null" ? oldPath : undefined;
	if (!filePath) return undefined;
	const body: string[] = [];
	if (oldPath === "/dev/null") body.push("--- /dev/null");
	else body.push(`--- a/${oldPath ?? filePath}`);
	if (newPath === "/dev/null") body.push("+++ /dev/null");
	else body.push(`+++ b/${newPath ?? filePath}`);
	const firstHunk = lines.findIndex((line) => line.startsWith("@@"));
	if (firstHunk >= 0) body.push(...lines.slice(firstHunk).filter((line, index, all) => !(index === all.length - 1 && line === "")));
	else {
		for (const line of lines) {
			if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch") || line.startsWith("literal ") || line.startsWith("delta ")) body.push(line);
			if (line.startsWith("old mode ") || line.startsWith("new mode ") || line.startsWith("similarity index ")) body.push(line);
		}
	}
	const previousPath = oldPath && oldPath !== "/dev/null" && newPath && newPath !== "/dev/null" && oldPath !== newPath ? oldPath : undefined;
	return { path: filePath, previousPath, patch: canonicalPatch(body.join("\n")) };
}

function parseDiff(stdout: string): ChangesetFile[] | undefined {
	if (!stdout) return [];
	const chunks = stdout.split(/(?=^diff --git )/m).filter((chunk) => chunk.trim());
	if (!chunks.length || chunks.some((chunk) => !chunk.startsWith("diff --git "))) return undefined;
	const files = chunks.map(normalizeChunk);
	return files.every((file): file is ChangesetFile => !!file) ? files : undefined;
}

type StatusEntry = Readonly<{ index: string; worktree: string; path: string; previousPath?: string }>;

function parseStatus(stdout: string): StatusEntry[] | undefined {
	if (!stdout) return [];
	if (!stdout.includes("\0")) return undefined;
	const values = stdout.split("\0");
	if (values.at(-1) === "") values.pop();
	const entries: StatusEntry[] = [];
	for (let index = 0; index < values.length; index++) {
		const value = values[index];
		if (value.length < 4 || value[2] !== " ") return undefined;
		const xy = value.slice(0, 2);
		const filePath = value.slice(3);
		if (!filePath) return undefined;
		if ((xy[0] === "R" || xy[0] === "C") && values[index + 1] !== undefined) {
			entries.push({ index: xy[0], worktree: xy[1], path: filePath, previousPath: values[++index] });
		} else {
			entries.push({ index: xy[0], worktree: xy[1], path: filePath });
		}
	}
	return entries;
}

function staged(entry: StatusEntry): boolean {
	return entry.index !== " " && entry.index !== "?";
}

function statusFiles(entries: readonly StatusEntry[]): StatusEntry[] {
	return entries.filter((entry) => entry.index === "?" && entry.worktree === "?");
}

function mapError(result: GitChangesetResult): GitChangesetResult {
	return result;
}

export function createGitChangesetAdapter(runner: GitCommandRunner = runGitCommand): {
	read(cwd: string, signal?: AbortSignal): Promise<GitChangesetResult>;
	captureFallback(cwd: string, snapshot: ReviewSnapshot, signal?: AbortSignal): Promise<{ fingerprint?: GitFingerprint; reason?: ChangesetUnknownReason; message?: string }>;
} {
	return {
		async read(cwd, signal) {
			const diff = await runner(DIFF_ARGS, { cwd, timeout: 5_000, signal });
			if (diff.code !== 0 || diff.signal || diff.timedOut || diff.launchError) return mapError(commandFailure(diff, "diff"));
			const tracked = parseDiff(diff.stdout);
			if (!tracked) return { ok: false, reason: "git_malformed", message: "Git diff output was malformed." };

			const status = await runner(STATUS_ARGS, { cwd, timeout: 5_000, signal });
			if (status.code !== 0 || status.signal || status.timedOut || status.launchError) return mapError(commandFailure(status, "status"));
			const entries = parseStatus(status.stdout);
			if (!entries) return { ok: false, reason: "git_malformed", message: "Git status output was not NUL-delimited porcelain v1." };
			if (entries.some(staged)) return { ok: false, reason: "git_staged_target", message: "Staged changes are not part of the working-tree fallback." };

			const untracked: ChangesetFile[] = [];
			for (const entry of statusFiles(entries)) {
				const args = ["diff", "--no-index", "--no-color", "--", "/dev/null", entry.path];
				const result = await runner(args, { cwd, timeout: 5_000, signal });
				if (result.timedOut || result.signal || result.launchError || (result.code !== 0 && result.code !== 1)) return mapError(commandFailure(result, "untracked diff"));
				const parsed = parseDiff(result.stdout);
				if (!parsed || parsed.length !== 1) return { ok: false, reason: "git_malformed", message: "Git untracked diff output was malformed." };
				untracked.push(parsed[0]);
			}

			const files = [...tracked, ...untracked];
			return { ok: true, value: { files, fingerprint: gitFingerprint(path.resolve(cwd), files) } };
		},
		async captureFallback(cwd, snapshot, signal) {
			if (!isDefaultGitWorkingTreeReview(snapshot)) return { reason: "hunk_target_unsupported", message: "The review target is not the owned default Git working tree." };
			const current = await this.read(cwd, signal);
			if (!current.ok) return { reason: current.reason, message: current.message };
			if (!gitFingerprintMatchesSnapshot(current.value.fingerprint, snapshot)) return { reason: "git_baseline_mismatch", message: "The Git working-tree files do not match the captured Hunk export." };
			return { fingerprint: current.value.fingerprint };
		},
	};
}

export const defaultGitChangesetAdapter = createGitChangesetAdapter();
