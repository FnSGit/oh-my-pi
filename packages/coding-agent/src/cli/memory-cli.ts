/**
 * Read-only memory usage report: recall counts per bank, the most-recalled
 * entries, recency, and the `recall_events` audit trail (channel + hits).
 *
 * Reads the mnemopi database files directly; never opens the backend, so it is
 * safe to run while omp sessions are live.
 */

import { Database } from "bun:sqlite";
import * as path from "node:path";
import { getAgentDir } from "@oh-my-pi/pi-utils";

export interface MemoryStatsArgs {
	agentDir?: string;
	json?: boolean;
	limit: number;
	days: number;
}

export interface MemoryBankStats {
	bank: string;
	path: string;
	rows: number;
	recalled: number;
	neverRecalled: number;
	events: number;
}

export interface MemoryTopEntry {
	bank: string;
	count: number;
	lastRecalled: string | null;
	source: string | null;
	content: string;
}

export interface MemoryChannelStats {
	channel: string;
	events: number;
	hits: number;
}

export interface MemoryRecentEvent {
	timestamp: string;
	channel: string | null;
	bank: string | null;
	query: string;
	hits: number;
}

export interface MemoryStatsReport {
	root: string;
	generatedAt: string;
	windowDays: number;
	rows: number;
	recalled: number;
	neverRecalled: number;
	events: number;
	banks: MemoryBankStats[];
	channels: MemoryChannelStats[];
	top: MemoryTopEntry[];
	recent: MemoryRecentEvent[];
}

type Row = Record<string, unknown>;

function openReadOnly(file: string): Database | null {
	try {
		const db = new Database(file, { readonly: true });
		db.run("PRAGMA busy_timeout = 2000");
		return db;
	} catch {
		return null;
	}
}

function hasTable(db: Database, table: string): boolean {
	const row = db
		.query("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1")
		.get(table) as { present: number } | null;
	return row !== null;
}

function countValue(db: Database, sql: string, params: readonly (string | number)[] = []): number {
	const row = db.query(sql).get(...params) as { value: number | null } | null;
	return row?.value ?? 0;
}

