# Evidence Schema 与溯源设计说明

## 1. 总体结论

每种文档都应该有单独的处理模式，但最终必须统一成同一种可溯源 Evidence Schema。

核心原则：

```text
解析可以分类型，引用必须统一。
```

整体链路：

```text
PDF parser
PPT parser
Word parser
Excel parser
Markdown / Obsidian parser
QA / memo parser
        ↓
Evidence Normalizer
        ↓
统一 Evidence Schema
        ↓
统一 Citation / Provenance 格式
```

系统最终要做到：

```text
任何一个 QA 答案、memo 段落、结构化 fact，都能通过 citation 回到 evidence，
再回到原始文件、文件版本和具体位置。
```

## 2. 为什么需要分类型处理

不同文件的可引用位置完全不同。

```text
PDF      -> page / section / paragraph / bbox
PPT      -> slide_no / shape_id / text_box
Word     -> heading / section / paragraph
Excel    -> workbook / sheet / cell / range / formula
Markdown -> file / heading / block / wikilink / tag
QA       -> session_id / message_id / turn_no
Memo     -> memo_id / section_id
```

因此，不能用同一种 parser 处理所有文件。

但是，不管来源是什么，最终都必须回答这些统一问题：

```text
这条 evidence 是什么？
它来自哪个 document？
它来自哪个 version？
它在原始资料中的位置在哪里？
它的内容是什么？
它如何展示成人类可读 citation？
```

## 3. 核心概念

### 3.1 Document

Document 是一份资料的稳定身份。

例如：

```text
Zeekr_2024_AR.pdf
Investor_Day.pptx
Zeekr_valuation_model.xlsx
meeting_minutes.docx
```

Document 关注：

```text
文件名
公司
资料类型
来源
日期
当前版本
```

### 3.2 Document Version

Document Version 是某份资料在某个时间点的具体文件版本。

用于解决：

```text
文件被替换后，旧 citation 是否还能追溯？
同一份 memo 修改后，观点如何演化？
Excel 模型更新后，旧目标价引用是否仍然有效？
```

每次文件入库都应该记录：

```text
checksum
file_path
version_no
parser_name
parser_version
ingested_at
```

### 3.3 Evidence

Evidence 是系统可引用的最小证据单元。

它可以来自：

```text
PDF 的一个 section
PPT 的一页 slide
Word 的一个段落或 section
Excel 的一个 cell / range / formula
Markdown 的一个 heading block
QA 的一个 message
Memo 的一个 section
```

### 3.4 Citation

Citation 是某个输出对 evidence 的引用关系。

输出可以是：

```text
QA answer
memo section
structured fact
personal note
watch alert
```

关系应该是：

```text
QA answer / memo section / fact
-> citation_id
-> evidence_id
-> doc_id
-> version_id
-> original file location
```

不要让答案直接引用文件。答案应该引用 `citation_id`，citation 再指向 `evidence_id`。

## 4. Chunk 和 Evidence 的区别

必须区分：

```text
chunk = 检索单位
evidence = 引用单位
```

两者有时可以相同，但不能默认相同。

示例：

```text
PDF section chunk 可以直接作为 evidence
PPT slide chunk 可以直接作为 evidence
Excel 不应该普通 chunk 化，应使用 cell / range / formula evidence
Memo 一个 section 里可能抽出多个 viewpoint evidence
表格 region 是 evidence，其中某个数字也可以成为 structured fact
```

设计上：

```text
检索系统可以用 chunk_id
引用系统必须用 evidence_id
```

如果某个 chunk 被答案引用，应先转换或绑定到 evidence。

## 5. 统一 Evidence Schema

建议统一结构：

```json
{
  "evidence_id": "ev_001",
  "project_id": "zeekr_project",
  "collection_id": "company_collection",
  "doc_id": "doc_001",
  "version_id": "ver_001",
  "evidence_type": "pdf_section",
  "content_text": "毛利率变化主要受到产品结构和价格竞争影响...",
  "content_json": {},
  "location": {
    "file_name": "Zeekr_2024_AR.pdf",
    "page_no": 42,
    "section": "Gross Margin"
  },
  "metadata": {
    "company": "zeekr",
    "doc_type": "annual_report",
    "source": "company_filing",
    "document_date": "2025-04-30",
    "parser": "mineru",
    "confidence": 0.92
  }
}
```

统一字段包括：

```text
evidence_id
project_id
collection_id
doc_id
version_id
evidence_type
content_text
content_json
location
metadata
created_at
```

不同文件类型的差异主要放在：

```text
evidence_type
location
metadata
content_json
```

## 6. 不同文件类型的 Evidence 设计

### 6.1 PDF

处理方式：

```text
page-level / section-level chunk
metadata 带 page_no / section / bbox / table_id
```

Evidence 示例：

