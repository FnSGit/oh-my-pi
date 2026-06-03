/**
 * Extension loader - loads TypeScript extension modules using native Bun import.
 */
import type * as fs1 from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { ImageContent, Model, TextContent, TSchema } from "@oh-my-pi/pi-ai";
import * as PiCodingAgent from "@oh-my-pi/pi-coding-agent";
import type { KeyId } from "@oh-my-pi/pi-tui";
import { hasFsCode, isEacces, isEnoent, logger } from "@oh-my-pi/pi-utils";
import * as Zod from "zod/v4";
import { type ExtensionModule, extensionModuleCapability } from "../../capability/extension-module";
import { type ClaudeHookEvent, type Hook, hookCapability } from "../../capability/hook";
import { loadCapability } from "../../discovery";
import { getExtensionNameFromPath } from "../../discovery/helpers";
import type { ExecOptions } from "../../exec/exec";
import { execCommand } from "../../exec/exec";
import type { CustomMessage } from "../../session/messages";
import { EventBus } from "../../utils/event-bus";
import { installLegacyPiSpecifierShim, loadLegacyPiModule } from "../plugins/legacy-pi-compat";
import { getAllPluginExtensionPaths } from "../plugins/loader";
import * as TypeBox from "../typebox";

import { resolvePath } from "../utils";
import type {
	AssistantThinkingRenderer,
	Extension,
	ExtensionAPI,
	ExtensionContext,
	ExtensionFactory,
	ExtensionRuntime as IExtensionRuntime,
	LoadExtensionsResult,
	MessageRenderer,
	ProviderConfig,
	RegisteredCommand,
	ToolDefinition,
} from "./types";

installLegacyPiSpecifierShim();

type HandlerFn = (...args: unknown[]) => Promise<unknown>;
type LoadedExtensionModule = ExtensionFactory | { default?: ExtensionFactory };

function getExtensionFactory(module: LoadedExtensionModule): ExtensionFactory | null {
	const candidate = typeof module === "function" ? module : module.default;
	return typeof candidate === "function" ? candidate : null;
}

export class ExtensionRuntimeNotInitializedError extends Error {
	constructor() {
		super("Extension runtime not initialized. Action methods cannot be called during extension loading.");
	}
}

/**
 * Extension runtime with throwing stubs for action methods.
 * These are replaced with real implementations during initialization.
 */
export class ExtensionRuntime implements IExtensionRuntime {
	flagValues = new Map<string, boolean | string>();
	pendingProviderRegistrations: Array<{ name: string; config: ProviderConfig; sourceId: string }> = [];

	sendMessage(): void {
		throw new ExtensionRuntimeNotInitializedError();
	}

	sendUserMessage(): void {
		throw new ExtensionRuntimeNotInitializedError();
	}

	appendEntry(): void {
		throw new ExtensionRuntimeNotInitializedError();
	}

	setLabel(): void {
		throw new ExtensionRuntimeNotInitializedError();
	}

	getActiveTools(): string[] {
		throw new ExtensionRuntimeNotInitializedError();
	}

	getAllTools(): string[] {
		throw new ExtensionRuntimeNotInitializedError();
	}

	setActiveTools(): Promise<void> {
		throw new ExtensionRuntimeNotInitializedError();
	}

	getCommands(): never {
		throw new ExtensionRuntimeNotInitializedError();
	}

	setModel(): Promise<boolean> {
		throw new ExtensionRuntimeNotInitializedError();
	}

	getThinkingLevel(): ThinkingLevel {
		throw new ExtensionRuntimeNotInitializedError();
	}

	setThinkingLevel(): void {
		throw new ExtensionRuntimeNotInitializedError();
	}

	getSessionName(): string | undefined {
		throw new ExtensionRuntimeNotInitializedError();
	}

	setSessionName(): Promise<void> {
		throw new ExtensionRuntimeNotInitializedError();
	}
}

