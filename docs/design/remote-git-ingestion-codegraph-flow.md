# 远程 Git 仓库从链接输入到 OpenViking 消化完成的调用链

## 1. 分析范围

本文基于 OpenViking 本地 CodeGraph 索引整理远程 Git 仓库的实际执行链。

索引信息：

- 项目：`/Users/bytedance/Desktop/OpenViking`
- 索引文件数：3,028
- CodeGraph 节点数：70,845
- CodeGraph 边数：209,068

本文回答：

1. 用户输入一个远程仓库 URL 后，请求如何进入 OpenViking。
2. 为什么公开 Git 仓库通常立即返回 `task_id`。
3. 仓库在何处下载、如何选择 ZIP 或 clone。
4. 仓库如何转换为 VikingFS 资源树。
5. 首次导入与已有资源更新有什么区别。
6. 摘要、语义和向量如何生成。
7. 什么时候可以认为仓库已经“消化完成”。
8. Watch 如何定期重新进入同一条处理链。

主要分析原生 Git 导入链。若 Connector 已启用并接管 Git 来源，请求会在
`ResourceService._submit_resource_ingestion()` 中提前分流到 Connector，见第 12 节。

## 2. 总览

```text
远程 Git URL
  |
  v
SDK / CLI / HTTP API
  |
  v
POST /api/v1/resources
  |
  v
ResourceService.add_resource
  |
  v
ResourceService._submit_resource_ingestion
  |
  +-- Connector 接管 --------------------> Connector 端到端导入
  |
  +-- 原生 Git，无请求级凭据
  |      |
  |      v
  |   enqueue_git_add_resource
  |      |
  |      +-- git ls-remote 预检
  |      +-- 规划并锁定目标 URI
  |      +-- AddResourceMsg 入持久队列
  |      +-- 立即返回 root_uri + task_id
  |                |
  |                v
  |        AddResourceProcessor Worker
  |
  +-- 原生 Git，带请求级 auth_config
         |
         v
      当前请求内消费凭据并获取仓库
      Parser 后只将无凭据 prepared 任务入队

Worker / 当前请求的共同后半段
  |
  v
UnifiedResourceProcessor
  |
  v
GitAccessor
  |
  +-- GitHub ZIP 优先，失败回退 clone
  +-- GitLab ZIP 优先，失败回退 clone
  +-- 其他代码托管地址 shallow clone
  |
  v
服务端本地临时仓库目录
  |
  v
DirectoryParser
  |
  v
CodeRepositoryParser
  |
  v
VikingFS 临时资源树
  |
  v
TreeBuilder
  |
  +-- 首次导入：持久化到最终 URI
  +-- 已有目标：保留临时树供差异同步
  |
  v
SemanticQueue
  |
  v
SemanticProcessor
  |
  +-- sync_tree 计算 added/modified/deleted
  +-- SemanticDagExecutor 增量生成摘要
  +-- vectorize_file 派发 embedding
  |
  v
TaskTracker 等待全部派生子任务
  |
  v
TaskTracker.complete
```

## 3. 第一阶段：客户端形成请求

### 3.1 Python SDK

文件：

- `sdk/python/openviking_sdk/client.py`

函数：

- `AsyncHTTPClient.add_resource()`
- 同步包装 `SyncHTTPClient.add_resource()`

远程 URL 不存在于客户端本地文件系统，因此 SDK 不执行本地上传，而是直接形成：

```json
{
  "path": "https://github.com/org/repo.git",
  "to": "viking://resources/...",
  "parent": null,
  "reason": "",
  "instruction": "",
  "wait": false,
  "watch_interval": 0,
  "processing_mode": "semantic_and_vectors",
  "args": {
    "branch": "main"
  }
}
```

`branch`、`commit` 和 `auth_config` 都通过 `args` 传入：

```json
{
  "args": {
    "branch": "main",
    "commit": null,
    "auth_config": {
      "username": "oauth2",
      "token": "..."
    }
  }
}
```