```json
{
  "evidence_type": "pdf_page_section",
  "content_text": "The gross margin decreased primarily due to...",
  "location": {
    "file_name": "Zeekr_2024_AR.pdf",
    "page_no": 42,
    "section": "Management Discussion",
    "bbox": [10, 120, 580, 720]
  }
}
```

必须支持：

```text
file_name
page_no
section
paragraph_no 或 bbox
```

### 6.2 PPT

处理方式：

```text
slide-level chunk
保留 slide_no / shape_id / text_box
```

Evidence 示例：

```json
{
  "evidence_type": "ppt_slide",
  "content_text": "2025 growth drivers include new model launches and overseas expansion.",
  "location": {
    "file_name": "Investor_Day.pptx",
    "slide_no": 12,
    "shape_id": "shape_4",
    "shape_type": "text_box"
  }
}
```

必须支持：

```text
file_name
slide_no
shape_id
```

第一版可以先只做到 slide_no。

### 6.3 Word

处理方式：

```text
section chunk
抽取 heading / paragraph / viewpoint / risk / todo
```

Evidence 示例：

```json
{
  "evidence_type": "word_section",
  "content_text": "管理层认为毛利率改善主要依赖规模效应和电池成本下降。",
  "location": {
    "file_name": "meeting_minutes.docx",
    "heading_path": ["调研纪要", "管理层问答", "毛利率"],
    "paragraph_no": 18
  }
}
```

必须支持：

```text
file_name
heading_path
paragraph_no
```

### 6.4 Excel

Excel 是特殊类型，不建议普通 chunk 化。

处理重点：

```text
workbook
sheet
table_region
cell
range
value
formula
upstream references
```

Evidence 示例：

```json
{
  "evidence_type": "excel_cell",
  "content_text": "DCF!E12 = 16.5%, formula = E11/E10",
  "location": {
    "file_name": "Zeekr_valuation_model.xlsx",
    "sheet": "DCF",
    "cell": "E12",
    "range": "B10:H20",
    "value": "16.5%",
    "formula": "=E11/E10"
  },
  "content_json": {
    "value": "16.5%",
    "formula": "=E11/E10",
    "number_format": "0.0%",
    "upstream_cells": ["E10", "E11"]
  }
}
```

第一版必须支持：

```text
定位目标价 / 核心假设所在 sheet/cell
展示 value
展示 formula
展示部分上游引用
```

第一版不要求：

```text
完整自动建模
三表配平
任意 Excel 理解
完整 dependency graph
```

### 6.5 Markdown / Obsidian

处理方式：

```text
解析 frontmatter
解析 tags
解析 wikilinks
解析 headings
解析 tasks
解析 block
```

Evidence 示例：

```json
{
  "evidence_type": "markdown_block",
  "content_text": "毛利率改善可能低于预期，主要由于价格竞争加剧。",
  "location": {
    "file_name": "zeekr_profitability.md",
    "heading": "毛利率趋势",
    "block_id": "block_003",
    "tags": ["#zeekr", "#gross_margin"]
  }
}
```

### 6.6 QA / Memo

QA 和 Memo 也可以成为 personal memory 中的 evidence，但它们通常引用 company_collection evidence。

QA evidence 示例：

```json
{
  "evidence_type": "qa_message",
  "content_text": "我们之前判断毛利率改善主要来自规模效应，但价格竞争是主要风险。",
  "location": {
    "session_id": "session_001",
    "message_id": "msg_002",
    "turn_no": 1
  }
}
```

Memo evidence 示例：

```json
{
  "evidence_type": "memo_section",
  "content_text": "核心观点：公司收入增长具备弹性，但毛利率改善仍需验证。",
  "location": {
    "memo_id": "memo_001",
    "section_id": "section_thesis"
  }
}
```

## 7. Citation Schema

Citation 记录某个输出对 evidence 的引用。

建议结构：

```json
{
  "citation_id": "cit_001",
  "project_id": "zeekr_project",
  "analyst_id": "analyst_001",
  "source_type": "qa_answer",
  "source_id": "msg_002",
  "evidence_id": "ev_001",
  "doc_id": "doc_001",
  "claim": "FY2024 毛利率承压主要来自价格竞争。",
  "quote": "公司披露毛利率受到产品组合和定价压力影响。",
  "reason": "支持毛利率承压原因判断",
  "display": "Zeekr_2024_AR.pdf, p.42"
}
```

字段说明：

```text
citation_id      引用 ID
source_type      谁在引用 evidence
source_id        引用方的 ID，例如 qa_message_id / memo_section_id / fact_id
evidence_id      被引用的证据
doc_id           冗余存储，便于快速查
claim            该 citation 支持的结论
quote            证据原文摘录
reason           为什么相关
display          人类可读引用
```

## 8. Provenance 展示格式

系统最终需要能把不同类型 evidence 渲染成统一的人类可读引用。

示例：

