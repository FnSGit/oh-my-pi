# Domain Skills（域级 `.agents/skills`）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 仓库位于 home 之下时，`.agent[s]/skills` 的向上扫描越过 git 仓库根，一路到 home 为止（不含 home），让域目录层的 skills 对域内任意 cwd 生效。

**Architecture:** 在 `src/discovery/agents.ts` 抽出一个纯走链 helper，`getProjectPathCandidates`（其余面）与新的 `getSkillPathCandidates`（skills 专用）共用；后者在「repoRoot 存在、repoRoot 在 home 之下、repoRoot ≠ home」时把停点从 repoRoot 改成 home。同名冲突、优先级、命名空间全部复用 `extensibility/skills.ts` 既有逻辑，不写新代码。

**Tech Stack:** TypeScript / Bun test，仓库既有 capability-provider 模式。

**Spec:** `docs/superpowers/specs/2026-11-28-domain-skills-design.md`

## Global Constraints

- 只改 skills 这一条面；rules / prompts / commands / AGENTS.md / SYSTEM.md 的走链边界不变。
- 不新增任何设置项；域 skills 归现有 `skills.enableAgentsProject` 开关管。
- home 永远不作为 project scope 返回（含 `repoRoot === home` 的情形）。
- 仓库不在 home 之下时，停点仍是 repoRoot（不爬到文件系统根）。
- 冲突处理零新代码：项目 skill 赢裸名，域 skill 落 `<域名>/<name>`（`skillNamespace` 从路径段推导）。
- 注释、代码注释一律简体中文；commit 遵循仓库既有 conventional 风格。
- 不用 `tsc`/`npx tsc`；类型检查走 `bun check`（本任务验证范围：单文件 `bun test` + LSP diagnostics）。

## Review Focus

1. **域 skill 与仓库内同名 skill 冲突**：期望近者（仓库内）赢裸名，域 skill 可经 `<域名>/<name>` 访问，且 `skill://<域名>/<name>` 能读到域目录文件。
2. **仓库在 home 之下但 repoRoot 恰为 home**：期望走链不越过 home、不把 `~/.agents/skills` 当 project scope 注册（否则与 user scan 重复，产生同名别名）。
3. **仓库不在 home 之下（如 `/srv/app`）**：期望停在 repoRoot，绝不爬到文件系统根。
4. **cwd 无 git 仓库且在 home 之下**：期望与今天完全一致（停在 home 且不含 home），#1116 的回归语义不破。
5. **home 自身含 `.agents/skills`**：期望它只以 user scope 出现一次，`source` 为 `agents:user`，无 `agents:project` 副本。

---

### Task 1: skills 走链越过仓库根到 home

**Files:**
- Modify: `packages/coding-agent/src/discovery/agents.ts:141-156`（`getProjectPathCandidates`）与 `:159-170`（`loadSkills`）
- Test: `packages/coding-agent/test/discovery/agents-monorepo-skills.test.ts:85-123`

**Interfaces:**
- Consumes: `LoadContext`（`packages/coding-agent/src/capability/types.ts:31`，字段 `cwd`/`home`/`repoRoot`）；`scanSkillsFromDir`（`discovery/helpers.ts:379`）；`pathIsWithinLexical`（`@oh-my-pi/pi-utils`，已被 `discovery/contained-path.ts` 使用）。
- Produces:
  - `export function getSkillPathCandidates(ctx: LoadContext, ...segments: string[]): string[]` — skills 专用的 `.agent[s]/<segments>` 走链；返回顺序近者在前。
  - `getProjectPathCandidates(ctx, ...segments)` 行为不变，签名不变。

