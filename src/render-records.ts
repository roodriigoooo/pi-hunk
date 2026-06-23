import { fileKey } from "./paths";

export type RenderRecord = {
	tool: "write" | "edit";
	filePath: string;
	patch: string;
	summary: string;
};

/**
 * In-memory store of recent rendered edits.
 *
 * The only place that knows the "recent edits, capped, keyed by tool call
 * and queryable by file" policy. Tools record; the status command reports the
 * count. Held in the extension closure, not module globals, so sessions don't
 * bleed into each other and tests can use a fresh instance.
 */
export interface RenderRecordStore {
	record(toolCallId: string, record: RenderRecord): void;
	get(toolCallId: string): RenderRecord | undefined;
	recentCount(): number;
	findRecent(filePath: string | undefined, cwd: string): RenderRecord | undefined;
}

export function createRenderRecordStore(): RenderRecordStore {
	const byCall = new Map<string, RenderRecord>();
	const recent: RenderRecord[] = [];
	const CAP = 40;

	return {
		record(toolCallId, record) {
			byCall.set(toolCallId, record);
			recent.unshift(record);
			recent.splice(CAP);
		},
		get(toolCallId) {
			return byCall.get(toolCallId);
		},
		recentCount() {
			return recent.length;
		},
		findRecent(filePath, cwd) {
			const key = fileKey(filePath, cwd);
			if (!key) return undefined;
			return recent.find((record) => fileKey(record.filePath, cwd) === key);
		},
	};
}
