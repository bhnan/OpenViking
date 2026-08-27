# Agent 触发式本地 Git 仓库导入设计

实现风格、文件/函数地图和分阶段实施方案见：

- `docs/design/agent-triggered-local-git-implementation-alignment.md`
- `docs/design/remote-git-ingestion-codegraph-flow.md`

## 1. 背景

OpenViking 已支持从 GitHub、GitLab 和其他允许的代码托管地址导入 Git
仓库，并可通过 Watch 定期重新获取远端仓库。现有远端仓库更新链路采用：

```text
重新获取完整仓库快照
  -> 重新解析为 VikingFS 临时树
  -> 与固定目标 URI 做文件级差异同步
  -> 按差异增量刷新语义和向量
```

本设计希望让 TRAE CLI 等 Agent 在使用本地 Git 仓库时也能复用同一条
解析和更新链路，但不要求用户先把本地提交推送到 GitHub，也不主动扫描
用户电脑上的目录。

核心原则是：

> 远端仓库和本地仓库只在“如何取得仓库快照”这一层分叉。取得快照后，
> 统一交给现有 `CodeRepositoryParser`、VikingFS 差异同步和增量索引链路。

## 2. 目标

1. 只有 Agent 成功执行相关 Git 操作后才被动触发，不做全盘扫描或后台目录发现。
2. 支持未推送到远端、但已经形成 Git commit 的本地仓库快照。
3. 首次触发时导入仓库；后续上传到同一目标 URI 时更新已有资源。
4. 复用现有代码仓库解析、资源树同步、摘要刷新和向量更新能力。
5. Hook 不等待耗时解析完成，不阻塞 Agent 的正常任务。
6. 默认不上传未提交文件、忽略文件、`.git/`、凭据或本地构建产物。

## 3. 非目标

- 不扫描电脑上的所有 Git 仓库。
- 不实现通用文件系统监听器。
- 不将用户电脑的本地路径直接暴露给远端 OpenViking 服务。
- 第一版不上传未提交工作区或 ignored 文件。
- 不为本地仓库另写一套 Parser、资源更新器或向量索引器。
- 不用 OpenViking 的账号级 Git 版本控制功能替代资源导入；两者是不同概念。

## 4. 已有远端 Git 仓库链路

### 4.1 获取

`GitAccessor` 将远端仓库转换为服务端本地 `LocalResource`：

- GitHub 公共仓库优先下载指定 ref 的 ZIP，失败后回退浅克隆。
- GitLab 在支持的 URL 结构下同样优先 ZIP，失败后回退浅克隆。
- 其他允许的代码托管地址使用 `git clone --depth 1`。
- 指定 commit 时会额外 fetch 并 checkout 对应 commit。
- 获取内容落在 OpenViking 服务所在机器的临时目录，例如
  `/tmp/ov_git_*`，不是 Agent 所在电脑。

### 4.2 解析

`GitAccessor` 输出的目录和 Git 元数据交给 `DirectoryParser`；
`DirectoryParser` 检测 `.git` 或 `.git_source_repo` 后委托
`CodeRepositoryParser`。

`CodeRepositoryParser` 会：

- 遵循 `.gitignore`；
- 排除 `.git`、`node_modules` 和默认忽略目录；
- 保留代码目录结构；
- 将仓库写入 VikingFS 临时树；
- 记录 `repo_name`、branch/ref 和 commit 元数据。

解析完成后，服务端临时 checkout 被清理。

### 4.3 更新

远端仓库 Watch 到期后，`WatchScheduler` 使用原 URL、固定目标 URI 和保存的
处理参数调用 `refresh_resource`。

当前实现不会先通过 `git ls-remote` 比较远端 HEAD。每次刷新都会重新获取并
解析完整快照，但后半段是增量的：

1. `VikingFS.sync_tree` 比较临时树和现有目标树。
2. 只写入新增文件、替换内容变化的文件、删除新快照中已不存在的文件。
3. 生成 `added`、`modified`、`deleted` 差异。
4. `SemanticDagExecutor` 以 `incremental_update=true` 处理这些差异。
5. 未变化文件复用已有内容和索引；变化文件重新处理；删除文件移除对应向量。

因此远端更新的准确描述是：

| 阶段 | 策略 |
| --- | --- |
| 远端内容获取 | 全量快照 |
| 仓库文件解析 | 全量解析 |
| VikingFS 资源树写入 | 增量合并 |
| 摘要和向量更新 | 按差异增量处理 |

## 5. 统一快照模型

远端和本地两类输入应在 Parser 前统一成一个逻辑模型：

```text
RepositorySnapshot
  path          服务端可读取的仓库快照目录
  repo_key      稳定的仓库身份
  repo_name     展示名称
  branch        当前分支或 ref
  commit        快照对应的完整 commit SHA
  source        remote_git 或 local_upload
  source_url    可选；远端仓库地址
```

