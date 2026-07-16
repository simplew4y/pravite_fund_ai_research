# Omnigent 本地服务运行手册

> 📝 2026-07-13：补充当前 Omnigent、Host 与 LiteLLM 的统一启停和健康检查约定。

📝 本项目使用一个 tmux session 统一托管五个长期服务，避免只重启 Server 后遗漏 Host 或异步 Worker。

## 服务组成

默认 tmux session 为 `omnigent-stack`，包含以下窗口：

| 窗口 | 服务 | 健康检查 |
|---|---|---|
| `litellm` | LiteLLM 模型代理 | `http://127.0.0.1:4000/health/liveliness` |
| `server` | Omnigent API 与 Web UI | `http://127.0.0.1:6767/health` |
| `tracking` | 📝 风险、催化剂与 Memo 异步跟踪 | tmux 窗口 + Worker health JSON |
| `valuation` | 📝 估值模型版本与变化跟踪 | tmux 窗口 + Worker health JSON |
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

📝 脚本按 `LiteLLM -> Server -> Tracking -> Valuation -> Host` 顺序启动。Server 会等待 LiteLLM，Host 会等待 Server，最后验证模型代理、HTTP 健康接口、两个 Worker 窗口和 Host tunnel。

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

## 📝 估值模型跟踪 Worker（2026-07-15）

统一服务栈新增 `valuation` 窗口，运行 `omnigent.server.private_fund_valuation_worker`。完整启动顺序为 `LiteLLM -> Server -> Research Tracking Worker -> Valuation Tracking Worker -> Host`；`status` 与 `logs` 会同时检查 `tracking` 和 `valuation` 两个异步 Worker。

估值 Worker 每轮发现各 dataset 中已分类并索引的 `valuation_model` 文档，为每个文档版本建立幂等任务，读取 pipeline 已生成的 Excel `metric_facts`，写入独立的模型系列、结构化快照、差异、分析、规则和提醒表。它不会执行宏、重算公式或改写原始工作簿。

可通过以下环境变量调整轮询：

| 变量 | 默认值 |
|---|---|
| `PRIVATE_FUND_VALUATION_POLL_SECONDS` | `5` |
| `PRIVATE_FUND_VALUATION_LOG_LEVEL` | `INFO` |
| `PRIVATE_FUND_VALUATION_LLM_BASE_URL` | 默认复用本地 LiteLLM `/v1` |

健康状态写入 `output/private_fund_datasets/.valuation-tracking-worker.json`。手工单轮验证可运行：

```bash
cd omnigent
uv run --offline python -m omnigent.server.private_fund_valuation_worker --once
```

### 📝 Agent 分析运行链路（2026-07-15）

估值 Worker 同时处理 `agent_analysis` 任务，并复用项目现有 OpenAI-compatible 客户端。统一启动脚本会等待 LiteLLM 健康后再启动估值 Worker，并默认把 `PDF_RESEARCH_LLM_BASE_URL` 指向 `http://127.0.0.1:4000/v1`；这样 Agent 分析与页面 Agent 使用同一模型代理、认证和重试出口，避免 Worker 直接连接外部模型端点时出现 TLS 或网络差异。

- 📝 健康 JSON 的 `llm_enabled` 用于确认 Worker 是否具备 Agent 分析能力；结构化版本扫描和确定性比较不依赖该字段。
- 📝 Agent 任务失败会保留状态和错误并按队列策略重试，不会阻塞其他模型版本入库。
- 📝 派生文件生成是本地确定性步骤，不调用模型；它只消费已经持久化并通过安全校验的建议。
- 📝 服务重启后，排队中的 Agent 任务、已完成分析和派生模型记录都从 dataset 的 `collection.sqlite3` 恢复。

### 📝 派生模型资源入库（2026-07-15）

`POST /v1/private-fund/projects/{dataset_id}/valuation-derived-models/{derived_model_id}/add-to-resources` 会校验本地派生文件和审计 checksum，以基础模型原文件名写入 `_uploads/<dataset_id>/`，随后提交一次非重置、递归的资料 Pipeline。该接口返回 Pipeline job，前端轮询至终态。

- 📝 Pipeline Worker 启动、完成或失败时会同步更新 `valuation_derived_models.resource_status`；完成后同时记录新文档 `doc_id`。
- 📝 接口只允许读取 dataset 自己的 `derived_models/`，不接受客户端路径，也不允许导入审计哈希不一致的文件。
- 📝 加入资源是显式用户操作；服务重启和模型派生本身都不会自动把文件推入资料源。
