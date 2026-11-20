/**
 * Unified Web Search Tool
 *
 * Single tool supporting Anthropic, Perplexity, Exa, Brave, DeepSeek, Jina, Kimi, Gemini, Codex, Tavily, Kagi, Z.AI, SearXNG, and Synthetic
 * providers with provider-specific parameters exposed conditionally.
 */

import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import { type Api, type AssistantMessage, type AuthStorage, type Model, tokenUsage } from "@oh-my-pi/pi-ai";
import { calculateCost } from "@oh-my-pi/pi-catalog/models";
import { modelKind } from "@oh-my-pi/pi-catalog/types";
import { formatAge, formatCount, prompt, truncate } from "@oh-my-pi/pi-utils";
import { cfgOffline } from "../../config/auxiliary-model-policy";
import { ModelRegistry } from "../../config/model-registry";
import { type RoleChainCandidate, resolveModelRoleValue, resolveRoleChain } from "../../config/model-resolver";
import { roleCandidatePool } from "../../config/model-roles";
import { settings, type Settings } from "../../config/settings";
import type { CustomTool, CustomToolContext } from "../../extensibility/custom-tools/types";
import webSearchSystemPrompt from "../../prompts/system/web-search.md" with { type: "text" };
import webSearchDescription from "../../prompts/tools/web-search.md" with { type: "text" };
import { type CompletionJournal, journalCompletion, type ModelUsageLedger } from "../../session/model-usage-journal";
import { resolveConfiguredModelTarget } from "../../session/role-models";
import { discoverAuthStorage } from "../../sdk";
import type { ToolSession } from "../../tools";
import { throwIfAborted } from "../../tools/tool-errors";
import {
	formatSearchProviderFailure,
	formatSearchProviderFailures,
	getGroundedSearchProvider,
	getSearchProvider,
	type SearchProvider,
	type SearchProviderFailure,
} from "./provider";
import { rankXAIProviders, targetsX, xaiModelChain, xSearchAvailable } from "./providers/xai";
import { mergeSearchSources } from "./merge";
import type { SearchParams } from "./providers/base";
import { applyQueryConstraints, parseSearchQuery, scopeConstraints, type StructuredQuery } from "./query";
import {
	DEFAULT_WEB_SEARCH_TIMEOUT_SECONDS,
	MAX_WEB_SEARCH_TIMEOUT_SECONDS,
	SearchProviderError,
	type SearchDepth,
	type SearchFailureDetail,
	type SearchResponse,
	type SearchResultDetails,
	type SearchSource,
} from "./types";

import {
	cfgProvidersAntigravityEndpoint,
	cfgProvidersWebKeyless,
	cfgProvidersWebSearchTimeoutSeconds,
} from "../../session/settings";

/** Web search tool parameters schema */
export const webSearchSchema = type({
	query: "string",
	recency: "'day' | 'week' | 'month' | 'year'?",
	limit: "number?",
	max_tokens: "number?",
	temperature: "number?",
	num_search_results: "number?",
	depth: "'quick' | 'standard' | 'deep'?",
});

export type SearchToolParams = typeof webSearchSchema.infer;

export interface SearchQueryParams extends SearchToolParams {
	model?: string;
}

/** Per-source excerpt cap for standard/quick searches; deep spends a larger budget. */
const DEFAULT_SNIPPET_CHARS = 240;
const DEEP_SNIPPET_CHARS = 1_200;

/**
 * Format response for LLM consumption. `notes` lead the output (e.g.
 * relaxed-constraint warnings); `snippetChars` caps the excerpt quoted per
 * source, so deep searches can keep the bodies they paid for.
 */
function formatForLLM(
	response: SearchResponse,
	notes: readonly string[] = [],
	options: { snippetChars?: number } = {},
): string {
	const snippetChars = options.snippetChars ?? DEFAULT_SNIPPET_CHARS;
	const parts: string[] = [];
	for (const note of notes) {
		parts.push(`Note: ${note}`);
	}

	if (response.answer) {
		parts.push(response.answer);
		if (response.sources.length > 0) {
			parts.push("\n## Sources");
			parts.push(formatCount("source", response.sources.length));
		}
	}

	for (const [i, src] of response.sources.entries()) {
		const age = formatAge(src.ageSeconds) || src.publishedDate;
		const agePart = age ? ` (${age})` : "";
		parts.push(`[${i + 1}] ${src.title}${agePart}\n    ${src.url}`);
		if (src.snippet) {
			parts.push(`    ${truncate(src.snippet, snippetChars)}`);
		}
	}

	if (response.citations && response.citations.length > 0) {
		parts.push("\n## Citations");
		parts.push(formatCount("citation", response.citations.length));
		for (const [i, citation] of response.citations.entries()) {
			const title = citation.title || citation.url;
			parts.push(`[${i + 1}] ${title}\n    ${citation.url}`);
			if (citation.citedText) {
				parts.push(`    ${truncate(citation.citedText, snippetChars)}`);
			}
		}
	}

	if (response.relatedQuestions && response.relatedQuestions.length > 0) {
		parts.push("\n## Related");
		parts.push(formatCount("question", response.relatedQuestions.length));
		for (const q of response.relatedQuestions) {
			parts.push(`- ${q}`);
		}
	}

	if (response.searchQueries && response.searchQueries.length > 0) {
		parts.push(`Search queries: ${response.searchQueries.length}`);
		for (const query of response.searchQueries.slice(0, 3)) {
			parts.push(`- ${truncate(query, 120)}`);
		}
	}

	return parts.join("\n");
}

