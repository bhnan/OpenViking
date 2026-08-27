# `git_local` 本地 Git 仓库导入开发文档

## 1. 目标

为 TRAE CLI 增加本地 Git 仓库自动导入能力：

1. Hook 在 Agent 成功执行 Git 相关操作后被动触发。
2. Hook 确认当前工作目录属于 Git 仓库。
3. Hook 将当前 `HEAD` 打包为 ZIP 快照。
4. ZIP 通过 OpenViking 现有临时上传接口上传。
5. 资源请求通过 `args.git_local` 标明该 ZIP 是 Git 仓库快照。
6. 服务端将 ZIP 解压为本地临时仓库目录。
7. 服务端输出与远端 Git 相同的 `LocalResource(SourceType.GIT)`。
8. 从 `DirectoryParser` 开始复用现有仓库消化链。

本功能不是把远端 Git URL 替换掉，而是增加一个并列来源：

```text
remote Git URL
  -> GitAccessor download/clone
  -> service-local repository directory

local Git repository
  -> Hook archive/upload
  -> GitAccessor extract
  -> service-local repository directory

共同后半段：
service-local repository directory
  -> LocalResource(SourceType.GIT)
  -> DirectoryParser
  -> CodeRepositoryParser
  -> TreeBuilder
  -> sync_tree
  -> semantic/vector processing
  -> TaskTracker completed
```

## 2. 非目标

- 不扫描用户电脑上的 Git 仓库。
- 不监听所有本地文件变化。
- 不上传未提交工作区。
- 不上传 untracked 文件；已被 Git 跟踪的 ignored 文件仍属于 HEAD 快照。
- 不修改现有远程 Git URL 导入行为。
- 不为本地仓库增加服务端 Watch。
- 不新增第二套代码仓库 Parser。
- 不修改 TreeBuilder、VikingFS 差异同步或语义/向量核心。
- 第一版不展开 submodule。

## 3. 协议设计

### 3.1 为什么不用顶层 `add_type`

当前 `AddResourceRequest.add_type` 是 Connector 专用字段：

- 显式 `add_type` 要求 `path`。
- 显式 `add_type` 要求精确 `to`。
- 显式 `add_type` 禁止与 `temp_file_id` 组合。
- 显式 `add_type` 不允许降级到标准资源链。

本地仓库必须使用 `temp_file_id`，因此 `git_local` 不能放入顶层 `add_type`。

### 3.2 请求形态

第一步上传 ZIP：

```http
POST /api/v1/resources/temp_upload
Content-Type: multipart/form-data
```

返回：

```json
{
  "temp_file_id": "upload_xxx.zip"
}
```

第二步添加或更新资源：

```http
POST /api/v1/resources
Content-Type: application/json
```

请求：

```json
{
  "temp_file_id": "upload_xxx.zip",
  "to": "viking://resources/local-git/<stable-repo-id>/<branch>",
  "wait": false,
  "args": {
    "git_local": {
      "version": 1,
      "repo_key": "local:<stable-id>",
      "repo_name": "example-repo",
      "branch": "main",
      "commit": "0123456789abcdef0123456789abcdef01234567",
      "archive_format": "zip"
    }
  }
}
```

### 3.3 `git_local` 字段

`git_local` 使用对象，不使用布尔值。

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `version` | 是 | 协议版本，第一版固定为 `1` |
| `repo_key` | 是 | 稳定仓库身份，不使用临时 ZIP 路径 |
| `repo_name` | 是 | 仓库显示名称 |
| `branch` | 是 | 当前 branch；detached HEAD 使用明确约定值 |
| `commit` | 是 | 40 位完整 SHA |
| `archive_format` | 是 | 第一版固定为 `zip` |

### 3.4 请求组合约束

存在 `args.git_local` 时：

- 必须有 `temp_file_id`。
- 必须有显式 `to`。
- 禁止 `path`。
- 禁止顶层 `add_type`。
- 禁止 `watch_interval > 0`。
- `archive_format` 必须为 `zip`。
- `commit` 必须为 40 位十六进制 SHA。

