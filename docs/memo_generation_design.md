# Memo 生成模块设计说明

## 1. 总体目标

Memo 模块的目标不是让 LLM 写一篇漂亮文章，而是把系统里的 evidence、facts、历史 QA、个人观点组织成一版：

```text
可编辑
可追溯
可复核
可审计
可进入 personal memory
```

的研究初稿。

一句话：

```text
Memo = 基于证据和研究记忆生成的结构化投研草稿。
```

Memo 的质量标准不是文采，而是：

```text
每个核心判断都有出处
每个数字能回到 evidence
历史观点能被复用
无证据内容能被标记 needs_review
生成过程能被 audit
```

## 2. Memo 模块要解决的问题

Memo 模块需要回答：

```text
这篇 memo 基于哪些资料？
每个核心判断引用了哪些 evidence？
财务数字来自哪里？
估值假设来自哪个 Excel sheet/cell？
历史 QA 或个人 note 有没有被复用？
哪些内容没有足够证据，需要人工复核？
这次 memo 是怎么生成的？
生成后的 memo 能否成为新的 research memory？
```

## 3. Memo 的输入

Memo 生成需要读取四类信息。

### 3.1 Company Collection Evidence

来自团队共享资料库。

包括：

```text
PDF 财报 / 研报 evidence
PPT slide evidence
Word 纪要 evidence
Excel cell / range / formula evidence
表格 evidence
```

### 3.2 Company Collection Structured Facts

结构化事实。

包括：

```text
财务指标
风险
催化剂
估值假设
公司事件
管理层表述
```

### 3.3 Analyst Space Memory

个人研究记忆。

包括：

```text
历史 QA
个人 note
之前 memo
viewpoint_versions
watch_alerts
personal_facts
```

### 3.4 用户当前指令

例如：

```text
生成覆盖 memo
生成风险 memo
生成财务表现 memo
基于最新资料更新 memo
只生成估值假设摘要
```

第一版建议只实现固定覆盖 memo 模板。

## 4. 第一版 Memo 模板

第一版建议使用固定结构：

```text
1. 公司概况
2. 近期变化
3. 核心观点
4. 财务表现
5. 估值假设摘要
6. 风险
7. 催化剂
8. 引用来源
```

每个 section 都应单独生成、单独存储、单独绑定 citations。

## 5. Memo 的输出

Memo 生成后至少要落三类结构化记录：

```text
memo_drafts
memo_sections
citations
```

同时生成一个 markdown 文件：

```text
analyst_space/
  markdown_memory/
    memos/
      {memo_id}.md
```

Memo 本身也应该注册成 memory item：

```text
memory_items.memory_type = memo
```

这样后续用户问“之前有没有相关研究”时，可以召回 memo。

## 6. 推荐 DB 表

### 6.1 memo_drafts

记录一篇 memo。

关键字段：

```text
memo_id
project_id
analyst_id
company_id
title
memo_type          -- coverage | risk | financials | valuation | update
status             -- draft | reviewed | archived
created_from       -- user_request | scheduled_update | watch_alert
created_at
updated_at
metadata_json
```

### 6.2 memo_sections

记录 memo 的每个 section。

关键字段：

```text
section_id
memo_id
section_type       -- overview | recent_changes | thesis | financials | valuation | risks | catalysts | sources
title
content
sort_order
needs_review
review_notes
created_at
updated_at
metadata_json
```

### 6.3 citations

Memo section 不直接引用文件，而是引用 citation。

关系：

```text
memo_sections.section_id
-> citations.source_id
-> citations.evidence_id
-> company_collection.evidence
-> original file location
```

Memo citation 示例：

```json
{
  "citation_id": "cit_101",
  "source_type": "memo_section",
  "source_id": "section_financials",
  "evidence_id": "ev_001",
  "doc_id": "doc_001",
  "claim": "FY2024 毛利率承压主要来自价格竞争。",
  "quote": "公司披露毛利率受到产品组合和定价压力影响。",
  "reason": "支持财务表现 section 中关于毛利率原因的判断。",
  "display": "Zeekr_2024_AR.pdf, p.42"
}
```

### 6.4 memo_generation_runs

建议增加一张生成过程表，方便 audit 和调试。

关键字段：

```text
run_id
memo_id
project_id
analyst_id
user_instruction
evidence_pack_json
section_plan_json
status
error
started_at
finished_at
```

也可以先写入 `audit_trail`，第二阶段再单独拆表。

## 7. Memo 生成链路

用户操作：

```text
生成一版极氪覆盖 memo。
```

后台处理：