/** Longest failure reason a fallback note quotes, the cap source snippets get; provider errors can carry whole response bodies. */
const MAX_FALLBACK_REASON_CHARS = 240;

/** Failed candidates as tool details record them and the fallback note quotes them: reason flattened and capped. */
function failureDetails(failures: readonly SearchProviderFailure[]): SearchFailureDetail[] {
	return failures.map(({ provider, error }): SearchFailureDetail => {
		const reason = formatSearchProviderFailure(error, provider).replace(/\s+/g, " ").trim().replace(/\.$/, "");
		return {
			provider: provider.id,
			label: provider.label,
			reason: truncate(reason, MAX_FALLBACK_REASON_CHARS),
			...(error instanceof SearchProviderError && error.status !== undefined ? { status: error.status } : {}),
		};
	});
}

/**
 * Note naming the candidates that failed before `served` answered. Without it a
 * fallback engine's results read as the preferred provider's, e.g. web pages
 * standing in for an X search.
 */
function fallbackNotes(failed: readonly SearchFailureDetail[], served: { label: string }): string[] {
	if (failed.length === 0) return [];
	return [`answered by ${served.label} after ${failed.map(f => `${f.label} failed (${f.reason})`).join(" and ")}`];
}

/** How long an engine that answered HTTP 429 is skipped by the automatic chain. */
const RATE_LIMIT_COOLDOWN_MS = 5 * 60 * 1000;
/**
 * Engines (`provider/id`) that answered HTTP 429, with when the automatic chain may
 * try them again. A keyless engine's free tier (Parallel, Exa) rate-limits for minutes,
 * so retrying it on every call only adds the 429's latency before the fallback answers.
 */
const rateLimitedUntil = new Map<string, number>();

function hasRenderableSearchContent(response: SearchResponse): boolean {
	if (response.answer?.trim()) return true;
	if (response.sources.length > 0) return true;
	if (response.citations?.length) return true;
	if (response.relatedQuestions?.some(question => question.trim())) return true;
	if (response.searchQueries?.some(query => query.trim())) return true;
	return false;
}

interface ExecuteSearchOptions {
	authStorage: AuthStorage;
	modelRegistry?: ModelRegistry;
	sessionId?: string;
	/** The session's active model; `web/hosted` searches through it. */
	sessionModel?: Model<Api>;
	settings?: Settings;
	signal?: AbortSignal;
	/** Session journal each provider response's usage is billed to; unjournaled when omitted. */
	usageLedger?: Partial<ModelUsageLedger>;
}

/**
 * A provider response's token usage as an assistant message for the session's usage journal, or
 * `undefined` when the provider reported neither input nor output tokens. Search usage carries no
 * cache breakdown and no billed amount, so the cost is the catalog price of the reported tokens:
 * per-search fees are not in it, and a search-only engine without token rates prices at zero.
 */
function searchUsageMessage(
	model: Model<Api>,
	response: SearchResponse,
	duration: number,
): AssistantMessage | undefined {
	const reported = response.usage;
	if (!reported || (reported.inputTokens === undefined && reported.outputTokens === undefined)) return undefined;
	const usage = tokenUsage(reported.inputTokens, reported.outputTokens);
	// A provider's total can count token classes (reasoning, cached input) the split leaves out.
	if (reported.totalTokens !== undefined && reported.totalTokens > usage.totalTokens) {
		usage.totalTokens = reported.totalTokens;
	}
	calculateCost(model, usage);
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: response.provider,
		model: response.model ?? model.id,
		usage,
		stopReason: "stop",
		timestamp: Date.now(),
		duration,
	};
}

function isHostedPlaceholder(model: Model<Api>): boolean {
	return model.provider === "web" && model.id === "hosted";
}

/**
 * Expand the `web/hosted` placeholder into models on the session's own
 * provider, which bill the credential the session already uses: first the
 * session model's cheaper `webSearchModel` swap, then the session model itself.
 * A swap the host does not expose is skipped; a failing swap falls through to
 * the session model. Left unexpanded when neither can search.
 */
