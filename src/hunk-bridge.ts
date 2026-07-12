import type { Theme } from "@earendil-works/pi-coding-agent";
import type { HunkConfig } from "./config";
import {
	findPatchLineAddress,
	parseUnifiedPatch,
	patchLineAddressKey,
	renderDiffLines,
	type DiffLineAnnotations,
	type Highlighter,
	type ParsedPatch,
	type PatchLineAddress,
} from "./diff-view";
import { createHunkSessionRead, type HunkSessionRead } from "./hunk-session-read";
import { displayPath, fileKey } from "./paths";
import type { PatchEntry, PatchSource, ReviewedPatchSource } from "./patch-source";
import { commentLocation, groupCommentsByFile, commentLines, renderReviewView, type ReviewViewStrategy } from "./review-view";

export { runHunkJson } from "./hunk-session-read";

// ============================================================================
// Types
// ============================================================================

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

export type ReviewNoteLine = {
	lineKey: string;
	address: PatchLineAddress;
	comments: HunkComment[];
};

export type ReviewNoteHunk = {
	filePath: string;
	summary: string;
	hunkIndex: number;
	header: string;
	/** The unified-diff patch this hunk was pinned against. Carried on the
	 *  shape so renderers draw the hunk from the shape itself, not by re-asking
	 *  the patch source — prompt and render then derive from one shape instance. */
	patch: string;
	lines: ReviewNoteLine[];
};

export type ReviewNoteShape = {
	hunks: ReviewNoteHunk[];
	openComments: HunkComment[];
};

export type ReviewNotesResult = {
	live: boolean;
	comments: HunkComment[];
	message: string;
	session?: any;
	reviewedRef?: string;
	error?: string;
	hunks?: ReviewNoteHunk[];
	openComments?: HunkComment[];
};

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

/** Extract the reviewed ref/range without depending on one Hunk JSON version.
 * Current Hunk review exports expose the range through their display `title`
 * (for example `repo main...feature`) rather than a dedicated ref field, so the
 * final fallback removes the repo-name prefix from that title. */
export function reviewedRefFromSession(session: any): string | undefined {
	const direct = [
		session?.reviewedRef,
		session?.reviewRef,
		session?.diffRange,
		session?.range,
		session?.ref,
		session?.targetRef,
		session?.compare,
		session?.input?.range,
		session?.input?.ref,
		session?.target?.range,
		session?.target?.ref,
		session?.target?.label,
		session?.diff?.range,
		session?.diff?.ref,
		session?.context?.reviewedRef,
		session?.context?.range,
		session?.session?.reviewedRef,
		session?.session?.range,
	].map(stringOrUndefined).find(Boolean);
	if (direct) return direct;

	const title = stringOrUndefined(session?.title ?? session?.review?.title ?? session?.session?.title);
	if (!title) return undefined;
	const sourceLabel = stringOrUndefined(session?.sourceLabel ?? session?.review?.sourceLabel ?? session?.session?.sourceLabel);
	const repoName = sourceLabel?.split(/[\\/]/).filter(Boolean).pop();
	if (repoName && title.startsWith(`${repoName} `)) return stringOrUndefined(title.slice(repoName.length + 1));
	return title;
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
	pushCollection(payload?.reviewNotes);
	pushCollection(payload?.notes);
	pushCollection(payload?.review?.reviewNotes);
	pushCollection(payload?.session?.reviewNotes);

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
			id: stringOrUndefined(c.id ?? c.commentId ?? c.noteId ?? c.uuid),
			filePath,
			oldLine: firstFiniteNumber(c.oldLine, c.old_line, location?.oldLine, line?.old, oldRange),
			newLine: firstFiniteNumber(c.newLine, c.new_line, location?.newLine, line?.new, newRange),
			summary,
			rationale: stringOrUndefined(c.rationale ?? c.reason ?? c.detail ?? c.details ?? c.description),
			author: typeof c.author === "object" ? stringOrUndefined(c.author?.name ?? c.author?.id) : stringOrUndefined(c.author),
			type: stringOrUndefined(c.type ?? c.kind ?? c.source),
		};
		const dedupeKey = JSON.stringify([comment.id, comment.filePath, comment.oldLine, comment.newLine, comment.summary, comment.rationale]);
		if (seen.has(dedupeKey)) continue;
		seen.add(dedupeKey);
		out.push(comment);
	}

	return out.filter((c) => c.type === undefined || c.type === "user" || c.type === "live");
}

