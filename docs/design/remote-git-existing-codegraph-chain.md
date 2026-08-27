# 远程 Git 仓库现有函数链

## 1. 说明

本文只记录 OpenViking 当前代码已经存在的远程 Git 仓库导入链路。

- 不包含本地仓库上传方案。
- 不包含任何建议新增的函数。
- 不描述未来修改方式。
- 文中的函数和行号均来自当前 CodeGraph 索引。

索引规模：

- 3,028 个文件
- 70,845 个节点
- 209,068 条边

## 2. 主链总览

用户通过 HTTP 输入远程 Git URL，且 Connector 未接管时，当前原生链为：

```text
1. routers.resources.add_resource()
   |
   v
2. ResourceService.add_resource()
   |
   v
3. ResourceService._submit_resource_ingestion()
   |
   +---------------------------------------------------+
   |                                                   |
   | 无请求级 auth_config                              | 带请求级 auth_config
   v                                                   v
4A. ResourceService.enqueue_git_add_resource()      4B. ResourceService._execute_resource_ingestion()
   |                                                   |
   +-> 5A. _preflight_git_source()                      +-> 当前请求内获取和解析仓库
   +-> 6A. _plan_resource_target()                      +-> 无凭据 prepared 任务入队
   +-> 7A. _enqueue_add_resource_job()                  |
   +-> 8A. AddResourceMsg                               |
   +-> 返回 root_uri + task_id                          |
   |                                                   |
   v                                                   |
9. AddResourceProcessor._process() <--------------------+
   |
   v
10. ResourceService.execute_add_resource_job()
   |
   v
11. ResourceService._execute_resource_ingestion()
   |
   v
12. ResourceProcessor.process_resource()
   |
   v
13. UnifiedResourceProcessor.process()
   |
   +-> 14. UnifiedResourceProcessor.prepare()
   |       |
   |       v
   |   15. AccessorRegistry.access()
   |       |
   |       +-> 16. AccessorRegistry.get_accessor()
   |       |       |
   |       |       v
   |       |   17. GitAccessor.can_handle()
   |       |
   |       v
   |   18. GitAccessor.access()
   |       |
   |       +-> GitHub ZIP / GitLab ZIP / git clone
   |       |
   |       v
   |   19. LocalResource(SourceType.GIT)
   |
   v
20. DirectoryParser.parse()
   |
   +-> 21. DirectoryParser._is_git_repository()
   |
   v
22. CodeRepositoryParser.parse()
   |
   +-> 23. CodeRepositoryParser._upload_directory()
   |
   v
24. TreeBuilder.finalize_from_temp()
   |
   v
25. ResourceProcessor.finish_prepared_resource()
   |
   v
26. Summarizer.summarize()
   |
   v
27. SemanticProcessor.on_dequeue()
   |
   +-> 28. SemanticProcessor._sync_topdown_recursive()
   |       |
   |       v
   |   29. VikingFS.sync_tree()
   |
   v
30. SemanticDagExecutor.run()
   |
   +-> 31. vectorize_file()
   |
   v
32. TaskTracker.wait_for_descendants()
   |
   v
33. TaskTracker.complete()
```

## 3. HTTP 入口

### 3.1 `routers.resources.add_resource()`

文件：

```text
openviking/server/routers/resources.py
```

位置：

```text
line 210
```

当前职责：

1. 接收 `AddResourceRequest`。
2. 远程 URL 走 `require_remote_resource_source()`。
3. 将 `path`、`to`、`parent`、`args`、`watch_interval`、`wait` 等参数传给
   `ResourceService.add_resource()`。
4. 使用 `response_from_result()` 返回 HTTP 响应。

远程 URL 在此处不下载，也不解析。

## 4. Service 入口与顶层分流

### 4.1 `ResourceService.add_resource()`

文件：

```text
openviking/service/resource_service.py
```

位置：

```text
line 812
```

当前职责：

