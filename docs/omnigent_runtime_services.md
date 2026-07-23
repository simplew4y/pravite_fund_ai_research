# Omnigent 本地服务运行手册

> 📝 2026-07-13：补充当前 Omnigent、Host 与 LiteLLM 的统一启停和健康检查约定。

📝 本项目使用一个 tmux session 统一托管六个长期服务，避免只重启 Server 后遗漏 Host 或异步 Worker。

## 服务组成

默认 tmux session 为 `omnigent-stack`，包含以下窗口：

| 窗口 | 服务 | 健康检查 |
|---|---|---|
| `litellm` | LiteLLM 模型代理 | `http://127.0.0.1:4000/health/liveliness` |
| `server` | Omnigent API 与 Web UI | `http://127.0.0.1:6767/health` |
| `tracking` | 📝 风险、催化剂与 Memo 异步跟踪 | tmux 窗口 + Worker health JSON |
| `valuation` | 📝 估值模型版本与变化跟踪 | tmux 窗口 + Worker health JSON |
| `obsidian` | 📝 Project DB 到 Obsidian 的版本知识投影 | tmux 窗口 + Worker health JSON |
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

📝 脚本按 `LiteLLM -> Server -> Tracking -> Valuation -> Obsidian -> Host` 顺序创建窗口。Server、Tracking 和 Valuation 会等待 LiteLLM，Host 会等待 Server；最后验证模型代理、HTTP 健康接口、三个 Worker 窗口和 Host tunnel。

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

## 📝 可回退的 xiaomoxing vLLM 配置（2026-07-21）

📝 当前本机已把统一模型出口切换到 SeetaCloud vLLM。服务的实际 `served-model-name` 是 `qwen3.6-35b-awq`，不是测试脚本最初填写的 `xiaomoxing`；LiteLLM 同时保留 `qwen3-max` 兼容别名，现有 Claude Native 会话无需修改模型名。

📝 切换前的 `qwen3-max -> DashScope` 完整配置只保存在本机权限为 `600` 的 `FinSagent/config/production.before-xiaomoxing.yaml`，该目录被 Git 忽略，禁止在文档、日志或提交中展开密钥。模型配置切换命令为：

```bash
scripts/switch_llm_profile.sh status
scripts/switch_llm_profile.sh xiaomoxing
scripts/manage_omnigent_services.sh restart
```

📝 恢复切换前配置时执行：

```bash
scripts/switch_llm_profile.sh previous
scripts/manage_omnigent_services.sh restart
```

📝 当前验证结果：远端 `/v1/models`、普通对话和流式输出可用；经本地 LiteLLM 的真实模型名与 `qwen3-max` 兼容名均能返回合法 JSON，Tracking/Valuation Worker 均显示 `llm_enabled=true`。通用 OpenAI-compatible 客户端和 LiteLLM 都会读取 `llm_chat_template_enable_thinking=false` 并向 vLLM 传递 `chat_template_kwargs.enable_thinking=false`，避免直接调用与代理调用把思考过程写入 JSON 正文。

> [!IMPORTANT]
> 📝 远端 vLLM 当前实际拒绝自动和强制工具调用，错误明确要求启用 `--enable-auto-tool-choice` 与 `--tool-call-parser`；Anthropic-compatible 路径也仍把思考过程写入正文。后台非工具型抽取/分析可使用新模型，但依赖工具调用的 Claude Native 研究链路在远端修复前不能视为完整可用。远端修复后必须重新验证普通对话、流式输出、自动工具调用和 Anthropic-compatible `/v1/messages`。

## 📝 AKShare 免费行情 Provider（2026-07-21）

估值跟踪默认使用 AKShare 获取 A 股和港股不复权日线，不需要 API Token。刷新真实数据时，系统会缓存日线价格，并把模型中的目标价与估值基准日收盘价、最新收盘价分别比较；页面展示估值日隐含空间和当前剩余空间。

- 📝 A 股支持六位代码及 `.SZ`、`.SH`、`.BJ` 后缀；港股支持 `.HK` 后缀并自动补齐 AKShare 五位代码。
- 📝 优先使用 AKShare 的东方财富历史行情接口；单一上游断连时，A 股和港股自动回退到新浪历史行情接口。
- 📝 价格比较固定使用 `adjust=""` 的原始收盘价，避免把前/后复权序列误当作估值当日真实成交价。
- 📝 AKShare 负责日线价格与可用时的 20 日平均成交额；季度财务指标和 Forward PE 仍需财报解析、一致预期 API 或其他专业数据源。
- 📝 每次行情异常都会作为 comparison 状态和错误信息持久化，不阻断模型版本入库，也不会用模拟值填补缺口。

