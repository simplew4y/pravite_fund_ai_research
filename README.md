# Private Fund AI Research

## 当前分支说明

本分支整理了当前 Omnigent + Claude Code Haha + 本地 PDF evidence 私募研究 demo 的完整系统结构。

核心文档：

| 文档 | 内容 |
|---|---|
| [omnigent_cc_haha_system_architecture_20260706.md](docs/omnigent_cc_haha_system_architecture_20260706.md) | Omnigent、cc-haha、LiteLLM、DashScope、本地 PDF QA、Memo PDF、来源点击面板的完整运行链路 |
| [private_fund_code_architecture_20260706.md](docs/private_fund_code_architecture_20260706.md) | `src/pdf_research_demo`、FinSagent 接入、脚本、测试和 Omnigent 补丁的代码架构说明 |
| [omnigent_private_fund_integration_20260706.patch](patches/omnigent_private_fund_integration_20260706.patch) | 当前本地 `omnigent/` clone 的私募研究集成补丁，避免把独立 clone 整体塞进主仓库 |

当前 GitHub 分支只提交主业务仓库代码、文档、脚本、测试和 Omnigent 补丁；本地 PDF、运行输出、`omnigent/` clone、`cc-haha/` clone 和依赖目录不进入主仓库。

## 任务分工

| 负责人 | 模块 | 主要交付物 | 测试目录 | 当前状态 | 进度 |
|---|---|---|---|---|---:|
| 雷雷 | Project DB / Company Collection / Analyst Space 总体 DB 结构 | [project_db_and_personal_memory_design.md](docs/project_db_and_personal_memory_design.md) | [test/project_db/](test/project_db/) | 初始设计完成，待实现 | 10% |
| 廖 | Research Memory | [research_memory_design.md](docs/research_memory_design.md) | [test/research_memory/](test/research_memory/) | 初始设计完成，待实现 | 10% |
| 朝龙 | Memo Generation | [memo_generation_design.md](docs/memo_generation_design.md) | [test/memo_generation/](test/memo_generation/) | 初版报告生成 PR 已送审，待修复后合并 | 40% |
| 程景逸 | Evidence Schema / Citation / Provenance | [evidence_schema_design.md](docs/evidence_schema_design.md) | [test/evidence_schema/](test/evidence_schema/) | 第一阶段实现 PR 已送审，待修复后合并 | 30% |

## 测试目录要求

当前阶段大家单独开发，所有和自己模块相关的测试、fixture、验证脚本、测试说明，都必须放在 `test/` 下对应目录中。

| 负责人 | 模块 | 测试目录 | 应包含内容 |
|---|---|---|---|
| 雷雷 | Project DB | [test/project_db/](test/project_db/) | schema 初始化测试、migration 测试、citation 到 evidence 的回溯测试、DB fixture |
| 廖 | Research Memory | [test/research_memory/](test/research_memory/) | QA 写入测试、messages.jsonl/content.md fixture、facts/citations/audit 测试、语义召回验证 |
| 朝龙 | Memo Generation | [test/memo_generation/](test/memo_generation/) | evidence pack fixture、memo section 生成测试、citation gate 测试、memo.md 输出样例 |
| 程景逸 | Evidence Schema | [test/evidence_schema/](test/evidence_schema/) | PDF/PPT/Word/Excel/Markdown evidence fixture、location 渲染测试、citation display 测试 |

每次更新 README 的“验证方式”时，必须引用自己模块下的测试目录或具体测试文件。例如：

```text
验证方式：运行 test/research_memory/test_qa_writer.py，并检查 test/research_memory/fixtures/session_001/content.md。
```

## 每个人的更新内容

### 雷雷：Project DB / Company Collection / Analyst Space

负责内容：

- 定义 `projects/{project_id}` 下的整体 DB 和目录结构。
- 设计 `company_collection` 与 `analyst_space` 的边界。
- 实现或指导 `documents`、`document_versions`、`evidence`、`citations`、`facts`、`audit_trail` 等核心表。
- 确保任意 QA / memo 结论可以回溯到 citation、evidence、document、original file location。
- 测试和验证材料统一放在 [test/project_db/](test/project_db/)。

更新记录：

