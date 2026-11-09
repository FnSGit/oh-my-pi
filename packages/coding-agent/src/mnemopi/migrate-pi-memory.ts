/**
 * One-shot migration from the external pi-memory extension to omp's native
 * Mnemopi backend.
 *
 * pi-memory keeps every entry's full text in a JSON sidecar next to a RuVector
 * database. The vectors are not reusable (512-d bge-small-zh vs Mnemopi's
 * 384/768/1024-d models), so this migration reads only the sidecars, maps the
 * three pi-memory types onto Mnemopi banks, and lets `Mnemopi.remember()` queue
 * fresh embeddings. Imported rows use `trustTier: "IMPORTED"`, which Mnemopi's
 * working-memory TTL trim explicitly skips, and exact-content dedupe makes the
 * migration idempotent.
 */
import { constants as fsConstants } from "node:fs";
import * as fs from "node:fs/promises";
import { homedir } from "node:os";
import * as path from "node:path";
import { Mnemopi } from "@oh-my-pi/pi-mnemopi";
import { type } from "@oh-my-pi/omptype";
import { getMemoriesDir, isEnoent } from "@oh-my-pi/pi-utils";
import { computeMnemopiBankScope, type MnemopiScoping } from "./config";

export type PiMemoryType = "preference" | "knowledge" | "project";

export interface PiMemoryEntry {
	id: string;
	content: string;
	type: PiMemoryType;
	tags: string[];
	createdAt: number;
	source: "manual" | "auto";
	projectPath?: string;
	hitCount: number;
	lastUsedAt: number;
	status: "unverified" | "correct" | "wrong";
	errorAnalysis?: string;
}

export interface PiMemoryReadResult {
	entries: PiMemoryEntry[];
	files: string[];
	warnings: string[];
}

export interface PiMemoryMigrationOptions {
	agentDir: string;
	/** Override the shared-bank database. Defaults to `<agentDir>/memories/mnemopi/mnemopi.db`. */
	dbPath?: string;
	/** Base name for the shared bank; per-project banks derive from it. */
	bank?: string;
	scoping?: MnemopiScoping;
	/** cwd used only for resolving the shared bank name. */
	cwd?: string;
}

export interface PiMemoryMigrationItem {
	entry: PiMemoryEntry;
	memoryType: string;
	importance: number;
	veracity: string;
}

export interface PiMemoryMigrationBankPlan {
	bank: string;
	dbPath: string;
	global: boolean;
	items: PiMemoryMigrationItem[];
}

export interface PiMemoryMigrationPlan {
	globalBank: string;
	globalDbPath: string;
	banks: PiMemoryMigrationBankPlan[];
	warnings: string[];
}

export interface PiMemoryMigrationProgress {
	bank: string;
	done: number;
	total: number;
	entryId: string;
}

export interface PiMemoryMigrationBankResult {
	bank: string;
	dbPath: string;
	written: number;
	attempted: number;
	totalInBank: number;
	backup?: string;
	error?: string;
}

export interface PiMemoryMigrationApplyResult {
	dryRun: boolean;
	written: number;
	failed: Array<{ id: string; error: string }>;
	banks: PiMemoryMigrationBankResult[];
	warnings: string[];
}

const GLOBAL_INDEX = "global.index.json";
const PROJECTS_DIR = "projects";
const INDEX_SUFFIX = ".index.json";

/** Boundary schema for one pi-memory sidecar entry; unknown keys are preserved by the parser. */
const piMemoryEntrySchema = type({
	id: "string",
	content: "string",
	type: "'preference' | 'knowledge' | 'project'",
	"tags?": "string[]",
	createdAt: "number",
	"source?": "'manual' | 'auto'",
	"projectPath?": "string",
	"hitCount?": "number",
	"lastUsedAt?": "number",
	"status?": "'unverified' | 'correct' | 'wrong'",
	"errorAnalysis?": "string",
});
type PiMemorySchemaEntry = typeof piMemoryEntrySchema.infer;