- [ ] **Step 1: 改写既有测试 `walk-up stops at repo root`（它钉的是旧契约）**

  替换 `packages/coding-agent/test/discovery/agents-monorepo-skills.test.ts:85-97`。原测试用 `ctx = { cwd: subProject, home: tempDir, repoRoot }`，其中 `repoRoot` 在 `tempDir` 之下——正好命中新契约。改成两个 test：

  ```ts
  test("walk-up stops at repo root when the repo is outside home", async () => {
      // 仓库不在 home 之下：停点仍是 repoRoot，不爬到文件系统根。
      const outsideCtx: LoadContext = {
          cwd: path.join(repoRoot, "packages", "my-app"),
          home: path.join(tempDir, "home"),
          repoRoot,
      };
      fs.mkdirSync(outsideCtx.home, { recursive: true });
      writeSkill(path.join(tempDir, ".agents", "skills"), "above-repo-skill", "Above repo");
      writeSkill(path.join(repoRoot, ".agents", "skills"), "root-skill", "At repo root");

      const candidates = getSkillPathCandidates(outsideCtx, "skills");
      expect(candidates).not.toContain(path.join(tempDir, ".agents", "skills"));

      const results = await Promise.all(
          candidates.map(dir =>
              scanSkillsFromDir(outsideCtx, { dir, providerId: PROVIDER_ID, level: "project" }),
          ),
      );
      const names = results.flatMap(r => r.items).map(s => s.name);
      expect(names).toContain("root-skill");
      expect(names).not.toContain("above-repo-skill");
  });

  test("skills walk past a repo root nested under home to the domain dir", async () => {
      // 仓库嵌在 home 之下：越过 repoRoot，一路到 home（不含 home）。
      writeSkill(path.join(tempDir, ".agents", "skills"), "domain-skill", "From domain dir");
      writeSkill(path.join(repoRoot, ".agents", "skills"), "root-skill", "From repo root");

      const candidates = getSkillPathCandidates(ctx, "skills");
      expect(candidates).toContain(path.join(tempDir, ".agents", "skills"));
      expect(candidates).toContain(path.join(repoRoot, ".agents", "skills"));

      const results = await Promise.all(
          candidates.map(dir =>
              scanSkillsFromDir(ctx, { dir, providerId: PROVIDER_ID, level: "project" }),
          ),
      );
      const names = results.flatMap(r => r.items).map(s => s.name);
      expect(names).toContain("domain-skill");
      expect(names).toContain("root-skill");
      // 近者在前：loadSkills 的 first-wins 让 root-skill 拿裸名。
      expect(names.indexOf("root-skill")).toBeLessThan(names.indexOf("domain-skill"));
  });
  ```

  同时把该文件顶部 import 改为：

  ```ts
  import { getProjectPathCandidates, getSkillPathCandidates } from "@oh-my-pi/pi-coding-agent/discovery/agents";
  ```

  其余 4 个既有 skills test（`:56`、`:71`、`:99`、`:125`）继续调用 `getProjectPathCandidates`，因为它们是给「其余面」的走链钉契约；其中 `:99` 的 `noRepoCtx` 场景由 Task 2 的测试覆盖。

- [ ] **Step 2: 运行测试确认新 test 失败**

  Run: `cd packages/coding-agent && bun test test/discovery/agents-monorepo-skills.test.ts 2>&1 | tail -30`
  Expected: FAIL — `getSkillPathCandidates` 未定义（import 报错），或新断言失败（旧实现停在 repoRoot）。

