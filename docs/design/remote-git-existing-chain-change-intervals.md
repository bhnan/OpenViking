# 远程 Git 现有链上的潜在变更区间

## 1. 说明

本文以当前代码的远程 Git 基线链为唯一底稿：

- `docs/design/remote-git-existing-codegraph-chain.md`

本文只在现有函数和节点上标注：

- 高概率修改；
- 可能修改；
- 仅透传、预计不修改；
- 后半段共享链、应保持不动。

本文不新增函数名，不定义新接口，也不展开具体实现。

## 2. 现有链与影响区间总览

```text
routers.resources.add_resource()
  |
  v
ResourceService.add_resource()
  |
  v
ResourceService._submit_resource_ingestion()
  |
  +-> ResourceService._normalize_add_resource_args()
  |
  v
ResourceService._execute_resource_ingestion()
  |
  v
ResourceProcessor.process_resource()
  |
  v
UnifiedResourceProcessor.process()
  |
  +-> UnifiedResourceProcessor.prepare()
          |
          v
      AccessorRegistry.access()
          |
          +-> AccessorRegistry.get_accessor()
                  |
                  v
              GitAccessor.can_handle()
                  |
                  v
              GitAccessor.access()
                  |
                  +-> GitAccessor._extract_zip()
                  |
                  v
              LocalResource(SourceType.GIT)
                  |
                  v
DirectoryParser.parse()
  |
  +-> DirectoryParser._is_git_repository()
  |
  v
CodeRepositoryParser.parse()
  |
  v
TreeBuilder.finalize_from_temp()
  |
  v
ResourceProcessor.finish_prepared_resource()
  |
  v
SemanticProcessor / VikingFS / embedding / TaskTracker
```

影响区间：

```text
区间 A：请求边界
routers.resources.add_resource()
  -> ResourceService._normalize_add_resource_args()
状态：可能修改

区间 B：标准资源透传
ResourceService._submit_resource_ingestion()
  -> UnifiedResourceProcessor.prepare()
状态：预计不修改

区间 C：Accessor 路由和仓库获取
AccessorRegistry.get_accessor()
  -> GitAccessor.can_handle()
  -> GitAccessor.access()
  -> GitAccessor._extract_zip()
状态：高概率修改集中区

区间 D：仓库 Parser 入口
LocalResource(SourceType.GIT)
  -> DirectoryParser.parse()
  -> DirectoryParser._is_git_repository()
  -> CodeRepositoryParser.parse()
状态：可能修改，但最小方案可不改

区间 E：仓库消化后半段
CodeRepositoryParser.parse()
  -> TreeBuilder
  -> sync_tree
  -> 语义/向量
  -> TaskTracker
状态：应保持不动
```

## 3. 区间 A：请求边界

### 3.1 `AddResourceRequest`

文件：

```text
openviking/server/routers/resources.py
```

当前节点：

```text
AddResourceRequest                                  line 26
check_path_or_temp_file_id()                       line 105
check_add_type()                                   line 111
```

分类：**可能修改**

可能涉及：

- 校验上传文件、远程 path、Connector add type、Watch 参数是否形成合法组合；
- 对明显冲突的请求尽早返回 HTTP 400；
- 保持普通文件、普通 ZIP 和远程 Git 请求行为不变。

是否必须修改：

- 不一定。
- 若所有约束统一放在 Service 层，现有 Router 可以保持不动。
- 若希望 HTTP 请求在进入 Service 前就得到更清晰的错误，则可能修改现有 validators。

影响范围：

- HTTP API 请求模型；
- 生成的 Web/TypeScript API 类型；
- `tests/server/test_api_resources.py`。

### 3.2 `routers.resources.add_resource()`

文件：

```text
openviking/server/routers/resources.py
```

位置：

```text
line 210
```

分类：**预计不修改**

当前已经支持：

- `temp_file_id`；
- `args`；
- `to`；
- `allow_local_path_resolution=True`；
- 上传文件成功消费和失败恢复；
- finally 清理。

只有在上传仓库需要新的顶层 HTTP 字段时才可能修改。当前方向是继续使用现有
`args`，因此 Router 主体预计不变。

### 3.3 `TempUploadStore.resolve_for_consume()`

文件：

```text
openviking/server/temp_upload_store.py
```

位置：

```text
line 128
```

分类：**预计不修改**

当前职责只是把 `temp_file_id` 转成服务端本地普通文件，已符合输入要求。

上传内容属于哪种资源，应由后面的 Accessor 判断，而不是由 TempUploadStore 判断。