请求发送到：

```text
POST /api/v1/resources
```

### 3.2 Rust CLI

文件：

- `crates/ov_cli/src/client.rs`

函数：

- `HttpClient.add_resource()`

CLI 同样区分本地路径与远程 URL：

- 本地目录：压缩并调用 `temp_upload`。
- 远程 Git URL：直接把 URL 放入 `path`。

远程仓库不会在 CLI 所在机器预先下载。

## 4. 第二阶段：HTTP Router 校验和转发

文件：

- `openviking/server/routers/resources.py`
- `openviking/server/local_input_guard.py`

类型和函数：

- `AddResourceRequest`
- `routers.resources.add_resource()`
- `require_remote_resource_source()`

执行步骤：

1. Pydantic `AddResourceRequest` 校验 `path`、`temp_file_id`、`add_type`、
   `to`、`parent` 等组合。
2. 对远程 URL 调用 `require_remote_resource_source()`。
3. 禁止 HTTP 客户端把任意服务端本地路径作为 `path`。
4. 网络 URL 还会经过公开远端目标校验。
5. Router 将请求参数传给 `service.resources.add_resource()`。

Router 不负责：

- 判断 GitHub/GitLab 下载策略；
- clone 仓库；
- 解析代码；
- 写资源树；
- 建向量。

这是原项目保持 HTTP 层薄化的关键设计。

## 5. 第三阶段：ResourceService 顶层路由

文件：

- `openviking/service/resource_service.py`

主要调用链：

```text
ResourceService.add_resource()
  -> ResourceService._submit_resource_ingestion()
```

### 5.1 `add_resource()`

职责：

- 拒绝外部调用者传入内部执行字段；
- 规范化 `add_type`；
- 将请求送入 `_submit_resource_ingestion()`；
- 设置 `manage_watch=True`。

它本身不执行 Git 下载。

### 5.2 `_submit_resource_ingestion()`

职责：

1. 校验 `processing_mode`、tags 和 `args`。
2. 计算用户默认资源 parent。
3. 询问 Connector 是否接管。
4. 使用 `is_git_repo_url(path)` 判断原生 Git 来源。
5. 根据是否携带请求级凭据选择执行方式。
6. 根据 `wait` 决定立即返回任务，还是等待任务终态。

原生 Git 的两个分支：

#### 无 `args.auth_config`

```text
_submit_resource_ingestion()
  -> enqueue_git_add_resource()
```

仓库 URL 和非敏感 Parser 参数可写入持久队列。

#### 有 `args.auth_config`

凭据不能写入持久队列，因此：

```text
_submit_resource_ingestion()
  -> _execute_resource_ingestion()
  -> 当前请求内 GitAccessor 使用凭据获取和解析
  -> Parser 后的无凭据 prepared payload 入队
```

这个设计保证 Git token 在来源获取后被移除，不进入普通队列消息。

## 6. 第四阶段：原生 Git 异步任务入队

文件：

- `openviking/service/resource_service.py`
- `openviking/storage/queuefs/add_resource_msg.py`
- `openviking/service/task_tracker.py`

函数和类型：

- `enqueue_git_add_resource()`
- `_preflight_git_source()`
- `_plan_resource_target()`
- `_enqueue_add_resource_job()`
- `AddResourceMsg`
- `TaskTracker.create()`
- `TaskTracker.update_stage()`

### 6.1 Git 预检

`_preflight_git_source()` 执行：

```bash
git ls-remote --heads <repository-url>
```

用途：

- 验证仓库是否可访问；
- 10 秒超时；
- 获取仓库展示名；
- 将来源格式冻结为 `repository`。

它不是增量更新检查：

- 不保存远端 HEAD；
- 不比较上次 commit；
- 不决定是否跳过后续下载。

### 6.2 目标 URI 规划