| 日期 | 更新摘要 | 影响文件 | 验证方式 | 状态 |
|---|---|---|---|---|
| 2026-06-24 | 创建 Project DB 与 Personal Memory 总体设计文档。 | `docs/project_db_and_personal_memory_design.md` | 文档已覆盖目标、表结构、链路、验收口径。 | done |
| 2026-06-24 | 新增模块测试目录要求。 | `README.md`, `test/project_db/README.md` | 确认 Project DB 后续测试统一归档到 `test/project_db/`。 | done |

### 廖：Research Memory

负责内容：

- 实现 QA 后写入 `messages.jsonl`、`content.md`、SQLite 精确记忆。
- 设计并实现 `facts`、`citations`、`audit_trail`、`memory_items`。
- 打通 Markdown + OpenViking 语义记忆。
- 支持“之前是否讨论过类似问题”的历史研究召回。
- 测试和验证材料统一放在 [test/research_memory/](test/research_memory/)。

更新记录：

| 日期 | 更新摘要 | 影响文件 | 验证方式 | 状态 |
|---|---|---|---|---|
| 2026-06-24 | 创建 Research Memory 设计文档。 | `docs/research_memory_design.md` | 文档已覆盖 QA 写入链路、SQLite/Markdown/OpenViking 分工、正确性验证。 | done |
| 2026-06-24 | 新增模块测试目录要求。 | `README.md`, `test/research_memory/README.md` | 确认 Research Memory 后续测试统一归档到 `test/research_memory/`。 | done |

### 朝龙：Memo Generation

负责内容：

- 基于 evidence、facts、history QA、personal notes 生成 memo 初稿。
- 实现 evidence pack、固定 memo 模板、section 生成、citation gate。
- 写入 `memo_drafts`、`memo_sections`、`citations`、markdown memo。
- 确保没有 citation 的核心判断被标记 `needs_review`。
- 测试和验证材料统一放在 [test/memo_generation/](test/memo_generation/)。

更新记录：

