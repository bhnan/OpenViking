# Agent 触发式本地 Git 导入：现有实现风格与对齐方案

## 1. 文档目的

本文不直接定义新功能代码，而是先回答以下问题：

1. OpenViking 当前远端 Git 仓库导入按什么分层实现？
2. 每一层涉及哪些文件和函数？
3. 现有 TRAE CLI Hook 与统一 installer 遵循什么结构？
4. 本地 Git 仓库快照上传应插入哪一层，才能最大程度复用原项目？
5. 实现与测试应该按什么顺序推进？

关联需求文档：

- `docs/design/agent-triggered-local-git-ingestion.md`
- `docs/design/remote-git-ingestion-codegraph-flow.md`

核心结论：

> 本地仓库和远端仓库只在 Accessor 之前的“取得服务端本地快照”方式上不同。
> 本地上传应转换为标准 `LocalResource(SourceType.GIT)`，然后继续复用
> `CodeRepositoryParser -> TreeBuilder -> sync_tree -> SemanticDagExecutor`。

## 2. 原项目的总体设计风格

### 2.1 单一公开入口

资源导入统一进入 `ResourceService.add_resource`。HTTP、SDK、MCP 只负责把请求
转换为这一入口需要的参数，不分别实现解析或更新逻辑。

对应文件和函数：

| 文件 | 函数 | 职责 |
| --- | --- | --- |
| `openviking/server/routers/resources.py` | `add_resource()` | HTTP 参数解析、上传文件解析、调用 Service |
| `openviking/server/resource_ingest.py` | `ingest_temp_upload()` | 已上传文件的一次性消费封装 |
| `sdk/python/openviking_sdk/client.py` | `AsyncHTTPClient.add_resource()` | SDK 识别本地文件/目录、上传，再调用资源 API |
| `openviking/service/resource_service.py` | `ResourceService.add_resource()` | 公开服务入口 |
| `openviking/service/resource_service.py` | `_submit_resource_ingestion()` | Connector/Git/标准链顶层分流 |

对齐要求：

- 不新增一套独立的“本地仓库导入 API + 独立 Service”。
- 本地仓库快照仍通过 `temp_upload + add_resource` 进入统一入口。
- 仓库专属信息放在 `args`，不把 Parser 参数提升成大量顶层 HTTP 字段。

### 2.2 Accessor 负责获取，Parser 负责解析

OpenViking 使用两层模型：

```text
Source
  -> DataAccessor
  -> LocalResource
  -> Parser
  -> ParseResult
```

Accessor 解决“数据在哪里、如何变成服务端本地文件/目录”；Parser 只处理服务端可读
的本地内容，不关心它来自 URL、上传还是本机路径。

对应文件和函数：

| 文件 | 函数/类型 | 职责 |
| --- | --- | --- |
| `openviking/parse/accessors/base.py` | `DataAccessor` | 来源获取接口 |
| `openviking/parse/accessors/base.py` | `LocalResource` | Accessor 与 Parser 的统一边界 |
| `openviking/parse/accessors/base.py` | `LocalResource.cleanup()` | 临时来源生命周期管理 |
| `openviking/parse/accessors/registry.py` | `AccessorRegistry._register_defaults()` | 注册内置 Accessor |
| `openviking/parse/accessors/registry.py` | `get_accessor()` | 按优先级选择 Accessor |
| `openviking/parse/accessors/registry.py` | `access()` | 执行 Accessor 并返回 `LocalResource` |
| `openviking/utils/media_processor.py` | `UnifiedResourceProcessor.prepare()` | 冻结来源身份 |
| `openviking/utils/media_processor.py` | `UnifiedResourceProcessor.process()` | Accessor 后选择 Parser |

对齐要求：

- 本地仓库上传差异应做成 Accessor，而不是在 `CodeRepositoryParser` 里识别 HTTP
  上传协议。
- 新 Accessor 最终必须输出 `LocalResource(path=<解包目录>, source_type=GIT, ...)`。
- 临时解包目录通过 `LocalResource.is_temporary` 和 `cleanup()` 清理。

### 2.3 来源专属参数走 `args`

`AddResourceRequest.args` 是 Parser/Accessor 专属参数通道。
`ResourceService._normalize_add_resource_args()` 负责校验和归一化，再把参数传给
Accessor/Parser。

相关函数：

- `AddResourceRequest.args`
- `ResourceService._normalize_add_resource_args()`
- `UnifiedResourceProcessor.prepare()`
- `AccessorRegistry.get_accessor(..., **kwargs)`
- `AccessorRegistry.access(..., **kwargs)`

现有例子：

