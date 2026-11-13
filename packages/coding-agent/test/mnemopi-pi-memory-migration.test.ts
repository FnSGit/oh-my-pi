/**
 * The pi-memory importer is a one-way data path, so its contract is pinned end
 * to end: read the sidecars, map preference/knowledge to the shared bank and
 * project entries to their cwd-derived bank, preserve the original metadata,
 * and stay idempotent when rerun.
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Mnemopi } from "@oh-my-pi/pi-mnemopi";
import { TempDir } from "@oh-my-pi/pi-utils";
import {
	applyPiMemoryMigration,
	planPiMemoryMigration,
	readPiMemoryEntries,
} from "@oh-my-pi/pi-coding-agent/mnemopi/migrate-pi-memory";

const roots: TempDir[] = [];
const agents: TempDir[] = [];

function makeDirs(): { root: TempDir; agent: TempDir } {
	const root = TempDir.createSync("@pi-memory-migration-");
	const agent = TempDir.createSync("@pi-memory-migration-agent-");
	roots.push(root);
	agents.push(agent);
	return { root, agent };
}

function entry(id: string, type: string, content: string, extra: Record<string, unknown> = {}) {
	return {
		id,
		content,
		type,
		tags: [type, "test"],
		createdAt: 1_792_000_000_000,
		source: "auto",
		hitCount: 3,
		lastUsedAt: 1_792_000_100_000,
		status: "unverified",
		...extra,
	};
}

afterEach(async () => {
	for (const root of roots.splice(0)) await root.remove();
	for (const agent of agents.splice(0)) await agent.remove();
});

describe("pi-memory migration", () => {
	it("plans and applies global + project entries into Mnemopi banks", async () => {
		const { root, agent } = makeDirs();
		const projectPath = path.join(root.path(), "projects", "demo");
		await Bun.write(
			path.join(root.path(), "global.index.json"),
			JSON.stringify({
				version: 1,
				dims: 512,
				entries: [
					entry("pref-1", "preference", "The user prefers concise Chinese answers"),
					entry("know-1", "knowledge", "The deployment target is stable-cluster"),
				],
			}),
		);
		await Bun.write(
			path.join(root.path(), "projects", "demo-abc.index.json"),
			JSON.stringify({
				version: 1,
				dims: 512,
				entries: [
					entry("proj-1", "project", "This project builds with Maven", {
						projectPath,
						source: "manual",
					}),
				],
			}),
		);

		const read = await readPiMemoryEntries(root.path());
		expect(read.entries).toHaveLength(3);
		expect(read.warnings).toEqual([]);

		const plan = planPiMemoryMigration(read.entries, {
			agentDir: agent.path(),
			scoping: "per-project-tagged",
		});
		expect(plan.banks.find(bank => bank.global)?.items).toHaveLength(2);
		const projectBank = plan.banks.find(bank => !bank.global);
		expect(projectBank?.items).toHaveLength(1);
		expect(projectBank?.items[0].entry.id).toBe("proj-1");

		const result = await applyPiMemoryMigration(plan, { dryRun: false, noEmbeddings: true, backup: false });
		expect(result.failed).toEqual([]);
		expect(result.written).toBe(3);

		const globalBank = plan.banks.find(bank => bank.global)!;
		const global = new Mnemopi({
			dbPath: globalBank.dbPath,
			bank: globalBank.bank,
			sessionId: globalBank.bank,
			noEmbeddings: true,
		});
		try {
			const rows = global.listIndex({ limit: 10 });
			expect(rows).toHaveLength(2);
			const preference = rows.find(row => row.memory_type === "preference");
			expect(preference?.content).toBe("The user prefers concise Chinese answers");
			// `get` is the full-row read path `memory://<id>` uses; assert the migration kept provenance.
			const stored = global.get(preference!.id) as { metadata_json?: string } | null;
			const raw = global.db.query("SELECT trust_tier FROM working_memory WHERE id = ?").get(preference!.id) as {
				trust_tier?: string;
			} | null;
			expect(raw?.trust_tier).toBe("IMPORTED");
			const metadata = JSON.parse(stored?.metadata_json ?? "{}");
			expect(metadata.pi_memory_id).toBe("pref-1");
			expect(metadata.pi_memory_tags).toContain("preference");
		} finally {
			global.close();
		}

		const project = new Mnemopi({
			dbPath: projectBank!.dbPath,
			bank: projectBank!.bank,
			sessionId: projectBank!.bank,
			noEmbeddings: true,
		});
		try {
			const rows = project.listIndex({ limit: 10 });
			expect(rows).toHaveLength(1);
			expect(rows[0].content).toBe("This project builds with Maven");
		} finally {
			project.close();
		}

		// Rerunning must update in place, never duplicate.
		const rerun = await applyPiMemoryMigration(plan, { dryRun: false, noEmbeddings: true, backup: false });
		expect(rerun.written).toBe(3);
		const reopened = new Mnemopi({
			dbPath: globalBank.dbPath,
			bank: globalBank.bank,
			sessionId: globalBank.bank,
			noEmbeddings: true,
		});
		try {
			expect(reopened.listIndex({ limit: 10 })).toHaveLength(2);
		} finally {
			reopened.close();
		}
	});

	it("skips malformed entries with a warning instead of importing garbage", async () => {
		const { root, agent } = makeDirs();
		await Bun.write(
			path.join(root.path(), "global.index.json"),
			JSON.stringify({
				version: 1,
				entries: [
					{ id: "ok", content: "valid", type: "knowledge", createdAt: 1_792_000_000_000 },
					{ id: "bad", content: "", type: "knowledge", createdAt: 1_792_000_000_000 },
					{ id: "no-project-path", content: "x", type: "project", createdAt: 1_792_000_000_000 },
				],
			}),
		);
		const read = await readPiMemoryEntries(root.path());
		expect(read.entries).toHaveLength(1);
		expect(read.warnings).toHaveLength(2);
		const plan = planPiMemoryMigration(read.entries, { agentDir: agent.path() });
		expect(plan.banks.reduce((sum, bank) => sum + bank.items.length, 0)).toBe(1);
	});
});
