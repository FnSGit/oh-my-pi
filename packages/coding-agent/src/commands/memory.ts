/**
 * Inspect memory usage: recall counts, cold entries, and the recall audit trail.
 */

import { APP_NAME } from "@oh-my-pi/pi-utils";
import { Args, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { memoryHelp as commandHelp } from "../cli/command-help";
import { runMemoryStats } from "../cli/memory-cli";

export default class Memory extends Command {
	static description = commandHelp.description;
	static args = {
		action: Args.string({
			description: "stats (default)",
			required: false,
		}),
	};

	static flags = {
		json: Flags.boolean({ description: "Output JSON" }),
		limit: Flags.integer({ description: "Rows per report section", default: 10 }),
		days: Flags.integer({ description: "Age window for cold-memory reporting", default: 30 }),
		"agent-dir": Flags.string({ description: "Agent directory to inspect" }),
	};

	static examples = [
		`# Recall counts, cold entries, and recent recall events\n  ${APP_NAME} memory`,
		`# Show more rows per section\n  ${APP_NAME} memory stats --limit 30`,
		`# Machine-readable output\n  ${APP_NAME} memory --json`,
	];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Memory);
		const action = args.action ?? "stats";
		if (action !== "stats") {
			throw new Error(`Unknown memory action: ${action} (expected "stats")`);
		}
		await runMemoryStats({
			agentDir: flags["agent-dir"],
			json: flags.json,
			limit: Math.max(1, flags.limit),
			days: Math.max(0, flags.days),
		});
	}
}