```text
PDF: Zeekr_2024_AR.pdf, p.42, Management Discussion
PPT: Investor_Day.pptx, slide 12
Word: meeting_minutes.docx, 管理层问答 > 毛利率, paragraph 18
Excel: Zeekr_valuation_model.xlsx, DCF!E12, formula = E11/E10
Markdown: zeekr_profitability.md, #毛利率趋势
QA: session_001, assistant message msg_002
Memo: memo_001, section 核心观点
```

因此需要一个统一函数：

```python
render_citation_display(evidence, location) -> str
```

## 9. 推荐 DB 表

### 9.1 evidence

统一证据主表。

关键字段：

```text
evidence_id
project_id
collection_id
doc_id
version_id
evidence_type
content_text
content_json
metadata_json
created_at
updated_at
```

### 9.2 evidence_locations

统一位置表。

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
paragraph_no
bbox_json
location_json
created_at
```

说明：

```text
通用字段直接放列里。
特殊字段放 location_json。
```

### 9.3 citations

引用关系表。

关键字段：

```text
citation_id
project_id
analyst_id
source_type
source_id
evidence_id
doc_id
claim
quote
reason
display
created_at
```

## 10. 处理链路

推荐处理流程：

```text
原始文件
-> 类型识别 doc_type
-> 专用 parser
-> parsed blocks
-> evidence adapter
-> evidence normalizer
-> evidence / evidence_locations
-> BM25 / vector / table / excel index
-> QA / memo / fact 通过 citation 引用 evidence
```

每个 parser 只负责把文件处理成该类型的 parsed blocks。

每个 adapter 负责把 parsed blocks 转成统一 evidence。

统一 normalizer 负责校验：

```text
是否有 doc_id
是否有 version_id
是否有 evidence_type
是否有 content_text 或 content_json
是否有可追溯 location
是否能生成 display citation
```

## 11. 正确性验证

Evidence schema 是否正确，看能不能回答以下问题。

### 11.1 Evidence 追溯测试

给定 `evidence_id`，必须能查到：

```text
doc_id
version_id
original file path
具体位置
content_text / content_json
```

### 11.2 Citation 追溯测试

给定 `citation_id`，必须能查到：

```text
citation
-> evidence
-> evidence_locations
-> document
-> document_version
-> original file
```

### 11.3 QA 引用测试

给定一个 QA answer，必须能查到它引用的所有 citations。

每个 citation 必须能渲染成人可读格式。

### 11.4 Memo 引用测试

给定一个 memo section，必须能查到它引用的 citations。

没有 citation 的核心结论必须标记 `needs_review`。

### 11.5 Excel 定位测试

给定 Excel evidence，必须能返回：

```text
file
sheet
cell or range
value
formula
```

第一版验收问题：

```text
模型里的目标价在哪里？
这个单元格公式是什么？
这个数字引用了哪些上游 cell？
```

### 11.6 版本追溯测试

文件更新后，旧 citation 必须仍然能知道自己引用的是哪个旧版本。

验收标准：

```text
citation -> evidence -> version_id 不应因为新文件入库而变化。
```

## 12. 最小端到端验收

第一版必须跑通：

```text
1. 导入 PDF、PPT、Word、Excel 各一个样例
2. 每个样例生成至少一条 evidence
3. 每条 evidence 有 location
4. 每条 evidence 能生成 display citation
5. QA answer 创建 citation
6. citation 能回到 evidence
7. evidence 能回到原文件位置
8. Excel evidence 能返回 sheet/cell/value/formula
9. memo section 能引用 evidence
10. 没有 citation 的 memo 核心结论被标记 needs_review
```

如果这 10 步不能稳定跑通，Evidence Schema 设计还不完整。

## 13. 开发优先级

### 第一阶段

```text
Document / DocumentVersion / Evidence / EvidenceLocation / Citation schema
PDF evidence adapter
Excel evidence adapter
render_citation_display
基础追溯测试
```

### 第二阶段

```text
PPT adapter
Word adapter
Markdown / Obsidian adapter
QA / Memo evidence adapter
```

### 第三阶段

```text
table region evidence
Excel upstream references
evidence version invalidation
citation quality gate
```

### 第四阶段

```text
复杂 KG
跨文件 evidence linking
完整 Excel dependency graph
自动证据冲突检测
```

## 14. 关键原则

1. 每种文档可以有独立 parser。
2. 所有 parser 最终必须输出统一 evidence。
3. 检索单位 chunk 和引用单位 evidence 要区分。
4. 答案和 memo 不直接引用文件，而是引用 citation。
5. citation 指向 evidence，evidence 指向 document/version/location。
6. Excel 不要普通 chunk 化。
7. 每条可信 fact 必须能回到 evidence。
8. 文件更新不能破坏旧 citation 的追溯链。
9. 没有 citation 的核心结论必须标记 needs_review。
10. Evidence Schema 是系统可信度的基础。