## 4. 区间 A/B 交界：Service 参数归一化

### 4.1 `ResourceService.add_resource()`

文件：

```text
openviking/service/resource_service.py
```

位置：

```text
line 812
```

分类：**预计不修改**

当前已是所有资源的统一入口，不应增加本地仓库专用分支。

### 4.2 `ResourceService._normalize_add_resource_args()`

文件：

```text
openviking/service/resource_service.py
```

位置：

```text
line 327
```

分类：**高概率修改**

原因：

- 当前所有 Accessor/Parser 专属参数都从这里归一化；
- 它是 HTTP、SDK、内部 Service 调用共同经过的校验点；
- 现有代码已在这里处理 parse mode 和 Feishu token/watch 约束；
- 上传仓库的身份、分支和 commit 信息同样属于来源专属参数。

可能涉及：

- 校验仓库快照元数据是对象；
- 校验版本、仓库身份、仓库名称、分支和 commit；
- 拒绝与 `watch_interval > 0` 组合；
- 将规范化后的参数继续放入 `processor_kwargs`；
- 不改变远程 Git 的 branch/commit/auth 参数行为。

影响范围：

- 所有 `add_resource` 调用方；
- Watch 参数测试；
- Service 参数测试；
- 持久任务参数序列化。

需要重点验证：

- 普通空 `args`；
- 远程 Git `branch/commit`；
- 远程私有 Git `auth_config`；
- Feishu token；
- Web feed 参数；
- 普通 ZIP。

## 5. 区间 B：标准资源透传

以下节点的职责都是把已归一化参数传到 Accessor，预计不需要修改。

### 5.1 `ResourceService._submit_resource_ingestion()`

文件：

```text
openviking/service/resource_service.py
```

位置：

```text
line 906
```

分类：**预计不修改**

当前上传文件不是远程 Git URL，会自然进入标准资源链。

不应把上传仓库塞进 `enqueue_git_add_resource()`，因为该函数的输入是可重复读取的
远程 URL，并会执行 `git ls-remote`。

### 5.2 `ResourceService._execute_resource_ingestion()`

文件：

```text
openviking/service/resource_service.py
```

位置：

```text
line 1158
```

分类：**预计不修改**

当前已将 `kwargs` 传给 `ResourceProcessor.process_resource()`，并能在 Parser 完成后
把无上传依赖的 prepared 后处理任务入队。

### 5.3 `ResourceProcessor.process_resource()`

文件：

```text
openviking/utils/resource_processor.py
```

位置：

```text
line 155
```

分类：**预计不修改**

当前已负责 Parser、TreeBuilder、首次持久化和增量后处理。

### 5.4 `UnifiedResourceProcessor.process()`

文件：

```text
openviking/utils/media_processor.py
```

位置：

```text
line 172
```

分类：**预计不修改，存在条件性调整可能**

最小方案中：

- Accessor 返回服务端本地目录；
- 目录继续走 `DirectoryParser`；
- 不需要修改。

只有在后续决定根据 `SourceType.GIT` 直接选择 `CodeRepositoryParser`，不再依赖
`.git_source_repo` marker 时，才可能修改该节点。

### 5.5 `UnifiedResourceProcessor.prepare()`

文件：

```text
openviking/utils/media_processor.py
```

位置：

```text
line 151
```

分类：**预计不修改**

当前已经将来源和全部 kwargs 交给 `AccessorRegistry.access()`。

## 6. 区间 C：Accessor 路由和仓库获取

这是高概率发生代码修改的核心区间。

### 6.1 `AccessorRegistry.access()`

文件：

```text
openviking/parse/accessors/registry.py
```

位置：

```text
line 156
```

分类：**预计不修改**

当前已执行：

```text
access()
  -> get_accessor(source, **kwargs)
  -> selected_accessor.access(source, **kwargs)
```

### 6.2 `AccessorRegistry.get_accessor()`

文件：

```text
openviking/parse/accessors/registry.py
```

位置：

```text
line 135
```

分类：**预计不修改**

当前已经：

- 按 priority 选择；
- 将 kwargs 传给 `can_handle()`；
- GitAccessor 优先级高于 LocalAccessor。

只要现有 `GitAccessor.can_handle()` 能对特定上传 ZIP 返回 true，Registry 不需要改。

### 6.3 `GitAccessor.can_handle()`

文件：

```text
openviking/parse/accessors/git_accessor.py
```

位置：

```text
line 60
```

