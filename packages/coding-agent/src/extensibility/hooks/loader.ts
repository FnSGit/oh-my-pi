/**
 * Hook loader - loads TypeScript hook modules using native Bun import.
 */
import * as path from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { logger } from "@oh-my-pi/pi-utils";
import * as zod from "zod/v4";
import { type ClaudeHookEvent, hookCapability } from "../../capability/hook";
import type { Hook } from "../../discovery";
import { loadCapability } from "../../discovery";
import type { HookMessage } from "../../session/messages";
import type { SessionManager } from "../../session/session-manager";
import * as typebox from "../typebox";
import { resolvePath } from "../utils";
import { execCommand } from "./runner";
import type { ExecOptions, HookAPI, HookFactory, HookMessageRenderer, RegisteredCommand } from "./types";

/**
 * Build a `ContextEventResult` for a Claude Code `UserPromptSubmit` command hook.
 *
 * The Claude Code spec emits a JSON envelope of shape
 *   { hookSpecificOutput: { hookEventName, additionalContext } }
 * and the `additionalContext` string is the actual content the model should
 * see. The hook must produce a proper `Message` (with `role: "user"`), not a
 * raw content block, or `convertToLlm` will drop every item on the floor
 * (it dispatches on `m.role`) and the LLM ends up with an empty conversation.
 *
 * For the `UserPromptSubmit` event the runner passes the current context
 * messages in the event payload, so the loader APPENDS the injected user
 * message to the existing conversation rather than replacing it. If the
 * runner's API ever changes and the event no longer carries `messages`,
 * this falls back to a single-item context override — still better than
 * the previous malformed payload, since one well-formed user message
 * passes the provider's `messages` minimum.
 */
function buildContextEventResultFromStdout(
	stdout: string,
	additionalContext: string | undefined,
	event: unknown,
): { messages: AgentMessage[] } | undefined {
	// When no additionalContext was extracted and stdout is just an empty JSON
	// object (e.g. "{}" from hooks like hookify that always emit JSON), treat it
	// as "no context modification" rather than injecting literal "{}" as a user
	// message. See https://github.com/can1357/oh-my-pi/issues/1580 for the
	// hookify-driven empty-message regression this closes.
	if (additionalContext === undefined && /^\s*\{\s*\}\s*$/.test(stdout)) {
		return undefined;
	}
	const text = (additionalContext ?? stdout).trim();
	if (!text) return undefined;
	const existing = Array.isArray((event as { messages?: unknown[] } | null)?.messages)
		? (event as { messages: AgentMessage[] }).messages
		: [];
	return {
		messages: [
			...existing,
			{ role: "user", content: [{ type: "text", text }], timestamp: Date.now() } as AgentMessage,
		],
	};
}

/**
 * Generic handler function type.
 */
type HandlerFn = (...args: unknown[]) => Promise<unknown>;

/**
 * Send message handler type for pi.sendMessage().
 */
export type SendMessageHandler = <T = unknown>(
	message: Pick<HookMessage<T>, "customType" | "content" | "display" | "details" | "attribution">,
	options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" },
) => void;

/**
 * Append entry handler type for pi.appendEntry().
 */
export type AppendEntryHandler = <T = unknown>(customType: string, data?: T) => void;

/**
 * New session handler type for ctx.newSession() in HookCommandContext.
 */
export type NewSessionHandler = (options?: {
	parentSession?: string;
	setup?: (sessionManager: SessionManager) => Promise<void>;
}) => Promise<{ cancelled: boolean }>;

/**
 * Branch handler type for ctx.branch() in HookCommandContext.
 */
export type BranchHandler = (entryId: string) => Promise<{ cancelled: boolean }>;

/**
 * Navigate tree handler type for ctx.navigateTree() in HookCommandContext.
 */
export type NavigateTreeHandler = (
	targetId: string,
	options?: { summarize?: boolean },
) => Promise<{ cancelled: boolean }>;

/**
 * Registered handlers for a loaded hook.
 */
export interface LoadedHook {
	/** Original path from config */
	path: string;
	/** Resolved absolute path */
	resolvedPath: string;
	/** Map of event type to handler functions */
	handlers: Map<string, HandlerFn[]>;
	/** Map of customType to hook message renderer */
	messageRenderers: Map<string, HookMessageRenderer>;
	/** Map of command name to registered command */
	commands: Map<string, RegisteredCommand>;
	/** Set the send message handler for this hook's pi.sendMessage() */
	setSendMessageHandler: (handler: SendMessageHandler) => void;
	/** Set the append entry handler for this hook's pi.appendEntry() */
	setAppendEntryHandler: (handler: AppendEntryHandler) => void;
}

