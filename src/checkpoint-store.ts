import { randomUUID } from "node:crypto";
import {
	createChangesetBaseline,
	isChangesetBaseline,
	type ChangesetBaseline,
	type ChangesetComparison,
} from "./changeset";
import { isReviewSnapshot, sameSnapshot, type ReviewSnapshot } from "./review-export";

export type CheckpointState = "reviewing" | "changes_requested" | "approved" | "re_review_due" | "abandoned";

export type ReviewCheckpoint = Readonly<{
	id: string;
	revision: number;
	state: CheckpointState;
	snapshot: ReviewSnapshot;
	baseline: ChangesetBaseline;
	createdAt: string;
	revisionCapturedAt: string;
	updatedAt: string;
	submittedAt?: string;
	abandonedAt?: string;
}>;

export type CheckpointEventV1 =
	| Readonly<{ version: 1; kind: "capture"; checkpointId: string; revision: number; at: string; snapshot: ReviewSnapshot }>
	| Readonly<{ version: 1; kind: "transition"; checkpointId: string; revision: number; at: string; state: CheckpointState }>;

export type CheckpointEventV2 =
	| Readonly<{ version: 2; kind: "capture"; checkpointId: string; revision: number; at: string; snapshot: ReviewSnapshot; baseline: ChangesetBaseline }>
	| Readonly<{ version: 2; kind: "transition"; checkpointId: string; revision: number; at: string; state: CheckpointState; reason?: "changeset_changed" }>;

export type CheckpointEvent = CheckpointEventV1 | CheckpointEventV2;
export type CheckpointError = Readonly<{ kind: "invalid_transition" | "stale_review"; message: string }>;
export type CheckpointResult = Readonly<{ ok: true; checkpoint: ReviewCheckpoint; persisted: boolean }> | Readonly<{ ok: false; error: CheckpointError }>;
export type CheckpointDiagnostics = Readonly<{ ignoredEntries: number; lastError?: string }>;
export type PersistCheckpointEvent = (event: CheckpointEvent) => void;

function freeze<T>(value: T): T {
	if (value && typeof value === "object" && !Object.isFrozen(value)) {
		Object.freeze(value);
		for (const item of Object.values(value as Record<string, unknown>)) freeze(item);
	}
	return value;
}

function error(kind: CheckpointError["kind"], message: string): CheckpointResult {
	return { ok: false, error: { kind, message } };
}

function validState(value: unknown): value is CheckpointState {
	return value === "reviewing" || value === "changes_requested" || value === "approved" || value === "re_review_due" || value === "abandoned";
}

function validTimestamp(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && Number.isFinite(Date.parse(value));
}

function baselineForSnapshot(snapshot: ReviewSnapshot): ChangesetBaseline {
	return createChangesetBaseline(snapshot, 0);
}

function sameBaseline(left: ChangesetBaseline, right: ChangesetBaseline): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

function eventFrom(entry: unknown): CheckpointEvent | undefined {
	if (!entry || typeof entry !== "object") return undefined;
	const custom = entry as { type?: unknown; customType?: unknown; data?: unknown };
	if (custom.type !== "custom" || custom.customType !== "hunk-checkpoint" || !custom.data || typeof custom.data !== "object") return undefined;
	const event = custom.data as Partial<CheckpointEvent> & { reason?: unknown };
	if ((event.version !== 1 && event.version !== 2) || typeof event.checkpointId !== "string" || !event.checkpointId || !Number.isInteger(event.revision) || event.revision < 1 || !validTimestamp(event.at)) return undefined;
	if (event.kind === "capture" && isReviewSnapshot(event.snapshot)) {
		if (event.version === 1) return event as CheckpointEventV1;
		return isChangesetBaseline(event.baseline) ? event as CheckpointEventV2 : undefined;
	}
	if (event.kind === "transition" && validState(event.state)) {
		if (event.reason !== undefined && event.reason !== "changeset_changed") return undefined;
		if (event.version === 2 && event.state === "re_review_due" && event.reason !== "changeset_changed") return undefined;
		if (event.version === 2 && event.state !== "re_review_due" && event.reason !== undefined) return undefined;
		return event as CheckpointEvent;
	}
	return undefined;
}

/** Append-only review state machine. Snapshot creation stays outside; all state
 * transitions, baselines, and journal records live here. */
