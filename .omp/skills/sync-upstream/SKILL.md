---
name: sync-upstream
description: 合并上游仓库新版本到本地 fork 分支并部署。Use when 用户说"更新/合并上游/sync upstream/拉取新版本/部署新版本"时触发
---

# Sync Upstream & Deploy

将上游仓库（upstream）的新版本合并到本地 fork 分支，构建并部署。

## 前置条件

- 本地仓库已配置 `upstream` remote（指向上游原始仓库）
- 本地仓库已配置 `origin` remote（指向用户 fork）
- 当前工作分支干净（无未提交更改）

## 执行步骤

### 1. 获取上游最新代码

```bash
cd {repo_root} && git fetch upstream
```

### 2. 更新本地 main 分支

```bash
git checkout main && git merge {upstream_remote}/{upstream_branch} --ff-only
```

若 fast-forward 失败，说明本地 main 有偏离，需人工判断是否 reset 或 merge。

### 3. 合并到工作分支

```bash
git checkout {work_branch} && git merge {upstream_remote}/{upstream_branch}
```

### 4. 解决冲突

**通用原则：锁文件和自动生成文件取上游（`--theirs`），代码文件逐个审查。**

本项目常见冲突文件：

| 文件 | 策略 | 原因 |
|------|------|------|
| `bun.lock` / `yarn.lock` / `pnpm-lock.yaml` | `--theirs` | 锁文件，后续 install 重新生成 |
| `packages/ai/src/models.json` | `--theirs` | 自动生成的模型数据，上游为准 |
| 其他代码文件 | 逐文件审查 | 需理解双方改动后手动合并 |

```bash
# 锁文件/自动生成文件：取上游
git checkout --theirs {file} && git add {file}

# 代码文件：审查后手动编辑
# 查看冲突位置：grep -n "^<<<<<<<\|^=======\|^>>>>>>>" {file}
```

### 5. 完成合并提交

```bash
git commit --no-edit
```

### 6. 推送到 origin

```bash
git push origin {work_branch} main
```

### 7. 本地部署

根据项目类型选择构建命令：

```bash
# Node/Bun 项目
bun install && bun run build:native

# Rust 项目
cargo build --release

# 混合项目（先 JS 依赖，后 native）
bun install && bun run build:native
```

### 8. 验证

```bash
# 确认版本号已更新（具体命令取决于项目）
{cli_binary} --version
```

## 项目参数（oh-my-pi）

| 参数 | 值 | 说明 |
|------|-----|------|
| `repo_root` | `~/IDE/oh-my-pi/oh-my-pi` | 仓库根目录 |
| `work_branch` | `dev/blunt` | 当前工作分支 |
| `upstream_remote` | `upstream` | 上游 remote（can1357/oh-my-pi） |
| `upstream_branch` | `main` | 上游目标分支 |
| `cli_binary` | `omp` | CLI 命令名 |
| `build_cmd` | `bun install && bun run build:native` | 构建命令 |

## 异常处理

- **fast-forward 失败**：本地 main 有自定义提交，需用户决定是否 `git reset --hard {upstream_remote}/{upstream_branch}` 或 `git merge`
- **代码冲突**：非自动生成文件需逐个审查，不可盲目 `--theirs`
- **构建失败**：检查 toolchain 版本（Rust 见 `rust-toolchain.toml`，Bun 见 `scripts/install.sh` 的 `MIN_BUN_VERSION`）
- **install 失败**：检查包管理器版本是否满足项目最低要求