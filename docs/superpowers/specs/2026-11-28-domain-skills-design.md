# 域级 `.agents/skills`（domain skills）设计

日期：2026-11-28
档位：小改动（short design）

## 意图与为什么

一个域目录（如 `~/IDE/ai-agent`，自身不是 git 仓库）下面挂着 oh-my-pi、pi、sextant、orca 等
多个仓库，它们共用同一套工具与解法。把这些 skill 复制进每个仓库，改一处要同步 N 处，迟早漂移。

omp 的 `agents` provider 从 cwd 向上扫 `.agent[s]/`，**停在 `repoRoot ?? home`**
（`src/discovery/agents.ts:141 getProjectPathCandidates`）。域目录那一层因此永远扫不到。
`pi` 有同样的限制，用户为此写了 `pi-domain-skills` 扩展。

本次改动把 **skills 这一条面**的走链边界从「git 仓库根」扩展到「home（不含）」，
让域目录及其下每一级 `.agents/skills` 对域内任意 cwd 生效。

## 目标 / 非目标 / 反目标

- 目标：仓库位于 home 之下时，`.agent[s]/skills` 的向上扫描越过仓库根，一路到 home（**不含** home）。
- 非目标：不改 rules / prompts / commands / AGENTS.md / SYSTEM.md 的走链边界（本次只做 skills）。
- 非目标：不新增扩展事件接线（`resources_discover` 仍无 AgentSession 调用点，保持现状）。
- 反目标：不把 `~/.agents/skills` 注册成 project scope（它与 user scan 重复，会引发同名别名）。
- 反目标：不为单个行为引入一堆开关；不改任何 provider 优先级。

## 约束

- 必须复用既有 home 跳过不变量：`getProjectPathCandidates` 现在对每一级都 `if (current !== ctx.home)`，
  且 `test/discovery/agents-monorepo-skills.test.ts:99` 有回归测试钉住「无仓库时 home 不当 project」。
- 语义必须与 AGENTS.md 走链一致：`src/discovery/helpers.ts:646 loadStandaloneContextFiles` 的规则是
  「仓库嵌在 home 之下 → 继续往上到 home 为止（不含 home）」。skills 采用同一条规则，
  不发明第二种边界口径。
- 仓库不在 home 之下（如 `/srv/app`）时保持今天的「停在 repoRoot」，不爬到文件系统根。

## 方案（已选 A）

| 方案 | 做法 | 取舍 |
|---|---|---|
| A（选） | 改 `agents` provider 的 skills 走链边界 | 覆盖面最大：`omp read` / RPC / SDK / 子代理 / `skill://` 全部自动生效，无需装扩展；改动约 30 行 |
| B | 裁上游 `origin/feat/extension-resources-discover`，只接 skills 钩子，让 `pi-domain-skills` 原样在 omp 跑 | ~200 行移植，且基于的 merge-base 陈旧（runner.ts import 已大幅漂移）；扩展路径绕过 omp 项目信任语义 |
| C | 零代码：`skills.customDirectories` 写死域目录 | 今天就能用，但域目录是硬编码列表，换域要手工加，且不做祖先链推导 |

选 A 的理由：语义与仓库内已有先例（AGENTS.md 走链）同源、覆盖面最大、无扩展逃逸口、
不依赖一条当前没有调用点的事件路径。

## 实现约定（已定，作为我的判断）

1. **只动 skills。** 其余面继续走 `getProjectPathCandidates`。
2. **不新增设置项。** 域 skills 归现有 `skills.enableAgentsProject` 开关管；
   关掉它域 skills 一起消失。备选是加 `skills.enableAgentsDomain`，我否决：多一个布尔、
   多一条文档、用户要理解两层边界，收益为零。
3. **home 始终不作为 project scope 返回**（保持既有不变量），即使 repoRoot == home。
4. **同名冲突走既有优先级**：域 skill 与项目 skill 同名 → 项目近者赢裸名，域 skill 落
   `<域名>/<name>` 命名空间（`extensibility/skills.ts:91 skillNamespace` 从路径段推导，
   即域目录名）。无需新代码。

## 留给实现者的内容

- `src/discovery/agents.ts`：抽出纯走链 helper，`getProjectPathCandidates` 与新的
  `getSkillPathCandidates` 共用；后者在「repoRoot 存在、repoRoot 在 home 之下、
  repoRoot ≠ home」时把停点从 repoRoot 改成 home。
- `test/discovery/agents-monorepo-skills.test.ts:85`「walk-up stops at repo root」必须改写：
  该断言钉的是旧契约。新契约要覆盖两个分支——仓库在 home 之下时越过仓库根（含断言顺序：
  近者在前、裸名归近者）；仓库不在 home 之下时仍停在 repoRoot。
- `docs/skills.md`：在 agents provider / 走链相关处补一段域边界规则。
- `packages/coding-agent/CHANGELOG.md`：`## [Unreleased]` → `### Added` 加一行用户可见描述。
- 验证：`bun test packages/coding-agent/test/discovery/agents-monorepo-skills.test.ts`
  + 改动文件的 LSP diagnostics。