/**
 * Result of loading hooks.
 */
export interface LoadHooksResult {
	/** Successfully loaded hooks */
	hooks: LoadedHook[];
	/** Errors encountered during loading */
	errors: Array<{ path: string; error: string }>;
}

/**
 * Create a HookAPI instance that collects handlers, renderers, and commands.
 * Returns the API, maps, and functions to set handlers later.
 */
async function createHookAPI(
	handlers: Map<string, HandlerFn[]>,
	cwd: string,
): Promise<{
	api: HookAPI;
	messageRenderers: Map<string, HookMessageRenderer>;
	commands: Map<string, RegisteredCommand>;
	setSendMessageHandler: (handler: SendMessageHandler) => void;
	setAppendEntryHandler: (handler: AppendEntryHandler) => void;
}> {
	let sendMessageHandler: SendMessageHandler | null = null;
	let appendEntryHandler: AppendEntryHandler | null = null;
	const messageRenderers = new Map<string, HookMessageRenderer>();
	const commands = new Map<string, RegisteredCommand>();

	// Cast to HookAPI - the implementation is more general (string event names)
	// but the interface has specific overloads for type safety in hooks
	const api = {
		on(event: string, handler: HandlerFn): void {
			if (!handlers.has(event)) {
				handlers.set(event, []);
			}
			handlers.get(event)!.push(handler);
		},
		sendMessage<T = unknown>(
			message: HookMessage<T>,
			options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" },
		): void {
			if (!sendMessageHandler) {
				throw new Error("sendMessage handler not initialized");
			}
			sendMessageHandler(message, options);
		},
		appendEntry<T = unknown>(customType: string, data?: T): void {
			if (!appendEntryHandler) {
				throw new Error("appendEntry handler not initialized");
			}
			appendEntryHandler(customType, data);
		},
		registerMessageRenderer<T = unknown>(customType: string, renderer: HookMessageRenderer<T>): void {
			messageRenderers.set(customType, renderer as HookMessageRenderer);
		},
		registerCommand(name: string, options: { description?: string; handler: RegisteredCommand["handler"] }): void {
			commands.set(name, { name, ...options });
		},
		exec(command: string, args: string[], options?: ExecOptions) {
			return execCommand(command, args, options?.cwd ?? cwd, options);
		},
		logger,
		typebox,
		zod,
		pi: await import("@oh-my-pi/pi-coding-agent"),
	} as HookAPI;

	return {
		api,
		messageRenderers,
		commands,
		setSendMessageHandler: (handler: SendMessageHandler) => {
			sendMessageHandler = handler;
		},
		setAppendEntryHandler: (handler: AppendEntryHandler) => {
			appendEntryHandler = handler;
		},
	};
}

/**
 * Load a single hook module using native Bun import.
 */
async function loadHook(hookPath: string, cwd: string): Promise<{ hook: LoadedHook | null; error: string | null }> {
	const resolvedPath = resolvePath(hookPath, cwd);

	try {
		// Import the module using native Bun import
		const module = await import(resolvedPath);
		const factory = module.default as HookFactory;

		if (typeof factory !== "function") {
			return { hook: null, error: "Hook must export a default function" };
		}

		// Create handlers map and API
		const handlers = new Map<string, HandlerFn[]>();
		const { api, messageRenderers, commands, setSendMessageHandler, setAppendEntryHandler } = await createHookAPI(
			handlers,
			cwd,
		);

		// Call factory to register handlers
		factory(api);

		return {
			hook: {
				path: hookPath,
				resolvedPath,
				handlers,
				messageRenderers,
				commands,
				setSendMessageHandler,
				setAppendEntryHandler,
			},
			error: null,
		};
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { hook: null, error: `Failed to load hook: ${message}` };
	}
}

/**
 * Load all hooks from configuration.
 * @param paths - Array of hook file paths
 * @param cwd - Current working directory for resolving relative paths
 */
export async function loadHooks(paths: string[], cwd: string): Promise<LoadHooksResult> {
	const hooks: LoadedHook[] = [];
	const errors: Array<{ path: string; error: string }> = [];

	for (const hookPath of paths) {
		const { hook, error } = await loadHook(hookPath, cwd);

		if (error) {
			errors.push({ path: hookPath, error });
			continue;
		}

		if (hook) {
			hooks.push(hook);
		}
	}

	return { hooks, errors };
}

/**
 * Map Claude Code hook events to omp internal event names.
 */
