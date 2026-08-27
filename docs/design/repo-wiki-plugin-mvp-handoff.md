# Repository Wiki 插件 MVP：方案设计与任务重启交接

## 1. 文档用途

本文记录 Repository Wiki 需求的最终设计、当前开发状态、关键文件、验证结果和任务重启步骤。后续任务应以本仓库当前磁盘状态和本文为入口，不再依赖旧 checkout 或聊天上下文。

正确开发仓库：

```text
/Users/bytedance/Desktop/OpenViking
```

当前开发分支：

```text
feat/trae-cli-memory
```

## 2. 需求目标

需求分为三部分：

1. 本地 Wiki 创建、读取和更新。
2. Git 触发上传时，将代码仓库内容与 `.repo_memory` Wiki 分离。
3. 代码沿用原 `git_local` 链路，Wiki 走独立 Resource 上传链路。

检索分为两类：

- 本地 Wiki：在当前仓库 `.repo_memory/` 中使用 `rg`、文件读取和 Wiki 页面链接。
- 云端 Wiki：在 OpenViking 的仓库 Wiki Resource 子树内使用 `grep`、`glob`、`find`、`read` 和 `list`。

Wiki 用于解决“项目是什么、相关模块在哪里、为什么这样设计、历史背景是什么”；当请求已有明确 live-code 文件、符号、行号、报错或失败测试时，应直接读取代码，不先查 Wiki。

## 3. 方案选择

### 3.1 方案 A：插件 MVP（当前实现）

当前选择方案 A，暂不修改 OpenViking 服务端核心：

- Wiki 在云端按普通 Resource 文件管理。
- 本地 Skill 负责 Wiki 创建、更新、校验和检索路由。
- Git PostToolUse Hook 负责上传前分流。
- 代码和 Wiki 独立打包、独立提交、独立记录状态、独立失败重试。
- 通用语义召回可能命中 Wiki；MVP 阶段接受这个边界，先通过实际体验评估。

### 3.2 方案 B：服务端原生 Wiki（延期）

若方案 A 的实际效果不合适，再考虑服务端原生支持：

- 增加明确的 Wiki 类型、scope 或检索过滤边界。
- 通用 Resource 召回与显式 Wiki 检索可以严格区分。
- 服务端理解 Wiki 的仓库、作者、版本和新鲜度语义。

方案 B 当前不实施，避免在验证插件 MVP 前扩大核心改动。

## 4. 本地 Wiki 设计

### 4.1 存储位置

```text
<repo>/.repo_memory/
```

`.repo_memory/` 是本地生成物，根 `.gitignore` 使用：

```gitignore
/.repo_memory/
```

本仓库另外忽略 `.agents/`，因为这是用户自己的本地 Agent 项目配置，不进入 Git：

```gitignore
.agents/
```

### 4.2 Wiki 结构

```text
.repo_memory/
├── PROFILE.md
├── <repository-native-topic>.md
├── raw/
│   ├── prepare-report.json
│   ├── git-commits.json
│   └── github-facets.json 或 gitlab-facets.json（显式启用时）
└── resources/
    ├── commits.md
    ├── prs.md
    └── issues.md
```

`PROFILE.md` 是 Wiki landing page；概念页按项目领域组织，不镜像源码目录；`resources/*.md` 是历史路由卡片；`raw/*.json` 只作为机械证据和调试材料。

### 4.3 新鲜度

`PROFILE.md` 至少记录：

- `local_head`：构建时基线 commit。
- `source_tree`：Wiki 所描述的 Git tree。
- `generated_at`：生成时间。
- `working_tree_state`：生成时工作区状态。

这些字段记录 Wiki 的构建来源和新鲜度，随发布写入 manifest/tag，供检索与诊断使用；它们不改变固定的 `repo_id + user_id` 云端目标，也不阻断该目标的首次创建或基于内容 hash 的增量更新。

## 5. Skill 设计

### 5.1 复用原则

Skill 以 `memorax-code` 指定版本的 Repo Wiki 子系统为基础：

```text
memorax-ai/memorax-code
commit: 110ca8a1d2500e41fdcddf0384e3037e32365516
```

原则是“能复用就复用，不能复用就删除，必要适配最小化”：