const piMemoryIndexSchema = type({ "version?": "number", "dims?": "number", entries: "unknown[]" });

function expandHome(value: string): string {
	if (value === "~") return homedir();
	if (value.startsWith("~/")) return path.join(homedir(), value.slice(2));
	return value;
}

function warningText(file: string, index: number, message: string): string {
	return `${file} entry ${index + 1}: ${message}`;
}

function normalizeEntry(raw: unknown, file: string, index: number, warnings: string[]): PiMemoryEntry | null {
	let value: PiMemorySchemaEntry;
	try {
		value = piMemoryEntrySchema.assert(raw);
	} catch (error) {
		warnings.push(
			warningText(file, index, `invalid shape (${error instanceof Error ? error.message : String(error)})`),
		);
		return null;
	}
	const id = value.id.trim();
	if (!id) {
		warnings.push(warningText(file, index, "missing id"));
		return null;
	}
	const content = value.content.trim();
	if (!content) {
		warnings.push(warningText(file, index, "empty content"));
		return null;
	}
	if (!Number.isFinite(value.createdAt) || value.createdAt <= 0) {
		warnings.push(warningText(file, index, "invalid createdAt"));
		return null;
	}
	const projectPath =
		typeof value.projectPath === "string" && value.projectPath.trim().length > 0
			? path.resolve(expandHome(value.projectPath.trim()))
			: undefined;
	if (value.type === "project" && !projectPath) {
		warnings.push(warningText(file, index, "project entry has no projectPath"));
		return null;
	}
	const tags = (value.tags ?? []).map(tag => tag.trim()).filter(tag => tag.length > 0);
	const hitCount = Number.isFinite(value.hitCount) ? (value.hitCount ?? 0) : 0;
	const lastUsedAt = Number.isFinite(value.lastUsedAt) ? (value.lastUsedAt ?? 0) : 0;
	const errorAnalysis = value.errorAnalysis?.trim() || undefined;
	return {
		id,
		content,
		type: value.type,
		tags,
		createdAt: value.createdAt,
		source: value.source ?? "auto",
		projectPath,
		hitCount,
		lastUsedAt,
		status: value.status ?? "unverified",
		errorAnalysis,
	};
}

async function readIndexFile(file: string, warnings: string[]): Promise<PiMemoryEntry[]> {
	let parsed: unknown;
	try {
		parsed = await Bun.file(file).json();
	} catch (error) {
		if (isEnoent(error)) return [];
		warnings.push(`${file}: cannot read/parse JSON (${error instanceof Error ? error.message : String(error)})`);
		return [];
	}
	let entries: unknown[];
	try {
		entries = piMemoryIndexSchema.assert(parsed).entries;
	} catch (error) {
		warnings.push(`${file}: invalid index shape (${error instanceof Error ? error.message : String(error)})`);
		return [];
	}
	const out: PiMemoryEntry[] = [];
	for (const [index, raw] of entries.entries()) {
		const entry = normalizeEntry(raw, file, index, warnings);
		if (entry) out.push(entry);
	}
	return out;
}

/** Read every pi-memory sidecar under `root` (global + projects). */
export async function readPiMemoryEntries(root: string): Promise<PiMemoryReadResult> {
	const resolvedRoot = path.resolve(expandHome(root));
	const warnings: string[] = [];
	const files: string[] = [];
	const globalFile = path.join(resolvedRoot, GLOBAL_INDEX);
	files.push(globalFile);
	let entries = await readIndexFile(globalFile, warnings);

	const projectsDir = path.join(resolvedRoot, PROJECTS_DIR);
	let projectFiles: string[] = [];
	try {
		projectFiles = (await fs.readdir(projectsDir))
			.filter(name => name.endsWith(INDEX_SUFFIX))
			.sort()
			.map(name => path.join(projectsDir, name));
	} catch (error) {
		if (!isEnoent(error)) {
			warnings.push(
				`${projectsDir}: cannot read directory (${error instanceof Error ? error.message : String(error)})`,
			);
		}
	}
	for (const file of projectFiles) {
		files.push(file);
		entries = entries.concat(await readIndexFile(file, warnings));
	}

	const seen = new Set<string>();
	const unique: PiMemoryEntry[] = [];
	for (const entry of entries) {
		if (seen.has(entry.id)) {
			warnings.push(`duplicate pi-memory id ${entry.id}; keeping the first occurrence`);
			continue;
		}
		seen.add(entry.id);
		unique.push(entry);
	}
	if (files.length === 1 && unique.length === 0) {
		warnings.push(`no pi-memory entries found under ${resolvedRoot}`);
	}
	return { entries: unique, files, warnings };
}

