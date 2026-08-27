# `git_local` 本地 Git 仓库导入测试文档

## 1. 测试目标

验证 `git_local` 功能在不破坏现有远程 Git 和普通资源导入的前提下，实现：

1. TRAE CLI Hook 仅在成功的 Git 变更事件后触发。
2. 本地 `HEAD` 被打包为一次性 ZIP。
3. ZIP 通过现有 `temp_upload` 上传。
4. `args.git_local` 被正确校验和透传。
5. GitAccessor 只接管明确标记的仓库 ZIP。
6. 上传 ZIP 被转换为标准 `LocalResource(SourceType.GIT)`。
7. 后续复用现有代码仓库 Parser 和增量更新链。
8. 同一仓库分支更新同一 URI。
9. Hook 不阻塞 TRAE CLI。
10. Installer 幂等、可卸载并保留第三方配置。

## 2. 测试原则

- 先验证服务端最小链，再接 Hook。
- 单元测试验证路由和边界。
- 集成测试验证真实 ZIP、Parser 和资源树。
- E2E 验证真实 TRAE CLI 事件和 OpenViking 最终可检索结果。
- 所有新增测试都要包含反向用例，确保普通 ZIP 与远程 Git 不回归。
- 不依赖公网 GitHub 完成核心测试；远程 Git 回归使用 mock 或本地 Git server。
- 涉及文件权限、进程和 ZIP 安全的测试必须在 macOS/Linux 可运行。

## 3. 测试分层

```text
L1  参数和协议单测
L2  Accessor 路由与 ZIP 安全单测
L3  ResourceService / HTTP 集成测试
L4  资源树与增量语义测试
L5  Hook runtime 单测
L6  Installer 集成测试
L7  真实 TRAE CLI + OpenViking E2E
```

## 4. 测试数据

### 4.1 仓库 A：初始版本

```text
repo/
  README.md
  docs/guide.md
  src/main.py
  ignored.log
  .gitignore
```

`.gitignore`：

```gitignore
*.log
node_modules/
.env
```

commit A：

- `README.md`: `version A`
- `docs/guide.md`: `guide A`
- `src/main.py`: `print("A")`
- `ignored.log` 被忽略

### 4.2 仓库 B：第二个版本

基于 A：

- 修改 `README.md` 为 `version B`
- 新增 `docs/new.md`
- 删除 `src/main.py`
- 新增未跟踪文件 `local-secret.txt`
- 新增 `.env`，不提交

commit B 只提交：

- 修改 `README.md`
- 新增 `docs/new.md`
- 删除 `src/main.py`

### 4.3 元数据

commit A/B 使用测试仓库真实的 40 位 SHA。

请求基础：

```json
{
  "version": 1,
  "repo_key": "local:test-repo",
  "repo_name": "test-repo",
  "branch": "main",
  "commit": "<40-char-sha>",
  "archive_format": "zip"
}
```

固定目标：

```text
viking://resources/local-git/test-repo/main
```

## 5. L1：参数和协议测试

### 5.1 目标文件

```text
tests/server/test_api_resources.py
tests/service/test_resource_service_watch.py
```

Service 参数校验用例直接放在现有
`tests/service/test_resource_service_watch.py`，避免为同一个
`_normalize_add_resource_args()` 入口拆出重复 fixture。

### 5.2 合法参数

用例：`git_local` 对象完整且 `watch_interval=0`。

预期：

- `_normalize_add_resource_args()` 成功。
- 规范化结果仍包含 `git_local`。
- branch、commit、repo fields 不被改写。

### 5.3 非对象

输入：

```json
{"git_local": true}
```

以及：

```json
{"git_local": "yes"}
```

预期：`InvalidArgumentError`。

### 5.4 缺失字段

分别缺失：

- `version`
- `repo_key`
- `repo_name`
- `branch`
- `commit`
- `archive_format`

预期：

- 每个请求失败。
- 错误信息指出准确字段。

### 5.5 非法 version

输入：

```json
{"version": 2}
```

预期：拒绝 unsupported version。

### 5.6 非法 commit

覆盖：

- 7 位短 SHA
- 39 位 SHA
- 41 位 SHA
- 非十六进制字符
- 空字符串

预期：全部拒绝。

