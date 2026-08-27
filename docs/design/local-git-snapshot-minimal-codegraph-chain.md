# 本地 Git 快照上传最小改动函数链

## 1. 范围

本文基于 `/Users/bytedance/Desktop/OpenViking/.codegraph` 索引，整理本地 Git
仓库快照通过 `temp_file_id + args.repository_snapshot` 进入 OpenViking 时，从
第一个请求节点到重新汇入现有远端 Git 共用链的完整函数路径。

索引规模：

- 3,028 个文件
- 70,845 个节点
- 209,068 条边

本文只讨论服务端最小改动链。TRAE CLI Hook 的打包和上传是该链之前的客户端入口，
不包含在本函数链内。

## 2. 一句话结论

完整调用会经过 15 个节点，但真正需要新增或修改的只有 4 个关口：

1. `AddResourceRequest` 增加 repository snapshot 请求组合校验。
2. `ResourceService._normalize_add_resource_args()` 增加服务层元数据校验。
3. `GitAccessor.can_handle()` 在显式 snapshot 参数存在时接管本地 ZIP。
4. `GitAccessor.access()` 解压 ZIP，并返回与远端 Git 相同结构的 `LocalResource`。

`GitAccessor._extract_zip()` 已存在，可以直接复用。从 `LocalResource(SourceType.GIT)`
返回开始，现有 Parser、TreeBuilder、增量同步、语义、向量和任务系统都无需修改。

## 3. 完整函数链

```text
[HTTP 请求]
  |
  v
1. AddResourceRequest.check_repository_snapshot()        [新增]
  |
  v
2. routers.resources.add_resource()                      [透传]
  |
  v
3. TempUploadStore.resolve_for_consume()                 [复用]
  |
  v
4. ResourceService.add_resource()                        [透传]
  |
  v
5. ResourceService._submit_resource_ingestion()          [透传]
  |
  +-> 6. ResourceService._normalize_add_resource_args()   [修改]
  |
  v
7. ResourceService._execute_resource_ingestion()         [透传]
  |
  v
8. ResourceProcessor.process_resource()                  [透传]
  |
  v
9. UnifiedResourceProcessor.process()                    [透传]
  |
  v
10. UnifiedResourceProcessor.prepare()                   [透传]
  |
  v
11. AccessorRegistry.access()                            [透传]
  |
  v
12. AccessorRegistry.get_accessor()                      [透传]
  |
  v
13. GitAccessor.can_handle()                             [修改]
  |
  v
14. GitAccessor.access()                                 [修改]
  |
  +-> 15. GitAccessor._extract_zip()                     [复用]
  |
  v
16. LocalResource(SourceType.GIT)                        [复用输出契约]
  |
  v
[重新汇入现有共同链]
DirectoryParser -> CodeRepositoryParser -> TreeBuilder
-> sync_tree -> SemanticDagExecutor -> embedding -> TaskTracker
```

## 4. 节点逐项说明

### 节点 1：请求组合校验

文件：

```text
openviking/server/routers/resources.py
```

现有类型：

```text
AddResourceRequest                                      line 26
AddResourceRequest.check_path_or_temp_file_id()         line 105
AddResourceRequest.check_add_type()                     line 111
```

建议新增：

```python
@model_validator(mode="after")
def check_repository_snapshot(self):
    ...
```

状态：**新增函数**

职责：

1. 发现 `args.repository_snapshot` 时，要求存在 `temp_file_id`。
2. 禁止同时传 `path`。
3. 禁止同时传 `add_type`。
4. 禁止 `watch_interval > 0`。
5. 要求显式 `to`，确保后续快照更新同一个资源。
6. 第一版只允许 ZIP snapshot。

为什么要在这里校验：

- 尽早返回清晰的 HTTP 400；
- 防止远程 URL 和上传快照语义混用；
- 不让非法请求进入 Parser 链。

这一层只做字段组合校验，不解析 repo name、branch、commit 的详细格式。

### 节点 2：HTTP Router

文件：

```text
openviking/server/routers/resources.py
```

函数：

```text
add_resource()                                          line 210
```

状态：**无需修改**

现有行为已经满足需求：

1. 看到 `temp_file_id` 后构建 `TempUploadStore`。
2. 调用 `resolve_for_consume()` 得到服务端本地 ZIP 路径。
3. 设置 `allow_local_path_resolution=True`。
4. 将 `request.args` 原样传给 `ResourceService.add_resource()`。
5. 成功后 mark consumed，失败后 mark failed。
6. finally 清理上传解析出的临时文件。

它已经支持：

```json
{
  "temp_file_id": "...",
  "to": "...",
  "args": {
    "repository_snapshot": {}
  }
}
```

因此不需要新增 API，也不需要在 Router 中解压 ZIP。