const CLAUDE_EVENT_MAP: Record<ClaudeHookEvent, string> = {
	PreToolUse: "tool_call",
	PostToolUse: "tool_result",
	PreCompact: "session_before_compact",
	PostCompact: "session_compact",
	Notification: "session_start",
	SessionStart: "context",
	SessionEnd: "session_shutdown",
	Stop: "session_shutdown",
	StopFailure: "session_shutdown",
	UserPromptSubmit: "context",
	SubagentStart: "agent_start",
	SubagentStop: "agent_end",
	PermissionRequest: "tool_call",
	PermissionDenied: "tool_call",
};

/**
 * Create a synthetic LoadedHook that executes a shell command for a Claude Code hook.
 * The command receives event data as JSON on stdin and returns results on stdout.
 *
 * Exported for testability — the synthetic handler is the only way to exercise the
 * Claude-Code-stdin → ContextEventResult conversion end-to-end without standing up
 * a full extension runner.
 */
export function createCommandHook(discoveredHook: Hook, cwd: string): LoadedHook {
	const handlers = new Map<string, HandlerFn[]>();
	const messageRenderers = new Map<string, HookMessageRenderer>();
	const commands = new Map<string, RegisteredCommand>();

	// Determine which omp event(s) this hook subscribes to
	const ompEvent = discoveredHook.claudeEvent
		? (CLAUDE_EVENT_MAP[discoveredHook.claudeEvent] ?? "tool_call")
		: discoveredHook.type === "pre"
			? "tool_call"
			: "tool_result";

	// Register a handler that spawns the command

	// SessionStart fires once per session to inject project memories.
	// Mapped to "context" so its additionalContext is chained into
	// emitContext() by buildContextEventResultFromStdout.  The flag
	// prevents duplicate injection on subsequent context events
	// (UserPromptSubmit etc.).
	let sessionStartHasRun = false;

	const handler: HandlerFn = async (event: unknown, _ctx: unknown) => {
		// Matcher check: skip if this hook is scoped to a specific tool and the event doesn't match
		const matcher = discoveredHook.tool ?? discoveredHook.matcher ?? "*";
		if (matcher !== "*" && matcher !== "") {
			const toolName = (event as Record<string, unknown>)?.toolName as string | undefined;
			if (toolName && matcher !== toolName) return undefined;
		}

		const timeoutMs = (discoveredHook.timeout ?? 30) * 1000;
		const command = discoveredHook.command!;
		const args = discoveredHook.args ?? [];

		// Build Claude Code compatible stdin payload
		const sessionId = (event as Record<string, unknown>)?.sessionId as string | undefined;
		let stdinPayload: Record<string, unknown>;
		switch (discoveredHook.claudeEvent) {
			case "PreToolUse":
			case "PostToolUse": {
				const ev = event as Record<string, unknown>;
				stdinPayload = {
					tool_name: ev.toolName ?? matcher,
					tool_input: ev.toolInput ?? ev.input ?? {},
					...(discoveredHook.claudeEvent === "PostToolUse"
						? { tool_output: ev.toolOutput ?? ev.output ?? "" }
						: {}),
					session_id: sessionId ?? "",
				};
				break;
			}
			case "PreCompact": {
				const ev = event as Record<string, unknown>;
				stdinPayload = {
					session_id: sessionId ?? "",
					conversation: ev.conversation ?? ev.transcript ?? "",
					custom_instructions: ev.customInstructions ?? "",
				};
				break;
			}
			case "UserPromptSubmit": {
				const ev = event as Record<string, unknown>;
				stdinPayload = {
					session_id: sessionId ?? "",
					prompt: ev.prompt ?? ev.content ?? "",
					custom_instructions: ev.customInstructions ?? "",
				};
				break;
			}
			case "Stop":
			case "StopFailure": {
				const ev = event as Record<string, unknown>;
				stdinPayload = {
					session_id: sessionId ?? "",
					transcript_path: ev.transcriptPath ?? "",
					stop_hook_active: ev.stopHookActive ?? false,
				};
				break;
			}
			default: {
				// SessionStart, SessionEnd, Notification, SubagentStart/Stop, etc.
				stdinPayload = {
					session_id: sessionId ?? "",
					...((event as Record<string, unknown>) ?? {}),
				};
				break;
			}
		}
		const stdinStr = JSON.stringify(stdinPayload);

		try {
			const result = await execCommand(command, args, cwd, {
				timeout: timeoutMs,
				stdin: stdinStr,
			});

			// Parse stdout for JSON decisions
			const stdout = result.stdout.trim();
			if (!stdout) {
				// Exit 0 with no output = no decision, continue normally
				return undefined;
			}

			try {
				const decision = JSON.parse(stdout);
				// Handle Claude Code hook output format
				const output = decision.hookSpecificOutput ?? decision;
				if (discoveredHook.claudeEvent === "PreToolUse") {
					if (output.permissionDecision === "deny" || output.decision === "block") {
						return { block: true, reason: output.permissionDecisionReason ?? output.reason ?? "Blocked by hook" };
					}
					if (output.permissionDecision === "allow" || output.decision === "allow") {
						return { block: false };
					}
				}
				if (discoveredHook.claudeEvent === "PreCompact") {
					if (output.decision === "block") {
						return { cancel: true, reason: output.reason ?? "Blocked by hook" };
					}
					if (output.custom_instructions) {
						return { compaction: { summary: output.custom_instructions } };
					}
				}
				// For informational events, stdout content is used as context.
				//
				// `UserPromptSubmit` Claude Code hooks emit JSON of shape
				//   { hookSpecificOutput: { hookEventName, additionalContext } }
				// — extract `additionalContext` rather than using the entire
				// JSON wrapper as text. The result is a real `Message` (with
				// `role: "user"`) appended to the current context, not a
				// content block that downstream `convertToLlm` would silently
				// drop (leaving `context.messages` empty and triggering the
				// `UserPromptSubmit` Claude Code hooks emit JSON of shape
				//   { hookSpecificOutput: { hookEventName, additionalContext } }
				// — extract `additionalContext` rather than using the entire
				// JSON wrapper as text. The result is a real `Message` (with
				// `role: "user"`) appended to the current context, not a
				// content block that downstream `convertToLlm` would silently
				// drop (leaving `context.messages` empty and triggering the
				// `buildParams` "all were filtered out" defensive throw).
				if (discoveredHook.claudeEvent === "UserPromptSubmit") {
					return buildContextEventResultFromStdout(
						stdout,
						typeof output.additionalContext === "string" ? output.additionalContext : undefined,
						event,
					);
				}
				if (discoveredHook.claudeEvent === "SessionStart") {
					if (sessionStartHasRun) return undefined;
					sessionStartHasRun = true;
					return buildContextEventResultFromStdout(
						stdout,
						typeof output.additionalContext === "string" ? output.additionalContext : undefined,
						event,
					);
				}
				return undefined;
			} catch {
				// Non-JSON stdout: same reasoning as the JSON path above.
				if (discoveredHook.claudeEvent === "UserPromptSubmit") {
					return buildContextEventResultFromStdout(stdout, undefined, event);
				}
				if (discoveredHook.claudeEvent === "SessionStart") {
					if (sessionStartHasRun) return undefined;
					sessionStartHasRun = true;
					return buildContextEventResultFromStdout(stdout, undefined, event);
				}
				return undefined;
			}
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			logger.warn(`Claude command hook failed: ${command}`, { error: message });
			// Fail-safe: for pre hooks, block on error; for post hooks, ignore
			if (discoveredHook.type === "pre") {
				return { block: true, reason: `Hook command failed: ${message}` };
			}
			return undefined;
		}
	};

	handlers.set(ompEvent, [handler]);

	return {
		path: discoveredHook.path,
		resolvedPath: discoveredHook.path,
		handlers,
		messageRenderers,
		commands,
		setSendMessageHandler: (_handler: SendMessageHandler) => {},
		setAppendEntryHandler: (_handler: AppendEntryHandler) => {},
	};
}

