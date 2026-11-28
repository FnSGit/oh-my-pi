/**
 * 域级 `.agents/skills` 的端到端契约：仓库嵌在 home 之下时，skills 走链越过
 * git 仓库根到 home（不含 home），域目录层的 skill 对域内任意 cwd 生效。
 *
 * 与 `agents-monorepo-skills.test.ts` 的分工：那个测走链 building block
 * （getSkillPathCandidates / scanSkillsFromDir），这个测完整 loadSkills 管线
 * （source 标注、同名冲突命名空间、home 不注册为 project scope）。
 */
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { clearCache } from "@oh-my-pi/pi-coding-agent/capability/fs";
import "@oh-my-pi/pi-coding-agent/discovery";
import { loadSkills } from "@oh-my-pi/pi-coding-agent/extensibility/skills";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import { getAgentDir, setAgentDir } from "@oh-my-pi/pi-utils/dirs";

async function writeSkill(dir: string, name: string, description: string): Promise<void> {
	const file = path.join(dir, name, "SKILL.md");
	await fs.mkdir(path.dirname(file), { recursive: true });
	await fs.writeFile(
		file,
		["---", `name: ${name}`, `description: ${description}`, "---", "", `# ${name}`].join("\n"),
	);
}

describe("domain skills (repo nested under home)", () => {
	let tempDir!: string;
	let home!: string;
	let domain!: string;
	let repoRoot!: string;
	let projectCwd!: string;
	let originalAgentDir!: string;

	beforeEach(async () => {
		clearCache();
		originalAgentDir = getAgentDir();
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-domain-skills-"));
		// home → 域目录（自身不是 git 仓库）→ 仓库 → 深层 cwd。
		home = path.join(tempDir, "home");
		domain = path.join(home, "acme");
		repoRoot = path.join(domain, "oh-my-pi");
		projectCwd = path.join(repoRoot, "packages", "coding-agent");
		await fs.mkdir(projectCwd, { recursive: true });
		await fs.mkdir(path.join(repoRoot, ".git"), { recursive: true });
		spyOn(os, "homedir").mockReturnValue(home);
		setAgentDir(path.join(home, ".omp", "agent"));
	});

	afterEach(async () => {
		spyOn(os, "homedir").mockRestore();
		setAgentDir(originalAgentDir);
		await removeWithRetries(tempDir);
	});

	it("loads a domain skill for a cwd nested under it", async () => {
		await writeSkill(path.join(domain, ".agents", "skills"), "domain-tool", "Shared across the domain.");
		const { skills } = await loadSkills({ cwd: projectCwd });
		const domainSkill = skills.find(s => s.name === "domain-tool");
		expect(domainSkill).toBeDefined();
		expect(domainSkill?.filePath).toBe(path.join(domain, ".agents", "skills", "domain-tool", "SKILL.md"));
		expect(domainSkill?.source).toBe("agents:project");
	});

	it("keeps the repo skill's bare name and namespaces the domain one on collision", async () => {
		await writeSkill(path.join(domain, ".agents", "skills"), "shared", "Domain copy.");
		await writeSkill(path.join(repoRoot, ".agents", "skills"), "shared", "Repo copy.");
		const { skills } = await loadSkills({ cwd: projectCwd });
		const shared = skills.filter(s => s.name === "shared" || s.name.endsWith("/shared"));
		expect(shared).toHaveLength(2);
		const bare = skills.find(s => s.name === "shared");
		expect(bare?.filePath).toBe(path.join(repoRoot, ".agents", "skills", "shared", "SKILL.md"));
		const namespaced = skills.find(s => s.name !== "shared" && s.name.endsWith("/shared"));
		expect(namespaced?.filePath).toBe(path.join(domain, ".agents", "skills", "shared", "SKILL.md"));
		// 命名空间推导自 skillNamespace（extensibility/skills.ts）：`.agents` 是
		// dotted home，不是有意义的名字，故回落到 provider id。
		expect(namespaced?.name).toBe("agents/shared");
	});

	it("never registers the home dir's own skills as project scope", async () => {
		await writeSkill(path.join(home, ".agents", "skills"), "home-only", "At home.");
		const { skills } = await loadSkills({ cwd: projectCwd });
		const copies = skills.filter(s => s.name === "home-only");
		expect(copies).toHaveLength(1);
		expect(copies[0]?.source).toBe("agents:user");
	});

	it("keeps the walk at repo root when the repo is outside home", async () => {
		// 仓库不在 home 之下：域层不生效，与改动前一致。
		const outsideHome = await fs.mkdtemp(path.join(os.tmpdir(), "omp-domain-skills-outside-"));
		try {
			const outsideRepo = path.join(outsideHome, "srv-app");
			const outsideCwd = path.join(outsideRepo, "sub");
			await fs.mkdir(outsideCwd, { recursive: true });
			await fs.mkdir(path.join(outsideRepo, ".git"), { recursive: true });
			await writeSkill(path.join(outsideHome, ".agents", "skills"), "above-repo", "Above repo.");
			await writeSkill(path.join(outsideRepo, ".agents", "skills"), "in-repo", "In repo.");
			const { skills } = await loadSkills({ cwd: outsideCwd });
			expect(skills.some(s => s.name === "in-repo")).toBe(true);
			expect(skills.some(s => s.name === "above-repo")).toBe(false);
		} finally {
			await removeWithRetries(outsideHome);
		}
	});

	it("keeps a home-rooted repo out of project scope", async () => {
		// repoRoot 恰为 home：不越过 home，~/.agents/skills 仍只是 user scope。
		await writeSkill(path.join(home, ".agents", "skills"), "home-only", "At home.");
		await fs.mkdir(path.join(home, ".git"), { recursive: true });
		const { skills } = await loadSkills({ cwd: home });
		const copies = skills.filter(s => s.name === "home-only");
		expect(copies).toHaveLength(1);
		expect(copies[0]?.source).toBe("agents:user");
	});
});
