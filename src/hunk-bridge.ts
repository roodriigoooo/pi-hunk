import type { Theme } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import type { HunkConfig } from "./config";
import { parseUnifiedPatch, type ParsedPatch } from "./diff-view";
import { displayPath, fileKey } from "./paths";

// ============================================================================
// Types
// ============================================================================

type HunkExecResult = { stdout: string; stderr: string; code: number };

export type HunkComment = {
	id?: string;
	filePath?: string;
	oldLine?: number;
	newLine?: number;
	summary: string;
	rationale?: string;
	author?: string;
	type?: string;
};

export type ReviewNotesResult = {
	live: boolean;
	comments: HunkComment[];
	message: string;
	session?: any;
	error?: string;
};

// ============================================================================
// Hunk CLI exec
// ============================================================================

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
		const timer = setTimeout(() => {
			child.kill("SIGTERM");
		}, timeout);
		const onAbort = () => child.kill("SIGTERM");
		signal?.addEventListener("abort", onAbort, { once: true });
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (d) => (stdout += d));
		child.stderr.on("data", (d) => (stderr += d));
		child.on("close", (code) => finish({ stdout, stderr, code: code ?? 1 }));
		child.on("error", (error) => finish({ stdout, stderr: String(error), code: 1 }));
	});
}

async function runHunkJson(cwd: string, args: string[], config: HunkConfig, timeout = 20_000, signal?: AbortSignal): Promise<any | undefined> {
	const execResult = await hunkExec(cwd, config.hunk.binary, args, timeout, signal);
	if (execResult.code !== 0) return undefined;
	try {
		return JSON.parse(execResult.stdout);
	} catch {
		return undefined;
	}
}

// ============================================================================
// Comment normalization — the defensive Hunk JSON schema tolerance
// ============================================================================

function isObject(value: unknown): value is Record<string, any> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function firstFiniteNumber(...values: unknown[]): number | undefined {
	for (const value of values) {
		if (Array.isArray(value)) {
			const n = firstFiniteNumber(...value);
			if (n !== undefined) return n;
			continue;
		}
		const n = Number(value);
		if (Number.isFinite(n)) return n;
	}
	return undefined;
}

function stringOrUndefined(value: unknown): string | undefined {
	if (value === undefined || value === null) return undefined;
	const s = String(value).trim();
	return s || undefined;
}

/** Normalize a Hunk `comment list` payload into semantic comments. */
export function normalizeHunkComments(payload: any): HunkComment[] {
	const raw: Array<{ comment: any; fileHint?: string }> = [];
	const pushCollection = (items: any, fileHint?: string) => {
		if (Array.isArray(items)) for (const comment of items) raw.push({ comment, fileHint });
	};

	pushCollection(payload);
	pushCollection(payload?.comments);
	pushCollection(payload?.items);
	pushCollection(payload?.annotations);

	if (Array.isArray(payload?.files)) {
		for (const file of payload.files) {
			const fileHint = stringOrUndefined(file?.path ?? file?.filePath ?? file?.file ?? file?.name);
			pushCollection(file?.comments, fileHint);
			pushCollection(file?.annotations, fileHint);
			pushCollection(file?.items, fileHint);
		}
	}

	const seen = new Set<string>();
	const out: HunkComment[] = [];
	for (const { comment: c, fileHint } of raw) {
		if (!isObject(c)) continue;
		const location = isObject(c.location) ? c.location : undefined;
		const range = isObject(c.range) ? c.range : undefined;
		const line = isObject(c.line) ? c.line : undefined;
		const newRange = c.newRange ?? location?.newRange ?? range?.newRange;
		const oldRange = c.oldRange ?? location?.oldRange ?? range?.oldRange;
		const summary = stringOrUndefined(c.summary ?? c.text ?? c.body ?? c.message ?? c.note ?? c.title);
		if (!summary) continue;
		const filePath = stringOrUndefined(c.filePath ?? c.file ?? c.path ?? location?.filePath ?? location?.file ?? location?.path ?? fileHint);
		const comment: HunkComment = {
			id: stringOrUndefined(c.id ?? c.commentId ?? c.uuid),
			filePath,
			oldLine: firstFiniteNumber(c.oldLine, c.old_line, location?.oldLine, line?.old, oldRange),
			newLine: firstFiniteNumber(c.newLine, c.new_line, location?.newLine, line?.new, newRange),
			summary,
			rationale: stringOrUndefined(c.rationale ?? c.reason ?? c.detail ?? c.details ?? c.description),
			author: typeof c.author === "object" ? stringOrUndefined(c.author?.name ?? c.author?.id) : stringOrUndefined(c.author),
			type: stringOrUndefined(c.type ?? c.kind),
		};
		const dedupeKey = JSON.stringify([comment.id, comment.filePath, comment.oldLine, comment.newLine, comment.summary, comment.rationale]);
		if (seen.has(dedupeKey)) continue;
		seen.add(dedupeKey);
		out.push(comment);
	}

	return out.filter((c) => c.type === undefined || c.type === "user" || c.type === "live");
}