- Git：`branch`、`commit`、`auth_config`
- Web feed：`site`、`depth`、`max_pages`
- Feishu：`feishu_access_token`
- 通用 Parser：`parse_mode`

本地仓库应使用类似结构：

```json
{
  "repository_snapshot": {
    "version": 1,
    "repo_key": "local:<stable-id>",
    "repo_name": "example-repo",
    "branch": "main",
    "commit": "40-character-sha"
  }
}
```

注意：

- `temp_file_id` 仍是顶层上传引用，不放入 `args`。
- `to` 仍是顶层固定目标 URI，不放入 `args`。
- endpoint、account、user、API key 不允许由仓库元数据覆盖。
- `watch_interval` 对上传快照继续保持不支持。

### 2.4 临时树与最终树分离

Parser 不直接覆盖最终资源，而是先生成 VikingFS 临时树：

```text
ParseResult.temp_dir_path
  -> TreeBuilder.finalize_from_temp()
  -> temp resource tree
  -> final target URI
```

对应文件和函数：

| 文件 | 函数 | 职责 |
| --- | --- | --- |
| `openviking/parse/tree_builder.py` | `resolve_target_uri()` | 计算目标 URI |
| `openviking/parse/tree_builder.py` | `finalize_from_temp()` | 将 Parser 临时结果转换为资源树 |
| `openviking/utils/resource_processor.py` | `process_resource()` | 驱动 Parser、TreeBuilder 和后处理 |
| `openviking/utils/resource_processor.py` | `finish_prepared_resource()` | 执行摘要、同步和向量阶段 |

对齐要求：

- 本地上传不要直接写 `viking://resources/...`。
- 不在 Hook 中逐文件调用 OpenViking write。
- 始终生成完整仓库临时树，再使用现有同步逻辑更新固定目标。

### 2.5 资源更新由统一差异层处理

现有更新不是 Parser 内部打 patch，而是将完整新临时树与目标树比较。

对应文件和函数：

| 文件 | 函数/类型 | 职责 |
| --- | --- | --- |
| `openviking/storage/viking_fs/_sync.py` | `SyncDiff` | 表示 added/modified/deleted |
| `openviking/storage/viking_fs/_sync.py` | `_SyncMixin.sync_tree()` | 文件级内容比较和增删改合并 |
| `openviking/storage/queuefs/semantic_processor.py` | `_sync_topdown_recursive()` | 同步临时树、处理 sidecar |
| `openviking/storage/queuefs/semantic_processor.py` | `on_dequeue()` | 将 `SyncDiff` 转成增量语义任务 |
| `openviking/storage/queuefs/semantic_dag.py` | `SemanticDagExecutor` | 增量摘要和向量执行 |

`sync_tree()` 的既有规则：

- 文件大小不同视为变化；
- 大小相同再比较内容；
- 新文件移动到目标；
- 变化文件替换；
- 新快照中消失的目标文件删除；
- 未变化文件保留；
- 输出 `SyncDiff.to_changes()`。

对齐要求：

- 本地上传不自行计算 Git diff。
- 第一版上传完整 `HEAD` 快照。
- 后端仍以内容差异为事实来源。
- `commit` 只用于幂等和顺序控制，不替代资源树内容比较。

### 2.6 耗时操作进入持久任务

远端 Git 的 `wait=false` 路径会预检来源、预占目标 URI，并把任务写入持久队列。

对应文件和函数：

| 文件 | 函数/类型 | 职责 |
| --- | --- | --- |
| `openviking/service/resource_service.py` | `enqueue_git_add_resource()` | 异步 Git 任务提交 |
| `openviking/service/resource_service.py` | `_preflight_git_source()` | `git ls-remote` 可访问性预检 |
| `openviking/service/resource_service.py` | `_plan_resource_target()` | 预占固定目标 |
| `openviking/storage/queuefs/add_resource_msg.py` | `AddResourceMsg` | 持久化任务载荷 |
| `openviking/storage/queuefs/add_resource_processor.py` | `AddResourceProcessor._process()` | Worker 消费任务 |
| `openviking/service/task_tracker.py` | Task tracker API | 查询任务状态 |

上传快照的当前行为是：

1. `TempUploadStore.resolve_for_consume()` 将上传内容解析成服务端本地文件。
2. 当前请求完成获取和解析。
3. `defer_post_processing=True` 把不再依赖上传文件的 prepared 结果交给队列。
4. 上传内容标记 consumed 并清理。

推荐对齐：

- 第一版沿用上传文件现有 prepared-job 路径，不把一次性 `temp_file_id` 写入持久队列。
- 快照必须在当前请求内安全解包并解析成 VikingFS 临时树。
- Parser 后的摘要/向量阶段继续通过 `AddResourceMsg.prepared` 异步执行。
- Hook 收到 `task_id` 即返回，不等待任务完成。

