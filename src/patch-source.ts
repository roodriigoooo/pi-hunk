import { fileKey } from "./paths";

// ============================================================================
// PatchSource — the seam where "which patch do we pin a note against?" is answered
// ============================================================================
//
// Note-to-edit correlation (`buildReviewNoteShape`, `reviewAnnotationsForRecord`,
// `notesRelevantToRecord`) and both review renderers depend on this interface,
// not on `RenderRecord`. Two adapters satisfy it:
//
//   1. Agent-edit source — backed by `RenderRecordStore` (today's behaviour).
//   2. Reviewed-session source — backed by
//      `hunk session review --include-patch --include-notes`, normalised the way
//      `normalizeHunkComments` tolerates shape variance.
//
// A preferring composite layers them: the reviewed patch wins when the human is
// reviewing one (branch-agnostic pinning), and the agent-edit record is the
// fallback. The composite is wired into the bridge once, so `findRecent` is no
// longer threaded through every renderer and command handler.

export type PatchEntry = {
	filePath: string;
	patch: string;
	summary: string;
};

export interface PatchSource {
	/** Return the patch + summary for a file, or undefined when no patch is available. */
	findForFile(filePath: string | undefined, cwd: string): PatchEntry | undefined;
}

/** Cache adapter for the reviewed patch already fetched by `HunkSessionRead`.
 * It deliberately has no CLI/fetch dependency: session round trips and command
 * construction have one owner, while this module only answers patch queries. */
export interface ReviewedPatchSource extends PatchSource {
	/** Hydrate the cache from a pre-fetched session-review payload. */
	hydrate(payload: any, cwd: string): void;
	/** Empty the cache (e.g. when the live session drops). */
	clear(): void;
}

export function createReviewedPatchSource(): ReviewedPatchSource {
	let cache = new Map<string, PatchEntry>();
	return {
		hydrate(payload, cwd) {
			cache = normalizeReviewPatches(payload, cwd);
		},
		clear() {
			cache = new Map();
		},
		findForFile(filePath, cwd) {
			const key = fileKey(filePath, cwd);
			return key ? cache.get(key) : undefined;
		},
	};
}

function stringOrUndefined(value: unknown): string | undefined {
	if (value === undefined || value === null) return undefined;
	const s = String(value).trim();
	return s || undefined;
}

/** Coerce a raw string field without trimming — patches are unified-diff text
 *  whose content (including a trailing newline) must be preserved verbatim. */
function rawStringOrUndefined(value: unknown): string | undefined {
	if (value === undefined || value === null) return undefined;
	const s = String(value);
	return s || undefined;
}

/** Normalise a `session review --include-patch` payload into a fileKey → PatchEntry
 *  map. Defensive over shape variance, the way `normalizeHunkComments` is: a file
 *  may appear under `files`/`items`/`reviewFiles` (or the payload may be a bare
 *  array), its path under `path`/`filePath`/`file`/`name`, and its patch under
 *  `patch`/`diff`/`unifiedDiff`/`text`. Renames carry a `previousPath`, which is
 *  also keyed so a note that still names the old path lands on the new patch.
 *  Only files with a non-empty patch are kept. */
export function normalizeReviewPatches(payload: any, cwd: string): Map<string, PatchEntry> {
	const out = new Map<string, PatchEntry>();
	if (!payload || typeof payload !== "object") return out;
	const files: any[] = [];
	for (const key of ["files", "items", "reviewFiles"]) {
		const collection = (payload as any)[key];
		if (Array.isArray(collection)) for (const file of collection) files.push(file);
	}
	if (Array.isArray(payload)) for (const file of payload) files.push(file);

	for (const file of files) {
		if (!file || typeof file !== "object") continue;
		const filePath = stringOrUndefined(file.path ?? file.filePath ?? file.file ?? file.name);
		const patch = rawStringOrUndefined(file.patch ?? file.diff ?? file.unifiedDiff ?? file.text ?? file.patchText);
		if (!filePath || !patch) continue;
		const summary = stringOrUndefined(file.summary ?? file.label ?? file.title) ?? filePath;
		const entry: PatchEntry = { filePath, patch, summary };
		const key = fileKey(filePath, cwd);
		if (key) out.set(key, entry);
		const previousPath = stringOrUndefined(file.previousPath ?? file.oldPath ?? file.from);
		if (previousPath) {
			const prevKey = fileKey(previousPath, cwd);
			if (prevKey && !out.has(prevKey)) out.set(prevKey, entry);
		}
	}
	return out;
}

/** Prefer `primary` (reviewed patch) and fall back to `fallback` (agent-edit
 * record), keeping the query policy in one place. */
export function createPatchSource(primary: PatchSource, fallback: PatchSource): PatchSource {
	return {
		findForFile(filePath, cwd) {
			return primary.findForFile(filePath, cwd) ?? fallback.findForFile(filePath, cwd);
		},
	};
}
