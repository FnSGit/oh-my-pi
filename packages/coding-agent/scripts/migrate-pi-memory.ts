#!/usr/bin/env bun
/**
 * Migrate the external pi-memory extension into omp's native Mnemopi backend.
 *
 *   bun packages/coding-agent/scripts/migrate-pi-memory.ts            # dry run
 *   bun packages/coding-agent/scripts/migrate-pi-memory.ts --apply    # write
 *
 * The script reads only the JSON sidecars; vectors are re-embedded by Mnemopi.
 * Stop omp before `--apply` so the shared databases are not being written.
 */
import { getAgentDir } from "@oh-my-pi/pi-utils";
import type { MnemopiScoping } from "../src/mnemopi/config";
import {
	applyPiMemoryMigration,
	planPiMemoryMigration,
	type PiMemoryMigrationApplyResult,
	type PiMemoryMigrationPlan,
	readPiMemoryEntries,
} from "../src/mnemopi/migrate-pi-memory";

interface CliArgs {
	apply: boolean;
	root: string;
	agentDir: string;
	dbPath?: string;
	bank?: string;
	scoping: MnemopiScoping;
	noEmbeddings: boolean;
	embeddingModel?: string;
	limit?: number;
	backup: boolean;
	json: boolean;
}

const SCOPING_VALUES: readonly MnemopiScoping[] = ["global", "per-project", "per-project-tagged"];

function usage(message?: string): never {
	if (message) process.stderr.write(`error: ${message}\n\n`);
	process.stderr.write(
		[
			"Usage: bun packages/coding-agent/scripts/migrate-pi-memory.ts [options]",
			"",
			"  --apply                    Write to Mnemopi; default is a dry run",
			"  --root <dir>               pi-memory root (default ~/.pi/agent/pi-memory)",
			"  --agent-dir <dir>          omp agent dir (default getAgentDir())",
			"  --db <path>                shared-bank SQLite path (default <agent-dir>/memories/mnemopi/mnemopi.db)",
			"  --bank <name>              shared-bank base name",
			"  --scoping <mode>           global | per-project | per-project-tagged (default per-project-tagged)",
			"  --no-embeddings            Import with FTS only; re-embed later by reopening Mnemopi",
			"  --embedding-model <id>     Override the embedding model for this import",
			"  --limit <n>                Write at most n entries (trial run)",
			"  --no-backup                Do not copy existing databases before writing",
			"  --json                     Print a machine-readable summary",
			"  --help                     Show this help",
		].join("\n") + "\n",
	);
	process.exit(message ? 2 : 0);
}

function parseArgs(argv: readonly string[]): CliArgs {
	const args: CliArgs = {
		apply: false,
		root: "~/.pi/agent/pi-memory",
		agentDir: getAgentDir(),
		scoping: "per-project-tagged",
		noEmbeddings: false,
		backup: true,
		json: false,
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		const next = (name: string): string => {
			const value = argv[++i];
			if (value === undefined) usage(`${name} requires a value`);
			return value;
		};
		switch (arg) {
			case "--apply":
				args.apply = true;
				break;
			case "--dry-run":
				args.apply = false;
				break;
			case "--root":
				args.root = next(arg);
				break;
			case "--agent-dir":
				args.agentDir = next(arg);
				break;
			case "--db":
				args.dbPath = next(arg);
				break;
			case "--bank":
				args.bank = next(arg);
				break;
			case "--scoping": {
				const value = next(arg);
				if (!SCOPING_VALUES.includes(value as MnemopiScoping)) usage(`unknown scoping mode: ${value}`);
				args.scoping = value as MnemopiScoping;
				break;
			}
			case "--no-embeddings":
				args.noEmbeddings = true;
				break;
			case "--embedding-model":
				args.embeddingModel = next(arg);
				break;
			case "--limit": {
				const value = Number(next(arg));
				if (!Number.isInteger(value) || value <= 0) usage(`--limit must be a positive integer`);
				args.limit = value;
				break;
			}
			case "--no-backup":
				args.backup = false;
				break;
			case "--json":
				args.json = true;
				break;
			case "--help":
			case "-h":
				usage();
				break;
			default:
				usage(`unknown option: ${arg}`);
		}
	}
	return args;
}

function summarizePlan(plan: PiMemoryMigrationPlan) {
	return {
		globalBank: plan.globalBank,
		globalDbPath: plan.globalDbPath,
		banks: plan.banks.map(bank => ({
			bank: bank.bank,
			global: bank.global,
			dbPath: bank.dbPath,
			entries: bank.items.length,
		})),
		warnings: plan.warnings,
	};
}

function printPlan(plan: PiMemoryMigrationPlan): void {
	process.stdout.write(`shared bank: ${plan.globalBank}\nshared db:   ${plan.globalDbPath}\n`);
	for (const bank of plan.banks) {
		const kind = bank.global ? "global" : "project";
		process.stdout.write(`- ${kind.padEnd(7)} ${bank.bank}: ${bank.items.length} entries -> ${bank.dbPath}\n`);
	}
	if (plan.warnings.length > 0) {
		process.stdout.write(`\nwarnings:\n${plan.warnings.map(warning => `- ${warning}`).join("\n")}\n`);
	}
}

function printResult(result: PiMemoryMigrationApplyResult): void {
	process.stdout.write(`\n${result.dryRun ? "dry run" : "migration"} result:\n`);
	for (const bank of result.banks) {
		const details = [
			`${bank.written}/${bank.attempted} written`,
			`${bank.totalInBank} in bank`,
			bank.backup ? `backup ${bank.backup}` : undefined,
			bank.error ? `error: ${bank.error}` : undefined,
		]
			.filter(Boolean)
			.join(", ");
		process.stdout.write(`- ${bank.bank}: ${details}\n`);
	}
	process.stdout.write(`total written: ${result.written}\n`);
	if (result.failed.length > 0) {
		process.stdout.write(`failed entries:\n${result.failed.map(f => `- ${f.id}: ${f.error}`).join("\n")}\n`);
	}
	if (result.warnings.length > 0) {
		process.stdout.write(`warnings:\n${result.warnings.map(warning => `- ${warning}`).join("\n")}\n`);
	}
}

const args = parseArgs(process.argv.slice(2));
const read = await readPiMemoryEntries(args.root);
const plan = planPiMemoryMigration(read.entries, {
	agentDir: args.agentDir,
	dbPath: args.dbPath,
	bank: args.bank,
	scoping: args.scoping,
});
const result = await applyPiMemoryMigration(plan, {
	dryRun: !args.apply,
	backup: args.backup,
	noEmbeddings: args.noEmbeddings,
	embeddingModel: args.embeddingModel,
	limit: args.limit,
	onProgress: progress => {
		if (args.json || progress.done % 25 !== 0) return;
		process.stderr.write(`\r${progress.bank}: ${progress.done}/${progress.total}...`);
	},
});

if (args.json) {
	process.stdout.write(
		`${JSON.stringify(
			{
				mode: args.apply ? "apply" : "dry-run",
				root: args.root,
				files: read.files,
				read: { entries: read.entries.length, warnings: read.warnings },
				plan: summarizePlan(plan),
				result,
			},
			null,
			2,
		)}\n`,
	);
} else {
	process.stdout.write(
		`pi-memory root: ${args.root}\nfiles: ${read.files.length}, entries: ${read.entries.length}\n\n`,
	);
	printPlan(plan);
	printResult(result);
}

if (result.failed.length > 0 || result.banks.some(bank => bank.error)) process.exit(1);
