import type { AuthStorage } from "@oh-my-pi/pi-ai";
import type { SearchProviderId, SearchResponse } from "../types";
import { SearchProviderError } from "../types";
import { mergeSearchSources } from "../merge";
import { clampNumResults } from "../utils";
import type { SearchParams } from "./base";
import { SearchProvider } from "./base";
import { withHardTimeout } from "./utils";

/**
 * Credential-free engines the Public Web aggregate fans out to. Order is the
 * tiebreak for merged ranking (earlier engines win equal consensus/rank), so
 * engines with the best ranking quality when they answer come first:
 * Google-index engines (startpage, google) lead, and Mojeek's independent
 * index breaks remaining ties (measured 2026-07).
 */
const PUBLIC_ENGINE_IDS = [
	"startpage",
	"google",
	"duckduckgo",
	"ecosia",
	"mojeek",
] as const satisfies readonly SearchProviderId[];

/** Aggregates get a wider default window than single engines: consensus needs breadth. */
const DEFAULT_NUM_RESULTS = 15;
const MAX_NUM_RESULTS = 30;

/**
 * Soft deadline for the fan-out: past this point the aggregate returns as
 * soon as it has at least one engine's results. Fast HTML engines answer
 * well under this; browser-backed engines (google, ecosia, mojeek) routinely
 * exceed it and are treated as bonus coverage rather than latency floor.
 */
const SOFT_DEADLINE_MS = 5_000;

/**
 * Hard deadline for the fan-out: the aggregate returns whatever it has, even
 * nothing, so one pathologically slow engine can never pin the tool call to
 * the per-request 60s ceiling.
 */
const HARD_DEADLINE_MS = 30_000;

/** Deadline overrides — test seam; production callers use the defaults. */
export interface PublicWebDeadlines {
	softMs?: number;
	hardMs?: number;
}

/**
 * Execute a web search against every credential-free engine in parallel and
 * consolidate the results: URLs are deduplicated across engines and ranked by
 * {@link mergeSearchSources} (consensus, per-engine rank, authority, freshness).
 *
 * The fan-out races three exits and returns at the earliest: every engine
 * settled; the soft deadline elapsed with at least one success in hand; the
 * hard deadline elapsed regardless. If the soft deadline fires before any
 * engine has delivered, the aggregate keeps waiting (up to the hard cap) for
 * the first success, so a slow field degrades to fewer engines rather than
 * an empty answer. Stragglers are aborted once the race resolves. Individual
 * engine failures (bot challenges, timeouts) are tolerated; the call fails
 * only when every engine fails.
 */
export async function searchPublicWeb(
	params: SearchParams,
	deadlines: PublicWebDeadlines = {},
): Promise<SearchResponse> {
	const softMs = deadlines.softMs ?? SOFT_DEADLINE_MS;
	const hardMs = deadlines.hardMs ?? HARD_DEADLINE_MS;
	const numResults = clampNumResults(params.numSearchResults ?? params.limit, DEFAULT_NUM_RESULTS, MAX_NUM_RESULTS);
	const engineIds = PUBLIC_ENGINE_IDS;
	// `provider` constructs this class in its static registry; defer the reverse
	// edge until search time to avoid observing its registry in the import TDZ.
	const { formatSearchProviderFailures, getSearchProvider } = await import("../provider");

	// Each engine composes its own per-request ceiling on top of the shared
	// hard deadline; the straggler controller lets the aggregate cancel
	// still-running engines once it decides to return.
	const straggler = new AbortController();
	const signal = AbortSignal.any([withHardTimeout(params.signal, params.timeoutMs), straggler.signal]);

	// oxlint-disable-next-line unicorn/no-new-array -- length preallocation
	const responses: (SearchResponse | undefined)[] = new Array(engineIds.length);
	const failures: { provider: { id: SearchProviderId; label: string }; error: unknown }[] = [];
	const firstSuccess = Promise.withResolvers<void>();
	const all = Promise.all(
		engineIds.map(async (id, index) => {
			try {
				const provider = await getSearchProvider(id);
				responses[index] = await provider.search({ ...params, signal });
				firstSuccess.resolve();
			} catch (error) {
				failures.push({ provider: { id, label: id }, error });
			}
		}),
	);

	await Promise.race([all, Bun.sleep(softMs)]);
	if (!responses.some(response => response !== undefined) && failures.length < engineIds.length) {
		await Promise.race([all, firstSuccess.promise, Bun.sleep(Math.max(0, hardMs - softMs))]);
	}
	straggler.abort();

	// Merge in engine-priority order (not settlement order) so ranking
	// tiebreaks stay deterministic.
	const merged = mergeSearchSources(
		responses.filter((response): response is SearchResponse => response !== undefined).map(r => r.sources),
		{ limit: numResults },
	);

	if (merged.length === 0 && failures.length === engineIds.length) {
		throw new SearchProviderError(
			"public",
			`All public engines failed: ${formatSearchProviderFailures(failures)}`,
			503,
		);
	}

	return { provider: "public", sources: merged };
}

/**
 * Aggregate meta-provider over every credential-free engine. Explicit-only:
 * role chains can select individual engines directly, so fanning out to all
 * five scrapers remains a deliberate choice rather than an implicit fallback.
 */
export class PublicWebProvider extends SearchProvider {
	readonly id = "public";
	readonly label = "Public Web";

	isAvailable(_authStorage: AuthStorage): boolean {
		return false;
	}

	override isExplicitlyAvailable(_authStorage: AuthStorage): boolean {
		return true;
	}

	override isKeyless(): boolean {
		return true;
	}

	search(params: SearchParams): Promise<SearchResponse> {
		return searchPublicWeb(params);
	}
}