这样能避免 Worker 重启后找不到已消费上传文件，也与当前上传资源语义一致。

### 2.7 配置写入必须幂等、可卸载、保留第三方配置

TRAE CLI installer 当前不会覆盖整个 hooks/TOML 文件，而是只替换 OpenViking
拥有的条目。

对应函数：

- `assemble_agent_integration()`
- `agent_write_trae_cli_configs()`
- `agent_remove_trae_cli_configs()`
- `install_trae_cli()`
- `validate_install()`

既有风格：

- 源包不提交 `lib/`，installer 组装 shared runtime；
- 用 `OPENVIKING_INTEGRATION_ID` 标记归属；
- 保留第三方 Hook 和 MCP；
- 写入前备份；
- 临时文件 + rename 原子更新；
- 重复安装不产生重复条目；
- 卸载只删除自身条目；
- 安装后做语法检查和 smoke test。

本地仓库 Hook 必须遵循同一规则。

## 3. 远端 Git 导入的完整调用链

### 3.1 HTTP/SDK 入口

```text
AsyncHTTPClient.add_resource(remote_url)
  -> POST /api/v1/resources
  -> routers.resources.add_resource()
  -> ResourceService.add_resource()
  -> ResourceService._submit_resource_ingestion()
```

关键文件：

- `sdk/python/openviking_sdk/client.py`
- `openviking/server/routers/resources.py`
- `openviking/service/resource_service.py`

### 3.2 Git 顶层分流

`_submit_resource_ingestion()` 使用 `is_git_repo_url(path)` 判断远端 Git 来源。

无请求级凭据时：

```text
enqueue_git_add_resource()
  -> _preflight_git_source()
  -> _plan_resource_target()
  -> AddResourceMsg
  -> ADD_RESOURCE queue
```

有 `args.auth_config` 时，凭据不能进入持久队列，因此在当前请求消费：

```text
_execute_resource_ingestion()
  -> GitAccessor.access(auth_config)
  -> Parser/TreeBuilder
  -> credential-free prepared payload
  -> queue
```

设计惯例：

- 凭据在最靠近来源获取的位置消费；
- 敏感参数不进入 durable message；
- 目标 URI 在耗时工作前预占；
- 资源锁通过 handoff 交给 Worker。

### 3.3 GitAccessor

关键函数：

- `GitAccessor.can_handle()`
- `GitAccessor.access()`
- `_parse_repo_source()`
- `_normalize_repo_url()`
- `_git_clone()`
- `_github_zip_download()`
- `_gitlab_zip_download()`
- `_run_git()`

输出形态：

```python
LocalResource(
    path=local_dir,
    source_type=SourceType.GIT,
    original_source=source_url,
    meta={
        "repo_name": "...",
        "repo_ref": "...",
        "repo_commit": "...",
    },
    is_temporary=True,
)
```

这正是本地快照 Accessor 应对齐的输出。

### 3.4 Parser

调用链：

```text
UnifiedResourceProcessor.process()
  -> local_resource.path.is_dir()
  -> DirectoryParser.parse()
  -> DirectoryParser._is_git_repository()
  -> CodeRepositoryParser.parse()
```

关键函数：

- `DirectoryParser.parse()`
- `DirectoryParser._is_git_repository()`
- `DirectoryParser._add_git_metadata()`
- `CodeRepositoryParser.parse()`
- `CodeRepositoryParser._upload_directory()`

远端 Git ZIP 会被 `GitAccessor` 加入 `.git_source_repo`，从而让
`DirectoryParser` 识别为仓库。

本地快照不应依赖伪造该标记。推荐由新 Accessor 直接输出 Git 来源，并在
`UnifiedResourceProcessor.process()` 中对 `source_type == SourceType.GIT` 显式选择
`CodeRepositoryParser`，或者由 Accessor 在解包目录中使用现有内部标记作为过渡。

长期风格更好的方案是显式来源类型，不用隐藏文件控制 Parser 路由。

### 3.5 目标与增量后处理

调用链：

```text
CodeRepositoryParser.parse()
  -> ParseResult(source_format="repository")
  -> TreeBuilder.finalize_from_temp()
  -> ResourceProcessor.finish_prepared_resource()
  -> Summarizer.summarize()
  -> SemanticMsg(target_uri=<fixed target>)
  -> SemanticProcessor._sync_topdown_recursive()
  -> VikingFS.sync_tree()
  -> SemanticDagExecutor(incremental_update=true)
```

本地与远端在这里应完全共用。

### 3.6 Watch

关键文件和函数：