function expandHostedCandidate(
	candidate: RoleChainCandidate,
	sessionModel: Model<Api> | undefined,
	pool: Model<Api>[],
): RoleChainCandidate[] {
	if (!isHostedPlaceholder(candidate.model) || !sessionModel) return [candidate];
	const swap = resolveConfiguredModelTarget(sessionModel.webSearchModel, sessionModel, pool);
	const distinctSwap = swap?.provider === sessionModel.provider && swap.id === sessionModel.id ? undefined : swap;
	const models = [distinctSwap, sessionModel].filter((model): model is Model<Api> => !!model?.webSearch);
	if (models.length === 0) return [candidate];
	return models.map(model => ({ ...candidate, model }));
}

/**
 * Move the chain's xAI-grounded candidates to the front, keeping their order,
 * or prepend {@link xaiModelChain} when the chain has none. Unchanged without
 * xAI credentials.
 */
function preferXAI(
	chain: RoleChainCandidate[],
	modelRegistry: ModelRegistry,
	activeSettings: Settings,
): RoleChainCandidate[] {
	const xai = chain.filter(candidate => candidate.model.webSearch === "xai");
	if (xai.length > 0) return [...xai, ...chain.filter(candidate => candidate.model.webSearch !== "xai")];
	return [...xaiModelChain(modelRegistry, activeSettings).map(model => ({ model, explicit: false })), ...chain];
}

function isHackerNewsEngine(model: Model<Api>): boolean {
	return model.provider === "web" && model.id === "hackernews";
}

/**
 * Move the chain's `web/hackernews` candidate to the front, or prepend the
 * pool's as an automatic candidate when the chain has none.
 */
function preferHackerNews(chain: RoleChainCandidate[], pool: Model<Api>[]): RoleChainCandidate[] {
	const listed = chain.filter(candidate => isHackerNewsEngine(candidate.model));
	if (listed.length > 0) return [...listed, ...chain.filter(candidate => !isHackerNewsEngine(candidate.model))];
	const model = pool.find(isHackerNewsEngine);
	return model ? [{ model, explicit: false }, ...chain] : chain;
}

/** Engines queried concurrently in deep mode; beyond this the marginal recall is not worth the latency. */
const DEEP_MAX_PROVIDERS = 3;
/** Deep-mode result window when the caller set no explicit limit. */
const DEEP_DEFAULT_LIMIT = 15;

type CandidateMeta = { id: string; label: string };

interface LoadedCandidate {
	candidate: RoleChainCandidate;
	provider: SearchProvider;
	model: Model<Api>;
}

type CandidateLoad =
	| { kind: "loaded"; loaded: LoadedCandidate }
	| { kind: "skipped" }
	| { kind: "keyless-skipped" }
	| { kind: "failed"; meta: CandidateMeta; error: unknown };

interface SearchAttemptContext {
	params: SearchQueryParams;
	parsedQuery: StructuredQuery;
	authStorage: AuthStorage;
	modelRegistry: ModelRegistry;
	sessionId?: string;
	/** The session's active model; `--offline` restricts search to its provider. */
	sessionModel?: Model<Api>;
	signal?: AbortSignal;
	antigravityEndpointMode?: "auto" | "production" | "sandbox";
	timeoutMs: number;
	/** Settings layer the caller used; policy reads must use the same one. */
	settings: Settings;
	/** Whether keyless engines may run (`providers.webKeyless`, or an explicit per-request selector). */
	keylessAllowed: boolean;
	/** Scope directives (`site:`/`inurl:`) that hold even when they empty the result set. */
	scope?: { label: string; matches: (source: SearchSource) => boolean };
	/** Session usage journal; provider token usage is billed here. */
	journal?: CompletionJournal;
}

interface AttemptStats {
	failures: SearchProviderFailure[];
	availableProviderCount: number;
	lastProvider?: CandidateMeta;
	failedResponseProvider: SearchResponse["provider"];
	/** A keyless engine was skipped because `providers.webKeyless` is off. */
	keylessSkipped: boolean;
	/** Engines that answered but returned nothing inside the scope directives. */
	scopeMisses: { id: SearchResponse["provider"]; label: string }[];
}

type SearchToolResult = { content: Array<{ type: "text"; text: string }>; details: SearchResultDetails };

/**
 * Load a candidate's provider and decide whether it may run: automatic
 * candidates without credentials are skipped silently, explicit ones surface
 * the missing-credential error.
 */
