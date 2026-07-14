import { createHash } from "node:crypto";
import { targetSignatureFromSnapshot, type ReviewSnapshot } from "./review-export";

export type ChangesetUnknownReason =
	| "hunk_session_unavailable"
	| "hunk_export_unavailable"
	| "hunk_target_unsupported"
	| "git_unavailable"
	| "git_timeout"
	| "git_failed"
	| "git_malformed"
	| "git_staged_target"
	| "git_baseline_mismatch"
	| "missing_git_fallback"
	| "git_root_changed";

export type ChangesetComparison =
	| Readonly<{ kind: "unchanged"; source: "hunk" | "git" }>
	| Readonly<{ kind: "changed"; source: "hunk" | "git"; unrendered: boolean }>
	| Readonly<{ kind: "unknown"; reason: ChangesetUnknownReason }>;

export type HunkFingerprint = Readonly<{
	sessionId: string;
	targetSignature: string;
	patchDigest: string;
}>;

export type ChangesetFile = Readonly<{
	path: string;
	previousPath?: string;
	patch: string;
}>;

export type GitFileFingerprint = Readonly<{
	path: string;
	previousPath?: string;
	patchDigest: string;
}>;

export type GitFingerprint = Readonly<{
	root: string;
	patchDigest: string;
	files: readonly GitFileFingerprint[];
}>;

export type ChangesetBaseline = Readonly<{
	hunk: HunkFingerprint;
	git?: GitFingerprint;
	renderRevision: number;
}>;

function lengthPrefix(value: string): Buffer {
	const bytes = Buffer.from(value, "utf8");
	const size = Buffer.allocUnsafe(8);
	size.writeBigUInt64BE(BigInt(bytes.length));
	return Buffer.concat([size, bytes]);
}

function digest(values: readonly string[]): string {
	const hash = createHash("sha256");
	for (const value of values) hash.update(lengthPrefix(value));
	return hash.digest("hex");
}

function pathName(value: string): string {
	return value.replace(/\\/g, "/");
}

/** Remove transport-only line endings and the terminal newline from a patch. */
export function canonicalPatch(patch: string): string {
	const lines = patch.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
	while (lines.length && lines[lines.length - 1] === "") lines.pop();
	return lines.join("\n");
}

export function canonicalChangesetFiles(files: readonly ChangesetFile[]): ChangesetFile[] {
	return files
		.map((file) => ({
			path: pathName(file.path),
			previousPath: file.previousPath ? pathName(file.previousPath) : undefined,
			patch: canonicalPatch(file.patch),
		}))
		.sort((left, right) => left.path.localeCompare(right.path) || (left.previousPath ?? "").localeCompare(right.previousPath ?? "") || left.patch.localeCompare(right.patch));
}

/** Stable, order-independent digest over one length-prefixed chunk per file. */
export function changesetDigest(files: readonly ChangesetFile[]): string {
	const parts: string[] = [];
	for (const file of canonicalChangesetFiles(files)) parts.push(file.path, file.previousPath ?? "", file.patch);
	return digest(parts);
}

export function hunkFingerprint(snapshot: ReviewSnapshot): HunkFingerprint {
	return {
		sessionId: snapshot.sessionId,
		targetSignature: targetSignatureFromSnapshot(snapshot),
		patchDigest: snapshot.patchDigest,
	};
}

export function gitFingerprint(root: string, files: readonly ChangesetFile[]): GitFingerprint {
	const canonical = canonicalChangesetFiles(files);
	return {
		root,
		patchDigest: changesetDigest(canonical),
		files: canonical.map((file) => ({
			path: file.path,
			previousPath: file.previousPath,
			patchDigest: changesetDigest([file]),
		})),
	};
}

export function gitFingerprintMatchesSnapshot(fingerprint: GitFingerprint, snapshot: ReviewSnapshot): boolean {
	return fingerprint.patchDigest === changesetDigest(snapshot.files);
}

export function createChangesetBaseline(snapshot: ReviewSnapshot, renderRevision: number, git?: GitFingerprint): ChangesetBaseline {
	return { hunk: hunkFingerprint(snapshot), ...(git ? { git } : {}), renderRevision };
}

