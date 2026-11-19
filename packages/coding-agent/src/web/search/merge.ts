/**
 * Cross-engine result merging for multi-provider search.
 *
 * One batch per engine response, in the order the engines were queried. A URL
 * seen by several engines keeps one entry: the best rank owns title/url, the
 * longest snippet wins, and the merged order is a weighted score over the
 * signals engines actually return (their own relevance, cross-engine consensus,
 * site authority, freshness).
 *
 * Merged entries carry no merge-only fields: the returned `SearchSource` objects
 * keep exactly the shape the engine produced, so callers (and tests) that
 * compare results never see synthetic ranking metadata.
 */

import type { SearchSource } from "./types";

/** Relative weight of each ranking signal; the four sum to 1. */
export interface MergeWeights {
	/** Engine relevance (reported score, else rank position within its batch). */
	relevance: number;
	/** How many engines returned this URL. */
	consensus: number;
	/** Engine-reported site authority. */
	authority: number;
	/** Publication freshness. */
	recency: number;
}

const DEFAULT_WEIGHTS: MergeWeights = {
	relevance: 0.5,
	consensus: 0.25,
	authority: 0.15,
	recency: 0.1,
};

/** Half-life of the freshness signal: a one-year-old page scores half. */
const RECENCY_HALF_LIFE_SECONDS = 180 * 24 * 60 * 60;

export interface MergeOptions {
	/** Max merged entries; defaults to every distinct URL. */
	limit?: number;
	weights?: Partial<MergeWeights>;
}

interface MergedEntry {
	source: SearchSource;
	engines: number;
	bestRank: number;
	bestRelevance: number;
	order: number;
}

/**
 * Canonical dedup key for a result URL: case-normalized host without a leading
 * `www.`, path without a trailing slash, query preserved, fragment dropped.
 * Engines disagree on exactly these variations for the same page.
 */
export function searchResultKey(rawUrl: string): string {
	try {
		const url = new URL(rawUrl);
		const host = url.hostname.toLowerCase().replace(/^www\./, "");
		let path = url.pathname;
		if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
		return `${host}${path}${url.search}`;
	} catch {
		return rawUrl;
	}
}

/** Freshness in [0,1] from age; unknown age is neutral. */
function freshness(source: SearchSource): number {
	const age = source.ageSeconds;
	if (age === undefined || !Number.isFinite(age)) return 0.5;
	return 0.5 ** (Math.max(0, age) / RECENCY_HALF_LIFE_SECONDS);
}

/** Engine relevance in [0,1]: the reported score, else its rank within the batch. */
function relevanceOf(source: SearchSource, rank: number, batchSize: number): number {
	const reported = source.relevance;
	if (reported !== undefined && Number.isFinite(reported)) return Math.min(1, Math.max(0, reported));
	return 1 - rank / Math.max(1, batchSize);
}

/**
 * Merge engine result batches into one ranked list.
 *
 * Ranking is `w_relevance * relevance + w_consensus * consensus +
 * w_authority * authority + w_recency * freshness`, with consensus measured as
 * the share of batches that returned the URL. Ties fall back to consensus, best
 * rank, and first-seen order so repeated calls stay deterministic.
 */
export function mergeSearchSources(
	batches: readonly (readonly SearchSource[])[],
	options: MergeOptions = {},
): SearchSource[] {
	const weights: MergeWeights = { ...DEFAULT_WEIGHTS, ...options.weights };
	const entries = new Map<string, MergedEntry>();

	for (const sources of batches) {
		for (const [rank, source] of sources.entries()) {
			const key = searchResultKey(source.url);
			const relevance = relevanceOf(source, rank, sources.length);
			const existing = entries.get(key);
			if (!existing) {
				entries.set(key, {
					source: { ...source },
					engines: 1,
					bestRank: rank,
					bestRelevance: relevance,
					order: entries.size,
				});
				continue;
			}
			existing.engines += 1;
			existing.bestRelevance = Math.max(existing.bestRelevance, relevance);
			if (rank < existing.bestRank) {
				existing.bestRank = rank;
				existing.source.title = source.title;
				existing.source.url = source.url;
			}
			// Keep the most informative snippet regardless of which engine ranked it best.
			if ((source.snippet?.length ?? 0) > (existing.source.snippet?.length ?? 0)) {
				existing.source.snippet = source.snippet;
			}
			if (existing.source.publishedDate === undefined && source.publishedDate !== undefined) {
				existing.source.publishedDate = source.publishedDate;
			}
			if (existing.source.ageSeconds === undefined && source.ageSeconds !== undefined) {
				existing.source.ageSeconds = source.ageSeconds;
			}
			if (existing.source.author === undefined && source.author !== undefined) {
				existing.source.author = source.author;
			}
			if (source.authority !== undefined) {
				existing.source.authority = Math.max(existing.source.authority ?? 0, source.authority);
			}
			if (source.relevance !== undefined) {
				existing.source.relevance = Math.max(existing.source.relevance ?? 0, source.relevance);
			}
		}
	}

	const batchCount = Math.max(1, batches.length);
	const scored = [...entries.values()].map(entry => {
		const consensus = entry.engines / batchCount;
		const authority = entry.source.authority ?? 0.5;
		const score =
			weights.relevance * entry.bestRelevance +
			weights.consensus * consensus +
			weights.authority * authority +
			weights.recency * freshness(entry.source);
		return { entry, score };
	});

	scored.sort(
		(a, b) =>
			b.score - a.score ||
			b.entry.engines - a.entry.engines ||
			a.entry.bestRank - b.entry.bestRank ||
			a.entry.order - b.entry.order,
	);

	return scored.slice(0, options.limit ?? scored.length).map(({ entry }) => entry.source);
}