1. 拒绝外部请求传入内部执行字段。
2. 规范化 `add_type`。
3. 调用 `_submit_resource_ingestion()`。
4. 设置 `manage_watch=True`。

调用边：

```text
add_resource()
  -> _submit_resource_ingestion()
```

### 4.2 `ResourceService._submit_resource_ingestion()`

文件：

```text
openviking/service/resource_service.py
```

位置：

```text
line 906
```

当前职责：

1. 调用 `_normalize_add_resource_args()`。
2. 判断 Connector 是否接管。
3. 使用 `is_git_repo_url(path)` 判断原生 Git URL。
4. 根据 `auth_config` 选择 Git 执行路径。
5. 根据 `wait` 决定返回任务还是等待任务完成。

当前 Git 分支：

```text
无 auth_config
  -> enqueue_git_add_resource()

有 auth_config
  -> _execute_resource_ingestion()
```

## 5. 无请求级凭据：Git 任务入队

### 5.1 `ResourceService.enqueue_git_add_resource()`

文件：

```text
openviking/service/resource_service.py
```

位置：

```text
line 586
```

当前职责：

1. 规范化 Parser 参数。
2. 拒绝把 Git 凭据写入持久任务。
3. 创建 `ContentTargetSpec`。
4. 调用 `_preflight_git_source()`。
5. 调用 `_plan_resource_target()`。
6. 构造 `AddResourceMsg`。
7. 调用 `_enqueue_add_resource_job()`。
8. 返回 `root_uri` 和 `task_id`。

### 5.2 `ResourceService._preflight_git_source()`

文件：

```text
openviking/service/resource_service.py
```

位置：

```text
line 779
```

当前执行：

```bash
git ls-remote --heads <repository-url>
```

当前用途：

- 确认仓库可访问。
- 10 秒超时。
- 计算展示名称。
- 将 source format 标记为 `repository`。

当前没有：

- 保存远端 HEAD。
- 比较上一次 commit。
- 在仓库未变化时跳过导入。

### 5.3 `ResourceService._plan_resource_target()`

文件：

```text
openviking/service/resource_service.py
```

位置：

```text
line 726
```

调用：

```text
_plan_resource_target()
  -> TreeBuilder.resolve_target_uri()
```

当前职责：

1. 根据 `to`、`parent`、仓库名和 source format 计算目标 URI。
2. 自动命名时预留唯一目标。
3. 获取目标资源树锁。

### 5.4 `ResourceService._enqueue_add_resource_job()`

文件：

```text
openviking/service/resource_service.py
```

位置：

```text
line 449
```

当前调用链：

```text
_enqueue_add_resource_job()
  -> QueueManager.enqueue()
  -> resource lock handoff
  -> TaskTracker.create()
  -> TaskTracker.update_stage("queued")
```

### 5.5 `AddResourceMsg`

文件：

```text
openviking/storage/queuefs/add_resource_msg.py
```

位置：

```text
line 12
```

当前保存：

- `task_id`
- 仓库 URL
- `root_uri`
- account/user/role
- branch/commit 等 `args`
- include/exclude/ignore 参数
- processing mode
- watch interval
- lock handoff
- tags

此时返回 `task_id` 仅代表任务已经入队。

## 6. 带请求级凭据：当前请求先消费凭据

当前调用链：

```text
ResourceService._submit_resource_ingestion()
  -> ResourceService._execute_resource_ingestion()
  -> GitAccessor 使用 auth_config 获取仓库
  -> Parser / TreeBuilder
  -> 无凭据 prepared payload 入队
```

原因：

- Git token 不能进入持久队列。
- 凭据在当前请求的 Accessor 阶段消费。
- 获取和 Parser 完成后，才把不含凭据的后处理任务入队。

最终后处理仍进入与无凭据路径相同的 Worker 和任务系统。

## 7. Worker 恢复持久任务

### 7.1 `AddResourceProcessor._process()`

文件：

```text
openviking/storage/queuefs/add_resource_processor.py
```