- [ ] **Step 3: 实现 `getSkillPathCandidates` 并让 skills 改用它**

  在 `packages/coding-agent/src/discovery/agents.ts` 中：

  - 从 `getProjectPathCandidates` 抽出共用走链：

    ```ts
    function agentDirPathCandidates(ctx: LoadContext, ...args: [...segments: string[], stopAt: string]): string[] {
        const segments = args.slice(0, -1) as string[];
        const stopAt = args[args.length - 1] as string;
        const paths: string[] = [];
        let current = ctx.cwd;
        while (true) {
            if (current !== ctx.home) {
                for (const baseDir of AGENT_DIR_CANDIDATES) {
                    paths.push(path.join(current, baseDir, ...segments));
                }
            }
            if (current === stopAt) break;
            const parent = path.dirname(current);
            if (parent === current) break;
            current = parent;
        }
        return paths;
    }
    ```

  - `getProjectPathCandidates(ctx, ...segments)` 改为 `return agentDirPathCandidates(ctx, ...segments, ctx.repoRoot ?? ctx.home);`，保持行为不变。
  - 新增：

    ```ts
    /**
     * Skills 专用走链：仓库嵌在 home 之下时越过 git 仓库根，一路到 home（不含
     * home），让域目录层（一个自身不是 git 仓库、下面挂多个仓库的目录）的
     * `.agent[s]/skills` 对域内任意 cwd 生效。语义与 AGENTS.md 的
     * `loadStandaloneContextFiles`（helpers.ts:646）同源。
     *
     * home 永远不作为 project scope 返回：`~/.agent[s]/skills` 已由
     * `getUserPathCandidates` 覆盖，重复注册会产生同名别名。仓库不在 home 之下
     * 时停点仍是 repoRoot，不爬到文件系统根。
     */
    export function getSkillPathCandidates(ctx: LoadContext, ...segments: string[]): string[] {
        const stopAt =
            ctx.repoRoot !== null && ctx.repoRoot !== ctx.home && pathIsWithinLexical(ctx.home, ctx.repoRoot)
                ? ctx.home
                : (ctx.repoRoot ?? ctx.home);
        return agentDirPathCandidates(ctx, ...segments, stopAt);
    }
    ```

  - `loadSkills` 第 160 行 `getProjectPathCandidates(ctx, "skills")` 改为 `getSkillPathCandidates(ctx, "skills")`。
  - 文件顶部 import 加 `pathIsWithinLexical`：`import { isWsl, pathIsWithinLexical, windowsPathToWslMount } from "@oh-my-pi/pi-utils";`
  - provider 注册的 `description` 更新为体现域边界，例如 `"Load skills from .agent/skills and .agents/skills (project walk-up to home + user home)"`。

- [ ] **Step 4: 运行测试确认通过**

  Run: `cd packages/coding-agent && bun test test/discovery/agents-monorepo-skills.test.ts 2>&1 | tail -20`
  Expected: PASS，5 个 skills test 全绿。

- [ ] **Step 5: 提交**

  ```bash
  git add packages/coding-agent/src/discovery/agents.ts packages/coding-agent/test/discovery/agents-monorepo-skills.test.ts
  git commit -m "feat(coding-agent): domain skills walk past a repo root nested under home"
  ```

---

### Task 2: 端到端验证——域 skill 经 loadSkills 加载、命名空间与 home 不变量

**Files:**
- Test: `packages/coding-agent/test/discovery/domain-skills.test.ts`（新建）

**Interfaces:**
- Consumes: `loadSkills`（`packages/coding-agent/src/extensibility/skills.ts:307`）；`getSkillPathCandidates`（Task 1）；`setAgentDir` / `getAgentDir`（`@oh-my-pi/pi-utils/dirs`）；`getManagedSkillsDir` 无关，本测试不碰 managed。
- Produces: 无新生产代码；本任务是回归契约的落点。

