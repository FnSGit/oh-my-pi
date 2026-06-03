/**
 * Tests for HookRunner - context event override behavior.
 * Regression: empty `messages: []` from a hook must NOT wipe the LLM context.
 * `[]` is truthy in JS, so the old `if (handlerResult.messages)` check
 * mis-classified "handler returned an empty array" as "handler had no messages
 * field" and applied the empty array, causing the provider to 400 with
 * "messages is required".
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { HookRunner } from "@oh-my-pi/pi-coding-agent/extensibility/hooks/runner";
import type { ContextEventResult, LoadedHook } from "@oh-my-pi/pi-coding-agent/extensibility/hooks/loader";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { logger, TempDir } from "@oh-my-pi/pi-utils";

describe("HookRunner context event override", () => {
	let tempDir: TempDir;
	let sessionManager: SessionManager;
	let modelRegistry: ModelRegistry;
	let authStorage: AuthStorage;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-hook-runner-test-");
		sessionManager = SessionManager.inMemory();
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterEach(() => {
		authStorage.close();
		tempDir.removeSync();
	});

	const makeUserMsg = (id: string) =>
		({ role: "user" as const, content: `msg-${id}`, timestamp: Date.now() });

	const runContextHandler = async (handlerResult: ContextEventResult | undefined | Promise<ContextEventResult | undefined>, input: any[]) => {
		const resolved = await Promise.resolve(handlerResult);
		const handlers = new Map<string, Array<(event: any) => any>>();
		handlers.set("context", [async () => resolved]);
		const hook: LoadedHook = {
			path: "test-hook",
			resolvedPath: "/test/test-hook.ts",
			handlers,
			messageRenderers: new Map(),
			commands: new Map(),
			setSendMessageHandler: () => {},
			setAppendEntryHandler: () => {},
		};
		const runner = new HookRunner([hook], tempDir.path(), sessionManager, modelRegistry);
		return runner.emitContext(input);
	};

	it("keeps original messages when hook returns { messages: [] } (regression)", async () => {
		const input = [makeUserMsg("u1"), makeUserMsg("u2")];
		const result = await runContextHandler({ messages: [] }, input);
		expect(result).toBe(input);
		expect(result).toHaveLength(2);
	});

	it("keeps original messages when hook returns { messages: undefined }", async () => {
		const input = [makeUserMsg("u1")];
		const result = await runContextHandler({ messages: undefined }, input);
		expect(result).toBe(input);
	});

	it("keeps original messages when hook returns nothing", async () => {
		const input = [makeUserMsg("u1")];
		const result = await runContextHandler(undefined, input);
		expect(result).toBe(input);
	});

	it("applies override when hook returns a non-empty array", async () => {
		const input = [makeUserMsg("original")];
		const override = [makeUserMsg("override")];
		const result = await runContextHandler({ messages: override }, input);
		expect(result).toEqual(override);
	});

	it("logs error but keeps messages when hook throws", async () => {
		const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {});
		const input = [makeUserMsg("u1")];
		const handlers = new Map<string, Array<(event: any) => any>>();
		handlers.set("context", [async () => { throw new Error("boom"); }]);
		const hook: LoadedHook = {
			path: "test-hook",
			resolvedPath: "/test/test-hook.ts",
			handlers,
			messageRenderers: new Map(),
			commands: new Map(),
			setSendMessageHandler: () => {},
			setAppendEntryHandler: () => {},
		};
		const runner = new HookRunner([hook], tempDir.path(), sessionManager, modelRegistry);
		const result = await runner.emitContext(input);
		expect(result).toBe(input);
		expect(result).toHaveLength(1);
		errorSpy.mockRestore();
	});
});