`_plan_resource_target()` 调用：

```text
TreeBuilder.resolve_target_uri()
```

若用户指定 `to`，则使用精确目标；否则根据仓库名和 parent 自动规划。

随后对目标路径获取树锁，并转换为可交接给 Worker 的 lock handoff。

作用：

- 在任务真正下载仓库前保留目标；
- 防止并发任务同时写同一资源树；
- 自动命名时避免两个任务选中相同名称。

### 6.3 持久消息

`enqueue_git_add_resource()` 创建 `AddResourceMsg`，保存：

- `task_id`
- 仓库 URL
- `root_uri`
- account/user/role
- branch/commit 等非敏感 `args`
- include/exclude/ignore 参数
- processing mode
- watch interval
- lock handoff
- tags

然后调用：

```text
_enqueue_add_resource_job()
  -> QueueManager.enqueue(ADD_RESOURCE)
  -> handoff resource lock
  -> TaskTracker.create()
  -> TaskTracker.update_stage("queued")
```

`wait=false` 此时返回：

```json
{
  "status": "success",
  "root_uri": "viking://resources/...",
  "task_id": "..."
}
```

此时只代表“任务已可靠入队”，不代表仓库已经解析或建好索引。

## 7. 第五阶段：Worker 恢复任务

文件：

- `openviking/storage/queuefs/add_resource_processor.py`
- `openviking/service/resource_service.py`
- `openviking/service/task_tracker.py`

函数：

- `AddResourceProcessor._process()`
- `ResourceService.execute_add_resource_job()`
- `TaskTracker.start()`
- `TaskTracker.update_stage()`

Worker 执行：

1. 从消息恢复 `RequestContext`。
2. 创建或恢复 `TaskRecord`。
3. 接管目标资源锁；失败时可重新获取或有限重排队。
4. 将任务标记为 running，stage 为 `queued`。
5. 调用 `execute_add_resource_job()`。

对于远端 Git 消息，`msg.prepared is None`，因此：

```text
execute_add_resource_job()
  -> _execute_resource_ingestion(
       path=<repo-url>,
       to=<preplanned-root-uri>,
       defer_post_processing=False,
       manage_watch=True,
       resource_lock=<adopted-lock>,
       ...
     )
```

Worker 会在 stage callback 中持续更新：

- `queued`
- `fetching`
- `parsing`
- `finalizing`
- `processing_queue`

## 8. 第六阶段：来源获取

文件：

- `openviking/utils/resource_processor.py`
- `openviking/utils/media_processor.py`
- `openviking/parse/accessors/registry.py`
- `openviking/parse/accessors/git_accessor.py`

调用链：

```text
ResourceService._execute_resource_ingestion()
  -> ResourceProcessor.process_resource()
  -> UnifiedResourceProcessor.process()
  -> UnifiedResourceProcessor.prepare()
  -> AccessorRegistry.access()
  -> AccessorRegistry.get_accessor()
  -> GitAccessor.access()
```

### 8.1 Accessor 选择

`AccessorRegistry` 按优先级选择来源访问器。

远程 Git URL 命中 `GitAccessor.can_handle()`，而不是普通 HTTPAccessor。

Accessor 层解决：

> 如何把一个远程 Git 来源转换成服务端本地可读的仓库目录。

### 8.2 服务端临时目录

`GitAccessor.access()` 创建：

```text
/tmp/ov_git_*
```

这个目录位于 OpenViking 服务所在机器。

### 8.3 GitHub

无 `auth_config` 时：

1. 规范化仓库 URL 和 branch/commit。
2. 尝试 GitHub archive ZIP：

```text
https://github.com/<owner>/<repo>/archive/<ref>.zip
```

3. 安全解压。
4. ZIP 获取失败则清理残留，并回退：

```bash
git clone --depth 1 --no-recurse-submodules ...
```

### 8.4 GitLab

满足 ZIP helper 支持的仓库结构时：

