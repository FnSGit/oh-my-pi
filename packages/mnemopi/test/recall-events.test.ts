import { afterEach, describe, expect, it } from "bun:test";
import { recallEnhanced } from "@oh-my-pi/pi-mnemopi/core/beam/recall";
import { initBeam } from "@oh-my-pi/pi-mnemopi/core/beam/schema";
import { remember } from "@oh-my-pi/pi-mnemopi/core/beam/store";
import type { BeamMemoryState } from "@oh-my-pi/pi-mnemopi/core/beam/types";
import { openDatabase } from "@oh-my-pi/pi-mnemopi/db";

const states: BeamMemoryState[] = [];

function makeState(sessionId = "store-session"): BeamMemoryState {
	const db = openDatabase(":memory:");
	initBeam(db);
	const state: BeamMemoryState = {
		db,
		dbPath: ":memory:",
		sessionId,
		authorId: null,
		authorType: null,
		channelId: "channel-a",
		useCloud: false,
		pluginManager: null,
		annotations: null,
		triples: null,
		episodicGraph: null,
		veracityConsolidator: null,
		caches: { timestampParse: new Map(), extractionBuffer: [] },
		config: {
			workingMemoryLimit: 1000,
			workingMemoryTtlHours: 24,
			recencyHalflifeHours: 72,
			vecWeight: 0.5,
			ftsWeight: 0.3,
			importanceWeight: 0.2,
			useCloud: false,
			localLlmEnabled: false,
			maxEpisodeChars: 100_000,
		},
	};
	states.push(state);
	return state;
}

type RecallEventRow = {
	session_id: string;
	channel: string | null;
	query: string;
	bank: string | null;
	memory_ids: string;
	tier_counts: string;
	top_score: number | null;
};

function readEvents(beam: BeamMemoryState): RecallEventRow[] {
	return beam.db
		.prepare(
			"SELECT session_id, channel, query, bank, memory_ids, tier_counts, top_score FROM recall_events ORDER BY id",
		)
		.all() as RecallEventRow[];
}

afterEach(() => {
	while (states.length > 0) states.pop()?.db.close();
});

describe("recall audit events", () => {
	it("records the caller channel, session, query and served memory ids", async () => {
		const beam = makeState();
		const id = remember(beam, "orchid blooms in spring", { source: "conversation", importance: 0.8 });

		const results = await recallEnhanced(beam, "orchid", 5, {
			recallContext: { sessionId: "session-42", channel: "tool" },
		});
		expect(results.map(result => result.id)).toContain(id);

		const rows = readEvents(beam);
		expect(rows).toHaveLength(1);
		expect(rows[0].session_id).toBe("session-42");
		expect(rows[0].channel).toBe("tool");
		expect(rows[0].query).toBe("orchid");
		expect(rows[0].bank).toBe("channel-a");
		expect(JSON.parse(rows[0].memory_ids)).toContain(id);
		expect(JSON.parse(rows[0].tier_counts)).toMatchObject({ working: 1 });
		expect(rows[0].top_score).toBeGreaterThan(0);
	});

	it("falls back to the store session and leaves the channel empty when the caller gives no context", async () => {
		const beam = makeState("store-session");
		remember(beam, "cobalt is a deep blue", { source: "conversation" });

		await recallEnhanced(beam, "cobalt", 5);

		const [event] = readEvents(beam);
		expect(event.session_id).toBe("store-session");
		expect(event.channel).toBeNull();
	});

	it("appends one row per recall instead of overwriting the audit trail", async () => {
		const beam = makeState();
		remember(beam, "jasmine smells sweet", { source: "conversation" });

		await recallEnhanced(beam, "jasmine", 5, { recallContext: { channel: "auto" } });
		await recallEnhanced(beam, "jasmine", 5, { recallContext: { channel: "tool" } });

		expect(readEvents(beam).map(event => event.channel)).toEqual(["auto", "tool"]);
	});
});
