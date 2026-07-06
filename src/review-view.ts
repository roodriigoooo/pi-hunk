import type { Theme } from "@earendil-works/pi-coding-agent";
import { displayPath } from "./paths";
import type { HunkComment, ReviewNoteHunk, ReviewNoteShape, ReviewNotesResult } from "./hunk-bridge";

// ============================================================================
// ReviewView — shared scaffolding for the two review views
// ============================================================================
//
// `renderNotesLines` (agent-facing `hunk_review_notes`) and `renderReviewLines`
// (human-facing `/hunk review`) share the same chrome: header box, status line,
// separator, and the open-comments footer grouped by file. They differ only in
// the body — one renders diff hunks with annotations pinned to rows, the other
// renders a `✓ touched` / `○ open` pairing. This module owns the shared frame
// and accepts a body-strategy adapter, so the two views become thin adapters
// over one scaffolding module. Header/status/separator/footer format changes
// hit one place, not two.

/** Append a comment's summary line with its optional rationale line. Shared
 *  by the touched/open body and the open-comment footer so rationale always
 *  renders as its own line (preserving per-line wrapping in the TUI). */
export function commentLines(mainLine: string, comment: HunkComment, theme: Theme): string[] {
	const out = [mainLine];
	if (comment.rationale) out.push(`   ${theme.fg("dim", "rationale:")} ${comment.rationale}`);
	return out;
}

/** A location string for a comment's line coordinates. */
export function commentLocation(c: Pick<HunkComment, "oldLine" | "newLine">): string {
	if (c.newLine !== undefined && c.oldLine !== undefined) return `new:${c.newLine} / old:${c.oldLine}`;
	if (c.newLine !== undefined) return `new:${c.newLine}`;
	if (c.oldLine !== undefined) return `old:${c.oldLine}`;
	return "file";
}

/** Group comments by their display path, preserving first-seen order. */
export function groupCommentsByFile(comments: HunkComment[], cwd: string): Map<string, HunkComment[]> {
	const grouped = new Map<string, HunkComment[]>();
	for (const comment of comments) {
		const file = displayPath(comment.filePath, cwd);
		const list = grouped.get(file) ?? [];
		list.push(comment);
		grouped.set(file, list);
	}
	return grouped;
}

/** The pre-built shape carried on a `ReviewNotesResult`. Renderers consume it
 *  verbatim instead of re-asking the patch source (see #12). */
function carriedShape(result: ReviewNotesResult): ReviewNoteShape {
	return { hunks: result.hunks ?? [], openComments: result.openComments ?? [] };
}

/** A body-strategy adapter: one renders diff hunks with annotations, the other
 *  renders the touched/open pairing. The scaffolding owns the frame; the
 *  strategy owns the middle. */
export interface ReviewViewStrategy {
	title: string;
	/** The `│ <status>` content (already theme-styled) plus whether to stop
	 *  before the body. When `stop` is true the scaffolding emits the status
	 *  line, the separator, and the optional message, then returns — covering
	 *  the not-live and no-comments cases. When false, the body + open footer
	 *  follow. */
	guard(result: ReviewNotesResult, shape: ReviewNoteShape, theme: Theme): { status: string; message?: string; stop: boolean };
	/** The pinned-hunks body. Returns the body lines and the starting index for
	 *  the open-comments footer (notes view resets to 1; review view continues
	 *  the body's numbering). */
	body(result: ReviewNotesResult, shape: ReviewNoteShape, cwd: string, theme: Theme, opts: any): { lines: string[]; openStartIndex: number };
	/** Optional section header above the open-comments footer (notes view emits
	 *  `@@ notes without recent hunk`; review view omits it). */
	openSectionHeader?(theme: Theme): string | undefined;
	/** Per-file group header inside the open-comments footer. */
	openGroupHeader(file: string, theme: Theme): string;
	/** One open-comment line at the given index. Returns one or more lines
	 *  (the summary line plus an optional rationale line) so the scaffolding's
	 *  per-line wrapping is unchanged. */
	openCommentLine(comment: HunkComment, index: number, theme: Theme): string[];
}

/** Render the shared open-comments footer: group by file, number comments from
 *  `startIndex`. The iteration + numbering is shared; the strategy provides the
 *  section header, group header, and per-comment line. */
function renderOpenFooter(shape: ReviewNoteShape, cwd: string, theme: Theme, strategy: ReviewViewStrategy, startIndex: number): string[] {
	if (!shape.openComments.length) return [];
	const lines: string[] = [];
	const section = strategy.openSectionHeader?.(theme);
	if (section) lines.push(section);
	let index = startIndex;
	for (const [file, comments] of groupCommentsByFile(shape.openComments, cwd)) {
		lines.push(strategy.openGroupHeader(file, theme));
		for (const comment of comments) {
			lines.push(...strategy.openCommentLine(comment, index, theme));
			index++;
		}
	}
	return lines;
}

/** Compose a review view from shared chrome + a body strategy. Owns the header
 *  box, the no-result guard, the status line, the separator, the body, and the
 *  open-comments footer. Both views are thin adapters over this one function. */
export function renderReviewView(result: ReviewNotesResult | undefined, cwd: string, theme: Theme, strategy: ReviewViewStrategy, opts: any): string[] {
	const lines: string[] = [];
	lines.push(`${theme.fg("accent", "✦")} ${theme.fg("borderMuted", "╭─")} ${theme.fg("toolTitle", theme.bold(strategy.title))}`);
	if (!result) {
		lines.push(`${theme.fg("borderMuted", "│")} ${theme.fg("muted", "No result details available.")}`);
		lines.push(theme.fg("borderMuted", "╰" + "─".repeat(32)));
		return lines;
	}
	const shape = carriedShape(result);
	const guard = strategy.guard(result, shape, theme);
	lines.push(`${theme.fg("borderMuted", "│")} ${guard.status}`);
	lines.push(theme.fg("borderMuted", "╰" + "─".repeat(32)));
	if (guard.stop) {
		if (guard.message !== undefined) lines.push(theme.fg("muted", guard.message));
		return lines;
	}
	const bodyOut = strategy.body(result, shape, cwd, theme, opts);
	lines.push(...bodyOut.lines);
	lines.push(...renderOpenFooter(shape, cwd, theme, strategy, bodyOut.openStartIndex));
	return lines;
}