// ============================================================================
// Note shaping — pinned onto the patch a PatchSource says to use
// ============================================================================

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

function buildReviewPrompt(comments: HunkComment[], cwd: string, shape?: ReviewNoteShape, reviewedRef?: string): string {
	const lines: string[] = ["Open Hunk review state (human-authored notes):"];
	if (reviewedRef) lines.push(`Human reviewing ${reviewedRef.replace(/[.]+$/, "")}.`);
	let index = 1;
	if (shape?.hunks.length) {
		for (const hunk of shape.hunks) {
			lines.push(`\nFile: ${displayPath(hunk.filePath, cwd)}`);
			lines.push(`Hunk: ${hunk.header}`);
			for (const line of hunk.lines) {
				const loc = commentLocation(line.address);
				for (const comment of line.comments) {
					lines.push(`${index}. ${loc} — ${comment.summary}`);
					if (comment.rationale) lines.push(`   rationale: ${comment.rationale}`);
					if (comment.author) lines.push(`   author: ${comment.author}`);
					index++;
				}
			}
		}
	}
	const openComments = shape ? shape.openComments : comments;
	if (openComments.length) {
		const groups = groupCommentsByFile(openComments, cwd);
		for (const [file, fileComments] of groups) {
			lines.push(`\nFile: ${file}${shape ? " (no recent rendered hunk)" : ""}`);
			for (const comment of fileComments) {
				lines.push(`${index}. ${commentLocation(comment)} — ${comment.summary}`);
				if (comment.rationale) lines.push(`   rationale: ${comment.rationale}`);
				if (comment.author) lines.push(`   author: ${comment.author}`);
				index++;
			}
		}
	}
	lines.push("", "Address each note without rewriting or summarizing the user's words.");
	return lines.join("\n");
}

function parseEntryPatch(entry: PatchEntry): ParsedPatch {
	return parseUnifiedPatch(entry.patch);
}

function noteAddressInEntry(note: HunkComment, entry: PatchEntry, cwd: string, parsed = parseEntryPatch(entry)): PatchLineAddress | undefined {
	if (fileKey(note.filePath, cwd) !== fileKey(entry.filePath, cwd)) return undefined;
	return findPatchLineAddress(parsed, note, cwd);
}

function noteOverlapsEntry(note: HunkComment, entry: PatchEntry, cwd: string): boolean {
	return !!noteAddressInEntry(note, entry, cwd);
}

function sortedReviewHunks(hunks: ReviewNoteHunk[]): ReviewNoteHunk[] {
	return hunks
		.map((hunk) => ({ ...hunk, lines: [...hunk.lines].sort((a, b) => a.address.lineIndex - b.address.lineIndex) }))
		.sort((a, b) => a.filePath.localeCompare(b.filePath) || a.hunkIndex - b.hunkIndex);
}

/** Shape notes by the rendered hunk row each one pins onto, using the patch a
 *  `PatchSource` supplies for the note's file. Pure + testable: pass any
 *  `findForFile` callback (an agent-edit source, a reviewed-patch source, or a
 *  test stub) and the shape is the same for the same patch. */