async function loadCandidate(
	candidate: RoleChainCandidate,
	authStorage: AuthStorage,
	keylessAllowed: boolean,
): Promise<CandidateLoad> {
	const model = candidate.model;
	const candidateMeta: CandidateMeta = { id: model.id, label: model.name };
	let provider: SearchProvider | undefined;
	try {
		if (isHostedPlaceholder(model)) {
			if (!candidate.explicit) return { kind: "skipped" };
			throw new Error("The session model has no web search grounding.");
		}
		if (modelKind(model) === "search") {
			provider = await getSearchProvider(model.id);
		} else if (model.webSearch) {
			provider = await getGroundedSearchProvider(model.webSearch);
		} else {
			throw new Error(`Model ${model.provider}/${model.id} does not support web search`);
		}
		if (!keylessAllowed && (await provider.isKeyless(authStorage, model))) return { kind: "keyless-skipped" };
		const available = candidate.explicit
			? await provider.isExplicitlyAvailable(authStorage, model)
			: await provider.isAvailable(authStorage, model);
		if (!available) {
			if (!candidate.explicit) return { kind: "skipped" };
			throw new SearchProviderError(
				provider.id,
				`${provider.label} web search is unavailable. Configure its credentials or select the automatic provider chain.`,
			);
		}
		return { kind: "loaded", loaded: { candidate, provider, model } };
	} catch (error) {
		return {
			kind: "failed",
			meta: provider ? { id: provider.id, label: provider.label } : candidateMeta,
			error,
		};
	}
}

/** Provider call parameters for one attempted candidate. */
function buildProviderParams(context: SearchAttemptContext, loaded: LoadedCandidate, depth: SearchDepth): SearchParams {
	return {
		query: context.params.query,
		parsedQuery: context.parsedQuery,
		depth,
		limit: context.params.limit,
		recency: context.params.recency,
		systemPrompt: webSearchSystemPrompt,
		maxOutputTokens: context.params.max_tokens,
		numSearchResults: context.params.num_search_results,
		temperature: context.params.temperature,
		signal: context.signal,
		timeoutMs: context.timeoutMs,
		authStorage: context.authStorage,
		model: loaded.model,
		thinkingLevel: loaded.candidate.thinkingLevel,
		modelRegistry: context.modelRegistry,
		explicit: loaded.candidate.explicit,
		sessionId: context.sessionId,
		antigravityEndpointMode: context.antigravityEndpointMode,
	};
}

/**
 * A host that silently drops the hosted search tool still answers from the
 * model's weights; without sources that answer is not a search result.
 */
function assertGroundedResult(loaded: LoadedCandidate, response: SearchResponse): void {
	if (modelKind(loaded.model) !== "search" && response.sources.length === 0 && !response.citations?.length) {
		throw new SearchProviderError(
			loaded.provider.id,
			`${loaded.provider.label} returned no sources; ${loaded.model.provider}/${loaded.model.id} may not support hosted web search.`,
			204,
		);
	}
}

/**
 * Constraint pass over whatever a provider returned: enforce the directives it
 * could not (or only partially) honor natively. Scope directives (`site:`,
 * `inurl:`, exclusions) hold even when nothing is left and also filter
 * citations; `intitle:`/`filetype:`/date relax when they would wipe out every
 * result. Answer text cannot be filtered, so it is flagged when sources it may
 * draw on were removed.
 *
 * `scopeMiss` marks a response that only had out-of-scope content: the engine
 * answered, so the caller treats it as an empty result rather than an error.
 */
function constrainResponse(
	response: SearchResponse,
	parsedQuery: StructuredQuery,
	scope?: SearchAttemptContext["scope"],
): { response: SearchResponse; notes: string[]; scopeMiss: boolean } {
	if (!parsedQuery.hasConstraints || (response.sources.length === 0 && !response.citations?.length)) {
		return { response, notes: [], scopeMiss: false };
	}
	const filtered = applyQueryConstraints(response.sources, parsedQuery);
	const citations = scope ? response.citations?.filter(scope.matches) : response.citations;
	const notes = filtered.dropped.map(label => `no results matched \`${label}\`; the constraint was relaxed`);
	let finalResponse = response;
	if (filtered.sources.length !== response.sources.length || citations !== response.citations) {
		finalResponse = {
			...response,
			sources: filtered.sources,
			...(citations === undefined ? {} : { citations }),
		};
	}
	if (!scope) return { response: finalResponse, notes, scopeMiss: false };
	if (filtered.sources.length === 0 && !citations?.length) {
		return { response: finalResponse, notes, scopeMiss: true };
	}
	const offScope =
		response.sources.filter(source => !scope.matches(source)).length +
		(response.citations?.length ?? 0) -
		(citations?.length ?? 0);
	if (response.answer?.trim() && offScope > 0) {
		notes.push(
			`removed ${formatCount("source", offScope)} outside \`${scope.label}\`; the answer text is unfiltered and may draw on them`,
		);
	}
	return { response: finalResponse, notes, scopeMiss: false };
}

/** Render one merged or single-provider response as the tool's text result. */
function renderOutcome(
	response: SearchResponse,
	notes: readonly string[],
	failures: readonly SearchProviderFailure[],
	snippetChars?: number,
): NonNullable<SearchToolResult> {
	const failed = failureDetails(failures);
	const options = snippetChars === undefined ? {} : { snippetChars };
	return {
		content: [{ type: "text" as const, text: formatForLLM(response, notes, options) }],
		details: failed.length > 0 ? { response, failures: failed } : { response },
	};
}