| 文件 | 函数 | 职责 |
| --- | --- | --- |
| `openviking/service/resource_service.py` | `_manage_watch_if_needed()` | 创建/更新/取消 Watch |
| `openviking/service/resource_service.py` | `_handle_watch_task_creation()` | 同 URI 幂等更新 |
| `openviking/resource/watch_manager.py` | `create_task()` | 持久化 Watch |
| `openviking/resource/watch_manager.py` | `update_task()` | 更新任务 |
| `openviking/resource/watch_scheduler.py` | `_check_and_execute_due_tasks()` | 调度到期任务 |
| `openviking/resource/watch_scheduler.py` | `_execute_stable_task()` | 调用 `refresh_resource()` |

本地快照不能复用 Watch，因为服务端无法重新读取用户电脑。上传请求继续保留
`watch_interval > 0` 的现有拒绝逻辑。

## 4. TRAE CLI Hook 的现有实现风格

### 4.1 源码包只放客户端适配

目录：

```text
examples/trae-cli-memory-hooks/
  hooks/hooks.json
  scripts/*.mjs
  servers/mcp-proxy.mjs
  openviking.integration.json
  .mcp.json
  README.md
```

共享逻辑位于：

```text
examples/memory-plugin-shared/lib/
```

installer 安装时组装到：

```text
~/.openviking/agent-integrations/
  trae-cli/
  memory-plugin-shared/lib/
```

对齐要求：

- TRAE CLI 包中新增 `scripts/repository-sync.mjs` 作为薄入口。
- 通用 Git 命令识别、快照生成、状态、上传和 API 调用放到
  `examples/memory-plugin-shared/lib/repository-sync.mjs`。
- 不在 TRAE CLI 包内复制通用实现。

### 4.2 Hook 配置声明与脚本分离

`hooks/hooks.json` 只声明：

- 事件；
- matcher；
- command；
- timeout。

现有脚本 wrapper 通过设置 `OPENVIKING_HOOK_EVENT` 后导入主适配器。

本地仓库应新增：

```json
{
  "PostToolUse": [
    {
      "matcher": "Bash|RunCommand|Shell",
      "hooks": [
        {
          "type": "command",
          "command": "node __OPENVIKING_TRAE_CLI_ROOT__/scripts/repository-sync.mjs",
          "timeout": 5
        }
      ]
    }
  ]
}
```

注意：

- matcher 匹配的是工具名，不是 shell 命令内容；
- 脚本内部再读取 `tool_input.command`；
- `PostToolUse` 输入还包含 `tool_response`，可用于确认成功；
- no-op 输出为空或 `{}`；
- 该 Hook 不返回 `decision:"approve"`。

### 4.3 Hook 进程应快速返回

已有 `async-writer.mjs` 使用 detached worker：

```text
parent hook
  -> 读 stdin
  -> 立即输出 no-op
  -> spawn detached worker
  -> worker 执行网络写入
```

关键函数：

- `maybeDetach()`
- `readHookStdin()`

仓库打包和上传可能明显超过 5 秒，因此必须复用这一模式：

1. 父 Hook 读取 payload。
2. 立即向 TRAE CLI 返回 `{}`。
3. detached worker 执行 Git 元数据读取、`git archive`、上传和任务提交。
4. worker 失败只写日志/重试状态，不影响原 Git 工具结果。

### 4.4 共享 runtime 的状态风格

现有 `agent-hook-runtime.mjs` 提供：

- `loadAgentHookConfig()`
- `readHookInput()`
- `resolveAgentCwd()`
- `stableHash()`
- `withAgentHookLock()`
- `readHookState()` / `writeHookState()`
- `makeAgentFetchJSON()`
- logger 和 retry queue。

仓库同步不应混入会话记忆 state 文件。建议在 shared runtime 中建立独立状态目录：

```text
~/.openviking/repository-sync/
  state/
  pending/
  locks/
```

状态键：

```text
repo_key + branch
```

状态至少记录：

- `lastSubmittedCommit`
- `lastCompletedCommit`（若轮询任务）
- `taskId`
- `targetUri`
- `lastAttemptAt`
- `lastError`

写文件继续使用 `0600`，目录使用 `0700`，临时文件 + rename 原子更新。

### 4.5 installer 风格

新增 shared 文件后需要更新 `assemble_agent_integration()` 的明确 allowlist，而不是
复制整个目录。

`agent_write_trae_cli_configs()` 会：

- 读取 package manifest；
- 替换 `__OPENVIKING_TRAE_CLI_ROOT__`；
- 添加 integration env；
- 过滤旧的自身 Hook；
- 保留第三方 Hook；
- 原子写入 hooks；
- 更新 `integration.json`。