### 5.7 非法 archive format

输入：

```json
{"archive_format": "tar"}
```

预期：第一版拒绝。

### 5.8 Watch 互斥

输入：

```json
{
  "watch_interval": 30,
  "args": {"git_local": {...}}
}
```

预期：

- 拒绝 uploaded snapshot watch。
- 不创建 WatchTask。
- 不遗留用户不可见任务。

### 5.9 HTTP 组合

覆盖：

| 组合 | 预期 |
| --- | --- |
| `temp_file_id + to + args.git_local` | 成功 |
| `path + args.git_local` | 拒绝 |
| `add_type + temp_file_id + args.git_local` | 拒绝 |
| `temp_file_id + args.git_local` 无 `to` | 拒绝 |
| 普通 `temp_file_id` 无 `git_local` | 保持成功 |
| 远程 Git `path + args.branch` | 保持成功 |

## 6. L2：GitAccessor 路由测试

### 6.1 目标文件

```text
tests/unit/test_accessors_git.py
tests/unit/test_accessors_registry.py
tests/unit/test_accessors_http.py
```

### 6.2 普通 ZIP 不接管

当前已有：

```text
test_cannot_handle_local_zip_file
```

保留并扩展断言：

```python
assert accessor.can_handle(zip_path) is False
```

预期：普通 ZIP 继续由 LocalAccessor/ZipParser 处理。

### 6.3 标记 ZIP 接管

输入：

- 本地 `.zip` 文件
- 合法 `git_local` kwargs

预期：

```python
GitAccessor.can_handle(path, git_local=metadata) is True
```

### 6.4 非 ZIP 不接管

输入：

- `.md`
- `.tar`
- 目录

即使携带 `git_local`，第一版也应拒绝或不匹配。

### 6.5 Registry 选择

注册：

- GitAccessor
- LocalAccessor

输入标记 ZIP。

预期：

- Registry 选择 GitAccessor。
- 普通 ZIP 选择 LocalAccessor。

### 6.6 远程 Git 回归

保留并运行：

- `test_can_handle_git_ssh_url`
- `test_can_handle_github_http_url`
- `test_can_handle_github_with_ref`
- `test_can_handle_azure_devops_http_url`
- `test_git_url_routed_to_git_accessor`
- `test_azure_devops_git_url_routed_to_git_accessor`
- `test_regular_http_url_routed_to_http_accessor`
- `test_azure_devops_browse_url_routed_to_http_accessor`

预期：全部行为不变。

## 7. L2：GitAccessor 解包与输出测试

### 7.1 标准输出

创建真实 `git archive HEAD` ZIP，调用 `GitAccessor.access()`。

预期：

```python
result.source_type == SourceType.GIT
result.is_temporary is True
result.meta["repo_name"] == "test-repo"
result.meta["repo_ref"] == "main"
result.meta["repo_commit"] == commit_a
result.original_source == "local:test-repo"
```

并验证：

- `result.path` 是目录。
- `README.md` 存在。
- `.git` 不存在。
- `.git_source_repo` 存在。
- 未被 Git 跟踪的 `ignored.log` 不存在。
- `.env` 不存在。

另增加一个已 tracked 后再写入 `.gitignore` 的文件，确认它仍会出现在
`git archive HEAD` 中；该用例用于验证 Git 真实语义，并为服务端 denylist 测试提供
输入。

### 7.2 cleanup

调用：

```python
result.cleanup()
```

预期：

- `ov_git_*` 临时目录被删除。
- 原上传 ZIP 不由 LocalResource 误删；由 TempUploadStore 生命周期管理。

### 7.3 异常 cleanup

mock `_extract_zip()` 抛错。

预期：

- `ov_git_*` 临时目录被清理。
- 异常继续抛出。
- 日志不包含敏感内容。

### 7.4 单根目录

ZIP 结构：

```text
repo-root/README.md
repo-root/src/main.py
```

预期：`result.path` 指向 `repo-root/`，不多保留无意义包装层。

### 7.5 根级文件

ZIP 结构：

```text
README.md
src/main.py
```

预期：`result.path` 指向解压目录本身。

## 8. L2：ZIP 安全测试

复用 `_extract_zip()` 现有安全语义。

