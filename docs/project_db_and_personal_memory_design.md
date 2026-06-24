# Project DB 与 Personal Memory 设计说明

## 1. 文档目的

本文档用于指导第一版私募投研资料系统的 DB、Memory、Memo 相关开发。

系统第一版不是完整投研平台，也不是自动投资决策系统。目标是围绕一个具体公司研究项目，打通以下闭环：

```text
本地资料入库
-> 资料证据化
-> 带引用问答
-> QA / note / memo 写入个人记忆
-> 基于证据生成 memo 初稿
-> 后续新资料可以触发关注目标检查
```

DB 设计的核心目标是：

```text
任何一个研究结论，都能追溯到原始资料、具体位置、引用关系、生成过程和历史观点。
```

## 2. 总体结构

一个研究项目建议采用以下目录结构：

```text
projects/
  {project_id}/
    project.json

    company_collection/
      original_files/
      parsed/
      bm25/
      vector_db/
      table_index/
      excel_index/
      graph/
      manifest.json
      collection.db

    analyst_space/
      obsidian_vault_link
      messages/
      markdown_memory/
      semantic_index/
      analyst.db
```

这里要明确一个概念：

```text
collection 不是单纯一个文件夹，也不是单纯一个 DB。
collection 是一个文件夹承载的一套资料、解析结果、索引和结构化数据库。
```

其中：

- `company_collection` 是团队共享资料库，负责资料、证据、结构化事实。
- `analyst_space` 是个人工作区，负责 QA、note、memo、个人事实、关注目标、观点演化。

两者的连接点是：

```text
analyst_space 中的 QA / note / memo
-> citation_id
-> company_collection.evidence_id
-> company_collection.doc_id
-> original file location
```

## 3. Project DB / Company Collection 的目标

`company_collection` 管的是“团队共享的资料和证据”。

它需要回答这些问题：

1. 这个项目里有哪些资料？
2. 每份资料是什么类型、来源、日期、版本？
3. 每份资料被解析出了哪些可引用 evidence？
4. 每条 evidence 来自原始资料的哪个位置？
5. 哪些结构化事实可以从资料中抽取出来？
6. BM25、向量库、表格索引、Excel 索引分别对应哪个版本？
7. 入库过程是否成功，失败在哪里，能否复现？

### 3.1 Company Collection 负责的内容

```text
财报 PDF
公告 / 研报 PDF
PPT
外部调研材料
团队共享纪要
Excel 估值模型
系统生成的 evidence pack
```

这些内容进入 `company_collection` 后，必须被转换为可引用 evidence。

示例：

```json
{
  "evidence_id": "ev_001",
  "doc_id": "doc_001",
  "evidence_type": "pdf_section",
  "file_name": "Zeekr_2024_AR.pdf",
  "page": 42,
  "section": "Gross margin",
  "text": "..."
}
```

Excel 不能简单按文本 chunk 处理。Excel evidence 应该保留 sheet、cell、range、value、formula。

示例：

```json
{
  "evidence_id": "ev_101",
  "doc_id": "doc_excel_001",
  "evidence_type": "excel_cell",
  "file_name": "Zeekr_valuation_model.xlsx",
  "sheet": "DCF",
  "range": "B10:H20",
  "cell": "E12",
  "value": "16.5%",
  "formula": "=E11/E10"
}
```

### 3.2 Company Collection 不负责的内容

第一版不要把个人工作流全部放进 company collection。

以下内容默认属于 `analyst_space`：

```text
个人手写 note
个人 Obsidian 笔记
个人 QA 历史
个人 memo 草稿
个人 watch target
个人观点变化
```

如果个人 memo 引用了团队资料，只存引用关系，不复制原始资料。

## 4. Personal / Analyst Space 的目标

`analyst_space` 管的是“研究员怎么研究、怎么记忆、怎么形成观点”。

它需要回答这些问题：

1. 我之前问过什么问题？
2. 系统当时怎么回答？
3. 当时用了哪些 evidence？
4. 我之前对某个公司、风险、指标的观点是什么？
5. 这个观点有没有变化？
6. 我长期关注哪些公司、指标、风险、催化剂？
7. 新资料入库后，是否命中了我的关注目标？
8. 生成的 memo 初稿引用了哪些证据，哪些地方需要人工复核？

### 4.1 Analyst Space 负责的内容

```text
QA 原始对话
QA markdown 归档
个人结构化 facts
个人 citations
个人 notes
Obsidian note 映射
memo drafts
memo sections
watch targets
watch alerts
viewpoint versions
personal audit trail
```

一次 QA 结束后，至少要写入三类记录：

```text
1. 原始对话：messages.jsonl
2. 可读归档：content.md
3. 结构化记录：analyst.db
```

结构化记录包括：

```text
qa_sessions
qa_messages
personal_facts
personal_citations
personal_audit_trail
```

### 4.2 Personal Memory 的重点

Personal memory 不是聊天记录备份，而是研究过程资产。

第一版必须支持：