/**
 * ExtensionAPI implementation for an extension.
 * Registration methods write to the extension object.
 * Action methods delegate to the shared runtime.
 */
class ConcreteExtensionAPI implements ExtensionAPI, IExtensionRuntime {
	readonly logger = logger;
	readonly typebox = TypeBox;
	readonly zod = Zod;
	readonly flagValues = new Map<string, boolean | string>();
	readonly pendingProviderRegistrations: Array<{
		name: string;
		config: ProviderConfig;
		sourceId: string;
	}> = [];

	constructor(
		public readonly pi: typeof PiCodingAgent,
		private readonly extension: Extension,
		private readonly runtime: IExtensionRuntime,
		private readonly cwd: string,
		public readonly events: EventBus,
	) {}

	on<F extends HandlerFn>(event: string, handler: F): void {
		const list = this.extension.handlers.get(event) ?? [];
		list.push(handler);
		this.extension.handlers.set(event, list);
	}

	registerTool<TParams extends TSchema = TSchema, TDetails = unknown>(tool: ToolDefinition<TParams, TDetails>): void {
		this.extension.tools.set(tool.name, {
			definition: tool,
			extensionPath: this.extension.path,
		});
	}

	registerCommand(
		name: string,
		options: {
			description?: string;
			getArgumentCompletions?: RegisteredCommand["getArgumentCompletions"];
			handler: RegisteredCommand["handler"];
		},
	): void {
		this.extension.commands.set(name, { name, ...options });
	}

	setLabel(label: string): void {
		this.extension.label = label;
	}

	registerShortcut(
		shortcut: KeyId,
		options: {
			description?: string;
			handler: (ctx: ExtensionContext) => Promise<void> | void;
		},
	): void {
		this.extension.shortcuts.set(shortcut, { shortcut, extensionPath: this.extension.path, ...options });
	}

	registerFlag(
		name: string,
		options: { description?: string; type: "boolean" | "string"; default?: boolean | string },
	): void {
		this.extension.flags.set(name, { name, extensionPath: this.extension.path, ...options });
		if (options.default !== undefined) {
			this.runtime.flagValues.set(name, options.default);
		}
	}

	registerMessageRenderer<T>(customType: string, renderer: MessageRenderer<T>): void {
		this.extension.messageRenderers.set(customType, renderer as MessageRenderer);
	}

	registerAssistantThinkingRenderer(renderer: AssistantThinkingRenderer): void {
		this.extension.assistantThinkingRenderers.push(renderer);
	}

	getFlag(name: string): boolean | string | undefined {
		if (!this.extension.flags.has(name)) return undefined;
		return this.runtime.flagValues.get(name);
	}

	sendMessage<T = unknown>(
		message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details" | "attribution">,
		options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
	): void {
		this.runtime.sendMessage(message, options);
	}

	sendUserMessage(
		content: string | (TextContent | ImageContent)[],
		options?: { deliverAs?: "steer" | "followUp" },
	): void {
		this.runtime.sendUserMessage(content, options);
	}

	appendEntry(customType: string, data?: unknown): void {
		this.runtime.appendEntry(customType, data);
	}

	exec(command: string, args: string[], options?: ExecOptions) {
		return execCommand(command, args, options?.cwd ?? this.cwd, options);
	}

	getActiveTools(): string[] {
		return this.runtime.getActiveTools();
	}

	getAllTools(): string[] {
		return this.runtime.getAllTools();
	}

	setActiveTools(toolNames: string[]): Promise<void> {
		return this.runtime.setActiveTools(toolNames);
	}

	getCommands() {
		return this.runtime.getCommands();
	}

	setModel(model: Model): Promise<boolean> {
		return this.runtime.setModel(model);
	}

	getThinkingLevel(): ThinkingLevel | undefined {
		return this.runtime.getThinkingLevel();
	}