整体结构为：

```text
远端仓库 URL
  -> GitAccessor 下载/clone
                         \
                          -> RepositorySnapshot
                         /       |
本地 Git 仓库                   v
  -> 生成快照并上传        CodeRepositoryParser
                            -> VikingFS 临时树
                            -> sync_tree
                            -> 增量摘要和向量
```

`RepositorySnapshot` 是设计上的统一契约，不要求第一版立即引入同名公开类。
实现时也可以复用现有 `LocalResource`，在 `meta` 中携带仓库字段。

## 6. 本地仓库导入链路

### 6.1 触发

TRAE CLI 使用 `PostToolUse`，而不是 `PreToolUse`：

- `PostToolUse` 表示 Git 命令已成功完成；
- 事件提供 `cwd`、`tool_name` 和 `tool_input`；
- Hook matcher 先匹配 `Bash|RunCommand|Shell` 等命令工具；
- 脚本内部再解析 `tool_input.command`，识别需要处理的 Git 操作。

第一版建议处理：

- `git commit`：本地 HEAD 已变化，可直接生成快照；
- `git merge`、`git rebase`：成功后 HEAD 可能变化；
- `git checkout`、`git switch`：分支或 HEAD 可能变化；
- `git pull`：本地 HEAD 可能变化；
- `git clone`：新仓库可首次登记。

`git status`、`git log`、`git diff` 等只读命令不触发上传。

### 6.2 定点仓库识别

Hook 只针对事件的 `cwd` 运行以下命令：

```bash
git rev-parse --show-toplevel
git rev-parse HEAD
git branch --show-current
git remote get-url origin
```

这不是目录扫描。Git 事件提供检查点，脚本仅解析这次事件所属的仓库。

没有 origin 的本地仓库仍可上传，`repo_key` 使用本地生成并持久化的仓库身份；
不能直接使用可变的绝对路径作为跨机器公共身份。

### 6.3 快照生成

第一版使用 `git archive HEAD` 生成快照：

- 只包含当前 commit 中由 Git 跟踪的文件；
- 不包含 `.git/`；
- 不包含未提交改动；
- 不包含 ignored 文件；
- 输出是确定的 commit 快照，便于按 SHA 去重。

快照外另传显式元数据，不依赖在 ZIP 中伪造 `.git`：

```json
{
  "source_format": "repository",
  "repo_key": "local:<stable-id>",
  "repo_name": "example-repo",
  "branch": "main",
  "commit": "40-character-sha",
  "target_uri": "<stable resource target>"
}
```

服务端必须校验这些字段。它们不能覆盖 endpoint、account、user 或其他安全配置。

### 6.4 上传与异步处理

本地 Hook：

1. 检查本地状态中该 `repo_key + branch + commit` 是否已经成功提交。
2. 生成临时 ZIP。
3. 上传到 `resources/temp_upload`。
4. 用 `temp_file_id` 和仓库元数据调用 `add_resource`。
5. 始终传入同一个稳定目标 URI。
6. 使用异步处理，不等待 Parser、摘要和向量任务完成。
7. 保存返回的 `task_id`，供状态查询和失败重试。
8. 删除本地临时 ZIP。

上传内容是一次性快照，因此不能使用现有 `watch_interval`。下一次本地 commit
需要由下一次 Agent Git 事件重新上传。

## 7. 服务端最小适配

当前普通 ZIP 上传走：

```text
temp_upload -> ZipParser -> DirectoryParser
```

`git archive` 生成的 ZIP 没有 `.git`，默认会被当作普通目录。为了明确复用
代码仓库 Parser，服务端需要支持“上传的是 repository snapshot”这一显式类型：

```text
temp_upload
  -> 解析并校验 repository 元数据
  -> 安全解包
  -> LocalResource(
       path=<extracted-dir>,
       source_type=GIT,
       original_source=<stable-local-source>,
       meta={repo_name, repo_ref, repo_commit, repo_key}
     )
  -> CodeRepositoryParser
```

不推荐把 `.git_source_repo` 作为公开上传协议。该标记可用于兼容内部链路，但显式
元数据更清楚，也避免污染快照内容。

### 7.1 需要新增

- 上传仓库快照的类型声明和元数据校验。
- 上传 ZIP 安全解包到服务端临时目录。
- 将解包结果组装为现有 `LocalResource`/仓库元数据。
- 本地提交 SHA 去重状态或服务端幂等键。
- TRAE CLI `PostToolUse` 薄适配脚本。

### 7.2 直接复用