function globalDbPathFor(options: PiMemoryMigrationOptions): string {
	return options.dbPath?.trim()
		? path.resolve(expandHome(options.dbPath.trim()))
		: path.join(getMemoriesDir(options.agentDir), "mnemopi", "mnemopi.db");
}

function projectDbPath(globalDbPath: string, bank: string): string {
	return path.join(path.dirname(globalDbPath), "banks", bank, "mnemopi.db");
}

function migrationItem(entry: PiMemoryEntry): PiMemoryMigrationItem {
	return {
		entry,
		memoryType: entry.type === "preference" ? "preference" : "fact",
		importance: entry.type === "preference" ? 0.9 : entry.type === "knowledge" ? 0.8 : 0.75,
		veracity: entry.status === "wrong" ? "false" : entry.source === "manual" ? "stated" : "inferred",
	};
}

/** Map entries onto Mnemopi shared/per-project banks without touching disk. */
export function planPiMemoryMigration(
	entries: readonly PiMemoryEntry[],
	options: PiMemoryMigrationOptions,
): PiMemoryMigrationPlan {
	const scoping = options.scoping ?? "per-project-tagged";
	const globalDbPath = globalDbPathFor(options);
	const sharedScope = computeMnemopiBankScope(options.bank, options.cwd ?? process.cwd(), scoping);
	const globalBank = sharedScope.globalBank;
	const warnings: string[] = [];
	const banks = new Map<string, PiMemoryMigrationBankPlan>();
	const getBank = (bank: string, dbPath: string, global: boolean) => {
		let plan = banks.get(bank);
		if (!plan) {
			plan = { bank, dbPath, global, items: [] };
			banks.set(bank, plan);
		}
		return plan;
	};
	let globalEntries = 0;
	for (const entry of entries) {
		const item = migrationItem(entry);
		if (entry.type === "project" && scoping !== "global") {
			const projectScope = computeMnemopiBankScope(
				options.bank,
				entry.projectPath ?? options.cwd ?? process.cwd(),
				"per-project",
			);
			const bank = projectScope.bank;
			const dbPath = bank === globalBank ? globalDbPath : projectDbPath(globalDbPath, bank);
			getBank(bank, dbPath, false).items.push(item);
			continue;
		}
		globalEntries++;
		getBank(globalBank, globalDbPath, true).items.push(item);
	}
	if (scoping === "per-project" && globalEntries > 0) {
		warnings.push(
			`${globalEntries} preference/knowledge entries were written to the shared bank, but per-project scoping never recalls that bank; use per-project-tagged or global`,
		);
	}
	const ordered = [...banks.values()].sort((left, right) => {
		if (left.global !== right.global) return left.global ? -1 : 1;
		return left.bank.localeCompare(right.bank);
	});
	return { globalBank, globalDbPath, banks: ordered, warnings };
}

async function backupDatabase(dbPath: string, timestamp: string): Promise<string | undefined> {
	try {
		await fs.access(dbPath);
	} catch (error) {
		if (isEnoent(error)) return undefined;
		throw error;
	}
	let backup = `${dbPath}.bak-${timestamp}`;
	for (let suffix = 1; ; suffix++) {
		try {
			await fs.access(backup);
			backup = `${dbPath}.bak-${timestamp}-${suffix}`;
		} catch (error) {
			if (isEnoent(error)) break;
			throw error;
		}
	}
	await fs.mkdir(path.dirname(dbPath), { recursive: true });
	await fs.copyFile(dbPath, backup, fsConstants.COPYFILE_EXCL);
	for (const suffix of ["-wal", "-shm"]) {
		try {
			await fs.copyFile(`${dbPath}${suffix}`, `${backup}${suffix}`, fsConstants.COPYFILE_EXCL);
		} catch (error) {
			if (!isEnoent(error)) throw error;
		}
	}
	return backup;
}