export function buildReviewNoteShape(comments: HunkComment[], findForFile: (filePath: string | undefined, cwd: string) => PatchEntry | undefined, cwd: string): ReviewNoteShape {
	const hunks = new Map<string, ReviewNoteHunk>();
	const lineMaps = new Map<string, Map<string, ReviewNoteLine>>();
	const parsedCache = new Map<PatchEntry, ParsedPatch>();
	const openComments: HunkComment[] = [];
	const parsedFor = (entry: PatchEntry) => {
		let parsed = parsedCache.get(entry);
		if (!parsed) {
			parsed = parseEntryPatch(entry);
			parsedCache.set(entry, parsed);
		}
		return parsed;
	};

	for (const comment of comments) {
		const entry = findForFile(comment.filePath, cwd);
		if (!entry) {
			openComments.push(comment);
			continue;
		}
		const parsed = parsedFor(entry);
		const address = noteAddressInEntry(comment, entry, cwd, parsed);
		const parsedHunk = address ? parsed.hunks[address.hunkIndex] : undefined;
		if (!address || !parsedHunk) {
			openComments.push(comment);
			continue;
		}
		const hunkKey = `${fileKey(entry.filePath, cwd)}:${address.hunkIndex}`;
		let hunk = hunks.get(hunkKey);
		if (!hunk) {
			hunk = { filePath: entry.filePath, summary: entry.summary, hunkIndex: address.hunkIndex, header: parsedHunk.header, patch: entry.patch, lines: [] };
			hunks.set(hunkKey, hunk);
			lineMaps.set(hunkKey, new Map());
		}
		const lineKey = patchLineAddressKey(address);
		const lineMap = lineMaps.get(hunkKey)!;
		let line = lineMap.get(lineKey);
		if (!line) {
			line = { lineKey, address, comments: [] };
			lineMap.set(lineKey, line);
			hunk.lines.push(line);
		}
		line.comments.push(comment);
	}

	return { hunks: sortedReviewHunks([...hunks.values()]), openComments };
}

/** Build inline diff-line annotations for a single patch entry's notes. */
export function reviewAnnotationsForRecord(comments: HunkComment[], entry: PatchEntry, cwd: string): DiffLineAnnotations {
	const parsed = parseEntryPatch(entry);
	const annotations = new Map<string, Array<{ text: string; detail?: string; author?: string; label?: string }>>();
	for (const comment of comments) {
		const address = noteAddressInEntry(comment, entry, cwd, parsed);
		if (!address) continue;
		const key = patchLineAddressKey(address);
		const list = annotations.get(key) ?? [];
		list.push({ text: comment.summary, detail: comment.rationale, author: comment.author, label: "note" });
		annotations.set(key, list);
	}
	return annotations;
}

/** Filter notes to those overlapping any patch the source supplies. Pure + testable. */
export function notesRelevantToRecords(notes: HunkComment[], findForFile: (filePath: string | undefined, cwd: string) => PatchEntry | undefined, cwd: string): HunkComment[] {
	return notes.filter((note) => {
		const entry = findForFile(note.filePath, cwd);
		return entry ? noteOverlapsEntry(note, entry, cwd) : false;
	});
}

function touchedCount(shape: ReviewNoteShape): number {
	return shape.hunks.reduce((count, hunk) => count + hunk.lines.reduce((inner, line) => inner + line.comments.length, 0), 0);
}