/**
 * Walk the role chain in order and return the first usable answer.
 * `quick` stops after the first available provider is attempted; `standard`
 * keeps walking the chain on failure.
 */
async function searchSequential(
	expanded: readonly RoleChainCandidate[],
	context: SearchAttemptContext,
	stats: AttemptStats,
	depth: SearchDepth,
): Promise<SearchToolResult | undefined> {
	for (const candidate of expanded) {
		const candidateMeta: CandidateMeta = { id: candidate.model.id, label: candidate.model.name };
		stats.lastProvider = candidateMeta;
		if (cfgOffline.get(context.settings)) {
			const activeProvider = context.sessionModel?.provider;
			// Search-only catalog entries use the synthetic "web" provider; their
			// backend is not the session's model endpoint, so do not infer a match.
			if (
				!activeProvider ||
				candidate.model.provider !== activeProvider ||
				modelKind(candidate.model) === "search"
			) {
				continue;
			}
		}
		const engineKey = `${candidate.model.provider}/${candidate.model.id}`;
		const cooldownEnds = rateLimitedUntil.get(engineKey);
		if (cooldownEnds !== undefined && !context.params.model) {
			if (cooldownEnds > Date.now()) {
				stats.failures.push({
					provider: candidateMeta,
					error: new Error(
						`skipped: rate-limited (429) within the last ${RATE_LIMIT_COOLDOWN_MS / 60_000} minutes`,
					),
				});
				continue;
			}
			rateLimitedUntil.delete(engineKey);
		}
		const load = await loadCandidate(candidate, context.authStorage, context.keylessAllowed);
		if (load.kind === "skipped") continue;
		if (load.kind === "keyless-skipped") {
			stats.keylessSkipped = true;
			continue;
		}
		if (load.kind === "failed") {
			stats.failedResponseProvider = "none";
			stats.failures.push({ provider: load.meta, error: load.error });
			continue;
		}
		const { provider } = load.loaded;
		stats.availableProviderCount++;
		stats.lastProvider = { id: provider.id, label: provider.label };
		try {
			const sentAt = Date.now();
			const response = await provider.search(buildProviderParams(context, load.loaded, depth));
			// Before any rejection below: a response a later check discards was still billed.
			const billed = searchUsageMessage(load.loaded.model, response, Date.now() - sentAt);
			if (billed) context.journal?.(billed);
			assertGroundedResult(load.loaded, response);
			const constrained = constrainResponse(response, context.parsedQuery, context.scope);
			if (constrained.scopeMiss) {
				stats.scopeMisses.push({ id: provider.id, label: provider.label });
				continue;
			}
			const notes = [...constrained.notes];
			if (modelKind(load.loaded.model) !== "search" && constrained.response.answer?.trim()) {
				notes.unshift(
					`synthesized answer by ${load.loaded.model.provider}/${load.loaded.model.id} hosted search, not a result list; check claims against the cited sources`,
				);
			}
			if (!hasRenderableSearchContent(constrained.response)) {
				throw new SearchProviderError(provider.id, `${provider.label} returned no renderable search content.`, 204);
			}
			const failed = failureDetails(stats.failures);
			return renderOutcome(constrained.response, [...fallbackNotes(failed, provider), ...notes], stats.failures);
		} catch (error) {
			// Surface user-initiated cancellation immediately so the session sees
			// a clean abort instead of a generic "all providers failed" message.
			// Without this, an AbortError from `fetch()` is treated as a provider
			// failure and the loop falls through to the next provider (or to the
			// summary error), masking the cancellation.
			throwIfAborted(context.signal);
			stats.failedResponseProvider = provider.id;
			stats.failures.push({ provider, error });
			if (error instanceof SearchProviderError && error.status === 429) {
				rateLimitedUntil.set(engineKey, Date.now() + RATE_LIMIT_COOLDOWN_MS);
			}
		}
		if (depth === "quick") break;
	}
	return undefined;
}

/**
 * Query up to {@link DEEP_MAX_PROVIDERS} available engines concurrently, merge
 * their results with cross-engine ranking, and quote longer excerpts. Pure
 * engines fill the fan-out first; grounded chat models only join when fewer
 * engines are available, because they bill tokens per search.
 */