// ============================================================================
// Note shaping
// ============================================================================

function commentLocation(c: Pick<HunkComment, "oldLine" | "newLine">): string {
	if (c.newLine !== undefined && c.oldLine !== undefined) return `new:${c.newLine} / old:${c.oldLine}`;
	if (c.newLine !== undefined) return `new:${c.newLine}`;
	if (c.oldLine !== undefined) return `old:${c.oldLine}`;
	return "file";
}

function groupCommentsByFile(comments: HunkComment[], cwd: string): Map<string, HunkComment[]> {
	const grouped = new Map<string, HunkComment[]>();
	for (const comment of comments) {
		const file = displayPath(comment.filePath, cwd);
		const list = grouped.get(file) ?? [];
		list.push(comment);
		grouped.set(file, list);
	}
	return grouped;
}

function reviewNotesSignature(comments: HunkComment[], cwd: string): string {
	return JSON.stringify(
		comments.map((comment) => ({
			file: displayPath(comment.filePath, cwd),
			oldLine: comment.oldLine,
			newLine: comment.newLine,
			summary: comment.summary,
			rationale: comment.rationale,
		})),
	);
}

function buildReviewPrompt(comments: HunkComment[], cwd: string): string {
	const groups = groupCommentsByFile(comments, cwd);
	const lines: string[] = ["Open Hunk review state (human-authored notes):"];
	let index = 1;
	for (const [file, fileComments] of groups) {
		lines.push(`\nFile: ${file}`);
		for (const comment of fileComments) {
			lines.push(`${index}. ${commentLocation(comment)} — ${comment.summary}`);
			if (comment.rationale) lines.push(`   rationale: ${comment.rationale}`);
			if (comment.author) lines.push(`   author: ${comment.author}`);
			index++;
		}
	}
	lines.push("", "Address each note without rewriting or summarizing the user's words.");
	return lines.join("\n");
}

export type RenderRecordLike = {
	tool: "write" | "edit";
	filePath: string;
	patch: string;
	summary: string;
};

/** Line spans a patch touches on each side, as [start, end] inclusive line
 *  numbers. The new side covers additions + context (newLine); the old side
 *  covers removals + context (oldLine). Used to correlate human notes to the
 *  edit they refer to, on whichever side the note is pinned to. */
function touchedLineRanges(patch: string): { old: Array<[number, number]>; new: Array<[number, number]> } {
	const parsed: ParsedPatch = parseUnifiedPatch(patch);
	const old: Array<[number, number]> = [];
	const neu: Array<[number, number]> = [];
	for (const hunk of parsed.hunks) {
		let oldStart: number | undefined;
		let oldEnd: number | undefined;
		let newStart: number | undefined;
		let newEnd: number | undefined;
		for (const line of hunk.lines) {
			if (line.kind === "remove" || line.kind === "context") {
				const n = line.oldLine;
				if (n !== undefined) {
					if (oldStart === undefined) oldStart = n;
					oldEnd = n;
				}
			}
			if (line.kind === "add" || line.kind === "context") {
				const n = line.newLine;
				if (n !== undefined) {
					if (newStart === undefined) newStart = n;
					newEnd = n;
				}
			}
		}
		if (oldStart !== undefined && oldEnd !== undefined) old.push([oldStart, oldEnd]);
		if (newStart !== undefined && newEnd !== undefined) neu.push([newStart, newEnd]);
	}
	return { old, new: neu };
}

function lineInRanges(line: number, ranges: Array<[number, number]>): boolean {
	return ranges.some(([s, e]) => line >= s && line <= e);
}

/** True if a note's pinned line falls inside a record's touched span on the
 *  side the note refers to: newLine checks the edit's new-side span, oldLine
 *  checks the old-side span. A note carrying both is touched if either side
 *  overlaps the same file's edit. */