1. 尝试 GitLab archive ZIP。
2. 失败后回退 shallow clone。

### 8.5 其他代码托管平台

直接执行：

```bash
git clone --depth 1 --no-recurse-submodules <url> <temp-dir>
```

### 8.6 branch 和 commit

- branch 且无 commit：clone 时使用 `--branch`。
- commit：clone 后 fetch commit 并 checkout。
- shallow fetch 找不到 commit 时逐步扩大 fetch 范围。

### 8.7 Accessor 输出

统一输出：

```python
LocalResource(
    path=<service-local-repository-dir>,
    source_type=SourceType.GIT,
    original_source=<remote-url>,
    meta={
        "repo_name": "...",
        "repo_ref": "...",
        "repo_commit": "...",
    },
    is_temporary=True,
)
```

Accessor 完成后，后续 Parser 不再访问网络。

## 9. 第七阶段：代码仓库解析

文件：

- `openviking/utils/media_processor.py`
- `openviking/parse/parsers/directory.py`
- `openviking/parse/parsers/code/code.py`
- `openviking/parse/parsers/upload_utils.py`

调用链：

```text
UnifiedResourceProcessor.process()
  -> DirectoryParser.parse()
  -> DirectoryParser._is_git_repository()
  -> CodeRepositoryParser.parse()
  -> CodeRepositoryParser._upload_directory()
  -> upload_directory()
```

### 9.1 为什么先进入 DirectoryParser

`GitAccessor` 输出的是本地目录。当前 `UnifiedResourceProcessor.process()` 对目录统一
选择 `DirectoryParser`。

### 9.2 如何识别为 Git 仓库

`DirectoryParser._is_git_repository()` 检查：

- 目录中存在 `.git/`；或
- 目录中存在 `.git_source_repo`。

clone 路径通常有 `.git/`。GitHub/GitLab ZIP 不带 `.git/`，因此 GitAccessor
会写入 `.git_source_repo` 内部 marker。

### 9.3 CodeRepositoryParser

`CodeRepositoryParser.parse()`：

1. 读取 `_source_meta` 中的 repo name/ref/commit。
2. 创建 VikingFS 临时 URI。
3. 在临时 URI 下创建 `repository` 根。
4. 递归扫描服务端本地仓库目录。
5. 应用 `.gitignore`、默认 ignore dirs、include/exclude。
6. 排除 `.git`、`node_modules`、二进制和不支持内容。
7. 保持目录结构，将文件写入 VikingFS 临时树。
8. 生成：

```python
ParseResult(
    source_path=<original-remote-url>,
    source_format="repository",
    parser_name="CodeRepositoryParser",
    temp_dir_path=<viking-temp-root>,
)
```

9. 在 result meta 中保留 repo name/ref/commit。

此阶段称为“全量解析”：

- 每次刷新都会重新扫描新快照；
- 不根据 Git diff 只解析少量文件。

### 9.4 本地下载目录清理

`UnifiedResourceProcessor.process()` 的 `finally` 调用：

```text
LocalResource.cleanup()
```

`GitAccessor` 创建的 `/tmp/ov_git_*` 会在 Parser 使用完后删除。

此后剩余数据已经位于 VikingFS 临时树，不再依赖 OS 临时目录。

## 10. 第八阶段：构建目标资源树

文件：

- `openviking/parse/tree_builder.py`
- `openviking/utils/resource_processor.py`

函数：

- `TreeBuilder.finalize_from_temp()`
- `ResourceProcessor.process_resource()`

`TreeBuilder.finalize_from_temp()`：

1. 检查 Parser 临时树。
2. 根据 `source_path`、`source_format=repository` 和显式 `to/parent` 确定最终 URI。
3. 生成 Context tree。
4. 返回：

```text
root.uri      最终资源 URI
root.temp_uri 新解析出的临时资源树
```

### 10.1 首次导入

若最终目标不存在：