```text
我之前是否讨论过某公司的毛利率？
之前关于某风险的判断是什么？
某次 memo 的核心观点引用了哪些资料？
某个假设是从哪次 QA 或哪份 Excel 模型来的？
新资料是否推翻了旧观点？
```

## 5. 推荐最小 DB 表

第一版可以先用 SQLite。不要一开始引入过多复杂基础设施。

### 5.1 collection.db

建议最小表：

```text
documents
document_versions
evidence
evidence_locations
structured_facts
entities
ingest_jobs
index_registry
ingest_audit
```

#### documents

记录每份资料的稳定身份。

关键字段：

```text
doc_id
project_id
company_id
file_name
doc_type
source
document_date
current_version_id
created_at
updated_at
```

#### document_versions

记录文件版本。

关键字段：

```text
version_id
doc_id
file_path
checksum
version_no
ingested_at
parser_name
parser_version
status
```

#### evidence

统一证据表。所有 PDF、PPT、Word、Excel evidence 都在这里有一条主记录。

关键字段：

```text
evidence_id
doc_id
version_id
evidence_type
content_text
content_json
metadata_json
created_at
```

#### evidence_locations

记录 evidence 在原始文件中的位置。

关键字段：

```text
location_id
evidence_id
file_name
page_no
slide_no
sheet_name
cell
cell_range
formula
heading
section
start_offset
end_offset
location_json
```

#### structured_facts

记录从资料中抽取的事实。

关键字段：

```text
fact_id
entity_id
metric
value
unit
period
fact_type
evidence_id
confidence
created_at
```

注意：第一版 facts 必须绑定 `evidence_id`，没有来源的 fact 不应进入可信事实表。

#### index_registry

记录索引状态。

关键字段：

```text
index_id
index_type      -- bm25 | vector | table | excel
path
version
related_doc_version_ids
built_at
status
```

### 5.2 analyst.db

建议最小表：

```text
qa_sessions
qa_messages
personal_notes
personal_facts
personal_citations
memo_drafts
memo_sections
watch_targets
watch_alerts
viewpoint_versions
personal_audit_trail
```

#### qa_sessions

记录一次研究会话。

关键字段：

```text
session_id
project_id
analyst_id
title
created_at
updated_at
```

#### qa_messages

记录原始问答。

关键字段：

```text
message_id
session_id
role
content
created_at
metadata_json
```

#### personal_citations

记录 QA、note、memo 对 company collection evidence 的引用。

关键字段：

```text
citation_id
project_id
analyst_id
source_type       -- qa_message | memo_section | personal_note
source_id
evidence_id
doc_id
quote
reason
created_at
```

注意：`evidence_id` 指向 `collection.db.evidence.evidence_id`。

#### personal_facts

记录个人研究过程中形成的结构化事实或观点。

关键字段：

```text
personal_fact_id
project_id
analyst_id
entity
metric
value
period
fact_type        -- metric | risk | catalyst | viewpoint | assumption
citation_id
source_message_id
created_at
```

#### memo_drafts

记录 memo 初稿。

关键字段：

```text
memo_id
project_id
analyst_id
title
status          -- draft | reviewed | archived
created_at
updated_at
```

#### memo_sections

记录 memo 每个 section。

关键字段：

```text
section_id
memo_id
section_type    -- overview | recent_changes | thesis | financials | valuation | risks | catalysts | sources
content
needs_review
created_at
updated_at
```

memo section 的引用通过 `personal_citations.source_type = memo_section` 关联。

#### watch_targets

记录个人关注目标。

关键字段：

```text
target_id
project_id
analyst_id
entity_id
target_type       -- company | person | metric | topic | risk | catalyst | document_query
target_name
description
query_json
priority          -- low | medium | high
frequency         -- on_ingest | daily | weekly | manual
active
created_at
updated_at
```

#### watch_alerts

记录新资料命中关注目标后的提醒。

关键字段：

```text
alert_id
target_id
project_id
evidence_id
alert_type
summary
status            -- new | acknowledged | dismissed
created_at
```

#### personal_audit_trail

记录 QA、memo、watch trigger 的执行轨迹。

关键字段：

```text
audit_id
project_id
analyst_id
event_type        -- qa | memo_generation | watch_check | memory_write
input_json
retrieved_evidence_json
output_json
created_at
```

## 6. 核心数据链路

### 6.1 入库链路

```text
用户上传文件
-> 保存到 company_collection/original_files
-> 计算 checksum
-> 写 documents / document_versions
-> 文档分诊，识别 doc_type / source / date
-> 按文件类型解析
-> 生成 evidence / evidence_locations
-> 抽取 structured_facts
-> 构建 BM25 / vector / table / excel index
-> 写 index_registry / ingest_audit
-> 触发 watch_targets 检查
```

### 6.2 QA 链路

```text
用户提问
-> 写 qa_messages(user)
-> 检索 company_collection evidence
-> 检索 analyst_space memory
-> 生成带引用答案
-> 写 qa_messages(assistant)
-> 写 personal_citations
-> 抽取 personal_facts
-> 写 personal_audit_trail
```

