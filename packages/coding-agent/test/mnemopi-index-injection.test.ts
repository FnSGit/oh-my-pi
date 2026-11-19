/**
 * The compact memory index is the omp counterpart of pi-memory's `<user_memory>`
 * catalog: the agent must see what it remembers before deciding to call `recall`.
 * These tests pin the externally visible block (sections, ids, review warning,
 * quotas, and the master switch) rather than the SQL behind it.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { mnemopiBackend } from "@oh-my-pi/pi-coding-agent/mnemopi/backend";
import { loadMnemopiConfig } from "@oh-my-pi/pi-coding-agent/mnemopi/config";
import {
	loadMnemopi,
	loadMnemopiCore,
	MnemopiSessionState,
	setMnemopiSessionState,
} from "@oh-my-pi/pi-coding-agent/mnemopi/state";
import { TempDir } from "@oh-my-pi/pi-utils";

await Promise.all([loadMnemopi(), loadMnemopiCore()]);

const SESSION_ID = "index-injection-session";
const states: MnemopiSessionState[] = [];
const dirs: TempDir[] = [];

function startSession(overrides: Record<string, unknown> = {}): {
	state: MnemopiSessionState;
	dir: TempDir;
	settings: Settings;
} {
	const dir = TempDir.createSync("@mnemopi-index-injection-");
	dirs.push(dir);
	const settings = Settings.isolated({
		"memory.backend": "mnemopi",
		"mnemopi.scoping": "per-project-tagged",
		"mnemopi.dbPath": dir.join("mnemopi.db"),
		"mnemopi.noEmbeddings": true,
		"mnemopi.llmMode": "none",
		"mnemopi.indexInjection": true,
		...overrides,
	});
	const state = new MnemopiSessionState({
		sessionId: SESSION_ID,
		config: loadMnemopiConfig(settings, dir.path()),
		session: {
			sessionId: SESSION_ID,
			settings,
			modelRegistry: {
				getApiKeyForProvider: async () => undefined,
				resolver: () => async () => undefined,
			} as never,
			sessionManager: { getEntries: () => [], getCwd: () => dir.path() } as never,
			emitNotice: () => {},
			getHindsightSessionState: () => undefined,
			getXdevToolEntries: () => [],
			subscribe: () => () => {},
		} as never,
	});
	setMnemopiSessionState(state.session as never, state);
	states.push(state);
	return { state, dir, settings };
}

function rememberPreference(state: MnemopiSessionState, content: string): void {
	state.rememberScoped(
		content,
		{
			source: "test",
			importance: 0.9,
			scope: "bank",
			trustTier: "IMPORTED",
			veracity: "stated",
			memoryType: "preference",
			timestamp: "2026-11-01T00:00:00.000Z",
		},
		state.getGlobalRetainTarget(),
	);
}

function rememberGlobalFact(
	state: MnemopiSessionState,
	content: string,
	veracity = "stated",
	timestamp = "2026-11-02T00:00:00.000Z",
): void {
	state.rememberScoped(
		content,
		{
			source: "test",
			importance: 0.8,
			scope: "bank",
			trustTier: "IMPORTED",
			veracity,
			memoryType: "fact",
			timestamp,
		},
		state.getGlobalRetainTarget(),
	);
}

function rememberProject(state: MnemopiSessionState, content: string): void {
	state.rememberScoped(content, {
		source: "test",
		importance: 0.75,
		scope: "bank",
		trustTier: "IMPORTED",
		veracity: "stated",
		memoryType: "project",
		timestamp: "2026-11-03T00:00:00.000Z",
	});
}

afterEach(async () => {
	for (const state of states.splice(0)) await state.dispose();
	for (const dir of dirs.splice(0)) await dir.remove();
});

describe("mnemopi.indexInjection", () => {
	it("renders preferences, knowledge, and project memories with id prefixes", () => {
		const { state } = startSession();
		rememberPreference(state, "The user prefers concise Chinese answers");
		rememberGlobalFact(state, "The deployment target is stable-cluster");
		rememberProject(state, "This project builds with Maven");

		const index = state.formatScopedIndex();
		expect(index).toBeDefined();
		expect(index).toContain("Long-term memory index");
		expect(index).toContain("User preferences:");
		expect(index).toContain("The user prefers concise Chinese answers");
		expect(index).toContain("Knowledge:");
		expect(index).toContain("The deployment target is stable-cluster");
		expect(index).toContain("Project memory:");
		expect(index).toContain("This project builds with Maven");
		expect(index).toMatch(/\(id=[0-9a-f]{8}\)/);
	});

	it("injects the index into the Mnemopi developer instructions", async () => {
		const { state, dir, settings } = startSession();
		rememberPreference(state, "The user prefers concise Chinese answers");
		rememberProject(state, "This project builds with Maven");

		const instructions = await mnemopiBackend.buildDeveloperInstructions(
			dir.path(),
			dir.path(),
			settings,
			state.session as never,
		);
		expect(instructions).toContain("Long-term memory index");
		expect(instructions).toContain("The user prefers concise Chinese answers");
		expect(instructions).toContain("This project builds with Maven");
	});

	it("excludes automatic transcript episodes from the index", () => {
		const { state } = startSession();
		rememberPreference(state, "Durable preference");
		state.rememberScoped("[role: user] raw transcript", {
			source: "coding-agent-transcript",
			importance: 0.99,
			scope: "bank",
			trustTier: "IMPORTED",
			veracity: "unknown",
			memoryType: "episode",
		});
		state.rememberScoped("[role: user] episode without transcript source", {
			importance: 0.99,
			scope: "bank",
			trustTier: "IMPORTED",
			veracity: "unknown",
			memoryType: "episode",
		});

		const index = state.formatScopedIndex();
		expect(index).toContain("Durable preference");
		expect(index).not.toContain("raw transcript");
		expect(index).not.toContain("episode without transcript source");
	});

	it("hides a memory retired with memory_edit invalidate", () => {
		const { state } = startSession();
		rememberPreference(state, "Retired preference");
		const id = state.listScopedIndexEntries()[0]?.id;
		expect(id).toBeDefined();
		expect(state.formatScopedIndex()).toContain("Retired preference");

		expect(state.editScopedMemory("invalidate", id!).status).toBe("invalidated");
		expect(state.formatScopedIndex() ?? "").not.toContain("Retired preference");
	});

	it("marks a memory reviewed as false with the warning prefix", () => {
		const { state } = startSession();
		rememberGlobalFact(state, "The old endpoint is deprecated", "false");
		const index = state.formatScopedIndex();
		expect(index).toContain("- ⚠️ [knowledge] The old endpoint is deprecated");
	});

	it("honors per-section quotas and hides empty sections", () => {
		const { state } = startSession({
			"mnemopi.indexInjectionPrefs": 0,
			"mnemopi.indexInjectionKnowledge": 1,
			"mnemopi.indexInjectionProject": 0,
		});
		rememberPreference(state, "Preference that must be hidden");
		rememberGlobalFact(state, "First knowledge", "stated", "2026-11-01T00:00:00.000Z");
		rememberGlobalFact(state, "Second knowledge");
		rememberProject(state, "Project that must be hidden");

		const index = state.formatScopedIndex();
		expect(index).toBeDefined();
		expect(index).not.toContain("User preferences:");
		expect(index).not.toContain("Preference that must be hidden");
		expect(index).toContain("Knowledge:");
		expect(index).toContain("Second knowledge");
		expect(index).not.toContain("First knowledge");
		expect(index).not.toContain("Project memory:");
		expect(index).not.toContain("Project that must be hidden");
	});

	it("returns undefined when the master switch is off", () => {
		const { state } = startSession({ "mnemopi.indexInjection": false });
		rememberPreference(state, "Hidden preference");
		expect(state.formatScopedIndex()).toBeUndefined();
	});

	it("returns undefined when every bank is empty", () => {
		const { state } = startSession();
		expect(state.formatScopedIndex()).toBeUndefined();
	});
});