// --- notes view strategy: render diff hunks with annotations pinned to rows -----
const notesViewStrategy: ReviewViewStrategy = {
	title: "Hunk review notes",
	guard(result, shape, theme) {
		const touched = touchedCount(shape);
		const status = result.live ? `${result.comments.length} user note${result.comments.length === 1 ? "" : "s"} · ${touched} pinned` : "no live session";
		return { status: theme.fg(result.live ? "toolDiffAdded" : "warning", status), message: result.live && result.comments.length ? undefined : result.message, stop: !result.live || !result.comments.length };
	},
	body(result, shape, cwd, _theme, opts) {
		const config = opts.config as HunkConfig;
		const highlighter = opts.highlighter as Highlighter | undefined;
		const configNoFooter = { ...config, showHunkHint: false };
		const lines: string[] = [];
		const renderedRecords = new Set<string>();
		for (const hunk of shape.hunks) {
			const recordKey = `${fileKey(hunk.filePath, cwd)}\0${hunk.patch}`;
			if (renderedRecords.has(recordKey)) continue;
			renderedRecords.add(recordKey);
			const recordComments = result.comments.filter((comment) => fileKey(comment.filePath, cwd) === fileKey(hunk.filePath, cwd));
			const entry: PatchEntry = { filePath: hunk.filePath, patch: hunk.patch, summary: hunk.summary };
			const annotations = reviewAnnotationsForRecord(recordComments, entry, cwd);
			lines.push(...renderDiffLines({ patch: hunk.patch, filePath: hunk.filePath, cwd, title: "review notes", config: configNoFooter, highlighter, theme: _theme, annotations }));
		}
		return { lines, openStartIndex: 1 };
	},
	openSectionHeader(theme) {
		return `${theme.fg("accent", "@@")} ${theme.fg("toolTitle", "notes without recent hunk")}`;
	},
	openGroupHeader(file, theme) {
		return `${theme.fg("dim", "file")} ${theme.fg("muted", file)}`;
	},
	openCommentLine(comment, index, theme) {
		return commentLines(`${theme.fg("warning", "○ open")} ${theme.fg("dim", String(index).padStart(2, " "))}. ${theme.fg("toolTitle", commentLocation(comment))} ${theme.fg("dim", "—")} ${comment.summary}`, comment, theme);
	},
};

// --- review view strategy: render the touched/open pairing --------------------
const reviewViewStrategy: ReviewViewStrategy = {
	title: "Hunk review",
	guard(result, shape, theme) {
		if (!result.live) return { status: theme.fg("warning", "no live session"), message: result.message, stop: true };
		if (!result.comments.length) return { status: theme.fg("muted", "no user notes"), stop: true };
		const touched = touchedCount(shape);
		const open = shape.openComments.length;
		return { status: `${theme.fg("toolDiffAdded", `${touched} touched`)} ${theme.fg("dim", "·")} ${theme.fg("warning", `${open} open`)}`, stop: false };
	},
	body(_result, shape, cwd, theme, _opts) {
		const lines: string[] = [];
		let index = 1;
		for (const hunk of shape.hunks) {
			lines.push(`${theme.fg("accent", "@@")} ${theme.fg("toolTitle", "notes")} ${theme.fg("dim", "·")} ${theme.fg("muted", `${displayPath(hunk.filePath, cwd)} ${hunk.header}`)}`);
			for (const line of hunk.lines) {
				for (const comment of line.comments) {
					lines.push(...commentLines(`${theme.fg("dim", String(index).padStart(2, " "))}. ${theme.fg("toolDiffAdded", "✓ touched")} ${theme.fg("toolTitle", commentLocation(line.address))} ${theme.fg("dim", "—")} ${comment.summary}`, comment, theme));
					index++;
				}
			}
		}
		return { lines, openStartIndex: index };
	},
	openGroupHeader(file, theme) {
		return `${theme.fg("accent", "@@")} ${theme.fg("toolTitle", "open notes")} ${theme.fg("dim", "·")} ${theme.fg("muted", file)}`;
	},
	openCommentLine(comment, index, theme) {
		return commentLines(`${theme.fg("dim", String(index).padStart(2, " "))}. ${theme.fg("warning", "○ open")} ${theme.fg("toolTitle", commentLocation(comment))} ${theme.fg("dim", "—")} ${comment.summary}`, comment, theme);
	},
};

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
	/** Forget the last-seen signature (e.g. after `/hunk off`). */
	resetSignature(): void;
	/** Render notes through the shared visual language. The bridge's patch source
	 *  supplies the patch to pin each note onto; nothing is threaded by the caller. */
	renderNotesLines(result: ReviewNotesResult | undefined, cwd: string, theme: Theme, config: HunkConfig, highlighter: Highlighter | undefined): string[];
	/** Render read-only review state for the human-facing `/hunk review` view. */
	renderReviewLines(result: ReviewNotesResult | undefined, cwd: string, theme: Theme): string[];
}