### 6.3 Memo 生成链路

```text
用户点击生成 memo
-> build evidence pack
-> 检索 company_collection facts / evidence
-> 检索 analyst_space notes / previous QA / personal facts
-> 生成 memo_draft
-> 写 memo_sections
-> 为每个核心 section 写 personal_citations
-> citation gate 检查无引用结论
-> 写 personal_audit_trail
```

## 7. 正确性的验证标准

DB 设计是否正确，不看表是否多，而看是否能回答关键追溯问题。

### 7.1 必须通过的追溯测试

#### 测试 1：从 QA 答案追溯到原文

给定一个 `qa_message_id`，系统必须能查到：

```text
qa answer
-> personal_citations
-> evidence
-> evidence_locations
-> documents
-> document_versions
-> original file path
```

验收标准：

```text
能定位到 PDF 页码、PPT slide、Word section 或 Excel sheet/cell。
```

#### 测试 2：从 memo section 追溯到证据

给定一个 `memo_section_id`，系统必须能查到：

```text
memo section
-> citations
-> evidence
-> original file location
```

验收标准：

```text
每个核心观点 section 至少有一个 citation。
没有 citation 的 section 必须标记 needs_review = true。
```

#### 测试 3：从 fact 追溯到来源

给定一个 `fact_id` 或 `personal_fact_id`，系统必须能查到：

```text
fact
-> citation or evidence
-> source document / QA / memo
```

验收标准：

```text
没有来源的 fact 不能进入可信事实表。
```

#### 测试 4：Excel 证据定位

给定一个 Excel evidence，系统必须返回：

```text
file
sheet
cell or range
value
formula
```

验收标准：

```text
能回答“目标价在哪个 sheet/cell，公式是什么”。
```

第一版可以只支持一层公式引用，不要求完整 Excel 理解。

#### 测试 5：个人记忆查询

给定问题：

```text
我之前是否讨论过某公司毛利率？
```

系统必须能返回：

```text
相关 QA
相关 memo
相关 personal_facts
当时引用的 evidence
```

验收标准：

```text
重启系统后仍然能查回。
```

#### 测试 6：Watch target 命中

给定一个 watch target：

```json
{
  "target_type": "risk",
  "entity": "某公司",
  "target_name": "应收账款恶化",
  "query_json": {
    "keywords": ["应收账款", "回款", "坏账", "账期延长"],
    "compare_against": "previous_quarter"
  }
}
```

新资料入库后，如果 evidence 命中关键词或语义规则，系统必须写入：

```text
watch_alerts
personal_audit_trail
```

验收标准：

```text
alert 能反查到触发它的 evidence_id。
```

### 7.2 完整性的验证标准

一个项目 DB 设计算完整，必须能跑通以下端到端 demo：

```text
1. 创建一个 project
2. 上传 1 个 PDF、1 个 PPT、1 个 Word、1 个 Excel
3. 写入 documents / document_versions
4. 生成 evidence / evidence_locations
5. 构建基础索引
6. 用户问一个投研问题
7. 系统返回带 citation 的答案
8. QA 写入 analyst.db 和 markdown memory
9. 系统抽取 personal_facts
10. 用户生成 memo 初稿
11. memo_sections 绑定 citations
12. 任意 citation 能回到原始文件位置
13. 新资料入库后能触发 watch target
```

如果这 13 步不能完整跑通，说明 DB 设计仍不完整。

## 8. 开发优先级

第一阶段只做最小闭环：

```text
documents
document_versions
evidence
evidence_locations
qa_sessions
qa_messages
personal_citations
personal_facts
memo_drafts
memo_sections
personal_audit_trail
```

第二阶段再补：

```text
watch_targets
watch_alerts
viewpoint_versions
index_registry
structured_facts
```

第三阶段再考虑：

```text
graph
复杂 KG
完整 Excel dependency graph
多用户权限
多人协作冲突
```

## 9. 实施原则

1. 不要只存文本，必须存 location。
2. 不要让答案直接引用文件，答案应引用 `evidence_id`。
3. `evidence_id` 必须稳定。
4. facts 必须有来源。
5. QA、memo、note 都必须沉淀到 personal memory。
6. Excel 单独处理，不要普通 chunk 化。
7. audit trail 不能省。
8. company collection 不存个人观点，analyst space 不复制团队原始资料。
9. 第一版优先做单公司闭环，不做全市场自由探索。
10. 没有 citation 的核心结论必须标记为需要人工复核。

## 10. 最终验收口径

第一版完成后，开发同事需要演示以下问题：

```text
1. 这个项目有哪些资料？
2. 某条证据来自哪份文件、哪一页/哪张 slide/哪个 Excel cell？
3. 某个 QA 答案用了哪些证据？
4. 某个 memo 段落用了哪些证据？
5. 某个结构化 fact 的来源是什么？
6. 我之前是否讨论过类似问题？
7. 新资料是否命中了我的关注目标？
8. 整个回答过程是否有 audit trail？
```

如果这些问题都能稳定回答，说明 DB 和 memory 的设计方向是正确的。

