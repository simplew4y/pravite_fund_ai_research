# Private Fund AI Research

## 任务分工

| 负责人 | 模块 | 主要交付物 | 当前状态 | 进度 |
|---|---|---|---|---:|
| 雷雷 | Project DB / Company Collection / Analyst Space 总体 DB 结构 | [project_db_and_personal_memory_design.md](docs/project_db_and_personal_memory_design.md) | 初始设计完成，待实现 | 10% |
| 廖 | Research Memory | [research_memory_design.md](docs/research_memory_design.md) | 初始设计完成，待实现 | 10% |
| 朝龙 | Memo Generation | [memo_generation_design.md](docs/memo_generation_design.md) | 初始设计完成，待实现 | 10% |
| 程景逸 | Evidence Schema / Citation / Provenance | [evidence_schema_design.md](docs/evidence_schema_design.md) | 初始设计完成，待实现 | 10% |

## 每个人的更新内容

### 雷雷：Project DB / Company Collection / Analyst Space

负责内容：

- 定义 `projects/{project_id}` 下的整体 DB 和目录结构。
- 设计 `company_collection` 与 `analyst_space` 的边界。
- 实现或指导 `documents`、`document_versions`、`evidence`、`citations`、`facts`、`audit_trail` 等核心表。
- 确保任意 QA / memo 结论可以回溯到 citation、evidence、document、original file location。

更新记录：

| 日期 | 更新摘要 | 影响文件 | 验证方式 | 状态 |
|---|---|---|---|---|
| 2026-06-24 | 创建 Project DB 与 Personal Memory 总体设计文档。 | `docs/project_db_and_personal_memory_design.md` | 文档已覆盖目标、表结构、链路、验收口径。 | done |

### 廖：Research Memory

负责内容：

- 实现 QA 后写入 `messages.jsonl`、`content.md`、SQLite 精确记忆。
- 设计并实现 `facts`、`citations`、`audit_trail`、`memory_items`。
- 打通 Markdown + OpenViking 语义记忆。
- 支持“之前是否讨论过类似问题”的历史研究召回。

更新记录：

| 日期 | 更新摘要 | 影响文件 | 验证方式 | 状态 |
|---|---|---|---|---|
| 2026-06-24 | 创建 Research Memory 设计文档。 | `docs/research_memory_design.md` | 文档已覆盖 QA 写入链路、SQLite/Markdown/OpenViking 分工、正确性验证。 | done |

### 朝龙：Memo Generation

负责内容：

- 基于 evidence、facts、history QA、personal notes 生成 memo 初稿。
- 实现 evidence pack、固定 memo 模板、section 生成、citation gate。
- 写入 `memo_drafts`、`memo_sections`、`citations`、markdown memo。
- 确保没有 citation 的核心判断被标记 `needs_review`。

更新记录：

| 日期 | 更新摘要 | 影响文件 | 验证方式 | 状态 |
|---|---|---|---|---|
| 2026-06-24 | 创建 Memo 生成模块设计文档。 | `docs/memo_generation_design.md` | 文档已覆盖输入输出、Evidence Pack、Citation Gate、验收流程。 | done |

### 程景逸：Evidence Schema / Citation / Provenance

负责内容：

- 设计统一 Evidence Schema。
- 为 PDF、PPT、Word、Excel、Markdown、QA、Memo 设计不同 adapter。
- 统一 citation/provenance 输出格式。
- 确保每条 evidence 能定位到原始文件、版本和具体位置。

更新记录：

| 日期 | 更新摘要 | 影响文件 | 验证方式 | 状态 |
|---|---|---|---|---|
| 2026-06-24 | 创建 Evidence Schema 与溯源设计文档。 | `docs/evidence_schema_design.md` | 文档已覆盖各文档类型 evidence 格式、citation schema、追溯测试。 | done |

## 模块进度看板

| 模块 | Owner | 阶段目标 | 下一步 | 阻塞项 |
|---|---|---|---|---|
| Project DB | 雷雷 | 固化 SQLite schema、目录结构和 repository API。 | 输出第一版 schema.sql 和初始化脚本。 | 暂无 |
| Research Memory | 廖 | QA 后完整写入原文、facts、citations、audit，并进入语义索引。 | 实现最小 QA memory 闭环。 | OpenViking 接入方案待确认 |
| Memo Generation | 朝龙 | 固定模板 memo + evidence pack + citation gate。 | 实现 memo 最小端到端 demo。 | 依赖 Evidence Schema 和 Memory API |
| Evidence Schema | 程景逸 | 统一 evidence/citation/provenance schema。 | 实现 PDF 和 Excel 两个最小 adapter。 | 需要和 DB schema 对齐 |

## 员工 Coding Agent 更新规范

每次提交前必须阅读并遵守：

[coding_agent_push_update_instructions.md](docs/coding_agent_push_update_instructions.md)

最低要求：

1. 只修改自己负责模块相关文件，跨模块变更必须在 README 更新记录里说明。
2. 每次 push 都要更新本 README 中对应负责人的“更新记录”和“模块进度看板”。
3. 每次提交都要说明验证方式，不允许只写“更新代码”。
4. 涉及 schema、citation、memory、memo 的变更，必须能说明如何回溯到原始 evidence。

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