| 日期 | 更新摘要 | 影响文件 | 验证方式 | 状态 |
|---|---|---|---|---|
| 2026-06-24 | 创建 Memo 生成模块设计文档。 | `docs/memo_generation_design.md` | 文档已覆盖输入输出、Evidence Pack、Citation Gate、验收流程。 | done |
| 2026-06-24 | 新增模块测试目录要求。 | `README.md`, `test/memo_generation/README.md` | 确认 Memo Generation 后续测试统一归档到 `test/memo_generation/`。 | done |
| 2026-06-29 | 初版 Memo / Equity Research Report 生成能力已提交 PR #2：新增 `/memo` 后端路由、RAG+LLM 章节生成、HTML 报告渲染、PDF 转换、前端报告生成入口、SSE 进度和 token 用量面板；当前待修复 review 阻塞点后合并。 | `README.md`, PR #2: `FinSagent/deploy/memo_routes.py`, `FinSagent/src/memo/report_generator.py`, `FinSagent/deploy/frontend/index.html`, `FinSagent/deploy/app.py` | 在 PR #2 临时 worktree 执行 `python -m py_compile FinSagent/deploy/memo_routes.py FinSagent/src/memo/report_generator.py` 通过；真实 import 暴露 FinRobot 私有绝对路径问题；fake RAG/LLM 最小生成通过；注入样例确认生成 HTML 需补 sanitizer / sandbox / CSP。 | review |
| 2026-06-30 | 新增 PDF-only 最小集成 demo：PDF/cached text 入库为 page evidence，支持 QA、固定 memo、citation_id 和 trace_citation 回到 PDF 文件/version/page/paragraph。 | `src/pdf_research_demo/*`, `scripts/run_pdf_research_demo.py`, `test/memo_generation/test_pdf_research_demo.py`, `test/memo_generation/outputs/tesla/pdf_demo_memo.md`, `test/memo_generation/README.md`, `README.md` | 运行 `python -m pytest test/memo_generation/test_pdf_research_demo.py -q`，结果 2 passed；运行 `python scripts/run_pdf_research_demo.py --pdf tesla_extracted/20260129_10-K_0001628280-26-003952.pdf --text tmp/pdfs/tesla_text/20260129_10-K_0001628280-26-003952.txt --question "What does Tesla say about Robotaxi and FSD?" --memo-out test/memo_generation/outputs/tesla/pdf_demo_memo.md`，确认 QA 和 memo citation 可 trace 到 PDF p.9。 | in_progress |
| 2026-06-30 | 在 PDF-only demo 上新增本地 Web 服务并接入真实 LLM：FastAPI API + 单页页面，可在浏览器提问、生成 memo，并点击 citation 查看 PDF 文件、version、page、paragraph 和原文片段；启动脚本默认读取 `FinSagent/config/production.yaml` 的 OpenAI-compatible LLM 配置。 | `src/pdf_research_demo/web_app.py`, `src/pdf_research_demo/llm.py`, `scripts/run_pdf_research_web_app.py`, `test/memo_generation/test_pdf_research_web_app.py`, `test/memo_generation/README.md`, `README.md` | 运行 `python -m pytest test/memo_generation -q`，结果 4 passed；运行 `python -m py_compile src/pdf_research_demo/*.py scripts/run_pdf_research_demo.py scripts/run_pdf_research_web_app.py` 通过；本地服务用 `python scripts/run_pdf_research_web_app.py --host 127.0.0.1 --port 8765` 启动后，可访问 `/api/health`、`/api/ask`、`/api/memo` 和 `/api/trace/{citation_id}`，需要禁用 LLM 时加 `--no-llm`。 | in_progress |
| 2026-06-30 | 完成真实 LLM smoke test：`qwen3-max` 可通过 DashScope OpenAI-compatible endpoint 调用；Web QA 和 memo 均返回 `llm_used=true`，citation 仍可 trace 到本地 Tesla PDF。 | `src/pdf_research_demo/llm.py`, `src/pdf_research_demo/demo.py`, `src/pdf_research_demo/web_app.py`, `scripts/run_pdf_research_web_app.py` | 运行最小 LLM 连通性检查返回 `ok`；启动 Web 服务后 `/api/health` 返回 `llm.enabled=true`、`model_name=qwen3-max`；`/api/ask` 返回 `llm_used=true`、3 条 citation、首条 trace 到 Tesla PDF p.9；`/api/memo` 返回 `llm_used=true`、4 个 section、8 条 citation。 | in_progress |
| 2026-06-30 | 将 FinSagent 主页面改为 Research Chat：左侧会话管理保留并支持 fallback SQLite；主输入框直接调用本地 evidence + 真实 LLM 的 research QA，不再使用单独 `PDF Research` 按钮；后端保留 `/pdf-research/health`、`/pdf-research/ask`、`/pdf-research/memo`、`/pdf-research/trace/{citation_id}` 作为内部 API。 | `FinSagent/deploy/app.py`, `FinSagent/deploy/session_routes.py`, `FinSagent/deploy/frontend/index.html`, `FinSagent/deploy/frontend/chat.js`, `FinSagent/deploy/frontend/session_sidebar.js`, `FinSagent/deploy/frontend/ui.js`, `README.md` | 运行 `python -m py_compile FinSagent/deploy/app.py FinSagent/deploy/session_routes.py src/pdf_research_demo/*.py` 通过；运行 `node --check FinSagent/deploy/frontend/chat.js && node --check FinSagent/deploy/frontend/session_sidebar.js && node --check FinSagent/deploy/frontend/ui.js` 通过；以 `FINSAGENT_SKIP_CHAT_INIT=1 python -m uvicorn app:app --host 127.0.0.1 --port 8000` 启动 FinSagent，确认首页有 `FinSagent Research`、没有 `pdf-research-trigger` 和 `pdf_research_panel.js`；`/sessions` 可创建会话；主 research ask 写入同一 session；`/sessions/{sid}/messages` 可读回带 citation 的回答。 | in_progress |

### 程景逸：Evidence Schema / Citation / Provenance

负责内容：

- 设计统一 Evidence Schema。
- 为 PDF、PPT、Word、Excel、Markdown、QA、Memo 设计不同 adapter。
- 统一 citation/provenance 输出格式。
- 确保每条 evidence 能定位到原始文件、版本和具体位置。
- 测试和验证材料统一放在 [test/evidence_schema/](test/evidence_schema/)。

更新记录：