显式 `to` 用于保证同一仓库同一分支的后续快照更新同一个资源，不产生副本。

## 4. 客户端与 Hook 流程

### 4.1 Hook 事件

使用 TRAE CLI `PostToolUse`：

- `PreToolUse` 无法确认 Git 命令是否成功。
- `Stop` 是模型 turn 结束，不是 Git 操作完成事件。
- `PostToolUse` 包含 `cwd`、`tool_name`、`tool_input` 和 `tool_response`。

Hook matcher：

```text
Bash|RunCommand|Shell
```

matcher 只筛选工具名，脚本内部判断命令内容。

### 4.2 触发命令

第一版处理可能改变仓库 HEAD 的成功命令：

- `git commit`
- `git merge`
- `git rebase`
- `git pull`
- `git checkout`
- `git switch`
- `git reset`
- `git revert`

第一版不处理 `git clone`：命令执行时 Hook 的 `cwd` 通常仍是父目录，
PostToolUse payload 没有稳定的新仓库路径，贸然猜测会上传错误目录。

不触发：

- `git status`
- `git log`
- `git diff`
- `git show`
- `git branch` 的只读形式
- 失败的 Git 命令

最终去重依据不是命令文本，而是：

```text
repo_key + branch + HEAD
```

### 4.3 仓库上下文

Hook 在事件 `cwd` 下定点执行：

```bash
git rev-parse --show-toplevel
git rev-parse HEAD
git branch --show-current
git remote get-url origin
```

这不属于目录扫描。Hook 只处理本次 Git 事件对应的工作目录。

### 4.4 快照

使用：

```bash
git -C <repo-root> archive \
  --format=zip \
  --output=<temporary-zip> \
  HEAD
```

特性：

- 只包含当前 commit 中已跟踪文件。
- 不包含 `.git/`。
- 不包含未提交更改。
- 不包含 untracked 文件。
- `.gitignore` 不会二次过滤已被 Git 跟踪的文件；若敏感文件已进入 HEAD，它仍会
  被打包，因此服务端 denylist/额外忽略策略仍有必要。
- 不递归 submodule。

### 4.5 异步

打包和上传不能阻塞 TRAE CLI。

复用现有 `async-writer.mjs` 模式：

```text
Hook parent
  -> 读取 stdin payload
  -> 立即向 TRAE CLI 输出 {}
  -> spawn detached worker
  -> worker 打包、上传、提交资源请求
```

父 Hook 超时、网络错误或 OpenViking 不可用均不得改变原 Git 工具结果。

## 5. 服务端流程

### 5.1 临时上传

现有入口：

```text
openviking/server/routers/resources.py
  temp_upload()                                  line 154

openviking/server/temp_upload_store.py
  TempUploadStore.save_upload()                 line 116
```

本阶段不识别 `git_local`，只存储 ZIP 并返回 `temp_file_id`。

预计不修改。

### 5.2 添加资源

现有入口：

```text
openviking/server/routers/resources.py
  AddResourceRequest                            line 26
  add_resource()                                line 210

openviking/server/temp_upload_store.py
  TempUploadStore.resolve_for_consume()         line 128
```

Router 已支持：

- `temp_file_id`
- `to`
- `args`
- `wait`
- 上传成功/失败状态
- 临时文件清理

`add_resource()` 主体预计不修改。

### 5.3 参数归一化

现有函数：

```text
openviking/service/resource_service.py
  ResourceService._normalize_add_resource_args() line 327
```

修改职责：

1. 读取 `args.git_local`。
2. 校验对象和字段。
3. 校验 `watch_interval == 0`。
4. 输出规范化 `git_local`，继续放在 `processor_kwargs`。
5. 保持远程 Git、Feishu、Web 和 parse mode 行为不变。

### 5.4 标准链透传

以下现有函数无需增加 `git_local` 专属分支：