- 保留完整 Repo Wiki build/read/update/templates 和 7 个 Repo Wiki 脚本。
- 删除 Coding Memory 的 search/add 与 `memorax-cli` 依赖。
- 删除 Personal Memory 的 read/write 与 `user_profile_memory.py`。
- 删除 MemoraX 专属 background supervisor/helper 依赖。
- 仅适配 Skill 名称、默认历史策略、OpenViking 云端 Wiki 检索和上传所需 `source_tree`。

### 5.2 Skill 文件

仓库内规范源：

```text
examples/skills/repo-wiki/
```

本地项目级部署（被 `.gitignore` 忽略）：

```text
.agents/skills/repo-wiki/
```

用户级安装：

```text
~/.trae/skills/repo-wiki/
~/.trae-cn/skills/repo-wiki/
```

规范 Skill 当前包含 16 个文件：

- `SKILL.md`
- `agents/openai.yaml`、`agents/claude.yaml`
- `defaults.json`
- `references/repo-build.md`
- `references/repo-read.md`
- `references/repo-update.md`
- `references/repo-templates.md`
- `references/openviking-read.md`
- `scripts/collect_all.py`
- `scripts/prepare_repo_memory.py`
- `scripts/git_commit_facets.py`
- `scripts/github_resource_facets.py`
- `scripts/gitlab_resource_facets.py`
- `scripts/detect_updates.py`
- `scripts/validate_memory.py`

默认 `repoHistory.mode` 为 `local-only`，普通 Wiki 构建不要求也不检查 `gh/glab`。只有用户明确要求 provider PR/MR/Issue 上下文时，才使用 provider 模式。

## 6. Git 触发与上传分流设计

### 6.1 触发条件

TRAE / TRAE CLI 的 PostToolUse repository worker 只处理成功的 Git mutation，例如：

- `commit`
- `merge`
- `rebase`
- `pull`
- `checkout` / `switch`
- `reset`
- `revert`

`git status`、`git diff`、`git log` 等只读命令不触发。

### 6.2 上传前预处理

`prepareRepositoryUploadInputs()` 返回两部分：

- `code`：原仓库上下文。
- `wiki`：`disabled`、`absent`、`invalid` 或 `ready`。

Wiki 预处理检查：

- `PROFILE.md` 和 schema。
- `local_head` / `source_tree` 来源元数据。
- Wiki 用户身份。
- 文件白名单和 symlink 安全。
- Markdown page schema 和内部链接。
- 本机绝对仓库路径清洗。
- 内容 hash。

### 6.3 代码链路

代码仍使用：

```text
git archive HEAD
  -> temp_upload
  -> POST /api/v1/resources
  -> args.git_local
```

代码 archive 显式排除 `.repo_memory`，即使 Wiki 曾被误加入 Git。

### 6.4 Wiki 链路

Wiki 独立打包，只允许：

- 根 `PROFILE.md`。
- 根目录带 Wiki page schema 的概念 Markdown。
- `resources/commits.md`、`resources/prs.md`、`resources/issues.md`。

不上传：

- `raw/`
- 临时 plan
- profile/procedure sidecar
- lock/log/tmp
- 未知文件或 symlink

云端目标：

```text
resources/wiki/<repo-id>/<user-id>/
```

请求使用：

```json
{
  "processing_mode": "vectors_only",
  "args": {"parse_mode": "no_split"}
}
```

目的：保留 Skill 已编写的文件边界，避免服务端再次生成语义摘要。

### 6.5 独立状态与重试

状态文件使用 v2 结构，分别记录 `code` 和 `wiki`：

- 代码按 commit 去重。
- Wiki 按 content hash 与提交状态去重。
- 两条链路并行执行并分别 settle。
- Wiki 失败可单独重试，不重复上传成功的代码。
- 代码失败也不覆盖 Wiki 的独立结果。

## 7. 当前真实状态

### 7.1 本地 Wiki

当前正确开发目录已有 Wiki：

```text
/Users/bytedance/Desktop/OpenViking/.repo_memory/
```

当前 profile：

```text
local_head: 4a55e6ee88352189524e3101038434a0fd8a5495
source_tree: 428413c3ac3a29d726be252b659c436aa598cb43
branch: feat/trae-cli-memory
working_tree_state: dirty
```

### 7.2 云端 Wiki

该仓库 Wiki 尚未上传。云端顶层 Wiki 目录为空。开发和测试阶段没有执行真实 Wiki 上传。