### 节点 3：解析一次性上传

文件：

```text
openviking/server/temp_upload_store.py
```

函数：

```text
TempUploadStore.resolve_for_consume()                   line 128
TempUploadStore._resolve_local()                        line 255
TempUploadStore._resolve_shared()                       line 303
```

状态：**无需修改**

输出：

```text
ResolvedTempUpload.local_path
ResolvedTempUpload.original_filename
```

该节点只负责把 `temp_file_id` 转成服务端本地普通文件，不判断它是否是 Git 快照。

### 节点 4：ResourceService 公共入口

文件：

```text
openviking/service/resource_service.py
```

函数：

```text
ResourceService.add_resource()                          line 812
```

状态：**无需修改**

它继续负责：

- 拒绝内部字段；
- 规范化 `add_type`；
- 调用 `_submit_resource_ingestion()`；
- 保持所有资源统一入口。

### 节点 5：顶层路由

文件：

```text
openviking/service/resource_service.py
```

函数：

```text
ResourceService._submit_resource_ingestion()            line 906
```

状态：**无需修改**

原因：

- 上传 ZIP 的 `path` 是服务端本地临时文件，不会被 `is_git_repo_url(path)` 当作远端
  Git URL；
- 它自然进入标准资源链；
- `normalized_args.processor_kwargs` 已通过 `kwargs` 继续向下传；
- 不需要给 snapshot 新增顶层分支。

这一点很重要：本地 snapshot 不应伪装成远端 URL，也不应进入
`enqueue_git_add_resource()` 的 URL 预检链。

### 节点 6：Service 级参数校验

文件：

```text
openviking/service/resource_service.py
```

函数：

```text
ResourceService._normalize_add_resource_args()          line 327
```

状态：**修改**

职责：

1. 对 `args.repository_snapshot` 做强类型校验。
2. 规范化字段。
3. 将规范化结果保留在 `processor_kwargs`，供 Accessor 使用。
4. 对内部 SDK 或 Service 直接调用也执行相同校验。

建议校验：

| 字段 | 规则 |
| --- | --- |
| `version` | 必须为 `1` |
| `repo_key` | 非空字符串，有限长 |
| `repo_name` | 非空展示名，有限长 |
| `branch` | 非空或显式 detached 值 |
| `commit` | 40 位十六进制 SHA |
| `archive_format` | 第一版只允许 `zip` |

此外：

```python
if repository_snapshot and watch_interval > 0:
    raise InvalidArgumentError(...)
```

为什么 Service 还要校验：

- HTTP Router 不是唯一调用入口；
- Python 内部调用、测试和未来 MCP 可能直接调用 Service；
- 安全约束不能只放在传输层。

### 节点 7：执行已路由资源

文件：

```text
openviking/service/resource_service.py
```

函数：

```text
ResourceService._execute_resource_ingestion()           line 1158
```

状态：**无需修改**

CodeGraph 显示标准分支最终调用：

```python
self._resource_processor.process_resource(
    path=path,
    allow_local_path_resolution=True,
    defer_post_processing=True,
    **kwargs,
)
```

其中 `kwargs` 已包含规范化的 `repository_snapshot`。

它继续负责：

- 目标 URI 构建；
- telemetry；
- Parser 处理；
- 将 prepared 后处理任务入队；
- 上传快照不创建 Watch；
- 返回 `task_id`。

### 节点 8：ResourceProcessor

文件：

```text
openviking/utils/resource_processor.py
```

函数：

```text
ResourceProcessor.process_resource()                    line 155
```

状态：**无需修改**

CodeGraph 调用边：

```text
process_resource()
  -> UnifiedResourceProcessor.process()
```

它继续负责：

- stage 更新；
- Parser 调用；
- `TreeBuilder.finalize_from_temp()`；
- 首次持久化或保留增量 temp tree；
- prepared payload。

### 节点 9：统一资源处理

文件：

```text
openviking/utils/media_processor.py
```

函数：

```text
UnifiedResourceProcessor.process()                      line 172
```

状态：**无需修改**

CodeGraph 调用边：

```text
process()
  -> prepare()
```

`process()` 会把 `repository_snapshot` kwargs 继续交给 AccessorRegistry。

当 Accessor 返回 `LocalResource(SourceType.GIT)` 和解包目录后，现有逻辑按目录进入
`DirectoryParser`。

### 节点 10：准备来源

文件：

```text
openviking/utils/media_processor.py
```

函数：

```text
UnifiedResourceProcessor.prepare()                      line 151
```

状态：**无需修改**

调用：

```python
resource = await self._get_accessor_registry().access(source, **kwargs)
```

因此 `repository_snapshot` 会进入 Accessor 选择和执行。