分类：**高概率修改**

当前逻辑：

- 接管远程 Git URL；
- 接管本地 `.git` 路径；
- 明确不接管本地 `.zip`。

要让上传仓库进入与远程 Git 一致的 Accessor，当前节点需要能够区分：

- 普通 ZIP；
- 明确携带仓库身份信息的 ZIP。

约束：

- 不能按 `.zip` 后缀直接接管所有 ZIP；
- 普通 ZIP 必须继续走 LocalAccessor/ZipParser；
- 远程 Git URL 判断必须保持不变；
- 判断必须依赖上游已经归一化的显式参数。

影响范围：

- `tests/unit/test_accessors_git.py`；
- `tests/unit/test_accessors_registry.py`；
- 所有 ZIP 资源路由。

### 6.4 `GitAccessor.access()`

文件：

```text
openviking/parse/accessors/git_accessor.py
```

位置：

```text
line 94
```

分类：**高概率修改**

当前函数已有三类获取方式：

- SSH Git；
- HTTP/HTTPS/Git URL；
- GitHub/GitLab archive 或 clone。

该节点是把另一种输入方式转换成相同 `LocalResource(SourceType.GIT)` 的自然位置。

可能涉及：

- 从 kwargs 读取已归一化的仓库身份；
- 选择本地 ZIP 解包路径；
- 使用现有 `ov_git_*` 临时目录；
- 定位解包后的仓库根；
- 填充现有 `repo_name/repo_ref/repo_commit`；
- 保持错误清理和 `is_temporary=True`；
- 保证 `original_source` 是稳定仓库身份，而不是临时文件名。

影响范围：

- GitHub/GitLab/其他 Git 来源；
- 本地 `.git` 来源；
- 临时目录清理；
- TreeBuilder 的来源命名；
- `tests/unit/test_accessors_git.py`。

修改原则：

- 新分支必须与远程 URL 分支隔离；
- 远程仓库现有行为不能改变；
- 输出契约必须与当前远程 Git 完全一致。

### 6.5 `GitAccessor._extract_zip()`

文件：

```text
openviking/parse/accessors/git_accessor.py
```

位置：

```text
line 631
```

分类：**预计直接复用，可能做小范围修正**

当前已经处理：

- 本地 ZIP；
- Zip Slip；
- 绝对路径；
- Windows drive；
- symlink 跳过；
- 解压目录逃逸；
- 异步线程执行。

可能的小范围修正：

- 统一复用公共 ZIP 安全 helper；
- 返回解包后的单根目录，而不只是 archive stem；
- 增加压缩后/解压后大小限制。

这些都不是接通链路的必要前提。最小实现可以直接调用当前函数。

## 7. 区间 D：仓库 Parser 入口

### 7.1 `DirectoryParser.parse()`

文件：

```text
openviking/parse/parsers/directory.py
```

位置：

```text
line 72
```

分类：**预计不修改**

只要 Accessor 输出的目录可以被 `_is_git_repository()` 识别，当前函数会自动委托
`CodeRepositoryParser`。

### 7.2 `DirectoryParser._is_git_repository()`

文件：

```text
openviking/parse/parsers/directory.py
```

位置：

```text
line 617
```

分类：**可能修改，但最小方案不需要**

当前只检查：

```text
.git/ exists
OR
.git_source_repo exists
```

两个选择：

#### 最小兼容路径

沿用现有 `.git_source_repo` 内部 marker。

- 当前节点不改；
- Accessor 解包后写 marker；
- 后续链完全复用。

#### 显式来源路径

让 Parser 路由识别 `SourceType.GIT`，减少对 marker 的依赖。

- 可能修改 `UnifiedResourceProcessor.process()`；
- `_is_git_repository()` 可能继续保留作本地目录兼容；
- 影响范围更大。

当前目标是最小改动，因此这一节点应优先保持不动。

### 7.3 `CodeRepositoryParser.parse()`

文件：

```text
openviking/parse/parsers/code/code.py
```

位置：

```text
line 112
```

分类：**应保持不动**

当前已接受服务端本地仓库目录和 `_source_meta`，不关心目录来自 URL、clone 还是上传。

### 7.4 `CodeRepositoryParser._upload_directory()`

文件：

```text
openviking/parse/parsers/code/code.py
```

位置：

```text
line 582
```

分类：**应保持不动**

当前代码扫描、`.gitignore`、include/exclude、目录结构上传全部可以复用。

## 8. 区间 E：消化后半段

以下节点应保持不动：