export interface PiMemoryMigrationApplyOptions {
	dryRun?: boolean;
	backup?: boolean;
	noEmbeddings?: boolean;
	embeddingModel?: string;
	/** Stop after this many entries across all banks; useful for a trial run. */
	limit?: number;
	onProgress?: (progress: PiMemoryMigrationProgress) => void;
}

function rememberOptions(item: PiMemoryMigrationItem) {
	const entry = item.entry;
	return {
		source: `pi-memory:${entry.source}`,
		importance: item.importance,
		scope: "bank",
		trustTier: "IMPORTED",
		veracity: item.veracity,
		memoryType: item.memoryType,
		timestamp: new Date(entry.createdAt).toISOString(),
		extract: false,
		extractEntities: false,
		metadata: {
			pi_memory_id: entry.id,
			pi_memory_type: entry.type,
			pi_memory_tags: entry.tags,
			pi_memory_source: entry.source,
			pi_memory_status: entry.status,
			pi_memory_hit_count: entry.hitCount,
			pi_memory_last_used_at: entry.lastUsedAt,
			pi_memory_project_path: entry.projectPath ?? null,
			pi_memory_error_analysis: entry.errorAnalysis ?? null,
		},
	};
}

/** Write a plan into Mnemopi. Safe to rerun: exact-content dedupe updates in place. */
export async function applyPiMemoryMigration(
	plan: PiMemoryMigrationPlan,
	options: PiMemoryMigrationApplyOptions = {},
): Promise<PiMemoryMigrationApplyResult> {
	const dryRun = options.dryRun !== false;
	const warnings = [...plan.warnings];
	const result: PiMemoryMigrationApplyResult = { dryRun, written: 0, failed: [], banks: [], warnings };
	if (dryRun) {
		for (const bank of plan.banks) {
			result.banks.push({
				bank: bank.bank,
				dbPath: bank.dbPath,
				written: 0,
				attempted: bank.items.length,
				totalInBank: 0,
			});
		}
		return result;
	}

	const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
	let remaining = options.limit === undefined ? Number.POSITIVE_INFINITY : Math.max(0, Math.trunc(options.limit));
	for (const bank of plan.banks) {
		if (remaining <= 0) break;
		const bankResult: PiMemoryMigrationBankResult = {
			bank: bank.bank,
			dbPath: bank.dbPath,
			written: 0,
			attempted: 0,
			totalInBank: 0,
		};
		result.banks.push(bankResult);
		try {
			if (options.backup !== false) {
				bankResult.backup = await backupDatabase(bank.dbPath, timestamp);
			}
			const memory = new Mnemopi({
				dbPath: bank.dbPath,
				bank: bank.bank,
				sessionId: bank.bank,
				noEmbeddings: options.noEmbeddings,
				embeddingModel: options.embeddingModel,
			});
			try {
				for (const item of bank.items) {
					if (remaining <= 0) break;
					bankResult.attempted++;
					try {
						memory.remember(item.entry.content, rememberOptions(item));
						bankResult.written++;
						result.written++;
					} catch (error) {
						result.failed.push({
							id: item.entry.id,
							error: error instanceof Error ? error.message : String(error),
						});
					}
					options.onProgress?.({
						bank: bank.bank,
						done: bankResult.attempted,
						total: bank.items.length,
						entryId: item.entry.id,
					});
					remaining--;
				}
				await memory.flushExtractions();
				bankResult.totalInBank = memory.getStats().total_memories;
			} finally {
				memory.close();
			}
		} catch (error) {
			bankResult.error = error instanceof Error ? error.message : String(error);
		}
	}
	return result;
}