function noteOverlapsRecord(note: HunkComment, record: RenderRecordLike, cwd: string): boolean {
	if (fileKey(note.filePath, cwd) !== fileKey(record.filePath, cwd)) return false;
	const ranges = touchedLineRanges(record.patch);
	if (note.newLine !== undefined && lineInRanges(note.newLine, ranges.new)) return true;
	if (note.oldLine !== undefined && lineInRanges(note.oldLine, ranges.old)) return true;
	return false;
}

/** Filter notes to those overlapping any recent edit. Pure + testable. */
export function notesRelevantToRecords(notes: HunkComment[], findRecent: (filePath: string | undefined, cwd: string) => RenderRecordLike | undefined, cwd: string): HunkComment[] {
	return notes.filter((note) => {
		const record = findRecent(note.filePath, cwd);
		return record ? noteOverlapsRecord(note, record, cwd) : false;
	});
}

// ============================================================================
// ReviewBridge — live session → semantic notes, with pickup/dedup policy
// ============================================================================

export interface ReviewBridge {
	/** Probe for a live Hunk session, returning the raw session (or undefined). */
	probeSession(cwd: string, config: HunkConfig, signal?: AbortSignal): Promise<any | undefined>;
	/** Read notes once. Does not track dedup state. */
	readNotes(cwd: string, config: HunkConfig, signal?: AbortSignal): Promise<ReviewNotesResult>;
	/**
	 * Read notes and, if a new relevant review state exists, mark it for injection.
	 * Returns the result plus whether it should inject. Duplicate unchanged states
	 * are not re-injected.
	 */
	pickup(cwd: string, config: HunkConfig, signal?: AbortSignal): Promise<{ result: ReviewNotesResult; inject: boolean }>;
	/** Forget the last-seen signature (e.g. after `/hunk auto off`). */
	resetSignature(): void;
	/** Render notes through the shared visual language. */
	renderNotesLines(result: ReviewNotesResult | undefined, cwd: string, theme: Theme): string[];
	/** Render read-only review state for the human-facing `/hunk review` view. */
	renderReviewLines(
		result: ReviewNotesResult | undefined,
		findRecent: (filePath: string | undefined, cwd: string) => RenderRecordLike | undefined,
		cwd: string,
		theme: Theme,
	): string[];
}

