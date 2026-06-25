import { createHighlighter } from "shiki";
import { COMMON_LANGS, highlighterKey, type HunkConfig } from "./config";
import type { Highlighter } from "./diff-view";

export type HighlighterFactory = (config: HunkConfig) => Promise<Highlighter | undefined>;

export interface HighlighterCache {
	get(config: HunkConfig, invalidate?: () => void): Highlighter | undefined;
	refresh(config: HunkConfig, invalidate?: () => void): Promise<void>;
	loadedKey(): string;
	isRefreshing(): boolean;
}

async function defaultHighlighterFactory(config: HunkConfig): Promise<Highlighter | undefined> {
	return (await createHighlighter({
		themes: Array.from(new Set([config.shikiDarkTheme, config.shikiLightTheme])),
		langs: [...COMMON_LANGS],
	})) as Highlighter;
}

export function createHighlighterCache(factory: HighlighterFactory = defaultHighlighterFactory): HighlighterCache {
	let highlighter: Highlighter | undefined;
	let loadedKey = "";
	let refreshPromise: Promise<void> | undefined;
	let queuedConfig: HunkConfig | undefined;
	const invalidates = new Set<() => void>();

	async function rebuild(config: HunkConfig): Promise<void> {
		const key = highlighterKey(config);
		try {
			highlighter = await factory(config);
			loadedKey = key;
		} catch {
			highlighter = undefined;
			loadedKey = key;
		}
	}

	function notifyInvalidated(): void {
		const callbacks = [...invalidates];
		invalidates.clear();
		for (const invalidate of callbacks) invalidate();
	}

	async function drain(): Promise<void> {
		while (queuedConfig && loadedKey !== highlighterKey(queuedConfig)) {
			const next = queuedConfig;
			queuedConfig = undefined;
			await rebuild(next);
			notifyInvalidated();
		}
	}

	return {
		get(config, invalidate) {
			if (loadedKey === highlighterKey(config)) return highlighter;
			void this.refresh(config, invalidate);
			return highlighter;
		},

		refresh(config, invalidate) {
			if (loadedKey === highlighterKey(config)) return Promise.resolve();
			if (invalidate) invalidates.add(invalidate);
			queuedConfig = config;
			if (!refreshPromise) {
				refreshPromise = drain().finally(() => {
					refreshPromise = undefined;
				});
			}
			return refreshPromise;
		},

		loadedKey() {
			return loadedKey;
		},

		isRefreshing() {
			return !!refreshPromise;
		},
	};
}