export function isChangesetBaseline(value: unknown): value is ChangesetBaseline {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const baseline = value as Record<string, unknown>;
	if (!Number.isInteger(baseline.renderRevision) || (baseline.renderRevision as number) < 0) return false;
	if (!baseline.hunk || typeof baseline.hunk !== "object" || Array.isArray(baseline.hunk)) return false;
	const hunk = baseline.hunk as Record<string, unknown>;
	if (typeof hunk.sessionId !== "string" || !hunk.sessionId || typeof hunk.targetSignature !== "string" || typeof hunk.patchDigest !== "string" || !hunk.patchDigest) return false;
	if (baseline.git === undefined) return true;
	if (!baseline.git || typeof baseline.git !== "object" || Array.isArray(baseline.git)) return false;
	const git = baseline.git as Record<string, unknown>;
	if (typeof git.root !== "string" || !git.root || typeof git.patchDigest !== "string" || !git.patchDigest || !Array.isArray(git.files)) return false;
	return git.files.every((file) => {
		if (!file || typeof file !== "object" || Array.isArray(file)) return false;
		const item = file as Record<string, unknown>;
		return typeof item.path === "string" && !!item.path && typeof item.patchDigest === "string" && !!item.patchDigest && (item.previousPath === undefined || typeof item.previousPath === "string");
	});
}

export function sameHunkFingerprint(left: HunkFingerprint, right: HunkFingerprint): boolean {
	return left.sessionId === right.sessionId && left.targetSignature === right.targetSignature && left.patchDigest === right.patchDigest;
}

export function compareHunkFingerprint(baseline: ChangesetBaseline, snapshot: ReviewSnapshot): ChangesetComparison {
	return sameHunkFingerprint(baseline.hunk, hunkFingerprint(snapshot))
		? { kind: "unchanged", source: "hunk" }
		: { kind: "changed", source: "hunk", unrendered: false };
}

export function compareGitFingerprint(baseline: ChangesetBaseline, current: GitFingerprint): ChangesetComparison {
	if (!baseline.git) return { kind: "unknown", reason: "missing_git_fallback" };
	if (baseline.git.root !== current.root) return { kind: "unknown", reason: "git_root_changed" };
	return baseline.git.patchDigest === current.patchDigest
		? { kind: "unchanged", source: "git" }
		: { kind: "changed", source: "git", unrendered: false };
}

/** A changed changeset without a new successful inline render is conservative. */
export function applyRenderBoundary(comparison: ChangesetComparison, baseline: ChangesetBaseline, currentRenderRevision: number): ChangesetComparison {
	if (comparison.kind !== "changed") return comparison;
	return { ...comparison, unrendered: currentRenderRevision <= baseline.renderRevision };
}

/** Only an owned default Git working-tree review can use the fallback. */
export function isDefaultGitWorkingTreeReview(snapshot: ReviewSnapshot): boolean {
	const source = snapshot.source && typeof snapshot.source === "object" && !Array.isArray(snapshot.source) ? snapshot.source as Record<string, unknown> : {};
	const kind = [source.inputKind, source.kind, source.source].find((value): value is string => typeof value === "string")?.toLowerCase();
	if (kind && ["raw", "patch", "staged", "jj", "sapling", "pathspec"].some((value) => kind.includes(value))) return false;
	if (snapshot.reviewedRef || targetSignatureFromSnapshot(snapshot)) return false;
	for (const key of ["staged", "cached", "pathspec", "pathspecs", "paths", "files", "range", "ref", "base", "head", "from", "to", "include", "exclude"]) {
		if (source[key] !== undefined) return false;
	}
	return true;
}

export function unknownReasonMessage(reason: ChangesetUnknownReason): string {
	switch (reason) {
		case "hunk_session_unavailable": return "The reviewed Hunk session is unavailable and no eligible Git fallback was captured.";
		case "hunk_export_unavailable": return "Hunk did not return a complete review export.";
		case "hunk_target_unsupported": return "This Hunk target has no safe Git fallback.";
		case "git_unavailable": return "Git is unavailable for the working-tree freshness check.";
		case "git_timeout": return "The Git freshness check timed out.";
		case "git_failed": return "The Git freshness check failed.";
		case "git_malformed": return "Git returned malformed freshness data.";
		case "git_staged_target": return "The review includes staged changes, which are outside the owned working-tree fallback.";
		case "git_baseline_mismatch": return "The captured Hunk files do not match the owned Git working-tree baseline.";
		case "missing_git_fallback": return "No eligible Git fallback was captured for this review.";
		case "git_root_changed": return "The current Git repository is different from the captured review repository.";
	}
}