位置：

```text
line 84
```

当前职责：

1. 从 `AddResourceMsg` 恢复 `RequestContext`。
2. 创建或恢复 `TaskRecord`。
3. 接管目标资源锁。
4. 标记任务 running。
5. 调用 `ResourceService.execute_add_resource_job()`。
6. 失败时标记 failed。
7. 成功后等待派生任务。
8. 最终标记 completed。

### 7.2 `ResourceService.execute_add_resource_job()`

文件：

```text
openviking/service/resource_service.py
```

位置：

```text
line 487
```

对于普通远程 Git 消息：

```text
msg.prepared is None
```

因此调用：

```text
execute_add_resource_job()
  -> _execute_resource_ingestion(
       path=<repository-url>,
       to=<planned-root-uri>,
       defer_post_processing=False,
       manage_watch=True,
       resource_lock=<adopted-lock>
     )
```

## 8. 执行资源导入

### 8.1 `ResourceService._execute_resource_ingestion()`

文件：

```text
openviking/service/resource_service.py
```

位置：

```text
line 1158
```

当前职责：

1. 构建 `ContentTargetSpec`。
2. 设置 telemetry 和 stage callback。
3. 调用 `ResourceProcessor.process_resource()`。
4. 管理后处理任务和 Watch。
5. 返回 `root_uri` / `task_id` / 状态。

主调用：

```text
_execute_resource_ingestion()
  -> ResourceProcessor.process_resource()
```

## 9. ResourceProcessor 和 Accessor 路由

### 9.1 `ResourceProcessor.process_resource()`

文件：

```text
openviking/utils/resource_processor.py
```

位置：

```text
line 155
```

调用：

```text
process_resource()
  -> UnifiedResourceProcessor.process()
```

当前职责：

- 更新 fetching/parsing/finalizing stage。
- 驱动来源获取和 Parser。
- 调用 TreeBuilder。
- 处理首次持久化和已有目标。
- 准备后处理信息。

### 9.2 `UnifiedResourceProcessor.process()`

文件：

```text
openviking/utils/media_processor.py
```

位置：

```text
line 172
```

当前调用：

```text
process()
  -> prepare()
  -> Parser
```

### 9.3 `UnifiedResourceProcessor.prepare()`

文件：

```text
openviking/utils/media_processor.py
```

位置：

```text
line 151
```

当前调用：

```text
prepare()
  -> AccessorRegistry.access(source, **kwargs)
```

## 10. Accessor 选择

### 10.1 `AccessorRegistry.access()`

文件：

```text
openviking/parse/accessors/registry.py
```

位置：

```text
line 156
```

调用：

```text
access()
  -> get_accessor()
  -> selected_accessor.access()
```

### 10.2 `AccessorRegistry.get_accessor()`

文件：

```text
openviking/parse/accessors/registry.py
```

位置：

```text
line 135
```

当前行为：

1. 按 priority 遍历 Accessor。
2. 将 kwargs 传给支持 `**kwargs` 的 `can_handle()`。
3. 返回第一个匹配的 Accessor。

远程 Git URL 命中 `GitAccessor`。

## 11. GitAccessor 获取仓库

### 11.1 `GitAccessor.can_handle()`

文件：

```text
openviking/parse/accessors/git_accessor.py
```

位置：

```text
line 60
```

当前支持：

- `git@...`
- `git://...`
- `ssh://...`
- GitHub/GitLab/Bitbucket 等代码托管 URL
- 本地 `.git` 路径

当前明确不接管本地 `.zip`。

### 11.2 `GitAccessor.access()`

文件：

```text
openviking/parse/accessors/git_accessor.py
```

位置：

```text
line 94
```

当前执行：

1. 创建 `/tmp/ov_git_*`。
2. 解析 branch/commit/auth。
3. 获取仓库快照。
4. 构造 metadata。
5. 返回 `LocalResource(SourceType.GIT)`。
6. 异常时清理临时目录。