export interface CheckpointStore {
	current(): ReviewCheckpoint | undefined;
	diagnostics(): CheckpointDiagnostics;
	beginReview(snapshot: ReviewSnapshot, baseline?: ChangesetBaseline): CheckpointResult;
	captureDraft(snapshot: ReviewSnapshot, baseline?: ChangesetBaseline): CheckpointResult;
	/** Compatibility entry point for callers that already have a draft. */
	capture(snapshot: ReviewSnapshot, baseline?: ChangesetBaseline): CheckpointResult;
	submit(): CheckpointResult;
	reconcileChangeset(comparison: ChangesetComparison): CheckpointResult;
	abandon(): CheckpointResult;
	rehydrate(entries: readonly unknown[]): void;
}

export function createCheckpointStore(
	persist: PersistCheckpointEvent,
	createId: () => string = randomUUID,
	now: () => string = () => new Date().toISOString(),
): CheckpointStore {
	let checkpoint: ReviewCheckpoint | undefined;
	let ignoredEntries = 0;
	let lastError: string | undefined;

	const set = (next: ReviewCheckpoint) => {
		checkpoint = freeze(next);
		return checkpoint;
	};
	const write = (event: CheckpointEvent) => persist(freeze(event));
	const success = (next: ReviewCheckpoint, persisted: boolean): CheckpointResult => ({ ok: true, checkpoint: next, persisted });
	const transitionFields = (current: ReviewCheckpoint, state: CheckpointState, at: string): ReviewCheckpoint => ({
		...current,
		state,
		updatedAt: at,
		...(state === "changes_requested" || state === "approved" ? { submittedAt: at } : {}),
		...(state === "abandoned" ? { abandonedAt: at } : {}),
	});
	const transition = (state: CheckpointState, persisted: boolean, reason?: "changeset_changed"): CheckpointResult => {
		if (!checkpoint) return error("invalid_transition", "No review checkpoint exists.");
		const at = now();
		if (!validTimestamp(at)) return error("invalid_transition", "Checkpoint clock returned an invalid timestamp.");
		const next = transitionFields(checkpoint, state, at);
		if (persisted) {
			const event: CheckpointEventV2 = { version: 2, kind: "transition", checkpointId: next.id, revision: next.revision, at, state, ...(reason ? { reason } : {}) };
			write(event);
		}
		return success(set(next), persisted);
	};

	const captureEvent = (next: ReviewCheckpoint): CheckpointEventV2 => ({
		version: 2,
		kind: "capture",
		checkpointId: next.id,
		revision: next.revision,
		at: next.revisionCapturedAt,
		snapshot: next.snapshot,
		baseline: next.baseline,
	});

	function captureNext(snapshot: ReviewSnapshot, baseline: ChangesetBaseline, explicit: boolean): CheckpointResult {
		if (!isReviewSnapshot(snapshot)) return error("invalid_transition", "Cannot capture malformed review snapshot.");
		if (!isChangesetBaseline(baseline)) return error("invalid_transition", "Cannot capture a malformed changeset baseline.");
		if (checkpoint?.state === "changes_requested" && !explicit) return error("invalid_transition", "Cannot update a submitted review before it is invalidated.");
		if (checkpoint?.state === "re_review_due" && !explicit) return error("stale_review", "Review is re-review due. Begin another Hunk review first.");
		if (checkpoint?.state === "reviewing" && sameSnapshot(checkpoint.snapshot, snapshot) && sameBaseline(checkpoint.baseline, baseline)) return success(checkpoint, false);
		const at = now();
		if (!validTimestamp(at)) return error("invalid_transition", "Checkpoint clock returned an invalid timestamp.");
		const terminal = !checkpoint || checkpoint.state === "approved" || checkpoint.state === "abandoned";
		const next: ReviewCheckpoint = terminal
			? { id: createId(), revision: 1, state: "reviewing", snapshot, baseline, createdAt: at, revisionCapturedAt: at, updatedAt: at }
			: { ...checkpoint, revision: checkpoint.revision + 1, state: "reviewing", snapshot, baseline, revisionCapturedAt: at, updatedAt: at, submittedAt: undefined, abandonedAt: undefined };
		write(captureEvent(next));
		return success(set(next), true);
	}

	function apply(event: CheckpointEvent): boolean {
		if (event.kind === "capture") {
			const baseline = event.version === 2 ? event.baseline : baselineForSnapshot(event.snapshot);
			if (!isChangesetBaseline(baseline)) return false;
			if (!checkpoint) {
				if (event.revision !== 1) return false;
				set({ id: event.checkpointId, revision: 1, state: "reviewing", snapshot: event.snapshot, baseline, createdAt: event.at, revisionCapturedAt: event.at, updatedAt: event.at });
				return true;
			}
			if (checkpoint.id !== event.checkpointId) {
				if ((checkpoint.state !== "approved" && checkpoint.state !== "abandoned") || event.revision !== 1) return false;
				set({ id: event.checkpointId, revision: 1, state: "reviewing", snapshot: event.snapshot, baseline, createdAt: event.at, revisionCapturedAt: event.at, updatedAt: event.at });
				return true;
			}
			if ((checkpoint.state !== "reviewing" && checkpoint.state !== "re_review_due") || event.revision !== checkpoint.revision + 1) return false;
			set({ ...checkpoint, revision: event.revision, state: "reviewing", snapshot: event.snapshot, baseline, revisionCapturedAt: event.at, updatedAt: event.at, submittedAt: undefined, abandonedAt: undefined });
			return true;
		}
		if (!checkpoint || checkpoint.id !== event.checkpointId || checkpoint.revision !== event.revision) return false;
		if (event.state === "changes_requested" || event.state === "approved") {
			if (checkpoint.state !== "reviewing") return false;
		} else if (event.state === "re_review_due") {
			if (checkpoint.state !== "reviewing" && checkpoint.state !== "changes_requested" && checkpoint.state !== "approved") return false;
		} else if (event.state === "abandoned") {
			if (checkpoint.state !== "reviewing" && checkpoint.state !== "changes_requested" && checkpoint.state !== "re_review_due") return false;
		} else {
			return false;
		}
		set(transitionFields(checkpoint, event.state, event.at));
		return true;
	}

	return {
		current: () => checkpoint,
		diagnostics: () => ({ ignoredEntries, lastError }),
		beginReview(snapshot, baseline = baselineForSnapshot(snapshot)) {
			return captureNext(snapshot, baseline, true);
		},
		captureDraft(snapshot, baseline = checkpoint?.baseline ?? baselineForSnapshot(snapshot)) {
			return captureNext(snapshot, baseline, false);
		},
		capture(snapshot, baseline) {
			return captureNext(snapshot, baseline ?? checkpoint?.baseline ?? baselineForSnapshot(snapshot), false);
		},
		submit() {
			if (!checkpoint || checkpoint.state !== "reviewing") return error("invalid_transition", "Submit requires a reviewing checkpoint.");
			return transition(checkpoint.snapshot.notes.length ? "changes_requested" : "approved", true);
		},
		reconcileChangeset(comparison) {
			if (comparison.kind !== "changed") return checkpoint ? success(checkpoint, false) : error("invalid_transition", "No review checkpoint exists.");
			if (!checkpoint || (checkpoint.state !== "reviewing" && checkpoint.state !== "changes_requested" && checkpoint.state !== "approved")) {
				return checkpoint ? success(checkpoint, false) : error("invalid_transition", "No review checkpoint exists.");
			}
			if (checkpoint.state === "re_review_due") return success(checkpoint, false);
			return transition("re_review_due", true, "changeset_changed");
		},
		abandon() {
			if (!checkpoint || (checkpoint.state !== "reviewing" && checkpoint.state !== "changes_requested" && checkpoint.state !== "re_review_due")) return error("invalid_transition", "No active review can be abandoned.");
			return transition("abandoned", true);
		},
		rehydrate(entries) {
			checkpoint = undefined;
			ignoredEntries = 0;
			lastError = undefined;
			for (const entry of entries) {
				const custom = entry as { type?: unknown; customType?: unknown };
				if (custom?.type !== "custom" || custom.customType !== "hunk-checkpoint") continue;
				const event = eventFrom(entry);
				if (!event || !apply(event)) {
					ignoredEntries++;
					lastError = "Ignored malformed or invalid hunk-checkpoint journal entry.";
				}
			}
		},
	};
}