| 日期 | 更新摘要 | 影响文件 | 验证方式 | 状态 |
|---|---|---|---|---|
| 2026-06-24 | 创建 Evidence Schema 与溯源设计文档。 | `docs/evidence_schema_design.md` | 文档已覆盖各文档类型 evidence 格式、citation schema、追溯测试。 | done |
| 2026-06-24 | 新增模块测试目录要求。 | `README.md`, `test/evidence_schema/README.md` | 确认 Evidence Schema 后续测试统一归档到 `test/evidence_schema/`。 | done |
| 2026-06-28 | 第一阶段实现已提交 PR #1：统一 evidence/location/citation schema、稳定 ID、PDF/Excel/PPT/Word/Markdown/QA/Memo adapter、citation display、内存版追溯 repository 和 citation gate；当前仍为 draft，待修复 review 问题后合并。 | `README.md`, PR #1: `src/evidence_schema/*`, `test/evidence_schema/*` | 在 PR #1 临时 worktree 运行 `pytest test/evidence_schema/`，结果 36 passed；review 发现 Excel 空 block 过滤和 Memo display 两项合并前修复点。 | review |

## 模块进度看板

| 模块 | Owner | 阶段目标 | 测试目录 | 下一步 | 阻塞项 |
|---|---|---|---|---|---|
| Project DB | 雷雷 | 固化 SQLite schema、目录结构和 repository API。 | `test/project_db/` | 输出第一版 schema.sql、初始化脚本和 DB 回溯测试。 | 暂无 |
| Research Memory | 廖 | QA 后完整写入原文、facts、citations、audit，并进入语义索引。 | `test/research_memory/` | 实现最小 QA memory 闭环和对应测试 fixture。 | OpenViking 接入方案待确认 |
| Memo Generation | 朝龙 | 已有 PDF-only 最小集成 demo、真实 LLM 综合、FinSagent 主 Research Chat、左侧会话管理和 citation trace；PR #2 报告生成链路仍在 review。 | `test/memo_generation/` | 将当前稳定 `citation_id -> evidence_id` 方案回填 PR #2 的报告链路；继续修复 sanitizer / sandbox / CSP 和输出路径校验；后续再接 MCP/skills 的多文件检索。 | PR #2 暂不建议合并；依赖 Evidence Schema、Memory API 和 Project DB SQLite repository 继续对齐 |
| Evidence Schema | 程景逸 | 第一阶段统一 evidence/citation/provenance 中间层 PR 已送审。 | `test/evidence_schema/` | 修复 Excel 空 block 过滤和 Memo display 后，将 PR #1 从 draft 转 ready 并合并；随后对接 SQLite repository。 | 需要和 DB schema、Research Memory citation 字段继续对齐 |

## 员工 Coding Agent 更新规范

每次提交前必须阅读并遵守：

[coding_agent_push_update_instructions.md](docs/coding_agent_push_update_instructions.md)

最低要求：

1. 只修改自己负责模块相关文件，跨模块变更必须在 README 更新记录里说明。
2. 每次 push 都要更新本 README 中对应负责人的“更新记录”和“模块进度看板”。
3. 每次提交都要说明验证方式，不允许只写“更新代码”。
4. 涉及 schema、citation、memory、memo 的变更，必须能说明如何回溯到原始 evidence。
5. 所有测试、fixture、验证脚本、验证输出样例，都必须放在 `test/` 下自己的模块目录。

## 项目目标

第一版 demo 目标是演示一个公司研究闭环：

```text
本地财报、研报、PPT、纪要、Excel 入库
-> 资料被处理成可检索、可引用、可审计的 evidence
-> 支持带出处问答
-> QA 和观点写入 research memory
-> 生成可编辑 memo 初稿
-> 每个核心结论都能回到证据
```

本项目不做自动投资决策，定位是：

```text
私募投研资料证据化与研究辅助 Demo
```

## 代码目录

当前仓库采用 monorepo 方式保存协作文档和相关代码：

```text
FinSagent/   主系统代码：本地资料库、Agentic RAG、证据问答、memory 原型
finrobot/    金融分析工具箱：财务数据、估值分析、报告生成能力
docs/        模块设计文档
test/        各模块独立测试与验证材料
```

注意：

```text
原 FinSagent / finrobot 的嵌套 .git 元数据已移出工作目录；
本仓库以顶层 Git 作为唯一协作入口。
```
