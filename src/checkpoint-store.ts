import { randomUUID } from "node:crypto";
import { isReviewSnapshot, sameSnapshot, type ReviewSnapshot } from "./review-export";

export type CheckpointState = "reviewing" | "changes_requested" | "approved" | "re_review_due" | "abandoned";

export type ReviewCheckpoint = Readonly<{
	id: string;
	revision: number;
	state: CheckpointState;
	snapshot: ReviewSnapshot;
	createdAt: string;
	revisionCapturedAt: string;
	updatedAt: string;
	submittedAt?: string;
	abandonedAt?: string;
}>;

export type CheckpointEventV1 =
	| Readonly<{ version: 1; kind: "capture"; checkpointId: string; revision: number; at: string; snapshot: ReviewSnapshot }>
	| Readonly<{ version: 1; kind: "transition"; checkpointId: string; revision: number; at: string; state: CheckpointState }>;

export type CheckpointError = Readonly<{ kind: "invalid_transition" | "stale_review"; message: string }>;
export type CheckpointResult = Readonly<{ ok: true; checkpoint: ReviewCheckpoint; persisted: boolean }> | Readonly<{ ok: false; error: CheckpointError }>;

export type CheckpointDiagnostics = Readonly<{ ignoredEntries: number; lastError?: string }>;
export type PersistCheckpointEvent = (event: CheckpointEventV1) => void;

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

function eventFrom(entry: unknown): CheckpointEventV1 | undefined {
	if (!entry || typeof entry !== "object") return undefined;
	const custom = entry as { type?: unknown; customType?: unknown; data?: unknown };
	if (custom.type !== "custom" || custom.customType !== "hunk-checkpoint" || !custom.data || typeof custom.data !== "object") return undefined;
	const event = custom.data as Partial<CheckpointEventV1>;
	if (event.version !== 1 || typeof event.checkpointId !== "string" || !Number.isInteger(event.revision) || event.revision < 1 || !validTimestamp(event.at)) return undefined;
	if (event.kind === "capture" && isReviewSnapshot(event.snapshot)) return event as CheckpointEventV1;
	if (event.kind === "transition" && validState(event.state)) return event as CheckpointEventV1;
	return undefined;
}

/** Append-only review state machine. Snapshot creation stays outside; all state
 * transitions and journal records live here. */
export interface CheckpointStore {
	current(): ReviewCheckpoint | undefined;
	diagnostics(): CheckpointDiagnostics;
	capture(snapshot: ReviewSnapshot): CheckpointResult;
	submit(): CheckpointResult;
	invalidateForAgentEdit(): CheckpointResult;
	abandon(): CheckpointResult;
	rehydrate(entries: readonly unknown[]): void;
}

export function createCheckpointStore(persist: PersistCheckpointEvent, createId: () => string = randomUUID, now: () => string = () => new Date().toISOString()): CheckpointStore {
	let checkpoint: ReviewCheckpoint | undefined;
	let ignoredEntries = 0;
	let lastError: string | undefined;

	const set = (next: ReviewCheckpoint) => {
		checkpoint = freeze(next);
		return checkpoint;
	};
	const write = (event: CheckpointEventV1) => persist(freeze(event));
	const success = (next: ReviewCheckpoint, persisted: boolean): CheckpointResult => ({ ok: true, checkpoint: next, persisted });
	const transitionFields = (current: ReviewCheckpoint, state: CheckpointState, at: string): ReviewCheckpoint => ({
		...current,
		state,
		updatedAt: at,
		...(state === "changes_requested" || state === "approved" ? { submittedAt: at } : {}),
		...(state === "abandoned" ? { abandonedAt: at } : {}),
	});
	const transition = (state: CheckpointState, persisted: boolean): CheckpointResult => {
		if (!checkpoint) return error("invalid_transition", "No review checkpoint exists.");
		const at = now();
		if (!validTimestamp(at)) return error("invalid_transition", "Checkpoint clock returned an invalid timestamp.");
		const next = transitionFields(checkpoint, state, at);
		if (persisted) write({ version: 1, kind: "transition", checkpointId: next.id, revision: next.revision, at, state });
		return success(set(next), persisted);
	};

	function apply(event: CheckpointEventV1): boolean {
		if (event.kind === "capture") {
			if (!checkpoint) {
				if (event.revision !== 1) return false;
				set({ id: event.checkpointId, revision: 1, state: "reviewing", snapshot: event.snapshot, createdAt: event.at, revisionCapturedAt: event.at, updatedAt: event.at });
				return true;
			}
			if (checkpoint.id !== event.checkpointId) {
				if ((checkpoint.state !== "approved" && checkpoint.state !== "abandoned") || event.revision !== 1) return false;
				set({ id: event.checkpointId, revision: 1, state: "reviewing", snapshot: event.snapshot, createdAt: event.at, revisionCapturedAt: event.at, updatedAt: event.at });
				return true;
			}
			if ((checkpoint.state !== "reviewing" && checkpoint.state !== "re_review_due") || event.revision !== checkpoint.revision + 1) return false;
			set({ ...checkpoint, revision: event.revision, state: "reviewing", snapshot: event.snapshot, revisionCapturedAt: event.at, updatedAt: event.at, submittedAt: undefined, abandonedAt: undefined });
			return true;
		}
		if (!checkpoint || checkpoint.id !== event.checkpointId || checkpoint.revision !== event.revision) return false;
		if (event.state === "changes_requested" || event.state === "approved") {
			if (checkpoint.state !== "reviewing") return false;
		} else if (event.state === "re_review_due") {
			if (checkpoint.state !== "reviewing" && checkpoint.state !== "changes_requested") return false;
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
		capture(snapshot) {
			if (!isReviewSnapshot(snapshot)) return error("invalid_transition", "Cannot capture malformed review snapshot.");
			if (checkpoint?.state === "reviewing" && sameSnapshot(checkpoint.snapshot, snapshot)) return success(checkpoint, false);
			if (checkpoint?.state === "changes_requested") return error("invalid_transition", "Cannot capture a submitted review before it is invalidated.");
			const at = now();
			if (!validTimestamp(at)) return error("invalid_transition", "Checkpoint clock returned an invalid timestamp.");
			if (!checkpoint || checkpoint.state === "approved" || checkpoint.state === "abandoned") {
				const next: ReviewCheckpoint = { id: createId(), revision: 1, state: "reviewing", snapshot, createdAt: at, revisionCapturedAt: at, updatedAt: at };
				write({ version: 1, kind: "capture", checkpointId: next.id, revision: next.revision, at, snapshot });
				return success(set(next), true);
			}
			const next: ReviewCheckpoint = { ...checkpoint, revision: checkpoint.revision + 1, state: "reviewing", snapshot, revisionCapturedAt: at, updatedAt: at, submittedAt: undefined, abandonedAt: undefined };
			write({ version: 1, kind: "capture", checkpointId: next.id, revision: next.revision, at, snapshot });
			return success(set(next), true);
		},
		submit() {
			if (!checkpoint || checkpoint.state !== "reviewing") return error("invalid_transition", "Submit requires a reviewing checkpoint.");
			return transition(checkpoint.snapshot.notes.length ? "changes_requested" : "approved", true);
		},
		invalidateForAgentEdit() {
			if (!checkpoint || (checkpoint.state !== "reviewing" && checkpoint.state !== "changes_requested")) return error("invalid_transition", "No active review needs invalidation.");
			return transition("re_review_due", true);
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