- [ ] **Step 1: 写端到端测试**

  新建 `packages/coding-agent/test/discovery/domain-skills.test.ts`。照 `autolearn-discovery.test.ts:1-50` 的模式伪造 home（`spyOn(os, "homedir")` + `setAgentDir`），cwd 必须落在假 home 之下以保证全库安全：

  ```ts
  import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
  import * as fs from "node:fs/promises";
  import * as os from "node:os";
  import * as path from "node:path";
  import "@oh-my-pi/pi-coding-agent/discovery";
  import { loadSkills } from "@oh-my-pi/pi-coding-agent/extensibility/skills";
  import { clearCache } from "@oh-my-pi/pi-coding-agent/capability/fs";
  import { removeWithRetries } from "@oh-my-pi/pi-utils";
  import { getAgentDir, setAgentDir } from "@oh-my-pi/pi-utils/dirs";

  async function writeSkill(dir: string, name: string, description: string): Promise<void> {
      const file = path.join(dir, name, "SKILL.md");
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, ["---", `name: ${name}`, `description: ${description}`, "---", "", `# ${name}`].join("\n"));
  }

  describe("domain skills (repo nested under home)", () => {
      let tempHome: string;
      let repoRoot: string;
      let projectCwd: string;
      let originalAgentDir: string;

      beforeEach(async () => {
          clearCache();
          originalAgentDir = getAgentDir();
          tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "omp-domain-skills-home-"));
          // 域目录：自身不是 git 仓库，下面挂一个仓库。
          repoRoot = path.join(tempHome, "oh-my-pi");
          projectCwd = path.join(repoRoot, "packages", "coding-agent");
          await fs.mkdir(projectCwd, { recursive: true });
          await fs.mkdir(path.join(repoRoot, ".git"), { recursive: true });
          spyOn(os, "homedir").mockReturnValue(tempHome);
          setAgentDir(path.join(tempHome, ".omp", "agent"));
      });

      afterEach(async () => {
          spyOn(os, "homedir").mockRestore();
          setAgentDir(originalAgentDir);
          await removeWithRetries(tempHome);
      });

      it("loads a domain skill for a cwd nested under it", async () => {
          await writeSkill(path.join(tempHome, ".agents", "skills"), "domain-tool", "Shared across the domain.");
          const { skills } = await loadSkills({ cwd: projectCwd });
          const domain = skills.find(s => s.name === "domain-tool");
          expect(domain).toBeDefined();
          expect(domain?.filePath).toBe(path.join(tempHome, ".agents", "skills", "domain-tool", "SKILL.md"));
          expect(domain?.source).toBe("agents:project");
      });

      it("keeps the repo skill's bare name and namespaces the domain one on collision", async () => {
          await writeSkill(path.join(tempHome, ".agents", "skills"), "shared", "Domain copy.");
          await writeSkill(path.join(repoRoot, ".agents", "skills"), "shared", "Repo copy.");
          const { skills } = await loadSkills({ cwd: projectCwd });
          const shared = skills.filter(s => s.name === "shared" || s.name.endsWith("/shared"));
          expect(shared).toHaveLength(2);
          const bare = skills.find(s => s.name === "shared");
          expect(bare?.filePath).toBe(path.join(repoRoot, ".agents", "skills", "shared", "SKILL.md"));
          const namespaced = skills.find(s => s.name !== "shared" && s.name.endsWith("/shared"));
          expect(namespaced?.filePath).toBe(path.join(tempHome, ".agents", "skills", "shared", "SKILL.md"));
          // 命名空间取域目录名，路径段推导自 skillNamespace（extensibility/skills.ts:91）。
          expect(namespaced?.name).toBe(`${path.basename(tempHome)}/shared`);
      });

      it("never registers the home dir's own skills as project scope", async () => {
          await writeSkill(path.join(tempHome, ".agents", "skills"), "home-only", "At home.");
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
  });
  ```

  > 注意：`loadSkills` 内部的 `loadCapability` 用 `os.homedir()` 取 home、`findRepoRoot(cwd)` 取 repoRoot，两者都吃 `spyOn(os, "homedir")` 与真实文件系统，所以上面伪造的 `.git` 目录即仓库根。`tempHome` 形如 `/tmp/omp-domain-skills-home-XXXX`，`os.tmpdir()` 也是 `/tmp`——`getProjectDiscoveryCeilings()` 只被 native provider 的 `getAncestorDirs` 使用，agents provider 的走链不吃 ceilings，故域层（tempHome 本身）仍可被发现。

- [ ] **Step 2: 运行测试确认失败（Task 1 之前）或全绿（Task 1 之后）**

  Run: `cd packages/coding-agent && bun test test/discovery/domain-skills.test.ts 2>&1 | tail -30`
  Expected: 4 个 test 全 PASS（Task 1 已实现）。

- [ ] **Step 3: 提交**

  ```bash
  git add packages/coding-agent/test/discovery/domain-skills.test.ts
  git commit -m "test(coding-agent): cover domain-skill discovery, collision, and home invariant"
  ```

---

### Task 3: 文档与 CHANGELOG

**Files:**
- Modify: `docs/skills.md`（agents provider 走链描述处）
- Modify: `packages/coding-agent/CHANGELOG.md`（`## [Unreleased]` → `### Added`）

