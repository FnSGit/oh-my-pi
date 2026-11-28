/**
 * 域级 `.agents/` 的端到端契约：仓库嵌在 home 之下时，agents provider 的每一条面
 * 都把域目录层的真实内容加载进来，而不只是让走链经过那里。
 *
 * 与 `agents-domain-surfaces.test.ts` 的分工：那个钉走链 building block
 * （getProjectPathCandidates 的返回值），这个钉完整 loadCapability 管线的结果
 * （去重键、depth、level、project 优先语义），确认域层条目真的进入 items。
 *
 * home 必须 mock：loadCapability 用 os.homedir() 作 home 边界，而域走链只在
 * repoRoot 位于 home 之下时启用（照 autolearn-discovery.test.ts 的模式）。
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { clearCache } from "@oh-my-pi/pi-coding-agent/capability/fs";
import { type ContextFile, contextFileCapability } from "@oh-my-pi/pi-coding-agent/capability/context-file";
import { promptCapability } from "@oh-my-pi/pi-coding-agent/capability/prompt";
import { type Rule, ruleCapability } from "@oh-my-pi/pi-coding-agent/capability/rule";
import { slashCommandCapability } from "@oh-my-pi/pi-coding-agent/capability/slash-command";
import { type SystemPrompt, systemPromptCapability } from "@oh-my-pi/pi-coding-agent/capability/system-prompt";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import "@oh-my-pi/pi-coding-agent/discovery";
import { initializeWithSettings, loadCapability } from "@oh-my-pi/pi-coding-agent/discovery";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import { getAgentDir, setAgentDir } from "@oh-my-pi/pi-utils/dirs";

describe("agents provider domain-level content (every surface)", () => {
	let tempDir!: string;
	let home!: string;
	let domain!: string;
	let repoRoot!: string;
	let projectCwd!: string;
	let originalAgentDir!: string;

	beforeEach(async () => {
		clearCache();
		resetSettingsForTest();
		originalAgentDir = getAgentDir();
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-domain-content-"));
		home = path.join(tempDir, "home");
		domain = path.join(home, "acme");
		repoRoot = path.join(domain, "oh-my-pi");
		projectCwd = path.join(repoRoot, "packages", "coding-agent");
		await fs.mkdir(projectCwd, { recursive: true });
		await fs.mkdir(path.join(repoRoot, ".git"), { recursive: true });
		setAgentDir(path.join(home, ".omp", "agent"));
		spyOn(os, "homedir").mockReturnValue(home);
		initializeWithSettings(Settings.isolated({}));
	});

	afterEach(async () => {
		resetSettingsForTest();
		spyOn(os, "homedir").mockRestore();
		setAgentDir(originalAgentDir);
		await removeWithRetries(tempDir);
	});

	test("rules load from the domain directory", async () => {
		const domainRules = path.join(domain, ".agents", "rules");
		await fs.mkdir(domainRules, { recursive: true });
		await fs.writeFile(
			path.join(domainRules, "domain-rule.md"),
			[
				"---",
				"description: Domain rule",
				"alwaysApply: true",
				"---",
				"",
				"# Domain rule",
				"",
				"Always use domain tooling.",
			].join("\n"),
		);

		const result = await loadCapability<Rule>(ruleCapability.id, { cwd: projectCwd });
		const rule = result.items.find(item => path.basename(item.path) === "domain-rule.md");
		expect(rule).toBeDefined();
		expect(rule?.content).toContain("Always use domain tooling.");
		expect(rule?._source.level).toBe("project");
	});

	test("prompts load from the domain directory", async () => {
		const domainPrompts = path.join(domain, ".agents", "prompts");
		await fs.mkdir(domainPrompts, { recursive: true });
		await fs.writeFile(path.join(domainPrompts, "domain-prompt.md"), "Review $1 against the domain checklist.");

		const result = await loadCapability<{ name: string; path: string; content: string }>(promptCapability.id, {
			cwd: projectCwd,
		});
		const prompt = result.items.find(item => item.name === "domain-prompt");
		expect(prompt?.content).toContain("domain checklist");
	});

	test("commands load from the domain directory", async () => {
		const domainCommands = path.join(domain, ".agents", "commands");
		await fs.mkdir(domainCommands, { recursive: true });
		await fs.writeFile(path.join(domainCommands, "domain-command.md"), "Run the domain workflow for $1.");

		const result = await loadCapability<{ name: string; path: string; content: string }>(slashCommandCapability.id, {
			cwd: projectCwd,
		});
		const command = result.items.find(item => item.name === "domain-command");
		expect(command?.content).toContain("domain workflow");
	});

	test("AGENTS.md loads from the domain directory and coexists with the repo copy", async () => {
		const domainAgents = path.join(domain, ".agents");
		await fs.mkdir(domainAgents, { recursive: true });
		await fs.writeFile(
			path.join(domainAgents, "AGENTS.md"),
			"# Domain instructions\n\nUse the domain toolchain.",
		);
		const repoAgents = path.join(repoRoot, ".agents");
		await fs.mkdir(repoAgents, { recursive: true });
		await fs.writeFile(path.join(repoAgents, "AGENTS.md"), "# Repo instructions\n\nUse the repo toolchain.");

		const result = await loadCapability<ContextFile>(contextFileCapability.id, { cwd: projectCwd });
		const domainFile = result.items.find(item => item.path === path.join(domainAgents, "AGENTS.md"));
		const repoFile = result.items.find(item => item.path === path.join(repoAgents, "AGENTS.md"));
		// 两者都在：contextFileCapability 以 project:<depth> 去重，域层占更深一级。
		expect(domainFile).toBeDefined();
		expect(repoFile).toBeDefined();
		expect(domainFile?.content).toContain("domain toolchain");
		expect(repoFile?.content).toContain("repo toolchain");
		// depth 排序让更近的仓库文件更显著（system-prompt.ts 按 depth 降序）。
		expect(domainFile!.depth!).toBeGreaterThan(repoFile!.depth!);
	});

	test("SYSTEM.md from the domain directory applies only when the repo has none", async () => {
		const domainAgents = path.join(domain, ".agents");
		await fs.mkdir(domainAgents, { recursive: true });
		await fs.writeFile(path.join(domainAgents, "SYSTEM.md"), "Domain system prompt.");

		const domainOnly = await loadCapability<SystemPrompt>(systemPromptCapability.id, { cwd: projectCwd });
		const winner = domainOnly.items.find(item => item.level === "project");
		expect(winner?.content).toBe("Domain system prompt.");

		// 仓库内出现 SYSTEM.md 后，它赢（project 级 find 取首个，近者在前）。
		const repoAgents = path.join(repoRoot, ".agents");
		await fs.mkdir(repoAgents, { recursive: true });
		await fs.writeFile(path.join(repoAgents, "SYSTEM.md"), "Repo system prompt.");
		clearCache();
		const withRepo = await loadCapability<SystemPrompt>(systemPromptCapability.id, { cwd: projectCwd });
		const repoWinner = withRepo.items.find(item => item.level === "project");
		expect(repoWinner?.content).toBe("Repo system prompt.");
	});
});