### 节点 11：Accessor 执行入口

文件：

```text
openviking/parse/accessors/registry.py
```

函数：

```text
AccessorRegistry.access()                               line 156
```

状态：**无需修改**

CodeGraph 调用边：

```text
access()
  -> get_accessor(source, **kwargs)
  -> accessor.access(source, **kwargs)
```

Registry 已经支持将 kwargs 同时传给 `can_handle()` 和 `access()`。

### 节点 12：Accessor 选择

文件：

```text
openviking/parse/accessors/registry.py
```

函数：

```text
AccessorRegistry.get_accessor()                         line 135
```

状态：**无需修改**

现有 GitAccessor 优先级为 80，高于 LocalAccessor 的 1。

当 `GitAccessor.can_handle()` 对显式 repository snapshot 返回 true 后，Registry 会选中
GitAccessor；普通 ZIP 仍由 LocalAccessor/ZipParser 处理。

### 节点 13：GitAccessor 路由判断

文件：

```text
openviking/parse/accessors/git_accessor.py
```

函数：

```text
GitAccessor.can_handle()                                line 60
```

状态：**修改**

当前逻辑明确规定：

```text
Local paths ending with .git
NOT .zip
```

建议增加最窄条件：

```python
snapshot = normalize_repository_snapshot(kwargs.get("repository_snapshot"))
if snapshot is not None:
    path = Path(source)
    return path.is_file() and path.suffix.lower() == ".zip"
```

约束：

- 不能仅凭 `.zip` 接管；
- 没有合法 `repository_snapshot` 时，行为必须与当前完全一致；
- 远程 Git URL 仍走现有分支；
- 普通 ZIP 仍走 `ZipParser`。

这是整个最小改动方案的路由开关。

### 节点 14：GitAccessor 获取快照

文件：

```text
openviking/parse/accessors/git_accessor.py
```

函数：

```text
GitAccessor.access()                                    line 94
```

状态：**修改**

建议在现有 URL 分支之前增加本地 snapshot 分支：

```python
snapshot = normalize_repository_snapshot(kwargs.get("repository_snapshot"))

if snapshot is not None:
    await self._extract_zip(source_str, temp_local_dir)
    local_dir = find_snapshot_root(Path(temp_local_dir))
    repo_name = snapshot.repo_name
    branch = snapshot.branch
    commit = snapshot.commit
    write_internal_marker(local_dir, snapshot.repo_key)
```

然后复用现有返回结构：

```python
return LocalResource(
    path=local_dir,
    source_type=SourceType.GIT,
    original_source=snapshot.repo_key,
    meta={
        "repo_name": repo_name,
        "repo_ref": branch,
        "repo_commit": commit,
    },
    is_temporary=True,
)
```

需要保持的现有行为：

- 临时目录前缀仍为 `ov_git_`；
- 失败时 cleanup；
- `LocalResource.is_temporary=True`；
- 下游接收与远端 Git 完全相同的 metadata key；
- 不把 ZIP 本地临时文件名当作 repo identity。

### 节点 15：ZIP 安全解包

文件：

```text
openviking/parse/accessors/git_accessor.py
```

函数：

```text
GitAccessor._extract_zip()                              line 631
```

状态：**直接复用，原则上无需修改**

它已经处理：

- 本地 ZIP；
- 跳过目录 entry；
- 跳过 symlink；
- 拒绝 `..`；
- 拒绝绝对路径和 Windows drive；
- 验证解压目标不逃逸；
- 在线程中执行阻塞解压。

可能只需新增一个小 helper 判断 ZIP 是单根目录还是根级文件，不需要修改安全解压
主体。

### 节点 16：统一输出边界

文件：

```text
openviking/parse/accessors/base.py
```

类型：

```text
LocalResource
SourceType.GIT
```

状态：**无需修改**

这是最小改动链的最后一个节点。

只要本地上传分支输出：

```text
LocalResource(SourceType.GIT)
```

并携带与远端 Git 相同的 meta，后续就回到原有共同链。

## 5. 重新汇入的现有共同链

以下节点全部无需修改：

```text
UnifiedResourceProcessor.process()
  |
  v
DirectoryParser.parse()
  |
  v
DirectoryParser._is_git_repository()
  |
  v
CodeRepositoryParser.parse()
  |
  v
CodeRepositoryParser._upload_directory()
  |
  v
TreeBuilder.finalize_from_temp()
  |
  v
ResourceProcessor.finish_prepared_resource()
  |
  v
Summarizer.summarize()
  |
  v
SemanticProcessor._sync_topdown_recursive()
  |
  v
VikingFS.sync_tree()
  |
  v
SemanticDagExecutor
  |
  v
vectorize_file()
  |
  v
TaskTracker.wait_for_descendants()
  |
  v
TaskTracker.complete()
```