async function searchDeep(
	expanded: readonly RoleChainCandidate[],
	context: SearchAttemptContext,
	stats: AttemptStats,
): Promise<SearchToolResult | undefined> {
	const engines: LoadedCandidate[] = [];
	const grounded: LoadedCandidate[] = [];
	for (const candidate of expanded) {
		if (engines.length >= DEEP_MAX_PROVIDERS) break;
		if (cfgOffline.get(context.settings)) {
			const activeProvider = context.sessionModel?.provider;
			if (
				!activeProvider ||
				candidate.model.provider !== activeProvider ||
				modelKind(candidate.model) === "search"
			) {
				continue;
			}
		}
		const engineKey = `${candidate.model.provider}/${candidate.model.id}`;
		const cooldownEnds = rateLimitedUntil.get(engineKey);
		if (cooldownEnds !== undefined && !context.params.model) {
			if (cooldownEnds > Date.now()) {
				stats.failures.push({
					provider: { id: candidate.model.id, label: candidate.model.name },
					error: new Error(
						`skipped: rate-limited (429) within the last ${RATE_LIMIT_COOLDOWN_MS / 60_000} minutes`,
					),
				});
				continue;
			}
			rateLimitedUntil.delete(engineKey);
		}
		const load = await loadCandidate(candidate, context.authStorage, context.keylessAllowed);
		if (load.kind === "skipped") continue;
		if (load.kind === "keyless-skipped") {
			stats.keylessSkipped = true;
			continue;
		}
		if (load.kind === "failed") {
			stats.failedResponseProvider = "none";
			stats.failures.push({ provider: load.meta, error: load.error });
			continue;
		}
		stats.availableProviderCount++;
		stats.lastProvider = { id: load.loaded.provider.id, label: load.loaded.provider.label };
		(modelKind(load.loaded.model) === "search" ? engines : grounded).push(load.loaded);
	}
	const selected = [...engines, ...grounded].slice(0, DEEP_MAX_PROVIDERS);
	if (selected.length === 0) return undefined;

	const settled = await Promise.allSettled(
		selected.map(async loaded => {
			const sentAt = Date.now();
			const response = await loaded.provider.search(buildProviderParams(context, loaded, "deep"));
			// Before any rejection below: a response a later check discards was still billed.
			const billed = searchUsageMessage(loaded.model, response, Date.now() - sentAt);
			if (billed) context.journal?.(billed);
			return response;
		}),
	);
	const responses: { loaded: LoadedCandidate; provider: SearchProvider; response: SearchResponse }[] = [];
	for (const [index, outcome] of settled.entries()) {
		const loaded = selected[index]!;
		if (outcome.status === "rejected") {
			throwIfAborted(context.signal);
			stats.failedResponseProvider = loaded.provider.id;
			stats.failures.push({ provider: loaded.provider, error: outcome.reason });
			if (outcome.reason instanceof SearchProviderError && outcome.reason.status === 429) {
				rateLimitedUntil.set(`${loaded.model.provider}/${loaded.model.id}`, Date.now() + RATE_LIMIT_COOLDOWN_MS);
			}
			continue;
		}
		try {
			assertGroundedResult(loaded, outcome.value);
			responses.push({ loaded, provider: loaded.provider, response: outcome.value });
		} catch (error) {
			stats.failedResponseProvider = loaded.provider.id;
			stats.failures.push({ provider: loaded.provider, error });
		}
	}
	if (responses.length === 0) return undefined;

	const limit = context.params.num_search_results ?? context.params.limit ?? DEEP_DEFAULT_LIMIT;
	const sources = mergeSearchSources(
		responses.map(entry => entry.response.sources),
		{ limit },
	);
	const answered = responses.find(entry => entry.response.answer?.trim());
	const seenCitations = new Set<string>();
	const citations = responses
		.flatMap(entry => entry.response.citations ?? [])
		.filter(citation => {
			if (seenCitations.has(citation.url)) return false;
			seenCitations.add(citation.url);
			return true;
		});
	const merged: SearchResponse = {
		provider: responses[0]!.provider.id,
		sources,
		...(answered?.response.answer ? { answer: answered.response.answer } : {}),
		...(citations.length > 0 ? { citations } : {}),
	};
	const constrained = constrainResponse(merged, context.parsedQuery, context.scope);
	if (constrained.scopeMiss) {
		// Every engine answered outside the requested scope: an empty result, not an error.
		for (const entry of responses) {
			stats.scopeMisses.push({ id: entry.provider.id, label: entry.provider.label });
		}
		return undefined;
	}
	if (!hasRenderableSearchContent(constrained.response)) return undefined;

	const notes: string[] = [];
	if (responses.length > 1) {
		notes.push(`merged results from ${responses.map(entry => entry.provider.label).join(", ")}`);
	}
	if (answered && modelKind(answered.loaded.model) !== "search" && constrained.response.answer?.trim()) {
		notes.push(
			`synthesized answer by ${answered.loaded.model.provider}/${answered.loaded.model.id} hosted search, not a result list; check claims against the cited sources`,
		);
	}
	const failed = failureDetails(stats.failures);
	if (failed.length > 0) {
		notes.push(`${failed.map(f => `${f.label} failed (${f.reason})`).join(" and ")}`);
	}
	return renderOutcome(constrained.response, [...notes, ...constrained.notes], stats.failures, DEEP_SNIPPET_CHARS);
}