export type HunkBridgeOptions = {
	/** Owns Hunk command construction and one-call/fallback fetch policy. */
	sessionRead?: HunkSessionRead;
	/** Cache hydrated from the exact reviewed patch returned by `sessionRead`. */
	reviewedSource?: ReviewedPatchSource;
};

/** Build a review bridge over one `PatchSource`. The source is wired once here;
 *  every correlation and render path asks it for the patch to pin against, so
 *  `findRecent` is no longer threaded through each call site. `HunkSessionRead`
 *  owns all CLI command/fetch policy; its reviewed payload hydrates the preferred
 *  patch adapter before notes are shaped. */
export function createHunkBridge(patchSource: PatchSource, options: HunkBridgeOptions = {}): ReviewBridge {
	let lastSignature = "";
	const sessionRead = options.sessionRead ?? createHunkSessionRead();
	const reviewedSource = options.reviewedSource;
	const findForFile = (filePath: string | undefined, cwd: string): PatchEntry | undefined => patchSource.findForFile(filePath, cwd);

	return {
		probeSession(cwd, config, signal) {
			if (!config.hunk.enabled) return Promise.resolve(undefined);
			return sessionRead.probe(cwd, config, signal);
		},

		async readNotes(cwd, config, signal) {
			const read = config.hunk.enabled ? await sessionRead.read(cwd, config, signal) : undefined;
			if (!read) {
				reviewedSource?.clear();
				return {
					live: false,
					comments: [],
					message: `No live Hunk session is attached to ${cwd}. Open another terminal in this repo and run: hunk diff --watch`,
				};
			}
			if (read.patch) reviewedSource?.hydrate(read.patch, cwd);
			else reviewedSource?.clear();
			const reviewedRef = reviewedRefFromSession(read.session);
			if (read.notes === undefined) {
				return { live: true, session: read.session, reviewedRef, comments: [], message: "Live Hunk session found, but no user comments were returned." };
			}
			const comments = normalizeHunkComments(read.notes);
			const shape = buildReviewNoteShape(comments, findForFile, cwd);
			return {
				live: true,
				session: read.session,
				reviewedRef,
				comments,
				hunks: shape.hunks,
				openComments: shape.openComments,
				message: comments.length
					? buildReviewPrompt(comments, cwd, shape, reviewedRef)
					: reviewedRef
						? `Live Hunk session found for ${reviewedRef}. No user Hunk comments are open.`
						: "Live Hunk session found. No user Hunk comments are open.",
			};
		},

		async pickup(cwd, config, signal) {
			const result = await this.readNotes(cwd, config, signal);
			if (!config.hunk.autoReviewNotes || !result.live) return { result, inject: false };
			// Scope to notes that overlap a patch the source supplies, so notes about
			// untouched files never trigger pickup on their own.
			const relevant = notesRelevantToRecords(result.comments, findForFile, cwd);
			const shape = buildReviewNoteShape(relevant, findForFile, cwd);
			const scoped: ReviewNotesResult =
				relevant.length === result.comments.length
					? result
					: { ...result, comments: relevant, hunks: shape.hunks, openComments: shape.openComments, message: buildReviewPrompt(relevant, cwd, shape, result.reviewedRef) };
			if (relevant.length < 1) return { result: scoped, inject: false };
			const signature = reviewNotesSignature(scoped.comments, cwd);
			if (signature === lastSignature) return { result: scoped, inject: false };
			lastSignature = signature;
			return { result: scoped, inject: true };
		},

		resetSignature() {
			lastSignature = "";
		},

		renderNotesLines(result, cwd, theme, config, highlighter) {
			return renderReviewView(result, cwd, theme, notesViewStrategy, { config, highlighter });
		},

		renderReviewLines(result, cwd, theme) {
			return renderReviewView(result, cwd, theme, reviewViewStrategy, {});
		},
	};
}

export function stringOr(value: unknown): string | undefined {
	return stringOrUndefined(value);
}