可用环境变量：

| 变量 | 值 | 说明 |
|---|---|---|
| `PRIVATE_FUND_MARKET_DATA_PROVIDER` | `akshare` | 📝 强制使用默认免费行情源 |
| `PRIVATE_FUND_MARKET_DATA_PROVIDER` | `tushare` | 📝 使用 `TUSHARE_TOKEN` 对应接口 |
| `PRIVATE_FUND_MARKET_DATA_PROVIDER` | `http` | 📝 使用标准化内部 API |
| `PRIVATE_FUND_MARKET_DATA_PROVIDER` | `disabled` | 📝 禁用外部真实数据请求 |

如未设置 Provider，系统按“已配置标准化 HTTP API → 已配置 Tushare Token → AKShare”选择；因此全新本地环境会直接使用 AKShare。

## 📝 估值模型跟踪 Worker（2026-07-15）

统一服务栈新增 `valuation` 窗口，运行 `omnigent.server.private_fund_valuation_worker`。完整启动顺序为 `LiteLLM -> Server -> Research Tracking Worker -> Valuation Tracking Worker -> Host`；`status` 与 `logs` 会同时检查 `tracking` 和 `valuation` 两个异步 Worker。

📝 估值 Worker 每轮发现各 dataset 中已分类并索引的估值模型：顶层业务类别为 `financial_valuation_data`，具体模型语义保留在 `doc_subtype`，同时接受 `excel_workbooks.workbook_type=valuation_model` 的结构识别。Worker 为每个文档版本建立幂等任务，读取 pipeline 已生成的 Excel `metric_facts`，写入独立的模型系列、结构化快照、差异、分析、规则和提醒表。它不会执行宏、重算公式或改写原始工作簿。

- 📝 当 `PRIVATE_FUND_VALUATION_USE_LLM` 未禁用且 LiteLLM 可用时，Worker 会加载 `private-fund-valuation-metrics` Skill，让 Agent 选择五指标语义、证据和估值日并输出固定 JSON；服务端按 evidence 重新计算增长/环比，再校验日期、数值和冲突后落库。
- 📝 同一 Worker 会加载 `private-fund-valuation-impacts` Skill，把当前项目的财报、研究报告和会议纪要片段转换为结构化估值影响卡片；方向、置信度、估值输入和 `chunk:` 证据经服务端校验后写入独立运行表与卡片表，不直接改写模型或触发五指标预警。
- 📝 Agent 结果按模型版本、提取器版本和目标期间缓存；Agent 不可用、格式错误、证据不足或与确定性提取冲突时自动回退，行情与估值版本任务继续执行。

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

## 📝 Obsidian Projection Worker（2026-07-20）

`obsidian` 窗口运行 `omnigent.server.private_fund_obsidian_worker`。它读取各 dataset 的 `obsidian_sync_outbox`，把 Memo 与估值系列、不可变版本、相邻差异和证据卡投影到配置的 Vault，并用 `obsidian_note_registry` 记录路径与内容 hash。

- 📝 `PRIVATE_FUND_OBSIDIAN_VAULT_PATH` 必须指向真实 Vault 根目录；统一脚本默认使用 `$HOME/feiyuzi/personal_obsidian_workspace`。
- 📝 Worker 使用临时文件和原子替换写笔记，保留 `USER` 区；受管 `AUTO` 区被人工修改时生成冲突记录，不静默覆盖。
- 📝 Worker 周期 reconcile，重复事件通过 dataset、实体、版本和 projector version 幂等去重。
- 📝 健康状态写入 `output/private_fund_datasets/.obsidian-projection-worker.json`；业务工具 `private_fund_knowledge_status` 可读取队列、registry、冲突和 Vault 可用性。

单轮诊断：

```bash
cd omnigent
PRIVATE_FUND_OBSIDIAN_VAULT_PATH="/absolute/path/to/obsidian-vault" \
  uv run --offline python -m omnigent.server.private_fund_obsidian_worker --once
```

> 📝 2026-07-20 运行提示：首次 `uvx` 启动 LiteLLM 时可能下载或构建依赖并超过默认 180 秒。tmux 窗口存在不等于服务健康；等待构建结束后再次执行 `restart`，并以 `status` 和 HTTP health 为准。