因此新增 Hook 只需进入源 `hooks.json`，installer 的泛化合并逻辑应自动安装。
但以下位置需要同步更新：

- `isOpenVikingHook()` 的已知脚本列表；
- uninstall 的 `ownsHook()` 脚本列表；
- `validate_install()` 对 `repository-sync.mjs` 和 PostToolUse 的检查；
- shared runtime allowlist；
- integration capability/version；
- installer tests。

## 5. 推荐的服务端实现插入点

### 5.1 新增 `RepositorySnapshotAccessor`

建议文件：

```text
openviking/parse/accessors/repository_snapshot_accessor.py
```

建议职责：

```python
class RepositorySnapshotAccessor(DataAccessor):
    @property
    def priority(self) -> int:
        return 90

    def can_handle(self, source, **kwargs) -> bool:
        return valid_repository_snapshot_args(kwargs)

    async def access(self, source, **kwargs) -> LocalResource:
        # source 是 TempUploadStore 解析后的本地 ZIP
        # 校验元数据
        # safe_extract_zip 到临时目录
        # 返回 SourceType.GIT LocalResource
```

为什么是 Accessor：

- 与 `GitAccessor` 同属“把来源变成本地仓库目录”；
- 可复用 `LocalResource` 生命周期；
- Parser 不需要理解上传 API；
- Router 不需要理解 ZIP 内部结构；
- 后续可供 CLI、MCP 和其他 Agent 共用。

### 5.2 注册顺序

修改：

- `openviking/parse/accessors/registry.py`
- `openviking/parse/accessors/__init__.py`

新 Accessor 应高于 `LocalAccessor` 和普通 ZIP 路由。建议优先级 90：

```text
Feishu 100
RepositorySnapshot 90
Git 80
WebFeed 60
HTTP 50
Local 1
```

它只能在 `args.repository_snapshot` 通过严格校验时命中，不能仅凭 `.zip` 后缀抢占
普通 ZIP 导入。

### 5.3 元数据校验

推荐在新模块中定义小型校验模型或函数，避免把仓库快照字段散落在 Router。

建议字段：

| 字段 | 校验 |
| --- | --- |
| `version` | 当前仅允许 `1` |
| `repo_key` | 非空、长度限制、不能包含密钥 |
| `repo_name` | 安全展示名，不作为未经转义的 URI |
| `branch` | 非空或 detached 标识，长度限制 |
| `commit` | 40 位十六进制 SHA |
| `archive_format` | 第一版只允许 `zip` |

目标 URI 仍由顶层 `to` 指定和现有 URI 校验负责。

### 5.4 Parser 选择

推荐修改：

- `openviking/utils/media_processor.py`

当前目录统一先进入 `DirectoryParser`，再靠 `.git`/marker 判断。新 Accessor 已明确
输出 `SourceType.GIT`，因此可以使用更清晰的显式分支：

```python
if local_resource.source_type == SourceType.GIT:
    return await CodeRepositoryParser().parse(...)
if local_resource.path.is_dir():
    return await DirectoryParser().parse(...)
```

这也能让现有 `GitAccessor` 去掉对 `.git_source_repo` 路由标记的长期依赖，但第一版
可以保留标记兼容和相关测试。

### 5.5 Router 与 Service 的最小改动

`AddResourceRequest.args` 已能承载元数据，Router 无需新增顶层字段。

需要确认或补充：

- `args.repository_snapshot` 只允许与 `temp_file_id` 同时使用；
- 禁止与 `path`、`add_type`、`watch_interval > 0` 组合；
- `_normalize_add_resource_args()` 调用快照元数据校验；
- 确保快照元数据进入当前请求 Accessor，但不会被写入不必要的持久敏感载荷。

建议修改文件：

- `openviking/server/routers/resources.py`
- `openviking/service/resource_service.py`

不要新增：

- 第二个资源入口；
- 第二个 TreeBuilder；
- 第二套增量同步 API；
- 本地仓库专用 Watch。

### 5.6 SDK 支持

现有 `AsyncHTTPClient.add_resource()` 已经会把本地目录 ZIP 上传，但它使用 `rglob`
打包整个目录，不等价于 Git commit 快照，也不会携带仓库元数据。

推荐新增显式方法，而不是改变普通目录行为：

```python
async def add_repository_snapshot(
    self,
    repo_path: str,
    *,
    to: str,
    branch: str | None = None,
    commit: str = "HEAD",
    wait: bool = False,
) -> dict:
    ...
```

建议内部 helper：

- `_resolve_git_repository()`
- `_create_git_archive()`
- `_upload_temp_file()`
- 然后调用现有 `add_resource()` 的 HTTP body 形态。

