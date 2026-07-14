import type { ReviewCheckpoint } from "./checkpoint-store";
import type { ChangesetComparison } from "./changeset";

export type HunkLiveSession = "none" | "local" | "elsewhere";

export type HunkPresentationInput = Readonly<{
	enabled: boolean;
	checkpoint?: ReviewCheckpoint;
	liveSession: HunkLiveSession;
	freshness?: ChangesetComparison;
}>;

export type HunkPresentation = Readonly<{
	status?: string;
	hunkHint?: string;
}>;

function notes(count: number): string {
	return `${count} note${count === 1 ? "" : "s"}`;
}

/** Pure mapping from lifecycle/freshness state to the persistent footer model. */
export function presentHunk(input: HunkPresentationInput): HunkPresentation {
	if (!input.enabled) return {};
	const checkpoint = input.checkpoint;
	if (!checkpoint || checkpoint.state === "abandoned") {
		return { status: "hunk · ready", hunkHint: "/hunk review (Ctrl+Shift+H)" };
	}

	if (checkpoint.state === "reviewing") {
		const status = input.liveSession === "elsewhere"
			? `hunk · reviewing elsewhere · ${notes(checkpoint.snapshot.notes.length)}`
			: `hunk · reviewing · ${notes(checkpoint.snapshot.notes.length)}`;
		if (input.freshness?.kind === "unknown") return { status, hunkHint: "/hunk status" };
		if (input.freshness?.kind === "changed" && input.freshness.unrendered) return { status, hunkHint: "changeset updated outside inline diff · /hunk review" };
		return { status, hunkHint: input.liveSession === "elsewhere" ? "review active elsewhere · /hunk submit" : "/hunk submit" };
	}

	if (checkpoint.state === "changes_requested") {
		return {
			status: `hunk · ${notes(checkpoint.snapshot.notes.length)} submitted`,
			...(input.freshness?.kind === "unknown" ? { hunkHint: "/hunk status" } : {}),
		};
	}

	if (checkpoint.state === "re_review_due") {
		const changed = input.freshness?.kind === "changed";
		const status = changed ? "hunk · re-review · external changes" : "hunk · re-review";
		if (input.freshness?.kind === "unknown") return { status: "hunk · re-review", hunkHint: "/hunk status" };
		if (input.freshness?.kind === "changed" && input.freshness.unrendered) return { status, hunkHint: "changeset updated outside inline diff · /hunk review" };
		return { status, hunkHint: "/hunk review (Ctrl+Shift+H)" };
	}

	if (input.freshness?.kind === "unknown") return { status: "hunk · approved · state unknown", hunkHint: "/hunk status" };
	return { status: "hunk · approved" };
}