/** Collapse whitespace so stored memory content fits one report line. */
function oneLine(text: string, max: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

interface BankSnapshot {
	stats: MemoryBankStats;
	top: MemoryTopEntry[];
	channels: Map<string, { events: number; hits: number }>;
	recent: MemoryRecentEvent[];
}

function inspectBank(file: string, bank: string, limit: number, cutoffIso: string): BankSnapshot | null {
	const db = openReadOnly(file);
	if (!db) return null;
	try {
		if (!hasTable(db, "working_memory")) return null;
		const rows = countValue(db, "SELECT count(*) AS value FROM working_memory");
		const recalled = countValue(
			db,
			"SELECT count(*) AS value FROM working_memory WHERE coalesce(recall_count, 0) > 0",
		);
		const neverRecalled = countValue(
			db,
			"SELECT count(*) AS value FROM working_memory WHERE coalesce(recall_count, 0) = 0 AND coalesce(timestamp, created_at) < ?",
			[cutoffIso],
		);
		const topRows = db
			.query(
				`SELECT recall_count AS count, last_recalled AS last_recalled, source AS source, content AS content
				 FROM working_memory WHERE coalesce(recall_count, 0) > 0
				 ORDER BY recall_count DESC, last_recalled DESC LIMIT ?`,
			)
			.all(limit) as Row[];
		const top: MemoryTopEntry[] = topRows.map(row => ({
			bank,
			count: Number(row.count ?? 0),
			lastRecalled: typeof row.last_recalled === "string" ? row.last_recalled : null,
			source: typeof row.source === "string" ? row.source : null,
			content: oneLine(String(row.content ?? ""), 90),
		}));

		const channels = new Map<string, { events: number; hits: number }>();
		const recent: MemoryRecentEvent[] = [];
		let events = 0;
		if (hasTable(db, "recall_events")) {
			events = countValue(db, "SELECT count(*) AS value FROM recall_events");
			const channelRows = db
				.query(
					`SELECT coalesce(channel, '(none)') AS channel, count(*) AS events,
					        sum(CASE WHEN json_valid(memory_ids) THEN json_array_length(memory_ids) ELSE 0 END) AS hits
					 FROM recall_events GROUP BY channel ORDER BY events DESC`,
				)
				.all() as Row[];
			for (const row of channelRows) {
				const channel = String(row.channel ?? "(none)");
				channels.set(channel, { events: Number(row.events ?? 0), hits: Number(row.hits ?? 0) });
			}
			const eventRows = db
				.query(
					`SELECT timestamp, channel, bank, query,
					        CASE WHEN json_valid(memory_ids) THEN json_array_length(memory_ids) ELSE 0 END AS hits
					 FROM recall_events ORDER BY id DESC LIMIT ?`,
				)
				.all(limit) as Row[];
			for (const row of eventRows) {
				recent.push({
					timestamp: String(row.timestamp ?? ""),
					channel: typeof row.channel === "string" ? row.channel : null,
					bank: typeof row.bank === "string" ? row.bank : null,
					query: oneLine(String(row.query ?? ""), 80),
					hits: Number(row.hits ?? 0),
				});
			}
		}
		return {
			stats: { bank, path: file, rows, recalled, neverRecalled, events },
			top,
			channels,
			recent,
		};
	} finally {
		db.close();
	}
}

function mergeChannels(snapshots: readonly BankSnapshot[]): MemoryChannelStats[] {
	const merged = new Map<string, { events: number; hits: number }>();
	for (const snapshot of snapshots) {
		for (const [channel, value] of snapshot.channels) {
			const current = merged.get(channel) ?? { events: 0, hits: 0 };
			current.events += value.events;
			current.hits += value.hits;
			merged.set(channel, current);
		}
	}
	return [...merged.entries()]
		.map(([channel, value]) => ({ channel, ...value }))
		.sort((left, right) => right.events - left.events);
}

export function collectMemoryStats(args: MemoryStatsArgs): MemoryStatsReport {
	const agentDir = args.agentDir ?? getAgentDir();
	const root = path.join(agentDir, "memories", "mnemopi");
	const cutoffIso = new Date(Date.now() - args.days * 86_400_000).toISOString();
	const sharedFile = path.join(root, "mnemopi.db");
	const banksDir = path.join(root, "banks");

	const targets: Array<{ bank: string; file: string }> = [];
	if (Bun.file(sharedFile).size !== 0) targets.push({ bank: "shared", file: sharedFile });
	const banks = (() => {
		try {
			return [...new Bun.Glob("*/mnemopi.db").scanSync({ cwd: banksDir })];
		} catch {
			return [] as string[];
		}
	})();
	for (const relative of banks.sort()) {
		targets.push({ bank: path.basename(path.dirname(relative)), file: path.join(banksDir, relative) });
	}

	const snapshots: BankSnapshot[] = [];
	for (const target of targets) {
		const snapshot = inspectBank(target.file, target.bank, args.limit, cutoffIso);
		if (snapshot) snapshots.push(snapshot);
	}

	const top = snapshots
		.flatMap(snapshot => snapshot.top)
		.sort(
			(left, right) => right.count - left.count || (right.lastRecalled ?? "").localeCompare(left.lastRecalled ?? ""),
		)
		.slice(0, args.limit);
	const recent = snapshots
		.flatMap(snapshot => snapshot.recent)
		.sort((left, right) => right.timestamp.localeCompare(left.timestamp))
		.slice(0, args.limit);

	return {
		root,
		generatedAt: new Date().toISOString(),
		windowDays: args.days,
		rows: snapshots.reduce((sum, snapshot) => sum + snapshot.stats.rows, 0),
		recalled: snapshots.reduce((sum, snapshot) => sum + snapshot.stats.recalled, 0),
		neverRecalled: snapshots.reduce((sum, snapshot) => sum + snapshot.stats.neverRecalled, 0),
		events: snapshots.reduce((sum, snapshot) => sum + snapshot.stats.events, 0),
		banks: snapshots.map(snapshot => snapshot.stats),
		channels: mergeChannels(snapshots),
		top,
		recent,
	};
}

function pad(value: string, width: number): string {
	return value.length >= width ? value : value + " ".repeat(width - value.length);
}

export function formatMemoryStats(report: MemoryStatsReport): string {
	const lines: string[] = [];
	lines.push(`memory store: ${report.root}`);
	lines.push(
		`rows ${report.rows} · recalled ${report.recalled} · never recalled (${report.windowDays}d+) ${report.neverRecalled} · events ${report.events}`,
	);

	lines.push("");
	lines.push("banks");
	for (const bank of report.banks) {
		lines.push(
			`  ${pad(bank.bank, 30)} rows ${String(bank.rows).padStart(4)}  recalled ${String(bank.recalled).padStart(4)}  cold ${String(bank.neverRecalled).padStart(4)}  events ${String(bank.events).padStart(4)}`,
		);
	}

	lines.push("");
	lines.push("top recalled");
	if (report.top.length === 0) {
		lines.push("  (none)");
	}
	for (const entry of report.top) {
		lines.push(
			`  ${String(entry.count).padStart(3)}x ${pad((entry.lastRecalled ?? "-").slice(0, 16), 17)} ${pad(entry.bank, 26)} ${entry.content}`,
		);
	}

	lines.push("");
	lines.push("recall channels");
	if (report.channels.length === 0) {
		lines.push("  (no recall events yet)");
	}
	for (const channel of report.channels) {
		lines.push(
			`  ${pad(channel.channel, 14)} events ${String(channel.events).padStart(4)}  hits ${String(channel.hits).padStart(5)}`,
		);
	}

	lines.push("");
	lines.push("recent recalls");
	if (report.recent.length === 0) {
		lines.push("  (none)");
	}
	for (const event of report.recent) {
		lines.push(
			`  ${event.timestamp.slice(0, 19)} ${pad(event.channel ?? "-", 11)} ${pad(event.bank ?? "-", 24)} ${String(event.hits).padStart(3)} hits  ${event.query}`,
		);
	}
	return lines.join("\n");
}

export async function runMemoryStats(args: MemoryStatsArgs): Promise<void> {
	const report = collectMemoryStats(args);
	if (!report.banks.length) {
		process.stderr.write(`No mnemopi database found under ${report.root}\n`);
		return;
	}
	process.stdout.write(args.json ? `${JSON.stringify(report, null, 2)}\n` : `${formatMemoryStats(report)}\n`);
}