不过 TRAE CLI Hook 是 Node 脚本，不能直接依赖 Python SDK。Node shared runtime 需要
实现相同 HTTP 协议；SDK 方法用于公共 API 完整性和服务端 E2E 测试。

## 6. 推荐的 Hook 实现插入点

### 6.1 TRAE CLI 薄入口

新增：

```text
examples/trae-cli-memory-hooks/scripts/repository-sync.mjs
```

职责仅限：

1. 使用 `maybeDetach()` 快速返回。
2. 读取 TRAE CLI `PostToolUse` payload。
3. 将 payload 交给 shared repository runtime。
4. no-op 输出 `{}` 或空 stdout。

不在该文件中实现：

- Git 命令解析；
- `git archive`；
- HTTP multipart 上传；
- 状态存储；
- URI 映射。

### 6.2 共享 repository runtime

新增：

```text
examples/memory-plugin-shared/lib/repository-sync.mjs
```

建议函数：

```javascript
export function isSuccessfulGitMutation(input)
export async function resolveRepositoryContext(cwd)
export function deriveRepositoryTarget(metadata, cfg)
export async function createRepositoryArchive(metadata)
export async function uploadRepositorySnapshot(cfg, archive, metadata)
export async function submitRepositorySnapshot(cfg, tempFileId, metadata)
export async function syncRepositoryFromHook(input, cfg, log)
```

可以再拆为：

```text
repository-git.mjs       Git 命令和 archive
repository-upload.mjs    multipart/API
repository-state.mjs     幂等/锁/重试
```

是否拆分取决于实现规模。原项目偏好单一职责，但也避免为很小的 helper 过度分文件。

### 6.3 Git 事件判断

`PostToolUse` matcher 只能筛工具名；shared runtime 需要解析以下输入变体：

- `tool_name` / `toolName`
- `tool_input` / `toolInput` / `input`
- `tool_response` / `toolResponse`
- `cwd`

第一版应保守识别成功的 Git mutation：

- 命令需以独立 git invocation 出现；
- 不匹配注释或字符串中的 `git`；
- shell pipeline/复合命令只在能确定整体成功和 cwd 时处理；
- `tool_response` 明确失败则跳过；
- 再以 `git rev-parse HEAD` 的结果作为最终事实。

推荐触发集合：

- `commit`
- `merge`
- `rebase`
- `pull`
- `checkout`
- `switch`
- `clone`

去重逻辑最终以 `repo_key + branch + HEAD` 为准，而不是命令文本。

### 6.4 快照生成

推荐使用子进程参数数组，不通过拼接 shell：

```text
git -C <repo> rev-parse --show-toplevel
git -C <repo> rev-parse HEAD
git -C <repo> branch --show-current
git -C <repo> remote get-url origin
git -C <repo> archive --format=zip --output=<tmp> HEAD
```

要求：

- 不执行仓库提供的 Hook；
- 不展开 submodule；
- 不读取未跟踪/ignored 文件；
- 临时 ZIP 使用 `0600`；
- finally 清理 ZIP；
- 子进程超时并正确 kill/reap；
- 日志不输出凭据或完整敏感路径。

### 6.5 HTTP 上传

Node runtime 执行两次请求：

1. multipart `POST /api/v1/resources/temp_upload`
2. JSON `POST /api/v1/resources`

第二次请求：

```json
{
  "temp_file_id": "...",
  "to": "<stable-target>",
  "wait": false,
  "args": {
    "repository_snapshot": {
      "version": 1,
      "repo_key": "...",
      "repo_name": "...",
      "branch": "...",
      "commit": "..."
    }
  }
}
```

不能使用现有 `makeAgentFetchJSON()` 上传 multipart，因为它默认设置
`Content-Type: application/json`。推荐新增共享 HTTP helper，复用凭据 header 构造，
但由 `fetch` 自动生成 multipart boundary。

## 7. 文件级改动清单

### 7.1 服务端新增

| 文件 | 作用 |
| --- | --- |
| `openviking/parse/accessors/repository_snapshot_accessor.py` | 安全解包上传快照并输出 Git `LocalResource` |
| `tests/unit/test_repository_snapshot_accessor.py` | 元数据、ZIP 安全、cleanup、Accessor 选择 |
| `tests/api_test/resources/test_repository_snapshot.py` 或现有资源 E2E 文件 | 首次导入、二次增量更新、幂等 |

### 7.2 服务端修改