/**
 * Discover and load hooks from all registered providers.
 * Handles both JS/TS module hooks and command-based hooks from Claude Code settings.json.
 */
export async function discoverAndLoadHooks(configuredPaths: string[], cwd: string): Promise<LoadHooksResult> {
	const modulePaths: string[] = [];
	const commandHooks: Hook[] = [];
	const seen = new Set<string>();

	const addPath = (p: string) => {
		const resolved = path.resolve(p);
		if (!seen.has(resolved)) {
			seen.add(resolved);
			modulePaths.push(p);
		}
	};

	// 1. Discover hooks via capability API
	const discovered = await loadCapability<Hook>(hookCapability.id, { cwd });

	for (const hook of discovered.items) {
		if (hook.command) {
			// Command-based hook (from settings.json) — create synthetic LoadedHook
			const key = `${hook.type}:${hook.tool}:${hook.name}`;
			if (key && !seen.has(key)) {
				seen.add(key);
				commandHooks.push(hook);
			}
		} else {
			// File-based hook — need to import as JS/TS module
			addPath(hook.path);
		}
	}

	// 2. Explicitly configured paths (can override/add)
	for (const p of configuredPaths) {
		addPath(resolvePath(p, cwd));
	}

	// Load JS/TS module hooks
	const result = await loadHooks(modulePaths, cwd);

	// Load command hooks
	for (const hook of commandHooks) {
		result.hooks.push(createCommandHook(hook, cwd));
	}

	return result;
}