	setThinkingLevel(level: ThinkingLevel, persist?: boolean): void {
		this.runtime.setThinkingLevel(level, persist);
	}

	getSessionName(): string | undefined {
		return this.runtime.getSessionName();
	}

	setSessionName(name: string): Promise<void> {
		return this.runtime.setSessionName(name);
	}

	registerProvider(name: string, config: ProviderConfig): void {
		this.runtime.pendingProviderRegistrations.push({ name, config, sourceId: this.extension.path });
	}
}

/**
 * Create an Extension object with empty collections.
 */
function createExtension(extensionPath: string, resolvedPath: string): Extension {
	return {
		path: extensionPath,
		resolvedPath,
		handlers: new Map(),
		tools: new Map(),
		assistantThinkingRenderers: [],
		messageRenderers: new Map(),
		commands: new Map(),
		flags: new Map(),
		shortcuts: new Map(),
	};
}

/**
 * Map Claude Code hook events to omp extension event names.
 */
const CLAUDE_EVENT_MAP: Record<ClaudeHookEvent, string> = {
	PreToolUse: "tool_call",
	PostToolUse: "tool_result",
	PreCompact: "session_before_compact",
	PostCompact: "session_compact",
	Notification: "session_start",
	SessionStart: "session_start",
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
 * Create a synthetic Extension from a Claude Code command-based hook.
 * The hook command receives event data as JSON on stdin and returns results on stdout.
 */
function createClaudeCommandExtension(discoveredHook: Hook, cwd: string): Extension {
	const ext = createExtension(discoveredHook.path, discoveredHook.path);

	const ompEvent = discoveredHook.claudeEvent
		? CLAUDE_EVENT_MAP[discoveredHook.claudeEvent] ?? "tool_call"
		: discoveredHook.type === "pre"
			? "tool_call"
			: "tool_result";

	const matcher = discoveredHook.tool ?? discoveredHook.matcher ?? "*";

	const handler: HandlerFn = async (event: unknown, _ctx: unknown) => {
		// Matcher check: skip if scoped to a specific tool and the event doesn't match
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
					...(discoveredHook.claudeEvent === "PostToolUse" ? { tool_output: ev.toolOutput ?? ev.output ?? "" } : {}),
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
				stdinPayload = {
					session_id: sessionId ?? "",
					...(event as Record<string, unknown> ?? {}),
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

			const stdout = result.stdout.trim();
			if (!stdout) return undefined;

			try {
				const decision = JSON.parse(stdout);
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
				if (discoveredHook.claudeEvent === "SessionStart" || discoveredHook.claudeEvent === "UserPromptSubmit") {
					return { messages: [{ type: "text", text: stdout }] };
				}
				return undefined;
			} catch {
				if (discoveredHook.claudeEvent === "SessionStart" || discoveredHook.claudeEvent === "UserPromptSubmit") {
					return { messages: [{ type: "text", text: stdout }] };
				}
				return undefined;
			}
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			logger.warn(`Claude command hook failed: ${command}`, { error: message });
			if (discoveredHook.type === "pre") {
				return { block: true, reason: `Hook command failed: ${message}` };
			}
			return undefined;
		}
	};

	ext.handlers.set(ompEvent, [handler]);
	return ext;
}

async function loadExtension(
	extensionPath: string,
	cwd: string,
	eventBus: EventBus,
	runtime: IExtensionRuntime,
): Promise<{ extension: Extension | null; error: string | null }> {
	const resolvedPath = resolvePath(extensionPath, cwd);
	try {
		const module = (await loadLegacyPiModule(resolvedPath)) as LoadedExtensionModule;
		const factory = getExtensionFactory(module);

		if (typeof factory !== "function") {
			return {
				extension: null,
				error: `Extension does not export a valid factory function: ${extensionPath}`,
			};
		}

		const extension = createExtension(extensionPath, resolvedPath);
		const api = new ConcreteExtensionAPI(PiCodingAgent, extension, runtime, cwd, eventBus);
		await factory(api);

		return { extension, error: null };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { extension: null, error: `Failed to load extension: ${message}` };
	}
}

/**
 * Create an Extension from an inline factory function.
 */
export async function loadExtensionFromFactory(
	factory: ExtensionFactory,
	cwd: string,
	eventBus: EventBus,
	runtime: IExtensionRuntime,
	name = "<inline>",
): Promise<Extension> {
	const extension = createExtension(name, name);
	const api = new ConcreteExtensionAPI(PiCodingAgent, extension, runtime, cwd, eventBus);
	await factory(api);
	return extension;
}

/**
 * Load extensions from paths.
 */
export async function loadExtensions(paths: string[], cwd: string, eventBus?: EventBus): Promise<LoadExtensionsResult> {
	const extensions: Extension[] = [];
	const errors: Array<{ path: string; error: string }> = [];
	const resolvedEventBus = eventBus ?? new EventBus();
	const runtime = new ExtensionRuntime();

	for (const extPath of paths) {
		const { extension, error } = await loadExtension(extPath, cwd, resolvedEventBus, runtime);

		if (error) {
			errors.push({ path: extPath, error });
			continue;
		}

		if (extension) {
			extensions.push(extension);
		}
	}

	return {
		extensions,
		errors,
		runtime,
	};
}

interface ExtensionManifest {
	extensions?: string[];
	themes?: string[];
	skills?: string[];
}

async function readExtensionManifest(packageJsonPath: string): Promise<ExtensionManifest | null> {
	try {
		const pkg = (await Bun.file(packageJsonPath).json()) as { omp?: ExtensionManifest; pi?: ExtensionManifest };
		const manifest = pkg.omp ?? pkg.pi;
		if (manifest && typeof manifest === "object") {
			return manifest;
		}
		return null;
	} catch (error) {
		if (isEnoent(error) || isEacces(error) || hasFsCode(error, "EPERM")) {
			return null;
		}
		logger.warn("Failed to read extension manifest", { path: packageJsonPath, error: String(error) });
		return null;
	}
}

function isExtensionFile(name: string): boolean {
	return name.endsWith(".ts") || name.endsWith(".js");
}

/**
 * Resolve extension entry points from a directory.
 */
async function resolveExtensionEntries(dir: string): Promise<string[] | null> {
	const packageJsonPath = path.join(dir, "package.json");
	const manifest = await readExtensionManifest(packageJsonPath);
	if (manifest?.extensions?.length) {
		const entries: string[] = [];
		for (const extPath of manifest.extensions) {
			const resolvedExtPath = path.resolve(dir, extPath);
			try {
				await fs.stat(resolvedExtPath);
				entries.push(resolvedExtPath);
			} catch (err) {
				if (isEnoent(err) || isEacces(err) || hasFsCode(err, "EPERM")) continue;
				throw err;
			}
		}
		if (entries.length > 0) {
			return entries;
		}
	}

	const indexTs = path.join(dir, "index.ts");
	const indexJs = path.join(dir, "index.js");
	try {
		await fs.stat(indexTs);
		return [indexTs];
	} catch (err) {
		if (isEnoent(err) || isEacces(err) || hasFsCode(err, "EPERM")) {
			// Ignore
		} else {
			throw err;
		}
	}
	try {
		await fs.stat(indexJs);
		return [indexJs];
	} catch (err) {
		if (isEnoent(err) || isEacces(err) || hasFsCode(err, "EPERM")) {
			// Ignore
		} else {
			throw err;
		}
	}

	return null;
}

/**
 * Discover extensions in a directory.
 *
 * Discovery rules:
 * 1. Direct files: `extensions/*.ts` or `*.js` → load
 * 2. Subdirectory with index: `extensions/<ext>/index.ts` or `index.js` → load
 * 3. Subdirectory with package.json: `extensions/<ext>/package.json` with "omp"/"pi" field → load declared paths
 *
 * No recursion beyond one level. Complex packages must use package.json manifest.
 */
async function discoverExtensionsInDir(dir: string): Promise<string[]> {
	const discovered: string[] = [];

	// First check if this directory itself has explicit extension entries (package.json or index)
	const rootEntries = await resolveExtensionEntries(dir);
	if (rootEntries) {
		return rootEntries;
	}

	// Otherwise, discover extensions from directory contents
	let entries: fs1.Dirent[];
	try {
		entries = await fs.readdir(dir, { withFileTypes: true });
	} catch (err) {
		if (isEnoent(err)) return [];
		logger.warn("Failed to discover extensions in directory", { path: dir, error: String(err) });
		return [];
	}

	for (const entry of entries) {
		const entryPath = path.join(dir, entry.name);

		if ((entry.isFile() || entry.isSymbolicLink()) && isExtensionFile(entry.name)) {
			discovered.push(entryPath);
			continue;
		}

		if (entry.isDirectory() || entry.isSymbolicLink()) {
			const resolved = await resolveExtensionEntries(entryPath);
			if (resolved) {
				discovered.push(...resolved);
			}
		}
	}

	return discovered;
}

/**
 * Discover and load extensions from standard locations.
 */
export async function discoverAndLoadExtensions(
	configuredPaths: string[],
	cwd: string,
	eventBus?: EventBus,
	disabledExtensionIds: string[] = [],
): Promise<LoadExtensionsResult> {
	const allPaths: string[] = [];
	const seen = new Set<string>();
	const disabled = new Set(disabledExtensionIds);

	const isDisabledName = (name: string): boolean => disabled.has(`extension-module:${name}`);

	const addPath = (extPath: string): void => {
		const resolved = path.resolve(extPath);
		if (!seen.has(resolved)) {
			seen.add(resolved);
			allPaths.push(extPath);
		}
	};

	const addPaths = (paths: string[]) => {
		for (const extPath of paths) {
			if (isDisabledName(getExtensionNameFromPath(extPath))) continue;
			addPath(extPath);
		}
	};

	// 1. Discover extension modules via capability API (native .omp/.pi only)
	const discovered = await loadCapability<ExtensionModule>(extensionModuleCapability.id, { cwd });
	for (const ext of discovered.items) {
		if (ext._source.provider !== "native") continue;
		if (isDisabledName(ext.name)) continue;
		addPath(ext.path);
	}

	// 2. Discover extension entry points from installed plugins
	addPaths(await getAllPluginExtensionPaths(cwd));

	// 3. Explicitly configured paths
	for (const configuredPath of configuredPaths) {
		const resolved = resolvePath(configuredPath, cwd);

		let stat: fs1.Stats | null = null;
		try {
			stat = await fs.stat(resolved);
		} catch (err) {
			if (!isEnoent(err)) throw err;
		}

		if (stat?.isDirectory()) {
			const entries = await resolveExtensionEntries(resolved);
			if (entries) {
				addPaths(entries);
				continue;
			}

			const discovered = await discoverExtensionsInDir(resolved);
			if (discovered.length > 0) {
				addPaths(discovered);
			}
			continue;
		}

		addPath(resolved);
	}

	const result = await loadExtensions(allPaths, cwd, eventBus);

	// 4. Discover command-based hooks from Claude Code settings.json
	//    and inject them as synthetic Extension objects into the runner.
	const discoveredHooks = await loadCapability<Hook>(hookCapability.id, { cwd });
	for (const hook of discoveredHooks.items) {
		if (!hook.command) continue; // file-based hooks are already loaded as extension modules
		const syntheticExt = createClaudeCommandExtension(hook, cwd);
		result.extensions.push(syntheticExt);
		logger.info(`Loaded Claude command hook: ${hook.claudeEvent}/${hook.tool} → ${hook.command}`);
	}

	return result;
}