| 文件 | 修改 |
| --- | --- |
| `openviking/parse/accessors/registry.py` | 注册新 Accessor |
| `openviking/parse/accessors/__init__.py` | 导出新 Accessor |
| `openviking/utils/media_processor.py` | `SourceType.GIT` 显式走 `CodeRepositoryParser` |
| `openviking/service/resource_service.py` | 校验 `args.repository_snapshot` 组合和元数据 |
| `openviking/server/routers/resources.py` | 请求组合的快速校验，保持 Router 薄 |
| `sdk/python/openviking_sdk/client.py` | 可选：公共 `add_repository_snapshot()` |
| `docs/en/api/02-resources.md` | 文档化上传仓库快照 |
| `docs/zh/api/02-resources.md` | 中文文档同步 |

### 7.3 Hook/shared 新增

| 文件 | 作用 |
| --- | --- |
| `examples/trae-cli-memory-hooks/scripts/repository-sync.mjs` | TRAE CLI PostToolUse 薄入口 |
| `examples/memory-plugin-shared/lib/repository-sync.mjs` | 通用 Git 快照同步 runtime |
| `examples/memory-plugin-shared/repository-sync.test.mjs` | Git 事件、archive、去重、上传协议测试 |

若 shared runtime 过大，再拆分 `repository-git.mjs`、`repository-upload.mjs` 和
`repository-state.mjs`。

### 7.4 Hook/installer 修改

| 文件 | 修改 |
| --- | --- |
| `examples/trae-cli-memory-hooks/hooks/hooks.json` | 增加 `PostToolUse` |
| `examples/trae-cli-memory-hooks/openviking.integration.json` | capability/version 更新 |
| `examples/trae-cli-memory-hooks/README.md` | 说明本地仓库同步 |
| `examples/memory-plugin-shared/install.sh` | shared allowlist、归属识别、uninstall、validation |
| `examples/memory-plugin-shared/install-agent-hooks.test.mjs` | 安装幂等、第三方 PostToolUse 保留、卸载 |
| `examples/memory-plugin-shared/release-marketplace.test.mjs` | 若发布包测试覆盖 TRAE CLI，则检查新文件 |

### 7.5 明确不修改

- `openviking/parse/parsers/code/code.py` 的核心扫描逻辑；
- `openviking/parse/tree_builder.py`；
- `openviking/storage/viking_fs/_sync.py`；
- `openviking/storage/queuefs/semantic_processor.py`；
- `openviking/resource/watch_manager.py`；
- `openviking/resource/watch_scheduler.py`；
- `.github/scripts/stage-memory-plugin-marketplace.sh`，除非后续单独处理发布资产。

只有测试暴露真实兼容问题时才修改这些共享核心。

## 8. 实施步骤

### 阶段 1：服务端最小纵向验证

1. 定义 `repository_snapshot` 元数据校验。
2. 新增 `RepositorySnapshotAccessor`。
3. 注册 Accessor。
4. 让 `SourceType.GIT` 显式进入 `CodeRepositoryParser`。
5. 用手工 ZIP + `temp_file_id` 导入固定目标 URI。
6. 第二次上传修改后的 ZIP，验证 `SyncDiff`。

验收：

- Parser 为 `CodeRepositoryParser`；
- source format 为 `repository`；
- repo/ref/commit 元数据存在；
- 第二次没有创建副本；
- added/modified/deleted 正确；
- 上传内容被消费和清理。

### 阶段 2：API/SDK 完整性

1. 补 Router/Service 参数组合校验。
2. 补 Python SDK `add_repository_snapshot()`。
3. 补 API 文档。
4. 覆盖 local/shared temp upload 两种模式。

验收：

- 普通 ZIP 行为不变；
- `repository_snapshot` 不能用于远端 URL；
- `watch_interval > 0` 仍拒绝；
- 非法 SHA/branch/repo_key 返回清晰错误；
- Zip Slip 和符号链接测试通过。

### 阶段 3：共享 Hook runtime

1. 实现 Git mutation 判断。
2. 实现 repository context 获取。
3. 实现 stable target 和状态。
4. 实现 `git archive HEAD`。
5. 实现 multipart 上传和 `add_resource` 提交。
6. 实现 detached worker、锁、幂等、失败重试。

验收：

- 同一 HEAD 重复事件只提交一次；
- commit 后提交新任务；
- status/log/diff 不提交；
- Git/网络失败不影响父 Hook；
- 临时 ZIP 必定清理。

### 阶段 4：TRAE CLI 薄适配和 installer

1. 新增 `repository-sync.mjs` wrapper。
2. 在 `hooks.json` 注册 PostToolUse。
3. 更新 installer allowlist 和归属判断。
4. 更新 validation、uninstall 和 smoke test。
5. 更新 README。

验收：

- 重复安装只有一个仓库 Hook；
- 第三方 PostToolUse 保留；
- 卸载只移除 OpenViking Hook；
- `/hooks` 显示正确 source；
- 真实 TRAE CLI commit 触发一次上传。

