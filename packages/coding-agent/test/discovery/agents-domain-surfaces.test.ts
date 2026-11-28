/**
 * 域级 `.agents/` 加载契约：仓库嵌在 home 之下时，agents provider 的每一条面
 * （skills / rules / prompts / commands / AGENTS.md / SYSTEM.md）都越过 git
 * 仓库根走到 home（不含 home），让域目录层的配置对域内任意 cwd 生效。
 *
 * 与 `agents-monorepo-skills.test.ts` 的分工：那个钉 skills 走链的 building
 * block，这个钉「全部面共用同一条走链」这一不变量——若某条面被单独改回
 * repoRoot 边界，这里立刻失败。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { clearCache } from "@oh-my-pi/pi-coding-agent/capability/fs";
import type { LoadContext } from "@oh-my-pi/pi-coding-agent/capability/types";
import { getProjectPathCandidates } from "@oh-my-pi/pi-coding-agent/discovery/agents";
import { scanSkillsFromDir } from "@oh-my-pi/pi-coding-agent/discovery/helpers";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";

const PROVIDER_ID = "agents";

/** 每一条面在域层放一个条目，名字带 `domain-` 前缀便于断言。 */
const SURFACES = [
	{ segment: "skills", entry: "domain-skill", file: "SKILL.md" },
	{ segment: "rules", entry: "domain-rule", file: "domain-rule.md" },
	{ segment: "prompts", entry: "domain-prompt", file: "domain-prompt.md" },
	{ segment: "commands", entry: "domain-command", file: "domain-command.md" },
] as const;

function writeSurface(root: string, segment: string, entry: string, fileName: string): void {
	const dir = path.join(root, ".agents", segment);
	fs.mkdirSync(path.join(dir, entry), { recursive: true });
	fs.writeFileSync(
		path.join(dir, entry, fileName),
		["---", `name: ${entry}`, `description: Domain-level ${segment} entry`, "---", "", `# ${entry}`].join("\n"),
	);
}

describe("agents provider domain-level walk (every surface)", () => {
	let tempDir!: string;
	let home!: string;
	let domain!: string;
	let repoRoot!: string;
	let domainCwd!: string;
	let domainCtx!: LoadContext;

	beforeEach(() => {
		clearCache();
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agents-domain-"));
		home = path.join(tempDir, "home");
		domain = path.join(home, "acme");
		repoRoot = path.join(domain, "api");
		domainCwd = path.join(repoRoot, "src");
		fs.mkdirSync(domainCwd, { recursive: true });
		fs.mkdirSync(path.join(repoRoot, ".git"), { recursive: true });
		domainCtx = { cwd: domainCwd, home, repoRoot };
	});

	afterEach(() => {
		clearCache();
		removeSyncWithRetries(tempDir);
	});

	test("every surface's walk reaches the domain directory", () => {
		for (const { segment } of SURFACES) {
			const candidates = getProjectPathCandidates(domainCtx, segment);
			expect(candidates).toContain(path.join(domain, ".agents", segment));
			expect(candidates).toContain(path.join(repoRoot, ".agents", segment));
			// home 自身永远不是 project scope（#1116）。
			expect(candidates).not.toContain(path.join(home, ".agents", segment));
		}
	});

	test("skills scan finds the domain skill through the shared walk", async () => {
		const { segment, entry, file } = SURFACES[0];
		writeSurface(domain, segment, entry, file);
		writeSurface(repoRoot, segment, "repo-skill", "SKILL.md");

		const results = await Promise.all(
			getProjectPathCandidates(domainCtx, segment).map(dir =>
				scanSkillsFromDir(domainCtx, { dir, providerId: PROVIDER_ID, level: "project" }),
			),
		);
		const names = results.flatMap(r => r.items).map(s => s.name);
		expect(names).toContain("domain-skill");
		expect(names).toContain("repo-skill");
		// 近者在前：loadSkills 的 first-wins 让 repo-skill 拿裸名。
		expect(names.indexOf("repo-skill")).toBeLessThan(names.indexOf("domain-skill"));
	});

	test("rules walk reaches the domain directory", () => {
		const candidates = getProjectPathCandidates(domainCtx, "rules");
		expect(candidates.indexOf(path.join(domain, ".agents", "rules"))).toBeGreaterThan(
			candidates.indexOf(path.join(repoRoot, ".agents", "rules")),
		);
	});

	test("AGENTS.md walk reaches the domain directory", () => {
		const candidates = getProjectPathCandidates(domainCtx, "AGENTS.md");
		expect(candidates).toContain(path.join(domain, ".agents", "AGENTS.md"));
		expect(candidates).toContain(path.join(repoRoot, ".agents", "AGENTS.md"));
		expect(candidates).not.toContain(path.join(home, ".agents", "AGENTS.md"));
	});

	test("SYSTEM.md and SYSTEM_TEMPLATE.md walks reach the domain directory", () => {
		for (const name of ["SYSTEM.md", "SYSTEM_TEMPLATE.md"]) {
			const candidates = getProjectPathCandidates(domainCtx, name);
			expect(candidates).toContain(path.join(domain, ".agents", name));
			expect(candidates).not.toContain(path.join(home, ".agents", name));
		}
	});

	test("walk stays at repo root when the repo is outside home", () => {
		const outsideHome = path.join(tempDir, "elsewhere");
		fs.mkdirSync(outsideHome, { recursive: true });
		const outsideCtx: LoadContext = { cwd: domainCwd, home: outsideHome, repoRoot };
		const candidates = getProjectPathCandidates(outsideCtx, "skills");
		expect(candidates).not.toContain(path.join(domain, ".agents", "skills"));
		expect(candidates).toContain(path.join(repoRoot, ".agents", "skills"));
	});

	test("a repo rooted at home stays out of project scope", () => {
		// repoRoot === home：不越过 home，~/.agents/* 仍只是 user scope。
		fs.mkdirSync(path.join(home, ".git"), { recursive: true });
		const homeRepoCtx: LoadContext = { cwd: home, home, repoRoot: home };
		const candidates = getProjectPathCandidates(homeRepoCtx, "skills");
		expect(candidates).toHaveLength(0);
	});
});