```text
persist_temp_tree(temp_uri, root_uri)
```

新树直接持久化到最终位置。

### 10.2 已有目标

若最终目标已经存在：

- 不立即覆盖整个目标；
- `target_preexisting=True`；
- 保留新 `temp_uri`；
- 交给语义队列做内容差异同步。

这是后续增量更新的前提。

## 11. 第九阶段：摘要、增量同步和向量

文件：

- `openviking/utils/resource_processor.py`
- `openviking/utils/summarizer.py`
- `openviking/storage/queuefs/semantic_msg.py`
- `openviking/storage/queuefs/semantic_processor.py`
- `openviking/storage/viking_fs/_sync.py`
- `openviking/storage/queuefs/semantic_dag.py`
- `openviking/utils/embedding_utils.py`

调用链：

```text
ResourceProcessor.finish_prepared_resource()
  -> Summarizer.summarize()
  -> SemanticMsg(
       uri=<new-temp-tree>,
       target_uri=<final-resource-uri>,
       is_code_repo=True,
       target_preexisting=True/False
     )
  -> SemanticQueue
  -> SemanticProcessor.on_dequeue()
  -> SemanticProcessor._sync_topdown_recursive()
  -> VikingFS.sync_tree()
  -> SyncDiff.to_changes()
  -> SemanticDagExecutor(incremental_update=True)
  -> vectorize_file()
  -> EmbeddingQueue
```

### 11.1 `finish_prepared_resource()`

正常 `semantic_and_vectors` 且启用索引时，它调用 `Summarizer.summarize()`，
把语义任务放入 SemanticQueue。

传入两个重要 URI：

- `resource_uris=[root_uri]`
- `temp_uris=[temp_uri]`

以及：

- `is_code_repo=True`
- `target_preexisting`
- resource lock handoff

### 11.2 SemanticProcessor 同步临时树

若 `msg.uri != msg.target_uri`：

```text
_sync_topdown_recursive(temp_uri, target_uri)
  -> VikingFS.sync_tree()
```

`sync_tree()` 对新树和旧树逐目录、逐文件比较：

- 新文件：added；
- 内容变化文件：modified；
- 新快照已无的旧文件/目录：deleted；
- 内容不变：不替换。

默认文件比较：

1. 比较 size；
2. size 相同再读取内容比较。

输出：

```python
SyncDiff(
    added_files=[...],
    updated_files=[...],
    deleted_files=[...],
    added_dirs=[...],
    deleted_dirs=[...],
)
```

再转换为：

```json
{
  "added": [],
  "modified": [],
  "deleted": []
}
```

### 11.3 增量语义 DAG

同步完成后创建：

```text
SemanticDagExecutor(
  incremental_update=True,
  target_uri=<final-uri>,
  changes=<sync-diff>,
  is_code_repo=True
)
```

含义：

- 新增和修改文件重新生成需要的摘要与向量；
- 删除文件移除相应语义/向量；
- 未变化文件复用已有结果；
- 受影响的父目录 overview/abstract 刷新。

### 11.4 向量任务

`vectorize_file()`：

1. 读取文件内容或摘要。
2. 构建 Context 和 embedding payload。
3. 生成 `EmbeddingMsg`。
4. 写入 EmbeddingQueue。

真正的模型 embedding 由后续 embedding worker 完成。

## 12. 第十阶段：何时算“消化完成”

文件：

- `openviking/storage/queuefs/add_resource_processor.py`
- `openviking/service/task_tracker.py`
- `openviking/service/task_work_index.py`

函数：

- `AddResourceProcessor._process()`
- `TaskTracker.wait_for_descendants()`
- `TaskTracker.complete()`

资源 Worker 调用 `execute_add_resource_job()` 后，不会立即把主任务标记 completed。

它继续执行：

```text
TaskTracker.wait_for_descendants(task_id, work_id)
```

等待本次主任务派生出的：

