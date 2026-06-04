/**
 * Tests for createCommandHook — Claude Code settings.json command hooks.
 *
 * Regression: `UserPromptSubmit` and `SessionStart` handlers must return proper
 * `Message` objects (with `role`) so downstream `convertToLlm` does not filter
 * them out. The old code returned `{ messages: [{ type: "text", text: stdout }] }`
 * — a content block, not a Message — which passed the runner's `length > 0`
 * guard but was silently dropped by `convertToLlm`, leaving `context.messages`
 * empty and tripping the `buildParams` defensive throw.
 *
 * Additionally, `UserPromptSubmit` Claude-Code hooks emit JSON of shape
 *   { hookSpecificOutput: { hookEventName, additionalContext } }
 * and the loader must extract `additionalContext` rather than the entire
 * JSON string.
 */

import { describe, expect, it } from "bun:test";
import type { Hook } from "@oh-my-pi/pi-coding-agent/capability/hook";
import { createCommandHook } from "@oh-my-pi/pi-coding-agent/extensibility/hooks/loader";

const makeHook = (overrides: Partial<Hook> = {}): Hook => ({
	name: "test-cmd-hook",
	path: "/synthetic/cmd-hook",
	type: "pre",
	tool: "*",
	level: "user",
	_source: { provider: "test", providerName: "test", path: "/test", level: "user" },
	...overrides,
});

const contextEventWith = (messages: unknown[]) => ({ type: "context", messages });

describe("createCommandHook — UserPromptSubmit context event", () => {
	it("returns proper user Message and APPENDS to existing context (JSON additionalContext)", async () => {
		const additionalContext = "相关记忆：- [project] oh-my-pi: bug fix history";
		const hook = makeHook({
			claudeEvent: "UserPromptSubmit",
			command: "printf",
			args: [
				"%s",
				JSON.stringify({
					hookSpecificOutput: {
						hookEventName: "UserPromptSubmit",
						additionalContext,
					},
				}),
			],
		});
		const loaded = createCommandHook(hook, process.cwd());
		const handler = loaded.handlers.get("context")?.[0];
		expect(handler).toBeDefined();

		const existingUserMsg = { role: "user", content: "user prompt", timestamp: 1000 };
		const result = (await handler!(contextEventWith([existingUserMsg]), {})) as
			| { messages?: unknown[] }
			| undefined;

		// Must return something
		expect(result).toBeDefined();
		expect(result?.messages).toBeDefined();
		expect(result!.messages).toHaveLength(2);

		// First item MUST be the original message preserved (append, not replace)
		expect(result!.messages![0]).toBe(existingUserMsg);

		// Second item MUST be a proper user Message — must have `role: "user"`
		// and a content array with a text block carrying the additional context.
		const appended = result!.messages![1] as { role?: string; content?: unknown };
		expect(appended.role).toBe("user");
		expect(Array.isArray(appended.content)).toBe(true);
		const blocks = appended.content as Array<{ type?: string; text?: string }>;
		const textBlock = blocks.find(b => b.type === "text");
		expect(textBlock?.text).toBe(additionalContext);
		// Specifically, the appended message must NOT be a raw content block —
		// i.e. it must have a `role` field. (This is the regression assertion.)
		expect((appended as Record<string, unknown>).type).toBeUndefined();
	});

	it("falls back to raw stdout when UserPromptSubmit output is not JSON-wrapped", async () => {
		const rawText = "plain text context from hook";
		const hook = makeHook({
			claudeEvent: "UserPromptSubmit",
			command: "printf",
			args: ["%s", rawText],
		});
		const loaded = createCommandHook(hook, process.cwd());
		const handler = loaded.handlers.get("context")?.[0]!;
		const result = (await handler(contextEventWith([]), {})) as { messages?: unknown[] };
		expect(result.messages).toHaveLength(1);
		const msg = result.messages![0] as { role?: string; content?: unknown };
		expect(msg.role).toBe("user");
		const blocks = msg.content as Array<{ type?: string; text?: string }>;
		expect(blocks.find(b => b.type === "text")?.text).toBe(rawText);
	});

	it("returns undefined when UserPromptSubmit output is empty (no override)", async () => {
		const hook = makeHook({
			claudeEvent: "UserPromptSubmit",
			command: "true", // exits 0 with no stdout
		});
		const loaded = createCommandHook(hook, process.cwd());
		const handler = loaded.handlers.get("context")?.[0]!;
		const result = await handler(contextEventWith([{ role: "user", content: "x" }]), {});
		expect(result).toBeUndefined();
	});
});

describe("createCommandHook — SessionStart event", () => {
	it("registers for session_start event (not context), so its return value is ignored upstream", async () => {
		// SessionStart is mapped to "session_start" in CLAUDE_EVENT_MAP, NOT
		// "context". The general `emit()` ignores session_start handler return
		// values entirely, so even if the loader tried to construct a messages
		// override, it would be silently dropped by the runner. The loader
		// must therefore NOT claim a context override for SessionStart.
		const hook = makeHook({
			claudeEvent: "SessionStart",
			command: "printf",
			args: ["%s", "memory injection text"],
		});
		const loaded = createCommandHook(hook, process.cwd());
		// The handler must be registered under "session_start", not "context".
		expect(loaded.handlers.get("session_start")?.length).toBe(1);
		expect(loaded.handlers.get("context")).toBeUndefined();
	});
});

describe("createCommandHook — malformed-message regression", () => {
	it("NEVER returns { messages: [contentBlock] } where contentBlock lacks `role`", async () => {
		// This is the direct regression for the bug: a Claude Code hook
		// returning a `UserPromptSubmit` JSON with `additionalContext` must not
		// surface as `{ messages: [{ type: "text", text: <entire JSON> }] }`.
		// If any returned item lacks `role`, convertToLlm will filter it out
		// and the provider will receive an empty messages array.
		const hook = makeHook({
			claudeEvent: "UserPromptSubmit",
			command: "printf",
			args: [
				"%s",
				JSON.stringify({
					hookSpecificOutput: {
						hookEventName: "UserPromptSubmit",
						additionalContext: "do not lose the user's history",
					},
				}),
			],
		});
		const loaded = createCommandHook(hook, process.cwd());
		const handler = loaded.handlers.get("context")?.[0]!;
		const result = (await handler(contextEventWith([]), {})) as
			| { messages?: unknown[] }
			| undefined;
		if (result?.messages) {
			for (const m of result.messages) {
				expect((m as { role?: string }).role).toBeDefined();
			}
		}
	});
});
