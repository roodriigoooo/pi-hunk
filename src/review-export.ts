import { createHash } from "node:crypto";

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export type ReviewFile = Readonly<{
	id?: string;
	path: string;
	previousPath?: string;
	patch: string;
	stats: JsonValue;
	hunks: JsonValue;
}>;

export type ReviewNote = Readonly<{
	id?: string;
	source: "user";
	body: string;
	file: string;
	title?: string;
	hunk?: JsonValue;
	oldRange?: JsonValue;
	newRange?: JsonValue;
	author?: JsonValue;
	timestamps: JsonValue;
}>;

export type ReviewSnapshot = Readonly<{
	version: 1;
	sessionId: string;
	source: JsonValue;
	reviewedRef?: string;
	targetSignature?: string;
	files: readonly ReviewFile[];
	notes: readonly ReviewNote[];
	patchDigest: string;
	reviewIdentity: string;
}>;

export type ReviewExportError = Readonly<{ kind: "malformed_export"; message: string }>;
export type ReviewExportResult = { ok: true; snapshot: ReviewSnapshot } | { ok: false; error: ReviewExportError };

function object(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function rawString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function clone(value: unknown): JsonValue {
	return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function freeze<T>(value: T): T {
	if (value && typeof value === "object" && !Object.isFrozen(value)) {
		Object.freeze(value);
		for (const child of Object.values(value as Record<string, unknown>)) freeze(child);
	}
	return value;
}

function lengthPrefix(value: string): Buffer {
	const bytes = Buffer.from(value, "utf8");
	const size = Buffer.allocUnsafe(8);
	size.writeBigUInt64BE(BigInt(bytes.length));
	return Buffer.concat([size, bytes]);
}

function digest(values: string[]): string {
	const hash = createHash("sha256");
	for (const value of values) hash.update(lengthPrefix(value));
	return hash.digest("hex");
}

function digestPath(value: string): string {
	return value.replace(/\\/g, "/");
}

/** SHA-256 over canonical file identity and exact UTF-8 patch bytes.
 * Display order stays intact in the snapshot, but harmless export reordering
 * cannot make the same reviewed changeset appear stale. */
export function patchDigest(files: readonly Pick<ReviewFile, "path" | "previousPath" | "patch">[]): string {
	const parts: string[] = [];
	const canonicalFiles = files
		.map((file) => ({ path: digestPath(file.path), previousPath: file.previousPath ? digestPath(file.previousPath) : "", patch: file.patch }))
		.sort((left, right) => left.path.localeCompare(right.path) || left.previousPath.localeCompare(right.previousPath) || left.patch.localeCompare(right.patch));
	for (const file of canonicalFiles) parts.push(file.path, file.previousPath, file.patch);
	return digest(parts);
}

/** Patch identity also binds explicit Hunk target metadata when present. */
export function reviewIdentity(patch: string, reviewedRef?: string, targetSignature?: string): string {
	return digest([patch, reviewedRef ?? "", targetSignature ?? ""]);
}

function legacyReviewIdentity(patch: string, reviewedRef?: string): string {
	return digest([patch, reviewedRef ?? ""]);
}

function isJsonValue(value: unknown): value is JsonValue {
	if (value === null || typeof value === "boolean" || typeof value === "string") return true;
	if (typeof value === "number") return Number.isFinite(value);
	if (Array.isArray(value)) return value.every(isJsonValue);
	if (object(value)) return Object.values(value).every(isJsonValue);
	return false;
}

const TARGET_FIELDS = ["ref", "range", "diffRange", "base", "head", "from", "to", "pathspec", "pathspecs", "paths", "include", "exclude"] as const;

function explicitTargetFields(value: Record<string, unknown>): Record<string, JsonValue> {
	const fields: Record<string, JsonValue> = {};
	for (const key of TARGET_FIELDS) {
		if (value[key] !== undefined && isJsonValue(value[key])) fields[key] = clone(value[key]);
	}
	return fields;
}

function explicitTargetValue(review: Record<string, unknown>): JsonValue | undefined {
	const sources = [
		review,
		object(review.input) ? review.input : undefined,
		object(review.target) ? review.target : undefined,
		object(review.diff) ? review.diff : undefined,
		object(review.context) ? review.context : undefined,
		object(review.session) ? review.session : undefined,
	].filter((value): value is Record<string, unknown> => !!value);
	const fields: Record<string, JsonValue> = {};
	for (const source of sources) {
		const selected = explicitTargetFields(source);
		for (const [key, value] of Object.entries(selected)) fields[key] = value;
	}
	return Object.keys(fields).length ? fields : undefined;
}

/** Stable signature of only structured Hunk target metadata.
 * Display titles and source labels are intentionally excluded. */
export function targetSignatureFromReview(review: Record<string, unknown>): string | undefined {
	const target = explicitTargetValue(review);
	return target ? digest([canonical(target)]) : undefined;
}

export function targetSignatureFromSnapshot(snapshot: Pick<ReviewSnapshot, "source" | "targetSignature">): string {
	if (snapshot.targetSignature) return snapshot.targetSignature;
	return object(snapshot.source) ? targetSignatureFromReview(snapshot.source) ?? "" : "";
}

/** Validate a serialized checkpoint snapshot before trusting session data. */
export function isReviewSnapshot(value: unknown): value is ReviewSnapshot {
	if (!object(value) || value.version !== 1 || !rawString(value.sessionId) || !object(value.source)) return false;
	if (value.reviewedRef !== undefined && !rawString(value.reviewedRef)) return false;
	if (value.targetSignature !== undefined && !rawString(value.targetSignature)) return false;
	if (!Array.isArray(value.files) || value.files.length < 1 || !Array.isArray(value.notes)) return false;
	const fileKeys = new Set<string>();
	for (const file of value.files) {
		if (!object(file) || !rawString(file.path) || !rawString(file.patch) || !object(file.stats) || !Array.isArray(file.hunks)) return false;
		if (file.id !== undefined && !rawString(file.id)) return false;
		if (file.previousPath !== undefined && typeof file.previousPath !== "string") return false;
		if (!isJsonValue(file.stats) || !isJsonValue(file.hunks)) return false;
		const key = digestPath(file.path as string);
		if (fileKeys.has(key)) return false;
		fileKeys.add(key);
	}
	for (const note of value.notes) {
		if (!object(note) || note.source !== "user" || typeof note.body !== "string" || !rawString(note.file) || !object(note.timestamps)) return false;
		if (note.id !== undefined && typeof note.id !== "string") return false;
		if (note.title !== undefined && typeof note.title !== "string") return false;
		for (const field of [note.hunk, note.oldRange, note.newRange, note.author, note.timestamps]) {
			if (field !== undefined && !isJsonValue(field)) return false;
		}
	}
	if (!isJsonValue(value.source) || typeof value.patchDigest !== "string" || typeof value.reviewIdentity !== "string") return false;
	const snapshot = value as unknown as ReviewSnapshot;
	const currentIdentity = reviewIdentity(snapshot.patchDigest, snapshot.reviewedRef, snapshot.targetSignature);
	const legacyIdentity = snapshot.targetSignature === undefined ? legacyReviewIdentity(snapshot.patchDigest, snapshot.reviewedRef) : "";
	return patchDigest(snapshot.files) === snapshot.patchDigest && (currentIdentity === snapshot.reviewIdentity || legacyIdentity === snapshot.reviewIdentity);
}

function reviewedRefFrom(review: Record<string, unknown>): string | undefined {
	const session = object(review.session) ? review.session : {};
	const input = object(review.input) ? review.input : {};
	const target = object(review.target) ? review.target : {};
	const diff = object(review.diff) ? review.diff : {};
	const context = object(review.context) ? review.context : {};
	const direct = [
		review.reviewedRef, review.reviewRef, review.diffRange, review.range, review.ref, review.targetRef, review.compare,
		input.range, input.ref,
		target.range, target.ref, target.label,
		diff.range, diff.ref,
		context.reviewedRef, context.range,
		session.reviewedRef, session.reviewRef, session.diffRange, session.range, session.ref, session.targetRef, session.compare,
	];
	for (const value of direct) if (typeof value === "string" && value.length) return value;
	return undefined;
}

function sourceMetadata(review: Record<string, unknown>): JsonValue {
	const source: Record<string, JsonValue> = {};
	for (const key of ["title", "source", "sourceLabel", "repo", "repoRoot", "path", "cwd", "inputKind", "input", "target", "base", "head", "diff", "context", "session"]) {
		if (review[key] !== undefined) source[key] = clone(review[key]);
	}
	return source;
}

function fileStats(file: Record<string, unknown>): JsonValue | undefined {
	if (file.stats !== undefined) return clone(file.stats);
	const stats: Record<string, JsonValue> = {};
	for (const key of ["additions", "deletions", "hunkCount", "binary"]) {
		if (file[key] !== undefined) stats[key] = clone(file[key]);
	}
	return Object.keys(stats).length ? stats : undefined;
}

function noteRange(note: Record<string, unknown>, side: "old" | "new"): JsonValue | undefined {
	const key = `${side}Range`;
	const location = object(note.location) ? note.location : undefined;
	const range = object(note.range) ? note.range : undefined;
	const value = note[key] ?? location?.[key] ?? range?.[key];
	if (value === undefined) return undefined;
	if (Array.isArray(value) && value.every((part) => typeof part === "number" && Number.isFinite(part))) return clone(value);
	if (object(value)) return clone(value);
	return undefined;
}

function noteHunk(note: Record<string, unknown>): JsonValue | undefined {
	const location = object(note.location) ? note.location : undefined;
	const value = note.hunk ?? note.hunkIndex ?? note.hunkNumber ?? location?.hunk ?? location?.hunkIndex;
	return value === undefined ? undefined : clone(value);
}

function noteTimestamps(note: Record<string, unknown>): JsonValue {
	const timestamps: Record<string, JsonValue> = {};
	for (const key of ["timestamp", "createdAt", "updatedAt", "created_at", "updated_at"]) {
		if (note[key] !== undefined) timestamps[key] = clone(note[key]);
	}
	return timestamps;
}

function canonical(value: JsonValue): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key]!)}`).join(",")}}`;
	return JSON.stringify(value);
}

