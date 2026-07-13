# Omnigent 本地服务运行手册

> 📝 2026-07-13：补充当前 Omnigent、Host 与 LiteLLM 的统一启停和健康检查约定。

本项目使用一个 tmux session 统一托管三个长期服务，避免只重启 Server 后遗漏 Host，导致页面提示 `host is offline`。

## 服务组成

默认 tmux session 为 `omnigent-stack`，包含以下窗口：

| 窗口 | 服务 | 健康检查 |
|---|---|---|
| `litellm` | LiteLLM 模型代理 | `http://127.0.0.1:4000/health/liveliness` |
| `server` | Omnigent API 与 Web UI | `http://127.0.0.1:6767/health` |
| `host` | 本机 Host tunnel 与 Runner 启动器 | `omnigent host status` |

`control` 窗口用于保持 tmux session 生命周期稳定，不承载业务请求。

## 常用命令

首次启动或日常启动：

```bash
scripts/manage_omnigent_services.sh start
```

完整重启：

```bash
scripts/manage_omnigent_services.sh restart
```

检查三层状态：

```bash
scripts/manage_omnigent_services.sh status
```

查看最近日志：

```bash
scripts/manage_omnigent_services.sh logs
```

进入 tmux：

```bash
scripts/manage_omnigent_services.sh attach
```

停止完整服务：

```bash
scripts/manage_omnigent_services.sh stop
```

## 启动顺序与故障判断

脚本按 `LiteLLM -> Server -> Host` 顺序启动。Server 会等待 LiteLLM，Host 会等待 Server，最后分别验证模型代理、HTTP 健康接口和 Host tunnel。

页面出现 `host is offline` 时，先执行：

```bash
scripts/manage_omnigent_services.sh status
scripts/manage_omnigent_services.sh logs
```

如果 Server 为 online、Host 为 offline，执行完整重启即可。脚本也会清理旧版的 `omnigent-server` 和 `omnigent-litellm` tmux session，避免端口被两套进程同时占用。

## 可配置项

可通过环境变量覆盖默认值：

| 变量 | 默认值 |
|---|---|
| `OMNIGENT_STACK_TMUX_SESSION` | `omnigent-stack` |
| `OMNIGENT_SERVER_HOST` | `127.0.0.1` |
| `OMNIGENT_SERVER_PORT` | `6767` |
| `LITELLM_HOST` | `127.0.0.1` |
| `LITELLM_PORT` | `4000` |
| `OMNIGENT_STACK_WAIT_SECONDS` | `180` |

第三方模型的目标地址、模型名和密钥从 `FinSagent/config/production.yaml` 或 LiteLLM 目标模型环境变量读取，具体代理配置由 `scripts/start_litellm_dashscope.sh` 生成。

私募投研入口优先使用 `claude-native-ui`。Claude Code 默认通过本服务栈的 LiteLLM Anthropic 兼容接口调用第三方模型，不需要 Anthropic 官方账号登录：

```text
私募投研页面 -> Claude Native -> LiteLLM :4000 -> 第三方模型 API
```

如需覆盖 Claude Code 到代理层的连接，可使用以下专用变量；脚本不会继承通用 `ANTHROPIC_BASE_URL`，避免意外绕过本地 LiteLLM：

| 变量 | 默认值 |
|---|---|
| `OMNIGENT_CLAUDE_API_BASE_URL` | `http://127.0.0.1:4000` |
| `OMNIGENT_CLAUDE_API_TOKEN` | `sk-local-cc-haha` |
| `OMNIGENT_CLAUDE_MODEL` | `qwen3-max` |

仅当 Claude Native Agent 不可用时，页面才回退到 `qwen-research/openai-agents`。