**Interfaces:**
- Consumes: Task 1 的最终行为；`docs/skills.md:121` 关于 agents provider 的开关说明、`:249` 关于 AGENTS.md home 边界的描述。
- Produces: 无。

- [ ] **Step 1: 更新 `docs/skills.md`**

  在「Source toggles and filtering」一节中关于 `agents` provider 的说明（当前在 `:121` 附近，原文：「The `agents` provider (`.agent[s]/skills`) has its own `enableAgentsUser`/`enableAgentsProject` toggles — disabling Claude/Codex/Pi does **not** turn it off. Claude, Codex, and OpenCode skills load only from project roots...」）之后，补一段：

  ```markdown
  The `agents` provider's project walk for **skills** stops at home rather than the
  git repository root when the repository is nested below home, so a domain
  directory (one that is not itself a git repository and holds several
  repositories, e.g. `~/projects/acme` with `api/` and `web/` under it) can carry
  one `.agents/skills` tree shared by every project below it. The home directory
  itself is never project scope — `~/.agents/skills` is already the user-level
  root — and a repository outside home still stops at its own root. Other
  surfaces (rules, prompts, commands, AGENTS.md, SYSTEM.md) keep the repository
  root as their boundary.
  ```

- [ ] **Step 2: CHANGELOG 加一行**

  在 `packages/coding-agent/CHANGELOG.md` 的 `### Added` 段（`## [Unreleased]` 下）追加：

  ```markdown
  - A `.agents/skills` tree in a domain directory (one that is not itself a git repository and holds several repositories, e.g. `~/projects/acme`) is now discovered by every project below it: the `agents` provider's skills walk continues past the git repository root up to the home directory, matching the AGENTS.md walk
  ```

- [ ] **Step 3: 验证文档与改动一致后提交**

  Run: `cd packages/coding-agent && bun test test/discovery/agents-monorepo-skills.test.ts test/discovery/domain-skills.test.ts 2>&1 | tail -15`
  Expected: 全 PASS。

  ```bash
  git add docs/skills.md packages/coding-agent/CHANGELOG.md
  git commit -m "docs(coding-agent): document domain-level .agents/skills discovery"
  ```

---

### Task 4: 全量验证与收尾

**Files:**
- 无新增文件；只跑检查。

- [ ] **Step 1: 跑改动面相关测试**

  Run: `cd packages/coding-agent && bun test test/discovery/agents-monorepo-skills.test.ts test/discovery/domain-skills.test.ts test/discovery/context-file-dedup.test.ts test/autolearn-discovery.test.ts 2>&1 | tail -20`
  Expected: 全 PASS。`context-file-dedup.test.ts` 覆盖 AGENTS.md 走链，确认本次未波及非 skills 面。

- [ ] **Step 2: LSP diagnostics**

  对 `packages/coding-agent/src/discovery/agents.ts` 调 `lsp`（`action: "diagnostics"`）。
  Expected: 0 error / 0 warning。

- [ ] **Step 3: 确认无残留旧契约引用**

  Run: `rg -n "getProjectPathCandidates" packages/coding-agent/src packages/coding-agent/test`
  Expected: `agents.ts` 内 1 处定义 + 5 处调用（rules/prompts/commands/AGENTS.md/SYSTEM.md），测试文件里 4 处；**skills 面不再出现**。