function comparableSnapshot(snapshot: ReviewSnapshot): JsonValue {
	const sorted = (values: readonly unknown[]) => values
		.map((value) => clone(value))
		.sort((left, right) => canonical(left).localeCompare(canonical(right)));
	return {
		version: snapshot.version,
		sessionId: snapshot.sessionId,
		source: clone(snapshot.source),
		reviewedRef: snapshot.reviewedRef ?? null,
		targetSignature: snapshot.targetSignature ?? null,
		files: sorted(snapshot.files),
		notes: sorted(snapshot.notes),
		patchDigest: snapshot.patchDigest,
		reviewIdentity: snapshot.reviewIdentity,
	};
}

/** Semantic snapshot equality. File/note display order is not review identity;
 * exact patches, wording, coordinates, IDs, and metadata still participate. */
export function sameSnapshot(left: ReviewSnapshot, right: ReviewSnapshot): boolean {
	return canonical(comparableSnapshot(left)) === canonical(comparableSnapshot(right));
}

/**
 * Convert only a complete `session review --include-patch --include-notes --json`
 * response. This deliberately has no comment-list fallback.
 */
export function normalizeReviewExport(payload: unknown): ReviewExportResult {
	const review = object(payload) && object(payload.review) ? payload.review : payload;
	if (!object(review)) return { ok: false, error: { kind: "malformed_export", message: "Hunk review export must be an object." } };

	const sessionId = rawString(review.sessionId ?? review.id ?? (object(review.session) ? review.session.id : undefined));
	if (!sessionId) return { ok: false, error: { kind: "malformed_export", message: "Hunk review export has no session ID." } };
	if (!Array.isArray(review.files) || review.files.length < 1) return { ok: false, error: { kind: "malformed_export", message: "Hunk review export has no files." } };

	const files: ReviewFile[] = [];
	const fileKeys = new Set<string>();
	for (const candidate of review.files) {
		if (!object(candidate)) return { ok: false, error: { kind: "malformed_export", message: "Hunk review export contains an invalid file." } };
		const path = rawString(candidate.path ?? candidate.filePath ?? candidate.file);
		const patch = rawString(candidate.patch);
		const previousPath = candidate.previousPath ?? candidate.oldPath ?? candidate.from;
		const id = candidate.id === undefined ? undefined : rawString(candidate.id);
		const stats = fileStats(candidate);
		if (!path || patch === undefined || !stats || !Array.isArray(candidate.hunks)) return { ok: false, error: { kind: "malformed_export", message: "Every reviewed file needs path, raw patch, stats, and hunk coordinates." } };
		if (candidate.id !== undefined && !id) return { ok: false, error: { kind: "malformed_export", message: "Reviewed file ID is malformed." } };
		if (previousPath !== undefined && typeof previousPath !== "string") return { ok: false, error: { kind: "malformed_export", message: "Reviewed file previous path is malformed." } };
		const key = digestPath(path);
		if (fileKeys.has(key)) return { ok: false, error: { kind: "malformed_export", message: `Hunk review export contains duplicate file path: ${path}` } };
		fileKeys.add(key);
		files.push(freeze({ id, path, previousPath, patch, stats, hunks: clone(candidate.hunks) }));
	}

	const rawNotes = review.reviewNotes ?? review.notes;
	if (!Array.isArray(rawNotes)) return { ok: false, error: { kind: "malformed_export", message: "Hunk review export omitted notes. Upgrade Hunk and use --include-notes." } };
	const notes: ReviewNote[] = [];
	for (const candidate of rawNotes) {
		if (!object(candidate)) return { ok: false, error: { kind: "malformed_export", message: "Hunk review export contains an invalid note." } };
		if (candidate.source !== "user") continue;
		const body = candidate.body;
		const file = candidate.filePath ?? candidate.file ?? candidate.path;
		const id = candidate.noteId ?? candidate.id ?? candidate.uuid;
		const title = candidate.title;
		const oldRange = noteRange(candidate, "old");
		const newRange = noteRange(candidate, "new");
		if (typeof body !== "string" || typeof file !== "string" || !file.length || (id !== undefined && typeof id !== "string") || (title !== undefined && typeof title !== "string") || (candidate.oldRange !== undefined && !oldRange) || (candidate.newRange !== undefined && !newRange)) {
			return { ok: false, error: { kind: "malformed_export", message: "Human review note is missing exact body, file, or valid coordinates." } };
		}
		const author = candidate.author === undefined ? undefined : clone(candidate.author);
		notes.push(freeze({ id: id as string | undefined, source: "user", body, file, title: title as string | undefined, hunk: noteHunk(candidate), oldRange, newRange, author, timestamps: noteTimestamps(candidate) }));
	}

	const reviewedRef = reviewedRefFrom(review);
	const targetSignature = targetSignatureFromReview(review);
	const patch = patchDigest(files);
	return { ok: true, snapshot: freeze({ version: 1, sessionId, source: sourceMetadata(review), reviewedRef, targetSignature, files: freeze(files), notes: freeze(notes), patchDigest: patch, reviewIdentity: reviewIdentity(patch, reviewedRef, targetSignature) }) };
}