- `CodeRepositoryParser`。
- `.gitignore`、ignore/include/exclude 过滤逻辑。
- `TreeBuilder`。
- `VikingFS.sync_tree`。
- `SyncDiff` 的 added/modified/deleted 计算。
- `SemanticDagExecutor` 增量摘要和向量更新。
- 固定目标 URI 的首次创建和后续更新语义。
- 现有后台资源任务和 `task_id` 查询。

## 8. 目标 URI 与分支

同一仓库的同一分支必须映射到同一个目标 URI；不同分支默认使用不同 URI。

逻辑映射至少包含：

```text
account/user namespace + repo_key + branch -> stable target URI
```

目标 URI 的具体编码由实现统一生成，并对用户输入做安全转义。不能把 origin、
本地绝对路径或任意 branch 文本未经处理直接拼入 URI。

重复上传同一 commit 应为 no-op 或返回已有任务状态。上传新 commit 到同一目标
URI 时进入现有增量更新链路。

## 9. 同机部署优化

如果 TRAE CLI 和 OpenViking 服务运行在同一台机器，并且调用的是允许本地路径的
内部 SDK/CLI，可以省略上传：

```text
本地仓库路径
  -> LocalAccessor
  -> DirectoryParser 检测 .git
  -> CodeRepositoryParser
  -> 后续共用链路
```

HTTP API 不应接受客户端提供的任意服务器本地路径。远程部署必须走受控上传。

同机直读是优化路径，不应改变远程上传协议的行为和安全边界。

## 10. 安全约束

- 默认只上传 `HEAD` 中已跟踪文件。
- 不上传未提交工作区、`.git/`、ignored 文件和 submodule 内容。
- 快照大小、文件数量、单文件大小和解压后总大小必须有限制。
- ZIP 解包必须防止 Zip Slip、绝对路径、符号链接逃逸和压缩炸弹。
- 支持额外 `.openvikingignore` 或 denylist，默认拒绝常见密钥和凭据文件。
- Hook 从可信的用户级配置读取 endpoint 和认证，不允许仓库内文件改写。
- `repo_key`、branch、commit 和 target URI 均需服务端校验。
- Hook 失败不得阻断 Git 命令或 Agent 任务。

## 11. 失败与幂等

- 本地使用 `repo_key + branch + commit` 作为幂等键。
- 同一个 commit 已成功入队时不重复上传。
- 网络或认证失败时记录 pending，下一次相关 Git 事件重试。
- 服务端同一目标 URI 需要串行更新，避免两个快照并发覆盖。
- 较旧 commit 的任务晚于新 commit 完成时，服务端应拒绝回退或按序执行。
- 任务状态通过现有 `task_id` 查询，长日志不注入 Agent 上下文。

## 12. 最小验证方案

先验证服务端输入适配，不先接 Hook：

1. 创建一个小型本地 Git 仓库，提交 `a.md` 和 `src/main.py`。
2. 用 `git archive HEAD` 生成第一次快照。
3. 携带 repository 元数据上传到固定目标 URI。
4. 验证资源按代码仓库结构创建，Parser 标识和 repo 元数据正确。
5. 修改 `a.md`、新增 `b.md`、删除 `src/main.py` 并再次 commit。
6. 生成第二次快照，上传到同一目标 URI。
7. 验证 `SyncDiff` 包含一个 modified、一个 added、一个 deleted。
8. 验证未变化文件未被重新写入，删除文件对应向量被清理。
9. 验证摘要和向量只处理差异，并且目标 URI 未产生副本。
10. 重复上传第二个 commit，验证幂等行为。

服务端验证通过后，再增加 TRAE CLI `PostToolUse`：

1. 只读 Git 命令不触发。
2. 成功 commit 触发一次上传。
3. 失败的 Git 命令不触发。
4. 同一 commit 的重复事件不重复上传。
5. Hook 超时或网络失败不影响 TRAE CLI。

## 13. 后续优化

- 上传前按上次 commit 生成增量 pack，而不是完整 `git archive`。
- 为远端 Watch 增加 `git ls-remote` HEAD 预检，未变化时跳过下载和解析。
- 支持用户显式选择是否包含未提交工作区。
- 支持 submodule 的受控展开。
- 支持可选的 `push` 后立即刷新远端 Watch。
- 将远端和本地快照输入正式抽象为统一 `RepositorySnapshot` 类型。

## 14. 结论

本地 Git 仓库不需要复制远端 Git 导入的整套实现。新增能力应限制在输入层：

```text
本地仓库 -> 受控快照 -> 上传 -> RepositorySnapshot
```

从 `RepositorySnapshot` 开始，解析、首次落库、文件级增量同步、摘要和向量更新
全部复用 OpenViking 现有链路。这是改动最小、边界最清楚、也最容易先做端到端
验证的实现方式。