```text
1. 创建 memo_generation_run
2. 解析用户意图和 memo 类型
3. 构建 evidence pack
4. 从 company_collection 拉资料 evidence / structured facts
5. 从 analyst_space 拉历史 QA / notes / previous memo / personal facts
6. 按模板生成 section outline
7. 分 section 生成内容
8. 为每个核心 claim 绑定 citation
9. 运行 citation gate / fact consistency check
10. 写 memo_drafts
11. 写 memo_sections
12. 写 citations
13. 生成 markdown memo
14. 写 audit_trail
15. 注册 memory_items
16. 更新 semantic index
```

其中最重要的是：

```text
Evidence Pack
Citation Gate
```

## 8. Evidence Pack

Memo 不应该直接把所有资料塞给 LLM。

Memo 生成前必须先构建 evidence pack。

Evidence pack 是结构化输入，用来控制 memo 每个 section 的证据来源。

推荐结构：

```json
{
  "company_profile_evidence": [],
  "recent_changes_evidence": [],
  "financial_metrics_evidence": [],
  "valuation_evidence": [],
  "risk_evidence": [],
  "catalyst_evidence": [],
  "historical_viewpoints": [],
  "excel_assumptions": [],
  "open_questions": []
}
```

### 8.1 company_profile_evidence

用于公司概况。

来源：

```text
年报
公司官网资料
研报 company overview
历史 memo 概况段落
```

### 8.2 recent_changes_evidence

用于近期变化。

来源：

```text
最新财报
公告
调研纪要
watch alerts
最近 QA
```

### 8.3 financial_metrics_evidence

用于财务表现。

来源：

```text
财报表格
structured_facts
研报财务分析
历史 QA 中的财务判断
```

### 8.4 valuation_evidence

用于估值假设摘要。

来源：

```text
Excel 模型
DCF sheet
目标价 cell
核心假设 cell
研报估值表
```

### 8.5 risk_evidence

用于风险。

来源：

```text
财报风险披露
调研纪要
研报风险提示
个人 watch targets
历史 memo
```

### 8.6 catalyst_evidence

用于催化剂。

来源：

```text
管理层表述
产品发布计划
行业事件
调研纪要
历史 QA
```

### 8.7 historical_viewpoints

用于复用个人研究记忆。

来源：

```text
历史 QA
previous memo
personal notes
viewpoint_versions
```

## 9. Citation Gate

Citation Gate 是 memo 质量控制的核心。

规则：

```text
核心观点必须有 citation
财务数字必须有 citation
估值假设必须有 Excel / model citation
风险和催化剂必须有 citation
历史观点必须能追溯到 QA / note / previous memo
没有 citation 的内容必须 needs_review = true
```

### 9.1 必须有 citation 的内容

```text
收入、毛利率、净利润、现金流等财务数字
目标价、折现率、长期增长率、毛利率假设等估值假设
风险判断
催化剂判断
管理层表述
和历史观点相关的结论
```

### 9.2 可以暂时无 citation 但要标记的内容

```text
明显的写作连接句
非常弱的总结性语言
需要人工判断的投资观点
LLM 推断出的开放问题
```

这些内容必须标记：

```text
needs_review = true
```

### 9.3 Citation Gate 输出

建议每个 section 生成后输出：

```json
{
  "section_id": "section_financials",
  "supported_claims": [
    {
      "claim": "FY2024 毛利率承压主要来自价格竞争。",
      "citation_ids": ["cit_101"]
    }
  ],
  "unsupported_claims": [
    {
      "claim": "公司未来毛利率将快速恢复。",
      "reason": "未找到直接证据支持"
    }
  ],
  "needs_review": true
}
```

## 10. Memo 和 Memory 的关系

Memo 同时是 memory 的消费者和生产者。

### 10.1 Memo 作为消费者

Memo 使用：

```text
历史 QA
个人 notes
previous memo
personal_facts
viewpoint_versions
watch_alerts
```

### 10.2 Memo 作为生产者

Memo 生成后写入：

```text
memo_drafts
memo_sections
citations
facts
viewpoint_versions
audit_trail
memory_items
markdown_memory
semantic_index
```

这样后续用户问：

```text
我们之前怎么看极氪毛利率？
```

系统可以召回：

```text
历史 QA
相关 memo section
对应 evidence citation
观点是否变化
```

## 11. 推荐模块拆分

建议代码结构：

```text
src/memo/
  memo_schema.py
  evidence_pack_builder.py
  memo_planner.py
  section_generator.py
  citation_binder.py
  citation_gate.py
  memo_writer.py
  markdown_exporter.py
  memo_memory_writer.py
```

### 11.1 memo_schema.py

定义：

```text
MemoDraft
MemoSection
EvidencePack
SectionPlan
MemoGenerationRun
CitationGateResult
```

### 11.2 evidence_pack_builder.py

负责从 DB / memory 中拉取 memo 所需证据。

输入：