- SemanticQueue 工作；
- EmbeddingQueue 工作；
- 其他登记到同一 work tree 的后处理。

全部子任务结束后才：

```text
TaskTracker.complete(task_id, result)
```

因此状态边界是：

| 状态 | 含义 |
| --- | --- |
| 收到 `task_id` | 任务已入队，目标 URI 已规划 |
| `fetching` | 正在获取远程仓库 |
| `parsing` | 正在扫描和解析代码仓库 |
| `finalizing` | 正在构建 VikingFS 资源树 |
| `processing_queue` | 摘要、差异同步、向量等后台工作进行中 |
| `completed` | 主任务和登记的派生子任务均完成 |

“仓库消化完成”应以 task completed 为准，而不是以 `root_uri` 已出现为准。

## 13. Connector 分叉

文件：

- `openviking/connector/delegate.py`
- `openviking/connector/client.py`
- `openviking/service/resource_service.py`

函数：

- `ConnectorDelegate.should_delegate()`
- `ConnectorDelegate.submit()`
- `ConnectorDelegate._monitor()`

在原生 Git 判断前，`_submit_resource_ingestion()` 先调用：

```text
ConnectorDelegate.should_delegate()
```

若：

- Connector 已启用；
- `git` 在 allowed add types 中；
- 参数受 Connector 支持；
- 提供精确 `to`；

请求会走：

```text
Connector doc/add
  -> Connector 自己获取和解析
  -> OpenViking 后台监控 Connector task/info
  -> 更新 OpenViking TaskRecord
```

此时不会进入本文第 6 至第 11 节的原生 `GitAccessor` 链。

若 Connector 不可用或参数不受支持，并且请求允许安全降级，则回到原生链。

显式 `add_type="git"` 是强制 Connector 路由，不允许静默降级。

## 14. Watch 更新链

文件：

- `openviking/service/resource_service.py`
- `openviking/resource/watch_manager.py`
- `openviking/resource/watch_scheduler.py`

函数：

- `_manage_watch_if_needed()`
- `_handle_watch_task_creation()`
- `WatchManager.create_task()`
- `WatchManager.update_task()`
- `WatchScheduler._check_and_execute_due_tasks()`
- `WatchScheduler._execute_stable_task()`
- `ResourceService.refresh_resource()`

首次导入传 `watch_interval > 0` 时，成功导入会保存：

- 远程仓库 URL；
- 固定目标 URI；
- branch/commit 等处理参数；
- build/summarize/processing mode；
- 下次执行时间；
- 私有仓库的私有 auth state。

到期后：

```text
WatchScheduler
  -> refresh_resource(
       path=<same-repo-url>,
       to=<same-target-uri>,
       manage_watch=False
     )
  -> _submit_resource_ingestion()
  -> 再次进入远程 Git 获取/解析/同步链
```

`manage_watch=False` 防止一次 Watch refresh 再创建或改写自己的 Watch 任务。

当前 Watch 策略：

- 每个周期重新获取完整仓库快照；
- 每个周期重新执行代码仓库解析；
- 最终写入和语义/向量按内容差异增量更新。

当前没有：

- 保存上次远端 HEAD；
- refresh 前先 `git ls-remote` 比较是否变化；
- 未变化时跳过下载和解析。

## 15. 首次导入与更新的差异

```text
                     首次导入                  已有资源更新
远端获取             完整快照                  完整快照
Parser               全量解析                  全量解析
VikingFS 临时树      新建                      新建
目标树处理           直接持久化                sync_tree 差异合并
摘要/语义            初次生成                  按变化刷新
向量                 初次生成                  新增/修改重建，删除清理
最终 URI             创建                      保持不变
```

远端 Git 更新不是“全量删除后重建”，也不是“只下载 Git diff”。

准确描述是：

> 全量获取、全量解析、文件级增量合并、语义与向量增量更新。

## 16. 关键文件与函数地图

