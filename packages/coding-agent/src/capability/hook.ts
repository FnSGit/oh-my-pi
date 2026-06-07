/**
 * Hooks Capability
 *
 * Pre/post tool execution hooks defined as shell scripts,
 * or as command-based hooks from Claude Code settings.json.
 */
import { defineCapability } from ".";
import type { SourceMeta } from "./types";

/**
 * Claude Code hook event names.
 * These map to omp's internal event system.
 */
export type ClaudeHookEvent =
	| "PreToolUse"
	| "PostToolUse"
	| "PreCompact"
	| "PostCompact"
	| "Notification"
	| "SessionStart"
	| "SessionEnd"
	| "Stop"
	| "StopFailure"
	| "UserPromptSubmit"
	| "SubagentStart"
	| "SubagentStop"
	| "PermissionRequest"
	| "PermissionDenied";

/**
 * A hook handler from Claude Code settings.json.
 */
export interface ClaudeHookHandler {
	/** Hook type: "command" for shell commands */
	type: "command" | "http" | "mcp_tool" | "prompt" | "agent";
	/** The command to execute (for type: "command") */
	command?: string;
	/** Arguments to pass to the command */
	args?: string[];
	/** Timeout in seconds */
	timeout?: number;
	/** If condition using permission rule syntax (e.g. "Bash(rm *)") */
	if?: string;
}

/**
 * A matcher group from Claude Code settings.json hooks.
 */
export interface ClaudeHookMatcherGroup {
	/** Matcher pattern for tool names or event subtypes */
	matcher?: string;
	/** Array of hook handlers in this group */
	hooks: ClaudeHookHandler[];
}

/**
 * The hooks object from Claude Code settings.json.
 * Keys are event names, values are arrays of matcher groups.
 */
export type ClaudeHooksConfig = Partial<Record<ClaudeHookEvent, ClaudeHookMatcherGroup[]>>;

/**
 * A hook script or command.
 */
export interface Hook {
	/** Hook name (filename without extension, or synthetic name for command hooks) */
	name: string;
	/** Absolute path to hook file, or synthetic path for command hooks */
	path: string;
	/** Hook type (pre/post) and associated tool */
	type: "pre" | "post";
	/** Tool this hook applies to, or "*" for all */
	tool: string;
	/** Source level */
	level: "user" | "project";
	/** Source metadata */
	_source: SourceMeta;

	// --- Claude Code command-hook fields (optional) ---
	/** When present, this hook is a command-based hook from settings.json */
	command?: string;
	/** Arguments for the command */
	args?: string[];
	/** Timeout in seconds (Claude Code format) */
	timeout?: number;
	/** If condition using permission rule syntax */
	ifCondition?: string;
	/** Original Claude Code event name */
	claudeEvent?: ClaudeHookEvent;
	/** Matcher pattern from Claude Code config */
	matcher?: string;
}

export const hookCapability = defineCapability<Hook>({
	id: "hooks",
	displayName: "Hooks",
	description: "Pre/post tool execution hooks",
	key: hook => `${hook.type}:${hook.tool}:${hook.name}`,
	toExtensionId: hook => `hook:${hook.type}:${hook.tool}:${hook.name}`,
	validate: hook => {
		if (!hook.name) return "Missing name";
		if (!hook.path) return "Missing path";
		if (hook.type !== "pre" && hook.type !== "post") return "Invalid type (must be 'pre' or 'post')";
		if (!hook.tool) return "Missing tool";
		return undefined;
	},
});