当前本机 TRAE、TRAE CN 与 TRAE CLI 的 repository-sync Hook 已显式设置：

```text
OPENVIKING_REPO_WIKI_UPLOAD_ENABLED
```

因此下一次满足新鲜度校验的 Git commit Hook 会同时尝试代码与 Wiki 两条上传链路。该设置属于本机安装态配置，重新运行安装器后应再次确认。

### 7.3 首次真实分流上传前置条件

要让某次 commit 同时走两条独立链路，必须在 commit 前完成：

1. 将本次应提交文件加入 Git index。
2. 用最终 index tree 更新 Wiki，使 `PROFILE.md.source_tree` 等于待提交 tree。
3. 运行完整 Wiki 校验。
4. 在触发 Hook 的 TRAE/Trae CLI 进程环境中显式设置 `OPENVIKING_REPO_WIKI_UPLOAD_ENABLED=1`。
5. 执行 commit。

满足后，预期行为是：代码走 `git_local`，Wiki 走普通 Resource，二者互不混包。

## 8. Git 提交状态

当前有方案 A 改动需要提交，但尚未执行 commit/push。

- 方案 A 的 tracked 修改和新增 Skill/测试文件已全部暂存。
- `.agents/` 与 `.repo_memory/` 被忽略，不进入 commit。
- `examples/skills/repo-wiki/` 是仓库内规范 Skill 源码，需要提交。

提交候选主要包含：

- `examples/skills/repo-wiki/`
- `examples/memory-plugin-shared/lib/repository-sync.mjs`
- `examples/memory-plugin-shared/repository-sync.test.mjs`
- `examples/memory-plugin-shared/repo-wiki-skill.test.mjs`
- `examples/memory-plugin-shared/install.sh` 及安装测试
- TRAE / TRAE CLI integration 与文档
- marketplace staging、CI 和生成 shared runtime
- 本文

## 9. 已完成验证

- Repo Wiki Skill 结构校验通过。
- 项目级、安装源、TRAE、TRAE CN Skill 内容一致。
- 完整 Repo Wiki 脚本可从项目级目录运行。
- 当前 `.repo_memory` 完整校验通过。
- 增量检测确认当前 baseline 无新增 commit。
- 分流、独立状态、独立失败重试测试通过。
- 安装器、marketplace staging、shared runtime 同步测试通过。
- 最近一次相关测试：25/25 通过。
- 未执行真实 Wiki 上传。

## 10. 任务重启步骤

新任务从以下步骤开始：

1. 进入仓库并读本文：

   ```bash
   cd /Users/bytedance/Desktop/OpenViking
   git status --short --branch
   ```

2. 确认设计没有变化，检查：

   - `examples/skills/repo-wiki/SKILL.md`
   - `examples/memory-plugin-shared/lib/repository-sync.mjs`
   - `examples/memory-plugin-shared/repository-sync.test.mjs`
   - `.repo_memory/PROFILE.md`

3. 决定本次目标：

   - 只 commit 代码，不测试云端 Wiki；或
   - 准备第一次真实代码/Wiki 分流上传。

4. 若只提交代码：保持 Wiki gate 关闭，审查、stage、测试、commit。

5. 若做第一次真实上传：先根据最终 index tree 更新 Wiki，再显式打开 gate，并对 OpenViking 目标路径、任务结果、文件边界和重复上传进行验收。

6. 未经用户明确要求，不 push、不删除云端 Resource、不做服务端核心改动。

## 11. 关键文件索引

- Skill：`examples/skills/repo-wiki/`
- 项目级本地 Skill：`.agents/skills/repo-wiki/`（ignored）
- 本地 Wiki：`.repo_memory/`（ignored）
- 上传分流：`examples/memory-plugin-shared/lib/repository-sync.mjs`
- 分流测试：`examples/memory-plugin-shared/repository-sync.test.mjs`
- Skill 测试：`examples/memory-plugin-shared/repo-wiki-skill.test.mjs`
- 安装器：`examples/memory-plugin-shared/install.sh`
- TRAE 文档：`docs/zh/agent-integrations/13-trae.md`
- Marketplace staging：`.github/scripts/stage-memory-plugin-marketplace.sh`
- Plugin CI：`.github/workflows/pr.yml`