export function createHunkBridge(findRecent?: (filePath: string | undefined, cwd: string) => RenderRecordLike | undefined): ReviewBridge {
	let lastSignature = "";

	return {
		probeSession(cwd, config, signal) {
			if (!config.hunk.enabled) return Promise.resolve(undefined);
			return runHunkJson(cwd, ["session", "get", "--repo", cwd, "--json"], config, 5_000, signal);
		},

		async readNotes(cwd, config, signal) {
			const session = await this.probeSession(cwd, config, signal);
			if (!session) {
				return {
					live: false,
					comments: [],
					message: `No live Hunk session is attached to ${cwd}. Open another terminal in this repo and run: hunk diff --watch`,
				};
			}
			const commentsPayload = await runHunkJson(cwd, ["session", "comment", "list", "--repo", cwd, "--type", "user", "--json"], config, 20_000, signal);
			if (!commentsPayload) {
				return { live: true, session, comments: [], message: "Live Hunk session found, but no user comments were returned." };
			}
			const comments = normalizeHunkComments(commentsPayload);
			return {
				live: true,
				session,
				comments,
				message: comments.length ? buildReviewPrompt(comments, cwd) : "Live Hunk session found. No user Hunk comments are open.",
			};
		},

		async pickup(cwd, config, signal) {
			const result = await this.readNotes(cwd, config, signal);
			if (!config.hunk.autoReviewNotes || !result.live) return { result, inject: false };
			// Scope to notes that overlap a recent edit, so notes about untouched
			// files never trigger pickup on their own. When no findRecent seam is
			// wired (older callers), fall back to all notes.
			const relevant = findRecent ? notesRelevantToRecords(result.comments, findRecent, cwd) : result.comments;
			const scoped: ReviewNotesResult = relevant.length === result.comments.length ? result : { ...result, comments: relevant, message: buildReviewPrompt(relevant, cwd) };
			if (relevant.length < 1) return { result: scoped, inject: false };
			const signature = reviewNotesSignature(scoped.comments, cwd);
			if (signature === lastSignature) return { result: scoped, inject: false };
			lastSignature = signature;
			return { result: scoped, inject: true };
		},

		resetSignature() {
			lastSignature = "";
		},

		renderNotesLines(result, cwd, theme) {
			const lines: string[] = [];
			lines.push(`${theme.fg("accent", "✦")} ${theme.fg("borderMuted", "╭─")} ${theme.fg("toolTitle", theme.bold("Hunk review notes"))}`);
			if (!result) {
				lines.push(`${theme.fg("borderMuted", "│")} ${theme.fg("muted", "No result details available.")}`);
				lines.push(theme.fg("borderMuted", "╰" + "─".repeat(32)));
				return lines;
			}
			const status = result.live ? `${result.comments.length} user note${result.comments.length === 1 ? "" : "s"}` : "no live session";
			lines.push(`${theme.fg("borderMuted", "│")} ${theme.fg(result.live ? "toolDiffAdded" : "warning", status)}`);
			lines.push(theme.fg("borderMuted", "╰" + "─".repeat(32)));
			if (!result.live || !result.comments.length) {
				lines.push(theme.fg("muted", result.message));
				return lines;
			}
			let index = 1;
			for (const [file, comments] of groupCommentsByFile(result.comments, cwd)) {
				lines.push(`${theme.fg("accent", "@@")} ${theme.fg("toolTitle", "notes")} ${theme.fg("dim", "·")} ${theme.fg("muted", file)}`);
				for (const comment of comments) {
					lines.push(`${theme.fg("toolDiffAdded", "▎")} ${theme.fg("dim", String(index).padStart(2, " "))}. ${theme.fg("toolTitle", commentLocation(comment))} ${theme.fg("dim", "—")} ${comment.summary}`);
					if (comment.rationale) lines.push(`   ${theme.fg("dim", "rationale:")} ${comment.rationale}`);
					index++;
				}
			}
			return lines;
		},

		renderReviewLines(result, findRecent, cwd, theme) {
			const lines: string[] = [];
			lines.push(`${theme.fg("accent", "✦")} ${theme.fg("borderMuted", "╭─")} ${theme.fg("toolTitle", theme.bold("Hunk review"))}`);
			if (!result) {
				lines.push(`${theme.fg("borderMuted", "│")} ${theme.fg("muted", "No result details available.")}`);
				lines.push(theme.fg("borderMuted", "╰" + "─".repeat(32)));
				return lines;
			}
			if (!result.live) {
				lines.push(`${theme.fg("borderMuted", "│")} ${theme.fg("warning", "no live session")}`);
				lines.push(theme.fg("borderMuted", "╰" + "─".repeat(32)));
				lines.push(theme.fg("muted", result.message));
				return lines;
			}
			if (!result.comments.length) {
				lines.push(`${theme.fg("borderMuted", "│")} ${theme.fg("muted", "no user notes")}`);
				lines.push(theme.fg("borderMuted", "╰" + "─".repeat(32)));
				return lines;
			}
			const touched = result.comments.filter((c) => {
				const rec = findRecent(c.filePath, cwd);
				return rec ? noteOverlapsRecord(c, rec, cwd) : false;
			}).length;
			const open = result.comments.length - touched;
			lines.push(`${theme.fg("borderMuted", "│")} ${theme.fg("toolDiffAdded", `${touched} touched`)} ${theme.fg("dim", "·")} ${theme.fg("warning", `${open} open`)}`);
			lines.push(theme.fg("borderMuted", "╰" + "─".repeat(32)));
			let index = 1;
			for (const [file, comments] of groupCommentsByFile(result.comments, cwd)) {
				lines.push(`${theme.fg("accent", "@@")} ${theme.fg("toolTitle", "notes")} ${theme.fg("dim", "·")} ${theme.fg("muted", file)}`);
				for (const comment of comments) {
					const rec = findRecent(comment.filePath, cwd);
					const isAddressed = rec ? noteOverlapsRecord(comment, rec, cwd) : false;
					const mark = isAddressed ? theme.fg("toolDiffAdded", "✓ touched") : theme.fg("warning", "○ open");
					lines.push(`${theme.fg("dim", String(index).padStart(2, " "))}. ${mark} ${theme.fg("toolTitle", commentLocation(comment))} ${theme.fg("dim", "—")} ${comment.summary}`);
					if (comment.rationale) lines.push(`   ${theme.fg("dim", "rationale:")} ${comment.rationale}`);
					index++;
				}
			}
			return lines;
		},
	};
}

export function stringOr(value: unknown): string | undefined {
	return stringOrUndefined(value);
}