```text
project_id
company_id
memo_type
user_instruction
```

输出：

```text
EvidencePack
```

### 11.3 memo_planner.py

负责生成 section plan。

第一版可以固定模板，不需要 LLM planner。

### 11.4 section_generator.py

负责分 section 生成内容。

要求：

```text
只能基于 evidence pack 生成
输出 claims + text
保留 claim 和 evidence 的候选绑定关系
```

### 11.5 citation_binder.py

负责把 claims 绑定到 evidence。

输入：

```text
claim
candidate evidence
```

输出：

```text
citation records
```

### 11.6 citation_gate.py

负责检查 section 是否有 unsupported claims。

### 11.7 memo_writer.py

负责写：

```text
memo_drafts
memo_sections
citations
audit_trail
```

### 11.8 markdown_exporter.py

负责生成：

```text
analyst_space/markdown_memory/memos/{memo_id}.md
```

### 11.9 memo_memory_writer.py

负责把 memo 注册进 memory：

```text
memory_items
semantic_index
personal_facts
viewpoint_versions
```

## 12. 第一版最小实现

第一版只需要实现：

```text
evidence_pack_builder
section_generator
citation_gate
memo_writer
markdown_exporter
```

可以暂时不做：

```text
复杂 LLM planner
多模板 memo
docx 导出
自动观点冲突检测
复杂图表
```

## 13. 正确性验证

Memo 是否正确，不看写得是否像正式研报，而看是否能追溯和复用。

### 13.1 Section Citation 测试

给定一个 `memo_id`，每个核心 section 必须有 citation。

验收标准：

```text
thesis / financials / valuation / risks / catalysts 至少各有一个 citation。
```

### 13.2 Citation 追溯测试

给定一个 `citation_id`，必须能查到：

```text
citation
-> evidence
-> evidence_location
-> document
-> original file
```

验收标准：

```text
能定位到 PDF page、PPT slide、Word section 或 Excel sheet/cell。
```

### 13.3 Unsupported Claim 测试

构造一个 evidence pack 不支持的结论。

系统必须：

```text
不写入可信 citation
把 section 或 claim 标记 needs_review
写 review_notes
```

### 13.4 Excel 估值测试

Memo 的估值 section 必须能引用 Excel evidence。

验收标准：

```text
目标价 / 核心假设能回到 sheet / cell / value / formula。
```

### 13.5 Memory 复用测试

如果历史 QA 中已经讨论过毛利率，memo financials section 应该能复用该 memory。

验收标准：

```text
memo section 可以关联历史 QA memory_item。
但最终财务结论仍然要绑定 company_collection evidence。
```

### 13.6 Audit 测试

给定一次 memo generation run，必须能看到：

```text
user_instruction
evidence_pack
section_plan
generated_sections
citations
unsupported_claims
status
```

### 13.7 持久化测试

重启服务后，仍能查回：

```text
memo_drafts
memo_sections
citations
markdown memo
memory_items
audit_trail
```

## 14. 最小端到端验收

第一版必须跑通以下流程：

```text
1. 输入 company_id
2. 系统构建 evidence pack
3. 系统生成 memo draft
4. memo 包含 6-8 个 section
5. thesis / financials / valuation / risks / catalysts 有 citation
6. 每个 citation 能回到 evidence
7. evidence 能回到原始文件位置
8. Excel 估值假设能回到 sheet/cell/formula
9. unsupported claim 被标记 needs_review
10. memo 写入 markdown_memory
11. memo 注册成 memory_item
12. memo generation 写入 audit_trail
```

如果这 12 步能稳定跑通，Memo 模块第一版就是正确的。

## 15. 开发优先级

### 第一阶段：固定模板 memo

```text
memo_drafts / memo_sections schema
evidence_pack_builder
固定 section 模板
section_generator
citation_gate
markdown_exporter
```

### 第二阶段：memory 复用

```text
读取历史 QA
读取 personal_facts
读取 previous memo
memo 注册 memory_item
```

### 第三阶段：质量增强

```text
unsupported claim 检测
fact consistency check
viewpoint_versions
watch_alerts 驱动 memo update
```

### 第四阶段：输出增强

```text
docx 导出
html 报告
图表
finrobot report 模板集成
```

## 16. 关键原则

1. Memo 不是无约束生成文章。
2. Memo 必须基于 evidence pack。
3. Memo section 必须独立存储。
4. 核心 claim 必须绑定 citation。
5. citation 必须能回到 evidence。
6. Excel 估值内容必须引用 sheet/cell/formula。
7. 无证据核心结论必须 needs_review。
8. Memo 必须写入 audit_trail。
9. Memo 既消费 memory，也生产 memory。
10. 第一版先做单公司覆盖 memo，不做复杂全行业报告。