### 阶段 5：真实 E2E

测试仓库初始提交：

```text
a.md
src/main.py
```

第二个提交：

```text
modify a.md
add b.md
delete src/main.py
```

验证：

1. 第一次 commit 后创建资源。
2. 第二次 commit 后更新同一 URI。
3. OpenViking 中 `a.md` 内容更新。
4. `b.md` 新增。
5. `src/main.py` 删除。
6. 搜索结果不再返回删除文件。
7. 重复触发不产生额外任务或资源副本。
8. 未提交文件不出现在 OpenViking。

## 9. 测试对齐矩阵

| 层 | 参考测试 | 新增测试重点 |
| --- | --- | --- |
| Git Accessor | `tests/unit/test_accessors_git.py` | 快照 Accessor 输出同形 `LocalResource` |
| ZIP 安全 | `ZipParser` / `zip_safe` 相关测试 | Zip Slip、symlink、压缩大小 |
| temp upload | `tests/server/test_api_resources.py` | local/shared 上传消费和清理 |
| Service 参数 | `tests/service/test_resource_service_watch.py` | snapshot 与 watch/path/add_type 互斥 |
| 增量资源 | `tests/misc/test_resource_processor_mv.py` | 二次 add 保留 temp URI |
| 增量语义 | `tests/storage/test_semantic_processor_target_preexisting.py` | modified/added/deleted 传给 DAG |
| Hook installer | `install-agent-hooks.test.mjs` | PostToolUse 幂等、保留第三方、卸载 |
| Hook runtime | shared runtime 新测试 | mutation、HEAD 去重、异步、清理 |

## 10. 关键实现决策

### 决策 1：Accessor 而不是新 Parser

本地快照与远端 Git 的差异是“如何取得仓库目录”，不是“如何解析代码仓库”。
因此新增 Accessor，复用 `CodeRepositoryParser`。

### 决策 2：显式元数据而不是 `.git_source_repo` 公共协议

隐藏 marker 是现有远端 ZIP 的内部兼容机制。新上传协议应显式携带 repo/ref/commit，
并由服务端校验。

### 决策 3：完整 HEAD 快照而不是客户端 Git diff

现有 `sync_tree` 已经是权威差异层。客户端只提供确定的完整 commit 快照，可减少
协议复杂度和恢复问题。

### 决策 4：上传在当前请求消费，prepared 后处理入队

`temp_file_id` 是一次性资源，不适合直接进入持久任务。当前请求先解包/解析，后续
摘要和向量通过现有 prepared task 异步完成。

### 决策 5：PostToolUse + detached worker

只有 PostToolUse 能确认工具成功；打包和上传必须脱离 Hook 父进程，避免阻塞 Agent。

### 决策 6：本地快照不使用 Watch

Watch 只能重读服务端可访问来源。上传快照的下一次更新由下一次 Git Hook 触发。

## 11. 风险和待确认项

1. TRAE CLI 真实 `tool_response` 的成功/失败字段需用 session 样本确认。
2. `Bash|RunCommand|Shell` 是否覆盖所有 TRAE CLI 命令工具，需要 `/hooks` 和真实事件验证。
3. detached Hook worker 在 TRAE CLI 退出后是否稳定存活，需要 E2E 验证。
4. 大仓库上传限制需要与 `TempUploadConfig.shared_max_size_bytes` 对齐。
5. `git archive` 不包含 submodule 内容，第一版需在文档明确。
6. detached HEAD 的 URI 映射策略需要确定，建议使用 `detached/<short-sha>`。
7. 无 origin 仓库的稳定 `repo_key` 应持久化在用户级状态，不写入仓库。
8. 任务乱序需要用 per-repo lock 和 commit 状态避免旧快照覆盖新快照。
9. `repo_name` 只用于展示，不能直接作为未经校验的 URI。
10. 发布/TOS staging 是否收录新 shared 文件应在实现完成后单独处理。

## 12. 最终对齐原则

实施时保持以下边界：

```text
TRAE CLI adapter
  只做事件协议适配

memory-plugin-shared
  负责 Git 事件、快照、上传、状态和重试

HTTP/SDK
  负责传输和请求校验

RepositorySnapshotAccessor
  负责将上传 ZIP 变成标准 Git LocalResource

CodeRepositoryParser 以后
  完全复用远端 Git 仓库链路
```

这与原项目“入口统一、Accessor 获取、Parser 解析、临时树后处理、增量层统一、
客户端适配薄化、installer 幂等组装”的风格保持一致，也把新增代码限制在真正不同
的输入层和 Hook 层。