### 11.3 GitHub 获取分支

调用：

```text
GitAccessor.access()
  -> _github_zip_download()
```

位置：

```text
GitAccessor._github_zip_download()                      line 444
```

当前逻辑：

1. 下载 archive ZIP。
2. 安全解压。
3. 删除下载 ZIP。
4. 定位单一根目录。
5. 写 `.git_source_repo` marker。
6. ZIP 失败时回退 `_git_clone()`。

### 11.4 GitLab 获取分支

位置：

```text
GitAccessor._gitlab_zip_download()                      line 538
```

当前逻辑：

- 支持的 GitLab URL 优先 archive ZIP。
- ZIP 失败回退 `_git_clone()`。

### 11.5 clone 路径

位置：

```text
GitAccessor._git_clone()                                line 367
```

当前命令：

```bash
git clone --depth 1 --no-recurse-submodules ...
```

指定 commit 时继续 fetch 和 checkout。

### 11.6 Accessor 输出

当前输出：

```python
LocalResource(
    path=local_dir,
    source_type=SourceType.GIT,
    original_source=source_url,
    meta={
        "repo_name": repo_name,
        "repo_ref": branch,
        "repo_commit": commit,
    },
    is_temporary=True,
)
```

这是来源获取层与 Parser 层的现有边界。

## 12. Parser 链

### 12.1 `DirectoryParser.parse()`

文件：

```text
openviking/parse/parsers/directory.py
```

位置：

```text
line 72
```

`UnifiedResourceProcessor.process()` 发现 Accessor 输出是目录后，调用
`DirectoryParser.parse()`。

### 12.2 `DirectoryParser._is_git_repository()`

位置：

```text
line 617
```

当前检查：

```text
.git/ exists
OR
.git_source_repo exists
```

clone 路径使用 `.git/`；GitHub/GitLab ZIP 路径使用 `.git_source_repo`。

命中后调用：

```text
CodeRepositoryParser.parse()
```

### 12.3 `CodeRepositoryParser.parse()`

文件：

```text
openviking/parse/parsers/code/code.py
```

位置：

```text
line 112
```

当前职责：

1. 读取 repo name/ref/commit。
2. 创建 VikingFS temp URI。
3. 调用 `_upload_directory()`。
4. 生成 `ParseResult`。
5. 设置 `source_format="repository"`。

### 12.4 `CodeRepositoryParser._upload_directory()`

位置：

```text
line 582
```

当前调用共享 `upload_directory()`：

- 递归扫描仓库。
- 应用 `.gitignore`。
- 应用默认 ignore dirs。
- 应用 include/exclude。
- 保持目录结构。
- 将文件写入 VikingFS 临时树。

## 13. TreeBuilder 与首次/更新分支

### 13.1 `TreeBuilder.finalize_from_temp()`

文件：

```text
openviking/parse/tree_builder.py
```

位置：

```text
line 146
```

当前职责：

- 读取 Parser 临时树。
- 结合 source URL、`source_format="repository"`、`to/parent` 计算目标。
- 返回最终 `root.uri` 和新解析的 `root.temp_uri`。

### 13.2 首次导入

目标不存在时：

```text
ResourceProcessor.process_resource()
  -> persist_temp_tree(temp_uri, root_uri)
```

### 13.3 已有目标

目标存在时：

- 设置 `target_preexisting=True`。
- 不直接覆盖整个目标。
- 保留新的 temp tree。
- 交给语义队列进行差异同步。

## 14. 后处理与增量同步

### 14.1 `ResourceProcessor.finish_prepared_resource()`

文件：

```text
openviking/utils/resource_processor.py
```

位置：

```text
line 466
```

正常模式下调用：

```text
Summarizer.summarize()
```

传入：

- final `root_uri`
- new `temp_uri`
- `is_code_repo=True`
- `target_preexisting`
- resource lock

### 14.2 `Summarizer.summarize()`

文件：

