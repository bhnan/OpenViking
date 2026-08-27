# TRAE 与 TRAE CN 记忆集成

为 TRAE 和 TRAE CN 添加跨项目、跨会话的长期记忆。安装后，OpenViking Hook 会自动加载相关上下文、捕获每轮对话并提交给记忆抽取器；MCP 用于主动搜索、读取和管理记忆。

## 安装

前置条件：macOS 或 Linux、Node.js 18+，以及支持 `SessionStart`、`UserPromptSubmit`、`PreToolUse`、`Stop` Hook 的 TRAE/TRAE CN 版本。安装过程中会引导配置 OpenViking 连接信息。

安装器询问连接方式时，火山引擎云服务用户请选择 **火山引擎 OpenViking 云服务** 并填写 API Key。只有本机已运行 OpenViking 服务时才选择 **自建 / 本地**。

```bash
# TRAE
bash <(curl -fsSL https://raw.githubusercontent.com/volcengine/OpenViking/main/examples/memory-plugin-shared/install.sh) \
  --harness trae

# TRAE CN
bash <(curl -fsSL https://raw.githubusercontent.com/volcengine/OpenViking/main/examples/memory-plugin-shared/install.sh) \
  --harness trae-cn

# 同时安装
bash <(curl -fsSL https://raw.githubusercontent.com/volcengine/OpenViking/main/examples/memory-plugin-shared/install.sh) \
  --harness trae,trae-cn
```

GitHub 访问受限时使用 TOS 镜像：

```bash
bash <(curl -fsSL https://ovrelease.tos-cn-beijing.volces.com/memory-plugin-shared/install.sh) \
  --harness trae,trae-cn --dist tos
```

安装后完全退出并重启对应客户端。

## 安装内容

- `SessionStart`：加载用户画像和当前项目记忆。
- `UserPromptSubmit`：根据当前问题召回并注入相关内容。
- `PreToolUse`：阻止把 `viking://` 虚拟路径当作本地文件访问，并提示改用 OpenViking MCP 工具。
- `PostToolUse`：成功执行会改变 `HEAD` 的 Git 命令后，异步上传已提交的代码快照；`git status`、`git diff` 等只读命令不会触发上传。
- `Stop`：捕获本轮消息并立即提交，使短会话也能进入记忆抽取流程。
- OpenViking MCP Server：提供 `search`、`recall`、`read`、`remember` 等主动记忆工具。
- 安装器同时安装 `repo-wiki` Skill，用于在本地 `.repo_memory` 中创建、更新、校验 Wiki，并区分本地与云端 Wiki 检索。

仓库 Wiki 上传目前是默认关闭的插件 MVP。只在隔离测试环境中设置
`OPENVIKING_REPO_WIKI_UPLOAD_ENABLED=1` 后，现有仓库 Hook 才会把 Wiki 与
`git_local` 代码快照分开上传。Wiki 使用 no-split、vectors-only 资源导入，
保留 Skill 已编写的页面，并跳过服务端二次语义摘要。

## 验证

1. 重启 TRAE 或 TRAE CN，并新建 Agent 会话。
2. 在客户端的 MCP 设置中确认 `openviking` 已连接。
3. 提问一个与已有项目或个人偏好相关的问题，确认回答使用了已有记忆。
4. 告诉 Agent 一个临时偏好，等待回复完成；新建会话后再次询问，确认捕获、提交和跨会话召回均生效。

需要排查 Hook 时，设置 `OPENVIKING_DEBUG=1` 后启动客户端，并查看：

- TRAE：`~/.openviking/logs/trae-hooks.log`
- TRAE CN：`~/.openviking/logs/trae-cn-hooks.log`

## 升级与卸载

重复运行对应安装命令即可升级。卸载时也应使用原安装渠道：

```bash
# GitHub，以 TRAE CN 为例
bash <(curl -fsSL https://raw.githubusercontent.com/volcengine/OpenViking/main/examples/memory-plugin-shared/install.sh) \
  --harness trae-cn --uninstall --yes

# TOS，以 TRAE CN 为例
bash <(curl -fsSL https://ovrelease.tos-cn-beijing.volces.com/memory-plugin-shared/install.sh) \
  --harness trae-cn --uninstall --yes
```

将 `trae-cn` 替换为 `trae` 可管理 TRAE 集成。卸载只移除 OpenViking 管理的配置与运行文件。

## 故障排查

| 现象 | 原因与处理 |
|------|-----------|
| 安装后没有自动召回 | 完全退出客户端后重新启动，并新建 Agent 会话。 |
| MCP 未连接 | 检查 `~/.openviking/ovcli.conf` 中的 URL/API Key，然后重启客户端。 |
| 新会话无法回忆上一轮内容 | 查看 Hook 日志，确认 `Stop` 已执行且 `/commit` 没有连接或鉴权错误。 |
| 同一内容被捕获多次 | 检查用户级与项目级 Hook 中是否仍有旧版 `trae-auto-recall.mjs` 或 `trae-auto-capture.mjs`；重跑安装器会移除由 OpenViking 管理的旧条目。 |

## 参见

- [鉴权](../guides/04-authentication.md)