### 8.1 Zip Slip

ZIP entry：

```text
../escape.txt
```

预期：拒绝，目标目录外无文件。

### 8.2 绝对路径

覆盖：

```text
/tmp/escape.txt
C:\Windows\escape.txt
```

预期：拒绝。

### 8.3 symlink

ZIP 中包含 symlink entry。

预期：

- symlink 被跳过。
- 不跟随到仓库外。

### 8.4 压缩炸弹限制

若本期补解压后大小和文件数量限制：

- 超总大小拒绝。
- 超文件数拒绝。
- 临时目录清理。

若本期不实现，测试文档中标记为已知风险，不伪造通过。

## 9. L3：HTTP 上传集成测试

### 9.1 目标文件

```text
tests/server/test_api_resources.py
```

### 9.2 local upload mode

1. `POST /resources/temp_upload` 上传 commit A ZIP。
2. 获取 `temp_file_id`。
3. `POST /resources`，携带 `to + args.git_local`。

预期：

- HTTP 200。
- 返回 `root_uri`。
- 返回 `task_id` 或同步结果。
- 上传标记 consumed。
- 本地临时上传文件清理。

### 9.3 shared upload mode

重复上一用例，使用：

```text
upload_mode=shared
```

预期：

- shared temp content 被安全解析。
- 消费成功后 shared upload 目录删除。
- account/user 隔离生效。

### 9.4 失败恢复

让 metadata 校验或 Parser 失败。

预期：

- shared upload 状态恢复为 uploaded，允许诊断或重试。
- local upload 不泄漏临时解包目录。
- 返回明确错误。

## 10. L3/L4：首次仓库导入

使用真实服务栈或现有 API test fixture。

步骤：

1. 创建测试 Git 仓库。
2. commit A。
3. `git archive HEAD`。
4. 上传。
5. 提交资源请求。
6. 等待 task completed。

预期资源树：

```text
<to>/
  README.md
  docs/guide.md
  src/main.py
  .abstract.md
  .overview.md
```

不应存在：

```text
.git/
ignored.log
.env
local-secret.txt
```

验证 metadata：

- source format 为 repository。
- repo name/ref/commit 正确。
- Parser 为代码仓库 Parser。

## 11. L4：第二次上传增量更新

步骤：

1. commit A 已完成导入。
2. 创建 commit B。
3. 上传 commit B ZIP 到同一 `to`。
4. 等待 completed。

预期：

| 文件 | 结果 |
| --- | --- |
| `README.md` | modified |
| `docs/new.md` | added |
| `src/main.py` | deleted |
| `docs/guide.md` | unchanged |

验证：

- `root_uri` 与第一次相同。
- 不产生 `_1` 等副本。
- `SyncDiff` 包含正确 changes。
- 删除文件的 detail vectors 被移除。
- 修改/新增文件重新向量化。
- 未修改文件不作为 modified。
- 父级 overview/abstract 刷新。

参考测试：

```text
tests/misc/test_resource_processor_mv.py
tests/storage/test_semantic_processor_target_preexisting.py
```

## 12. L4：幂等

### 12.1 同一 commit 重复上传

连续两次提交相同 commit ZIP。

预期：

- 目标 URI 不变。
- 文件内容不变。
- 不产生副本。
- 最终任务成功。
- 若实现 Hook 去重，则第二次不发请求；服务端仍需能安全处理重复请求。

### 12.2 同一分支连续 commit

快速提交 A、B。

预期：

- 最终资源为 B。
- A 不在 B 完成后覆盖目标。

如果第一版无法保证跨进程乱序，则该用例必须暴露为失败风险，不能忽略。

## 13. L4：任务生命周期

验证 stage：

```text
queued
parsing/finalizing
processing_queue
completed
```

上传快照没有远程 fetching 时，可不要求 `fetching`。

验证：

- 收到 `task_id` 不等于 completed。
- `TaskTracker.wait_for_descendants()` 等待语义和 embedding。
- completed 后资源可检索。
- failed 时错误落到 TaskRecord。

## 14. L5：Hook runtime 单测

### 14.1 建议测试文件

```text
examples/memory-plugin-shared/repository-sync.test.mjs
```

### 14.2 PostToolUse 解析

覆盖字段变体：