/** Execute web search */
async function executeSearch(
	_toolCallId: string,
	params: SearchQueryParams,
	options: ExecuteSearchOptions,
): Promise<{ content: Array<{ type: "text"; text: string }>; details: SearchResultDetails }> {
	const { authStorage, sessionId, signal } = options;
	// The session's own settings (an ACP session's project, a subagent overlay) win over the process global.
	const activeSettings = options.settings ?? settings;
	const modelRegistry =
		options.modelRegistry ?? new ModelRegistry(authStorage, undefined, { settings: activeSettings });
	const pool = roleCandidatePool("web", activeSettings, modelRegistry);
	const candidates = params.model
		? (() => {
				const resolved = resolveModelRoleValue(params.model, pool, { settings: activeSettings });
				return resolved.model
					? [{ model: resolved.model, explicit: true, thinkingLevel: resolved.thinkingLevel }]
					: [];
			})()
		: resolveRoleChain("web", activeSettings, pool);
	const parsedQuery = parseSearchQuery(params.query);
	let expanded = rankXAIProviders(
		candidates.flatMap(candidate => expandHostedCandidate(candidate, options.sessionModel, pool)),
		candidate => candidate.model,
		activeSettings,
	);
	// Only xAI reaches X posts; X-only queries try it first even when the role prefers another engine.
	if (!params.model && targetsX(parsedQuery)) expanded = preferXAI(expanded, modelRegistry, activeSettings);
	// General engines index HN threads sparsely and late; a query whose every
	// `site:` is Hacker News (with or without a path) tries the HN Search API first.
	const hnOnly =
		parsedQuery.sites.length > 0 && parsedQuery.sites.every(site => site.split("/", 1)[0] === "news.ycombinator.com");
	if (!params.model && hnOnly) expanded = preferHackerNews(expanded, pool);

	// Invariant across candidates; resolve once before walking the role chain.
	let antigravityEndpointMode: "auto" | "production" | "sandbox" | undefined;
	try {
		antigravityEndpointMode = cfgProvidersAntigravityEndpoint.get(activeSettings);
	} catch {
		antigravityEndpointMode = undefined;
	}

	let timeoutMs = DEFAULT_WEB_SEARCH_TIMEOUT_SECONDS * 1_000;
	try {
		const configuredSeconds = cfgProvidersWebSearchTimeoutSeconds.get(activeSettings);
		if (Number.isFinite(configuredSeconds) && configuredSeconds > 0) {
			timeoutMs = Math.ceil(Math.min(configuredSeconds, MAX_WEB_SEARCH_TIMEOUT_SECONDS) * 1_000);
		}
	} catch {
		// Preserve the default for one-shot callers that do not initialize Settings.
	}

	// Only a per-request selector reaches a keyless service once the user turned them off.
	const keylessAllowed = params.model !== undefined || cfgProvidersWebKeyless.get(activeSettings);
	const failures: SearchProviderFailure[] = [];
	const scope = parsedQuery.hasConstraints ? scopeConstraints(parsedQuery) : undefined;
	// The tool result holds the text; this is the only place a search's tokens reach session totals.
	const journal = journalCompletion(options.usageLedger, { purpose: "web-search", usageOnly: true });
	const context: SearchAttemptContext = {
		params,
		parsedQuery,
		authStorage,
		modelRegistry,
		sessionId,
		sessionModel: options.sessionModel,
		signal,
		antigravityEndpointMode,
		timeoutMs,
		settings: activeSettings,
		keylessAllowed,
		scope,
		journal,
	};
	const depth: SearchDepth = params.depth ?? "standard";
	const stats: AttemptStats = {
		failures,
		availableProviderCount: 0,
		failedResponseProvider: "none",
		keylessSkipped: false,
		scopeMisses: [],
	};
	const result =
		depth === "deep"
			? await searchDeep(expanded, context, stats)
			: await searchSequential(expanded, context, stats, depth);
	if (result) return result;

	if (scope && stats.scopeMisses.length > 0) {
		// Engines answered, just not inside the requested scope: an empty result, not an error.
		const searched = stats.scopeMisses.map(miss => miss.label).join(", ");
		const notes = fallbackNotes(failureDetails(failures), { label: searched });
		const text = [
			...notes.map(note => `Note: ${note}`),
			`No results from ${searched} matched \`${scope.label}\`.`,
		].join("\n");
		return {
			content: [{ type: "text" as const, text }],
			details: { response: { provider: stats.scopeMisses[0]!.id, sources: [] } },
		};
	}

	if (stats.availableProviderCount === 0 && stats.failures.length === 0) {
		const message = cfgOffline.get(activeSettings)
			? "No web search backend is available on the active model's provider under --offline."
			: params.model
				? `No web search model matches selector "${params.model}".`
				: stats.keylessSkipped
					? "No configured web search service is available, and providers.webKeyless is off. Configure a search credential or turn providers.webKeyless on."
					: "No web search model configured.";
		return {
			content: [{ type: "text" as const, text: `Error: ${message}` }],
			details: { response: { provider: "none", sources: [] }, error: message },
		};
	}

	const lastFailure = stats.failures[stats.failures.length - 1];
	const baseMessage = lastFailure
		? formatSearchProviderFailure(lastFailure.error, lastFailure.provider)
		: `Unknown error from ${stats.lastProvider?.label ?? "web search provider"}`;
	const message =
		stats.failures.length > 1
			? `All web search providers failed: ${formatSearchProviderFailures(stats.failures)}`
			: baseMessage;

	return {
		content: [{ type: "text" as const, text: `Error: ${message}` }],
		details: {
			response: { provider: stats.failedResponseProvider, sources: [] },
			error: message,
			failures: failureDetails(stats.failures),
		},
	};
}

