# Private Fund AI Research

## 任务分工

| 负责人 | 模块 | 主要交付物 | 测试目录 | 当前状态 | 进度 |
|---|---|---|---|---|---:|
| 雷雷 | Project DB / Company Collection / Analyst Space 总体 DB 结构 | [project_db_and_personal_memory_design.md](docs/project_db_and_personal_memory_design.md) | [test/project_db/](test/project_db/) | 初始设计完成，待实现 | 10% |
| 廖 | Research Memory | [research_memory_design.md](docs/research_memory_design.md) | [test/research_memory/](test/research_memory/) | 初始设计完成，待实现 | 10% |
| 朝龙 | Memo Generation | [memo_generation_design.md](docs/memo_generation_design.md) | [test/memo_generation/](test/memo_generation/) | 初始设计完成，待实现 | 10% |
| 程景逸 | Evidence Schema / Citation / Provenance | [evidence_schema_design.md](docs/evidence_schema_design.md) | [test/evidence_schema/](test/evidence_schema/) | 第一阶段实现完成，待与 DB 对齐 | 40% |

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
| 2026-06-25 | 实现第一阶段：统一 Evidence/Location/Citation schema、稳定 ID、PDF/Excel adapter、normalizer、render_citation_display、追溯 repository（内存版）。 | `src/evidence_schema/*`, `test/evidence_schema/*`, `README.md` | 运行 `pytest test/evidence_schema/`（11 passed）；给定 evidence_id 可定位原文件，Excel 返回 sheet/cell/value/formula，新版本入库不破坏旧 citation。 | review |
| 2026-06-26 | Excel adapter 兼容 `file`/`file_name`，`upstream_cells`/`number_format` 改为可选；新增 canonical block 测试；第一阶段提交分支送审。 | `src/evidence_schema/adapters/excel_adapter.py`, `test/evidence_schema/test_excel_evidence.py`, `README.md` | 运行 `pytest test/evidence_schema/`（13 passed）。 | review |
| 2026-06-26 | 第二阶段：新增 PPT/Word/Markdown 三个 evidence adapter（slide_no/shape_id、heading_path/labels、frontmatter/tags/wikilinks），统一接入 normalizer 与 display。 | `src/evidence_schema/adapters/ppt_adapter.py`, `src/evidence_schema/adapters/word_adapter.py`, `src/evidence_schema/adapters/markdown_adapter.py`, `src/evidence_schema/adapters/__init__.py`, `src/evidence_schema/__init__.py`, `test/evidence_schema/*`, `README.md` | 运行 `pytest test/evidence_schema/`（16 passed）；三类 parsed block 转统一 evidence，display 渲染与设计文档 §8 一致。 | review |
| 2026-06-28 | 低耦合 MVP：新增 `pick()` 字段 alias 助手，所有 adapter 不再写死上游字段名（page/page_no、slide/slide_no、heading/heading_path、file/file_name 等）；Excel `upstream_cells`/`number_format` 严格可选；补字段 alias 契约测试；在 `test/evidence_schema/README.md` 记录全部未确认接口与假设。 | `src/evidence_schema/adapters/base.py`, `src/evidence_schema/adapters/{pdf,ppt,word,markdown,excel}_adapter.py`, `test/evidence_schema/test_excel_evidence.py`, `test/evidence_schema/test_evidence_normalizer.py`, `test/evidence_schema/README.md`, `README.md` | 运行 `pytest test/evidence_schema/`（23 passed）；parser/DB/Memory/Memo 接口变更只需改 adapter alias，不影响下游。 | review |
| 2026-06-28 | 安全假设三项：新增 QA adapter（qa_message：session_id/message_id/role）、Memo adapter（memo_section：memo_id/section_id，可被 build_citation 消费）、轻量纯函数 citation quality gate（缺 evidence_id/claim/display -> needs_review）；均不接真实 DB/LLM，未确认项写入 ASSUMPTIONS。 | `src/evidence_schema/adapters/{qa,memo}_adapter.py`, `src/evidence_schema/citation_gate.py`, `src/evidence_schema/adapters/__init__.py`, `src/evidence_schema/__init__.py`, `test/evidence_schema/{test_qa_memo_adapters,test_citation_gate}.py`, `test/evidence_schema/fixtures/{qa,memo}_parsed.json`, `test/evidence_schema/{conftest,README}.py/md`, `README.md` | 运行 `pytest test/evidence_schema/`（34 passed）；gate 归属与 QA/Memo 真实字段待与廖/朝龙对齐，确认后只改 alias，不动 schema。 | review |

## 模块进度看板

| 模块 | Owner | 阶段目标 | 测试目录 | 下一步 | 阻塞项 |
|---|---|---|---|---|---|
| Project DB | 雷雷 | 固化 SQLite schema、目录结构和 repository API。 | `test/project_db/` | 输出第一版 schema.sql、初始化脚本和 DB 回溯测试。 | 暂无 |
| Research Memory | 廖 | QA 后完整写入原文、facts、citations、audit，并进入语义索引。 | `test/research_memory/` | 实现最小 QA memory 闭环和对应测试 fixture。 | OpenViking 接入方案待确认 |
| Memo Generation | 朝龙 | 固定模板 memo + evidence pack + citation gate。 | `test/memo_generation/` | 实现 memo 最小端到端 demo 和 citation gate 测试。 | 依赖 Evidence Schema 和 Memory API |
| Evidence Schema | 程景逸 | 统一 evidence/citation/provenance schema。 | `test/evidence_schema/` | 与雷雷对齐 collection.db 字段后接入 SQLite repository；补 QA/Memo adapter。 | 需要和 DB schema 对齐（见 `test/evidence_schema/README.md` 对齐清单） |

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