- `tool_name`
- `toolName`
- `tool_input`
- `toolInput`
- `tool_response`
- `toolResponse`
- `cwd`

### 14.3 命令识别

应触发：

```text
git commit -m test
git pull --rebase
git merge feature
git rebase main
git checkout branch
git switch branch
git reset --hard HEAD~1
git revert HEAD
```

第一版不处理 `git clone`：clone 命令执行时 Hook 的 `cwd` 通常仍是父目录，
仅凭 PostToolUse payload 无法可靠判断新仓库路径。

不触发：

```text
git status
git log
git diff
echo "git commit"
# git commit
notgit commit
```

复合命令只在能够可靠判断成功时触发。

### 14.4 工具失败

`tool_response` 表示非零退出或失败。

预期：

- 不打包。
- 不上传。
- Hook 输出 no-op。

### 14.5 非 Git 目录

`git rev-parse --show-toplevel` 失败。

预期：静默 no-op，不报错到 TRAE CLI。

### 14.6 archive

使用真实临时 Git 仓库。

验证 ZIP：

- 只含 commit 文件。
- 不含 `.git`。
- 不含未提交文件。
- 不含未跟踪的 ignored 文件。
- 已 tracked 的 ignored 文件仍会存在，符合 `git archive` 语义。
- SHA 与元数据一致。

### 14.7 上传协议

mock fetch：

1. 第一次请求是 multipart temp upload。
2. 第二次请求是 JSON add resource。
3. 第二次 body 包含：
   - `temp_file_id`
   - `to`
   - `args.git_local`
4. Authorization/account/user/peer headers 正确。
5. multipart 请求不能错误写死 JSON Content-Type。

### 14.8 detached worker

参考：

```text
examples/memory-plugin-shared/lib/async-writer.mjs
examples/zcode-memory-plugin/scripts/zcode-async.test.mjs
```

测试：

- 父进程在慢上传前返回。
- stdout 为 `{}` 或空。
- worker 最终完成上传。
- worker 失败不改变父进程退出码。

### 14.9 临时文件清理

覆盖：

- 上传成功。
- temp_upload 失败。
- add_resource 失败。
- worker 被取消。
- fetch 超时。

每种情况 ZIP 均删除。

### 14.10 去重

同一 repo/branch/HEAD 连续触发。

预期：只上传一次。

新 HEAD：

预期：上传一次新快照。

## 15. L6：TRAE CLI Hook 安装测试

### 15.1 目标文件

```text
examples/memory-plugin-shared/install-agent-hooks.test.mjs
```

### 15.2 首次安装

预期：

- `~/.trae/cli/hooks.json` 包含一个 OpenViking PostToolUse 组。
- matcher 为命令工具集合。
- command 指向安装目录脚本。
- 带 `OPENVIKING_INTEGRATION_ID`。
- shared runtime 文件存在。

### 15.3 幂等安装

连续安装两次。

预期：

- OpenViking PostToolUse 只有一份。
- integration manifest 时间保持幂等规则。
- 不重复 shared runtime。

### 15.4 第三方 Hook 保留

预置第三方 PostToolUse。

预期：

- 第三方条目保留。
- OpenViking 条目追加/替换自身旧版本。

### 15.5 旧版本迁移

预置旧 OpenViking repository Hook。

预期：

- 旧自身条目移除。
- 新条目只有一份。
- 不误删名称相似的第三方 Hook。

### 15.6 卸载

预期：

- OpenViking repository Hook 移除。
- 其他 OpenViking memory Hook 按 harness 卸载规则处理。
- 第三方 Hook 保留。
- 安装目录清理。
- 无其他 integration 时 shared runtime 清理。

### 15.7 validation

安装后：

- `node --check` 通过。
- no-op smoke test 通过。
- Hook 脚本文件存在。
- hooks.json 包含正确 command。

## 16. L7：真实 TRAE CLI E2E

### 16.1 前置

- OpenViking 服务可用。
- TRAE CLI 已安装集成。
- `/hooks` 显示 Hook source 正确。
- `/mcp` 正常。
- 使用独立测试仓库和独立目标 URI。

### 16.2 首次 commit

在 TRAE CLI 中让 Agent：

1. 修改测试文件。
2. 执行 `git commit`。