```text
ResourceService.add_resource()
ResourceService._submit_resource_ingestion()
ResourceService._execute_resource_ingestion()
ResourceProcessor.process_resource()
UnifiedResourceProcessor.process()
UnifiedResourceProcessor.prepare()
AccessorRegistry.access()
AccessorRegistry.get_accessor()
```

原因：

- 上传 ZIP 是服务端本地路径，会进入标准资源链。
- `kwargs` 已经透传到 AccessorRegistry。
- Registry 已经把 kwargs 交给 Accessor 的 `can_handle()` 和 `access()`。

### 5.5 GitAccessor 路由

现有函数：

```text
openviking/parse/accessors/git_accessor.py
  GitAccessor.can_handle()                      line 60
```

修改规则：

- 远程 Git URL：保持当前判断。
- 本地 `.git`：保持当前判断。
- 本地 ZIP 且没有合法 `git_local`：返回 false。
- 本地 ZIP 且有合法 `git_local`：返回 true。

不能把所有 `.zip` 都交给 GitAccessor，否则普通 ZIP 资源会回归。

### 5.6 GitAccessor 获取

现有函数：

```text
openviking/parse/accessors/git_accessor.py
  GitAccessor.access()                          line 94
  GitAccessor._extract_zip()                    line 631
```

`access()` 增加本地快照输入分支：

1. 创建现有 `ov_git_*` 临时目录。
2. 读取规范化后的 `git_local`。
3. 调用现有 `_extract_zip()`。
4. 定位 ZIP 的仓库根目录。
5. 写入现有内部 `.git_source_repo` marker。
6. 构造与远端 Git 相同的 metadata。
7. 返回：

```python
LocalResource(
    path=local_dir,
    source_type=SourceType.GIT,
    original_source=repo_key,
    meta={
        "repo_name": repo_name,
        "repo_ref": branch,
        "repo_commit": commit,
    },
    is_temporary=True,
)
```

失败时沿用当前 cleanup。

### 5.7 共同后半段

从 `LocalResource(SourceType.GIT)` 开始全部复用：

```text
DirectoryParser.parse()
  -> DirectoryParser._is_git_repository()
  -> CodeRepositoryParser.parse()
  -> CodeRepositoryParser._upload_directory()
  -> TreeBuilder.finalize_from_temp()
  -> ResourceProcessor.finish_prepared_resource()
  -> SemanticProcessor._sync_topdown_recursive()
  -> VikingFS.sync_tree()
  -> SemanticDagExecutor
  -> vectorize_file()
  -> TaskTracker.wait_for_descendants()
  -> TaskTracker.complete()
```

第一版沿用 `.git_source_repo` marker，因此不修改 Parser 入口。

## 6. 目标 URI

推荐逻辑维度：

```text
account/user namespace + repo_key + branch
```

示例：

```text
viking://resources/local-git/<encoded-repo-key>/<encoded-branch>
```

约束：

- 不直接拼接未经校验的绝对路径。
- 不直接拼接未经转义的 branch。
- 同一 repo/branch 始终使用同一 `to`。
- 不同 branch 默认使用不同 `to`。
- detached HEAD 使用独立目标或明确拒绝，不能覆盖某个 branch。

第一版 URI 由 Hook 生成并显式传入；服务端继续使用现有 URI 校验。

## 7. 幂等和顺序

Hook 本地状态建议记录：

```text
repo_key
branch
last_submitted_commit
task_id
target_uri
last_error
```

规则：

- 同一 `repo_key + branch + commit` 不重复上传。
- 同一 repo/branch 使用本地锁。
- 上传失败保留待重试状态。
- 新 commit 到来时不能被旧任务完成结果回退。
- 服务端目标树锁继续负责同一 URI 的写互斥。

第一版可先保证同一 Hook 进程体系内顺序提交；跨进程乱序需要在 E2E 中验证。

## 8. 安全

### 8.1 客户端

- 使用子进程参数数组，不拼接 shell。
- 临时 ZIP 权限 `0600`。
- finally 删除 ZIP。
- 不记录 API key。
- 不记录带凭据 origin URL。
- 不上传工作区未提交内容。