```text
openviking/utils/summarizer.py
```

位置：

```text
line 94
```

构造 `SemanticMsg` 并写入 SemanticQueue。

### 14.3 `SemanticProcessor.on_dequeue()`

文件：

```text
openviking/storage/queuefs/semantic_processor.py
```

位置：

```text
line 276
```

若 temp URI 与 target URI 不同，则调用：

```text
_sync_topdown_recursive()
```

### 14.4 `SemanticProcessor._sync_topdown_recursive()`

位置：

```text
line 709
```

调用：

```text
VikingFS.sync_tree()
```

### 14.5 `VikingFS.sync_tree()`

文件：

```text
openviking/storage/viking_fs/_sync.py
```

位置：

```text
line 46
```

当前处理：

- added files/dirs
- modified files
- deleted files/dirs
- unchanged files

输出 `SyncDiff`，随后转换为 `added/modified/deleted` changes。

## 15. 语义和向量

### 15.1 `SemanticDagExecutor.run()`

文件：

```text
openviking/storage/queuefs/semantic_dag.py
```

现有行为：

- 首次导入执行完整语义 DAG。
- 已有目标以 `incremental_update=True` 和 changes 执行增量 DAG。
- 更新变化文件。
- 删除消失文件的派生数据。
- 刷新受影响的父级摘要。

### 15.2 `vectorize_file()`

文件：

```text
openviking/utils/embedding_utils.py
```

位置：

```text
line 482
```

当前职责：

1. 读取文件或摘要。
2. 构造 embedding Context。
3. 构造 `EmbeddingMsg`。
4. 写入 EmbeddingQueue。

## 16. 任务完成

### 16.1 `TaskTracker.wait_for_descendants()`

文件：

```text
openviking/service/task_tracker.py
```

位置：

```text
line 790
```

`AddResourceProcessor._process()` 在主处理返回后等待当前任务派生出的语义与 embedding
工作。

### 16.2 `TaskTracker.complete()`

全部登记的子任务结束后，主任务才标记 completed。

因此：

```text
收到 task_id != 仓库消化完成
task status completed == 仓库及派生任务完成
```

## 17. 当前链的阶段表

| 阶段 | 当前函数 | 当前行为 |
| --- | --- | --- |
| HTTP 接收 | `routers.resources.add_resource()` | 参数转发 |
| Service 入口 | `ResourceService.add_resource()` | 统一入口 |
| 顶层路由 | `_submit_resource_ingestion()` | Connector/Git/标准链分流 |
| Git 预检 | `_preflight_git_source()` | `git ls-remote --heads` |
| 目标规划 | `_plan_resource_target()` | URI + lock |
| 持久任务 | `_enqueue_add_resource_job()` | Queue + TaskRecord |
| Worker | `AddResourceProcessor._process()` | 恢复上下文和锁 |
| 执行 | `execute_add_resource_job()` | 恢复 Git 请求 |
| 资源处理 | `_execute_resource_ingestion()` | 调 ResourceProcessor |
| Accessor | `GitAccessor.access()` | ZIP/clone 到服务端本地 |
| Parser | `CodeRepositoryParser.parse()` | 仓库扫描到 VikingFS temp |
| Tree | `TreeBuilder.finalize_from_temp()` | 规划最终树 |
| 差异 | `VikingFS.sync_tree()` | added/modified/deleted |
| 语义 | `SemanticDagExecutor.run()` | 摘要和增量处理 |
| 向量 | `vectorize_file()` | embedding 入队 |
| 终态 | `TaskTracker.complete()` | 主任务完成 |

## 18. 当前链的准确语义

远程仓库首次导入和后续刷新当前均采用：

```text
全量获取仓库快照
  -> 全量扫描和解析
  -> 生成新的 VikingFS 临时树
  -> 首次直接持久化，更新时做文件级差异合并
  -> 按差异更新语义和向量
  -> 等待派生任务完成
```

本文到此为止，只描述当前代码现状。
