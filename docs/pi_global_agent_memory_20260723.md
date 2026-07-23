# 📝 Pi 全局 Agent 与跨会话记忆设计

> 📝 2026-07-23：在 `main@82d058b` 基础上实现，开发分支为
> `codex/pi-global-agent-memory`。

## 📝 目标

- 📝 Pi 是工作区的顶层编排 Agent，可以查看授权范围内的 Agent/会话、创建并驱动子会话、执行异步任务、设置定时任务、操作终端与工作区，并通过 Omnigent 的统一策略层执行工具。
- 📝 Pi 在新会话中能够召回同一项目此前保存的决策、偏好、进度和交接信息。
- 📝 运行记忆不成为投资事实来源。私募研究结论仍必须来自结构化 `private_fund_*` 工具，并保留 `evidence_id` 与研究谱系。
- 📝 “掌控全局”只覆盖用户已授权的资源，不自动开放公开分享会话或扩大访问范围。

## 📝 运行链路

```text
Pi TUI
  ├─ Pi 原生 read/write/edit/bash
  ├─ pi-memory@0.4.0
  │    └─ 项目级 Markdown 记忆目录
  └─ Omnigent Pi Native Extension
       ├─ Agent / Session / Async / Timer / Terminal / OS / Policy
       ├─ load_skill
       └─ private_fund_* 结构化研究工具
```

- 📝 内置 `pi-native-ui` 使用原生 `config.yaml` Agent bundle，显式开启 `spawn`、`async` 和 `timers`，同时保持 `agent_session_sharing: none`。
- 📝 Pi Native Extension 在 `before_agent_start` 生命周期中追加编排、记忆和证据边界，不覆盖 Pi 自带系统提示、项目 `AGENTS.md` 或其他扩展提示。
- 📝 `load_skill` 进入 native relay；四个私募研究 Skill 随 Pi bundle 分发，Pi 可以按任务加载详细工作流。
- 📝 私募基金业务工具仍由 Omnigent MCP 代理执行，继续使用服务端权限、策略和 dataset 绑定，而不是绕过到本地数据库。

## 📝 记忆模型

- 📝 接入固定版本 `npm:pi-memory@0.4.0`，核心记忆以 Markdown 保存；`qmd` 仅用于可选的关键词/语义检索，缺少 `qmd` 不影响基本读写。
- 📝 默认目录为 `~/.omnigent/pi-memory/<项目名>-<仓库身份哈希>/`，权限为 `0700`。
- 📝 同一 Git 仓库的主工作区和所有 worktree 使用 Git common dir 作为身份，因此跨分支、跨 Pi 会话共享一份项目记忆。
- 📝 非 Git 工作区按规范化绝对路径隔离；不同项目默认不共享记忆，避免公司、策略或用户偏好串库。
- 📝 `OMNIGENT_PI_MEMORY_DIR` 优先于 `PI_MEMORY_DIR`；二者都可以显式指向团队挂载盘或单一跨项目目录。
- 📝 `PI_MEMORY_SNAPSHOT` 默认使用 `stable`，也接受显式 `per-turn`。默认值优先保持提示缓存稳定。

## 📝 Pi 配置与凭据边界

- 📝 每个 Omnigent 会话继续使用自己的受管 `PI_CODING_AGENT_DIR`；`pi-memory` 作为固定必需 package 加入受管 `settings.json`，不会替换用户已有 packages。
- 📝 新增 package 时 `npm/` 与 `git/` 安装树保持会话隔离，不通过 symlink 把自动安装写入用户的 `~/.pi/agent`。
- 📝 用户已有 `auth.json` 和 `models.json` 只复制到权限 `0700` 的受管目录，目标已存在时不覆盖；Omnigent Provider 随后只改写受管 `models.json`。
- 📝 第三方 Pi package 拥有 Pi 进程权限，因此版本固定，不使用浮动 latest；升级前必须单独复核源代码、许可证和回归测试。

## 📝 事实与记忆边界

- 📝 可以写入运行记忆：用户偏好、已批准决策、工作进度、交接说明、失败教训、后续检查项。
- 📝 不应直接写成确定事实：未经验证的公司数据、估值假设、风险/催化剂状态、财务数值和来源不明的模型结论。
- 📝 当记忆与 Project DB 冲突时，以 Project DB、当前资料版本和 evidence 链为准；Pi 应重新调用结构化工具，而不是沿用旧记忆。
- 📝 `memory_forget` 只影响 Pi 运行记忆，不删除 Project DB、原始资料、研究节点、Memo 或 Obsidian 投影。

## 📝 验证

- 📝 137 项 Pi Native、记忆、受管设置、bundle、扩展、工具中继、模型配置、私募本地分发和真实终端启动测试通过。
- 📝 Ruff 检查通过；新增记忆与受管设置核心模块通过 MyPy。
- 📝 较大的 native-session 回归共 379 项，其中 377 项通过；2 项 Claude Native 断言因本仓库存在 `cc-haha/bin/claude-haha` 包装器而期望 `claude` 命令失败，与本次 Pi 改动无关。
- 📝 尚未完成真实 Pi 二进制 + 模型凭据的交互式端到端验收；首次启动仍需要网络安装固定的 `pi-memory` package，语义检索另需安装 `qmd`。