/**
 * Execute a web search query for CLI/testing workflows.
 *
 * `authStorage` may be omitted; in that case we discover one via the standard
 * factory (`discoverAuthStorage`), which honours `OMP_AUTH_BROKER_URL` and
 * otherwise opens the local SQLite credential store.
 */
export async function runSearchQuery(
	params: SearchQueryParams,
	options: {
		authStorage?: AuthStorage;
		modelRegistry?: ModelRegistry;
		sessionId?: string;
		sessionModel?: Model<Api>;
		settings?: Settings;
		signal?: AbortSignal;
	} = {},
): Promise<{ content: Array<{ type: "text"; text: string }>; details: SearchResultDetails }> {
	const createdAuthStorage = options.authStorage || options.modelRegistry ? undefined : await discoverAuthStorage();
	const authStorage = options.authStorage ?? options.modelRegistry?.authStorage ?? createdAuthStorage;
	if (!authStorage) {
		throw new Error("Failed to initialize authentication storage");
	}
	try {
		return await executeSearch("cli-web-search", params, {
			authStorage,
			modelRegistry: options.modelRegistry,
			sessionId: options.sessionId,
			sessionModel: options.sessionModel,
			settings: options.settings,
			signal: options.signal,
		});
	} finally {
		createdAuthStorage?.close();
	}
}

/** Description without the X operators, for hosts without a model registry. */
const plainDescription = prompt.render(webSearchDescription);

/**
 * Description rendered on first read with a model registry, then reused for
 * the process: re-checking xAI auth per read would rewrite the tool
 * description, and invalidate the prompt cache, whenever auth changes.
 */
let registryDescription: string | undefined;

/**
 * Web search tool implementation.
 *
 * Supports the configured web model role chain with automatic fallback.
 */
export class WebSearchTool implements AgentTool<typeof webSearchSchema, SearchResultDetails> {
	readonly name = "web_search";
	readonly approval = "read" as const;
	readonly label = "Web Search";
	readonly parameters = webSearchSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly summary = "Search the web for up-to-date information";

	#session: ToolSession;

	constructor(session: ToolSession) {
		this.#session = session;
	}

	/** Advertises X search operators when xAI credentials existed at the process's first read. */
	get description(): string {
		const modelRegistry = this.#session.modelRegistry;
		if (!modelRegistry) return plainDescription;
		registryDescription ??= prompt.render(webSearchDescription, { xSearch: xSearchAvailable(modelRegistry) });
		return registryDescription;
	}

	async execute(
		_toolCallId: string,
		params: SearchToolParams,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<SearchResultDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<SearchResultDetails>> {
		const authStorage = this.#session.authStorage ?? (await discoverAuthStorage());
		const sessionId = this.#session.getSessionId?.() ?? undefined;
		return executeSearch(_toolCallId, params, {
			authStorage,
			modelRegistry: this.#session.modelRegistry,
			sessionId,
			sessionModel: this.#session.getActiveModel?.(),
			settings: this.#session.settings,
			signal,
			usageLedger: this.#session.sessionManager,
		});
	}
}

/** Web search tool as CustomTool for consumers embedding the custom-tool API. */
export const webSearchCustomTool: CustomTool<typeof webSearchSchema, SearchResultDetails> = {
	name: "web_search",
	label: "Web Search",
	description: plainDescription,
	parameters: webSearchSchema,

	approval: "read",
	async execute(
		toolCallId: string,
		params: SearchToolParams,
		_onUpdate,
		ctx: CustomToolContext,
		signal?: AbortSignal,
	) {
		const authStorage = ctx.modelRegistry?.authStorage ?? (await discoverAuthStorage());
		const sessionId = ctx.sessionManager.getSessionId();
		return executeSearch(toolCallId, params, {
			authStorage,
			modelRegistry: ctx.modelRegistry,
			sessionId,
			sessionModel: ctx.model,
			signal,
		});
	},
};

export function getSearchTools(): CustomTool<typeof webSearchSchema, SearchResultDetails>[] {
	return [webSearchCustomTool];
}

export { getSearchProvider } from "./provider";
export type { SearchProviderId as SearchProvider, SearchResponse } from "./types";