第一版为保持最小改动，可以由 `GitAccessor.access()` 在解包目录写入现有内部
`.git_source_repo` marker，使 `DirectoryParser._is_git_repository()` 按当前逻辑识别。

长期可以改成 `SourceType.GIT` 显式选择 `CodeRepositoryParser`，但这不是第一版必需
修改。

## 6. 真正需要改的函数

### 必改

| 顺序 | 文件 | 函数 | 修改 |
| --- | --- | --- | --- |
| 1 | `openviking/server/routers/resources.py` | 新增 `AddResourceRequest.check_repository_snapshot()` | 请求组合校验 |
| 2 | `openviking/service/resource_service.py` | `_normalize_add_resource_args()` | 元数据格式和 watch 校验 |
| 3 | `openviking/parse/accessors/git_accessor.py` | `GitAccessor.can_handle()` | 显式 snapshot ZIP 路由 |
| 4 | `openviking/parse/accessors/git_accessor.py` | `GitAccessor.access()` | 解包并构造 Git LocalResource |

### 复用

| 文件 | 函数 |
| --- | --- |
| `openviking/parse/accessors/git_accessor.py` | `_extract_zip()` |
| `openviking/parse/accessors/base.py` | `LocalResource` |
| `openviking/parse/accessors/registry.py` | `get_accessor()`, `access()` |
| 后续 Parser/Tree/Queue 文件 | 全部现有函数 |

### 可选新增 helper

建议放在 `git_accessor.py` 或独立小型校验模块：

```text
normalize_repository_snapshot()
find_snapshot_root()
write_repository_marker()
```

如果 Router 和 Service 共用同一元数据模型，建议抽到：

```text
openviking/parse/accessors/repository_snapshot.py
```

该文件只放 schema/normalize helper，不新增第二个 Accessor。

## 7. 透传节点为什么不改

| 节点 | 不改原因 |
| --- | --- |
| Router `add_resource()` | 已支持 temp_file_id + args + to |
| `TempUploadStore` | 已把上传安全转换为本地文件 |
| `ResourceService.add_resource()` | 已是统一入口 |
| `_submit_resource_ingestion()` | snapshot 应走标准本地资源链 |
| `_execute_resource_ingestion()` | 已把 kwargs 传给 ResourceProcessor |
| `process_resource()` | 已驱动完整 Parser/Tree/Queue |
| `UnifiedResourceProcessor.prepare/process()` | 已把 kwargs 传给 Registry |
| `AccessorRegistry` | 已支持 kwargs 条件路由和优先级 |
| Parser 以后 | 接收统一 Git LocalResource 即可复用 |

## 8. 对应测试链

### 请求层

文件：

```text
tests/server/test_api_resources.py
```

新增覆盖：

- snapshot 必须与 `temp_file_id` 同用；
- 禁止 `path`；
- 禁止 `add_type`；
- 禁止 `watch_interval > 0`；
- 缺少显式 `to` 时拒绝；
- 普通 ZIP 不受影响。

### Service 层

建议文件：

```text
tests/service/test_resource_service_parse_mode.py
```

或新增：

```text
tests/service/test_resource_service_repository_snapshot.py
```

覆盖：

- 非法 version；
- 非法 commit；
- branch/repo_key/repo_name 缺失；
- 直接 Service 调用也会拒绝非法元数据。

### Accessor 层

文件：

```text
tests/unit/test_accessors_git.py
```

新增覆盖：

- 普通 ZIP 仍不由 GitAccessor 接管；
- 合法 snapshot ZIP 由 GitAccessor 接管；
- `_extract_zip()` 被调用；
- 返回 `SourceType.GIT`；
- meta 与远端 Git 同形；
- marker 写入；
- cleanup 正确；
- Zip Slip/symlink 仍受保护。

### E2E

新增资源测试：

1. 上传 commit A ZIP 到固定 `to`。
2. 上传 commit B ZIP 到同一 `to`。
3. 验证一个 added、一个 modified、一个 deleted。
4. 验证没有创建第二份资源。
5. 验证任务最终 completed。

## 9. 最小实现边界

```text
第一个新增/修改函数：
AddResourceRequest.check_repository_snapshot()

最后一个修改函数：
GitAccessor.access()

最后一个复用函数：
GitAccessor._extract_zip()

共同链重新接入点：
LocalResource(SourceType.GIT)
```

因此服务端不是改整条远程 Git 链，而是在已有 GitAccessor 中增加一个新的输入分支：

```text
remote URL  -> download/clone ┐
                             ├-> LocalResource(SourceType.GIT)
local ZIP   -> _extract_zip --┘
```

后续消化流程保持完全一致。