### 8.2 服务端

- 复用 `_extract_zip()` 的 Zip Slip 检查。
- 跳过 symlink。
- 校验解压目标未逃逸。
- 限制上传大小。
- 建议补解压后总大小和文件数量限制。
- `git_local` 元数据不得覆盖 account/user/endpoint/auth。
- `repo_name` 只做 metadata，不绕过 URI 校验。

## 9. 文件改动

### 9.1 TRAE CLI

修改：

```text
examples/trae-cli-memory-hooks/hooks/hooks.json
examples/trae-cli-memory-hooks/openviking.integration.json
examples/trae-cli-memory-hooks/README.md
```

新增 Hook 脚本放在：

```text
examples/trae-cli-memory-hooks/scripts/
```

通用 Git 打包、上传、状态逻辑放在：

```text
examples/memory-plugin-shared/lib/
```

### 9.2 Installer

修改：

```text
examples/memory-plugin-shared/install.sh
```

现有插入点：

```text
assemble_agent_integration()                    line 1760
agent_write_trae_cli_configs()                  line 1965
install_trae_cli()                              line 2463
validate_install()
```

需要同步：

- shared runtime allowlist；
- OpenViking Hook 归属识别；
- uninstall 归属识别；
- 安装完整性检查；
- smoke test。

### 9.3 服务端

高概率修改：

```text
openviking/service/resource_service.py
  ResourceService._normalize_add_resource_args()

openviking/parse/accessors/git_accessor.py
  GitAccessor.can_handle()
  GitAccessor.access()
```

可能小范围修改：

```text
openviking/server/routers/resources.py
  AddResourceRequest 现有 validators

openviking/parse/accessors/git_accessor.py
  GitAccessor._extract_zip()
```

原则上不修改：

```text
openviking/parse/parsers/directory.py
openviking/parse/parsers/code/code.py
openviking/parse/tree_builder.py
openviking/utils/resource_processor.py
openviking/storage/viking_fs/_sync.py
openviking/storage/queuefs/semantic_processor.py
openviking/service/task_tracker.py
```

## 10. 实施顺序

### 阶段 1：服务端 Accessor 打通

1. 在 `_normalize_add_resource_args()` 校验 `git_local`。
2. 修改 `GitAccessor.can_handle()`。
3. 修改 `GitAccessor.access()`。
4. 手工上传 ZIP，验证返回 Git `LocalResource`。
5. 验证普通 ZIP 和远程 Git 无回归。

### 阶段 2：服务端增量 E2E

1. 上传 commit A 到固定 `to`。
2. 修改、新增、删除文件后上传 commit B。
3. 验证同一目标资源发生增量变化。
4. 验证任务 completed。

### 阶段 3：Hook runtime

1. 解析 PostToolUse。
2. 确认 Git mutation 成功。
3. 获取 repo root/branch/HEAD。
4. 生成 ZIP。
5. 调 temp_upload。
6. 调 add_resource。
7. 增加状态、锁、日志和重试。

### 阶段 4：Installer

1. 注册 PostToolUse。
2. 安装 shared runtime。
3. 验证重复安装。
4. 验证卸载。
5. 验证第三方 Hook 保留。

### 阶段 5：真实 TRAE CLI E2E

在真实 session 中执行：

```text
commit A
commit B
重复只读命令
失败 Git 命令
```

确认 Hook 行为和 OpenViking 资源变化。

## 11. 完成标准

- Hook 不扫描目录，只处理实际 Git 事件。
- 本地 commit 无需 push 即可进入 OpenViking。
- 普通 ZIP 导入不变。
- 远程 Git URL 导入不变。
- 私有远程 Git auth 不变。
- 上传快照不创建 Watch。
- 同一 repo/branch 更新同一 URI。
- 二次上传正确处理 added/modified/deleted。
- 未提交内容不上传。
- Hook 不阻塞 TRAE CLI。
- Installer 幂等、可卸载、保留第三方配置。
- 主任务 completed 后可检索到新内容，删除内容不再命中。