| 文件 | 函数 | 原因 |
| --- | --- | --- |
| `openviking/parse/tree_builder.py` | `finalize_from_temp()` | 已接收标准 repository ParseResult |
| `openviking/utils/resource_processor.py` | `finish_prepared_resource()` | 已处理首次与已有目标 |
| `openviking/utils/summarizer.py` | `summarize()` | 已生成 SemanticMsg |
| `openviking/storage/queuefs/semantic_processor.py` | `on_dequeue()` | 已处理临时树到目标树 |
| 同上 | `_sync_topdown_recursive()` | 已复用 VikingFS diff |
| `openviking/storage/viking_fs/_sync.py` | `sync_tree()` | 已计算 added/modified/deleted |
| `openviking/storage/queuefs/semantic_dag.py` | `SemanticDagExecutor.run()` | 已支持增量语义处理 |
| `openviking/utils/embedding_utils.py` | `vectorize_file()` | 已派发 embedding |
| `openviking/service/task_tracker.py` | `wait_for_descendants()` | 已等待派生任务 |
| 同上 | `complete()` | 已标记最终完成 |

这些节点的输入契约不会因为仓库来源是远程 URL 还是上传 ZIP 而变化。

修改这些节点会扩大影响范围，且没有当前需求上的必要性。

## 9. 影响等级汇总

### 高概率修改

```text
ResourceService._normalize_add_resource_args()
GitAccessor.can_handle()
GitAccessor.access()
```

### 可能修改

```text
AddResourceRequest 现有 validators
GitAccessor._extract_zip()
UnifiedResourceProcessor.process()
DirectoryParser._is_git_repository()
```

### 预计不修改

```text
routers.resources.add_resource()
TempUploadStore.resolve_for_consume()
ResourceService.add_resource()
ResourceService._submit_resource_ingestion()
ResourceService._execute_resource_ingestion()
ResourceProcessor.process_resource()
UnifiedResourceProcessor.prepare()
AccessorRegistry.access()
AccessorRegistry.get_accessor()
DirectoryParser.parse()
```

### 应保持不动

```text
CodeRepositoryParser.parse()
CodeRepositoryParser._upload_directory()
TreeBuilder.finalize_from_temp()
ResourceProcessor.finish_prepared_resource()
Summarizer.summarize()
SemanticProcessor.on_dequeue()
SemanticProcessor._sync_topdown_recursive()
VikingFS.sync_tree()
SemanticDagExecutor.run()
vectorize_file()
TaskTracker.wait_for_descendants()
TaskTracker.complete()
```

## 10. 区间边界

从现有链上看，潜在改动区间的最宽边界是：

```text
AddResourceRequest
  -> ResourceService._normalize_add_resource_args()
  -> GitAccessor.can_handle()
  -> GitAccessor.access()
  -> GitAccessor._extract_zip()
  -> DirectoryParser._is_git_repository()
```

最小改动边界可进一步收窄为：

```text
ResourceService._normalize_add_resource_args()
  -> GitAccessor.can_handle()
  -> GitAccessor.access()
```

从 `CodeRepositoryParser.parse()` 开始，当前链已经具备完整仓库消化能力，应作为稳定
复用边界。

## 11. 测试影响区间

### 请求/API

```text
tests/server/test_api_resources.py
```

仅当修改 Router validators 时需要扩展。

### Service 参数

```text
tests/service/test_resource_service_watch.py
tests/service/test_resource_service_parse_mode.py
tests/service/test_resource_service_connector.py
```

重点确认参数归一化没有破坏 Watch、parse mode、Connector 和 Git auth。

### Accessor 和路由

```text
tests/unit/test_accessors_git.py
tests/unit/test_accessors_registry.py
```

重点确认：

- 远程 Git URL 行为不变；
- 普通 ZIP 行为不变；
- 特定上传来源才进入 GitAccessor；
- metadata 和 cleanup 保持现有契约。

### Parser 与增量链

```text
tests/misc/test_resource_processor_mv.py
tests/storage/test_semantic_processor_target_preexisting.py
```

这些测试原则上无需改测试实现，只需作为回归验证运行。

## 12. 当前建议的理解顺序

1. 先把 `remote-git-existing-codegraph-chain.md` 作为现状事实。
2. 再看本文的区间分类。
3. 当前只确定“哪里可能改”，不确定具体代码写法。
4. 在选定最小兼容路径或显式来源路径后，再形成具体实现计划。

本文没有引入任何新函数，只标注当前节点的潜在影响范围。