| 阶段 | 文件 | 关键函数 |
| --- | --- | --- |
| Python SDK | `sdk/python/openviking_sdk/client.py` | `AsyncHTTPClient.add_resource()` |
| Rust CLI | `crates/ov_cli/src/client.rs` | `HttpClient.add_resource()` |
| HTTP 请求 | `openviking/server/routers/resources.py` | `AddResourceRequest`, `add_resource()` |
| 本地路径安全 | `openviking/server/local_input_guard.py` | `require_remote_resource_source()` |
| 顶层路由 | `openviking/service/resource_service.py` | `add_resource()`, `_submit_resource_ingestion()` |
| Git 入队 | 同上 | `enqueue_git_add_resource()` |
| Git 预检 | 同上 | `_preflight_git_source()` |
| 目标规划 | 同上 | `_plan_resource_target()` |
| 队列消息 | `openviking/storage/queuefs/add_resource_msg.py` | `AddResourceMsg` |
| Worker | `openviking/storage/queuefs/add_resource_processor.py` | `_process()` |
| Worker 执行 | `openviking/service/resource_service.py` | `execute_add_resource_job()` |
| Accessor 路由 | `openviking/parse/accessors/registry.py` | `get_accessor()`, `access()` |
| Git 获取 | `openviking/parse/accessors/git_accessor.py` | `access()`, `_git_clone()`, `_github_zip_download()` |
| 统一处理 | `openviking/utils/media_processor.py` | `prepare()`, `process()` |
| 仓库识别 | `openviking/parse/parsers/directory.py` | `parse()`, `_is_git_repository()` |
| 代码解析 | `openviking/parse/parsers/code/code.py` | `parse()`, `_upload_directory()` |
| 目标树 | `openviking/parse/tree_builder.py` | `resolve_target_uri()`, `finalize_from_temp()` |
| 后处理 | `openviking/utils/resource_processor.py` | `process_resource()`, `finish_prepared_resource()` |
| 语义入队 | `openviking/utils/summarizer.py` | `summarize()` |
| 语义 Worker | `openviking/storage/queuefs/semantic_processor.py` | `on_dequeue()`, `_sync_topdown_recursive()` |
| 差异同步 | `openviking/storage/viking_fs/_sync.py` | `sync_tree()`, `SyncDiff` |
| 增量 DAG | `openviking/storage/queuefs/semantic_dag.py` | `SemanticDagExecutor` |
| 向量入队 | `openviking/utils/embedding_utils.py` | `vectorize_file()` |
| 任务终态 | `openviking/service/task_tracker.py` | `wait_for_descendants()`, `complete()` |
| Watch | `openviking/resource/watch_manager.py` | `create_task()`, `update_task()` |
| Watch 调度 | `openviking/resource/watch_scheduler.py` | `_execute_stable_task()` |
| Connector | `openviking/connector/delegate.py` | `should_delegate()`, `submit()`, `_monitor()` |

## 17. 对本地仓库上传设计的直接启示

远程 Git 链可以分成两个边界：

```text
来源获取边界：
remote URL -> GitAccessor -> LocalResource(SourceType.GIT)

统一消化边界：
LocalResource(SourceType.GIT)
  -> CodeRepositoryParser
  -> TreeBuilder
  -> sync_tree
  -> SemanticDagExecutor
  -> embedding
```

本地仓库上传只需要对齐第一个边界：

```text
local repo
  -> git archive HEAD
  -> temp_upload
  -> RepositorySnapshotAccessor
  -> LocalResource(SourceType.GIT)
```

从 `LocalResource(SourceType.GIT)` 开始，直接进入本文第 9 至第 12 节，不需要复制：

- `CodeRepositoryParser`
- `TreeBuilder`
- `sync_tree`
- `SemanticDagExecutor`
- embedding
- TaskTracker

这也是本地仓库方案应与原项目保持一致的最小插入点。