预期：

- Git commit 正常完成，不被 Hook 阻塞。
- Hook 后台生成 ZIP。
- OpenViking 出现 add_resource task。
- task completed。
- 资源树包含 commit 内容。

### 16.3 第二次 commit

让 Agent：

- 修改一个文件。
- 新增一个文件。
- 删除一个文件。
- commit。

预期：同第 11 节。

### 16.4 只读 Git 命令

执行：

```text
git status
git log -1
git diff HEAD~1
```

预期：

- 不产生新上传任务。
- Hook 日志可记录 skip 原因。

### 16.5 失败 Git 命令

执行不存在 branch 的 checkout。

预期：

- 命令失败。
- 不上传。
- 不影响 TRAE CLI 后续对话。

### 16.6 未提交内容

创建文件但不 commit，执行一个会触发检查的操作。

预期：

- 未提交文件不出现在 OpenViking。

### 16.7 OpenViking 不可用

停掉服务后 commit。

预期：

- commit 正常完成。
- Hook 返回不阻塞。
- 记录失败/待重试。
- 服务恢复后按设计重试或下次事件补传。

## 17. 性能测试

### 17.1 Hook 返回时间

目标：

- 父 Hook 在 1 秒内返回。
- 不受仓库 ZIP 大小和网络延迟影响。

### 17.2 小仓库

规模：

- 100 文件
- 10 MB

记录：

- archive 时间
- upload 时间
- parser 时间
- semantic/embedding 时间

### 17.3 中型仓库

规模：

- 5,000 文件
- 200 MB，受上传配置上限约束

确认：

- 不阻塞 Hook。
- 内存无明显峰值泄漏。
- 临时文件清理。
- 服务端任务可恢复。

## 18. 回归测试命令

### Python 核心

```bash
pytest -q \
  tests/unit/test_accessors_git.py \
  tests/unit/test_accessors_registry.py \
  tests/unit/test_accessors_http.py \
  tests/server/test_api_resources.py \
  tests/service/test_resource_service_watch.py \
  tests/service/test_resource_service_connector.py \
  tests/misc/test_resource_processor_mv.py \
  tests/storage/test_semantic_processor_target_preexisting.py
```

### TRAE CLI installer

```bash
node --test \
  examples/memory-plugin-shared/install-agent-hooks.test.mjs \
  examples/memory-plugin-shared/install-tui.test.mjs
```

### Shared Hook runtime

```bash
node --test examples/memory-plugin-shared/repository-sync.test.mjs
```

### 静态检查

```bash
bash -n examples/memory-plugin-shared/install.sh
node --check <repository-hook-entry>
git diff --check
```

## 19. 验收矩阵

| 能力 | 单测 | 集成 | E2E |
| --- | --- | --- | --- |
| `git_local` 参数校验 | 是 | 是 | 间接 |
| 普通 ZIP 不回归 | 是 | 是 | 否 |
| 远程 Git 不回归 | 是 | 可选 | 否 |
| ZIP 安全 | 是 | 是 | 否 |
| Git LocalResource metadata | 是 | 是 | 否 |
| 首次导入 | 否 | 是 | 是 |
| 二次增量更新 | 否 | 是 | 是 |
| 删除向量清理 | 否 | 是 | 是 |
| Hook 命令识别 | 是 | 否 | 是 |
| Hook 不阻塞 | 是 | 否 | 是 |
| Installer 幂等 | 是 | 是 | 是 |
| 第三方 Hook 保留 | 是 | 是 | 否 |
| 服务不可用降级 | 是 | 否 | 是 |

## 20. 退出标准

以下全部满足才认为功能完成：

1. 所有 L1-L6 自动测试通过。
2. 真实 TRAE CLI E2E 首次和二次 commit 通过。
3. 普通 ZIP 和远程 Git 回归通过。
4. 同一 `to` 无资源副本。
5. 删除文件不可再检索。
6. 未提交、untracked 和未被 Git 跟踪的 ignored 文件未上传；已 tracked 文件按 HEAD
   语义处理。
7. Hook 返回时间符合目标。
8. 上传和解压临时文件无残留。
9. 安装/重复安装/卸载均通过。
10. 文档与实际请求协议一致。
