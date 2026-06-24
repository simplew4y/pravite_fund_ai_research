# Research Memory 设计说明

## 1. 总体目标

Research Memory 的目标不是保存聊天记录，而是把每次研究问答从“一次聊天”变成：

```text
可回看
可检索
可复用
可审计
可追溯证据
```

一句话：

```text
Research Memory 要让系统知道：我之前研究过什么、当时依据是什么、观点有没有变化、哪些内容需要持续跟踪。
```

它需要同时服务两类记忆：

```text
SQLite = 精确记忆
Markdown + OpenViking = 语义记忆
```

## 2. Memory 要解决的问题

### 2.1 完整回看

系统必须能完整还原一次研究对话：

```text
用户当时问了什么？
系统当时答了什么？
上下文是什么？
答案引用了哪些证据？
```

对应存储：

```text
Messages.jsonl
content.md
```

### 2.2 精确查询

系统必须能回答结构化问题：

```text
极氪 FY2024 毛利率是多少？
这个事实来自哪个出处？
某次回答引用了哪些 evidence？
某个 memo section 的依据是什么？
```

对应存储：

```text
SQLite facts
SQLite citations
SQLite audit_trail
```

### 2.3 语义召回

系统必须能回答模糊研究记忆问题：

```text
我之前是不是讨论过类似的极氪盈利能力问题？
有没有相关历史研究？
之前关于毛利率趋势的分析在哪？
我们之前怎么看价格竞争对毛利率的影响？
```

对应存储：

```text
markdown_memory
OpenViking semantic index
```

## 3. 推荐目录结构

一个项目下的个人研究记忆建议放在 `analyst_space` 中：

```text
projects/
  {project_id}/
    analyst_space/
      messages/
        {session_id}/
          messages.jsonl
          content.md
          .overview.md
          .abstract.md

      markdown_memory/
        qa/
        notes/
        memos/
        viewpoints/

      semantic_index/
        openviking/

      analyst.db
```

说明：

- `messages/` 保存每次 QA 的原始记录和可读归档。
- `markdown_memory/` 保存可被语义索引的研究资产。
- `semantic_index/openviking/` 保存语义检索索引。
- `analyst.db` 保存精确记忆和引用关系。

## 4. 每次 QA 后必须写入的内容

一次 QA 结束后，至少写入 5 类东西：

```text
1. 原始消息：messages.jsonl
2. 可读归档：content.md
3. 结构化事实：facts 表
4. 引用出处：citations 表
5. 审计轨迹：audit_trail 表
```

### 4.1 Messages.jsonl

用于完整回看对话。每一条消息一行 JSON。

示例：

```json
{
  "session_id": "session_001",
  "message_id": "msg_001",
  "role": "user",
  "content": "极氪 FY2024 毛利率变化怎么看？",
  "timestamp": "2026-06-24T10:00:00Z",
  "metadata": {}
}
```

Assistant 回答也写入同一个文件：

```json
{
  "session_id": "session_001",
  "message_id": "msg_002",
  "role": "assistant",
  "content": "毛利率变化主要来自产品结构、价格竞争和成本改善的共同影响...",
  "timestamp": "2026-06-24T10:00:30Z",
  "metadata": {
    "citation_ids": ["cit_001", "cit_002"]
  }
}
```

### 4.2 content.md

用于人工阅读和语义索引。

示例：

```markdown
# QA Session session_001

## User

极氪 FY2024 毛利率变化怎么看？

## Assistant

毛利率变化主要来自产品结构、价格竞争和成本改善的共同影响...

引用：

- cit_001: Zeekr_2024_AR.pdf p.42
- cit_002: Zeekr_valuation_model.xlsx / DCF / E12
```

### 4.3 facts 表

用于精确记忆。

示例：

```text
Entity = zeekr
Metric = gross margin
Value = x
Period = FY2024
Citation = cit_001
```

### 4.4 citations 表

用于记录 QA / memo / note / fact 和 evidence 的关系。

不要把 citations 完全合并到 facts 里。

原因：

```text
一个 fact 可能有多个 citation
一个 citation 可能支持多个输出
citation 会被 QA、memo、note、fact 共同复用
citation 是证据连接，fact 是结构化结论
```

推荐做法：

```text
facts 表存结构化事实
citations 表存引用关系
facts.primary_citation_id 指向主引用
必要时用 fact_citations 支持多对多
```

### 4.5 audit_trail 表

用于复盘一次回答的全过程。

必须记录：

```text
query 是什么
是否被改写
拆成了哪些子问题
检索到了哪些 evidence
最终使用了哪些 evidence
生成了什么 answer
抽取了哪些 facts
写入 memory 是否成功
```

## 5. 推荐 SQLite 表

第一版建议至少实现以下表：

```text
qa_sessions
qa_messages
memory_items
facts
citations
fact_citations
audit_trail
```

第二阶段再补：

```text
watch_targets
watch_alerts
viewpoint_versions
personal_notes
memo_drafts
memo_sections
```

## 6. 表设计建议

### 6.1 qa_sessions

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

### 6.2 qa_messages

记录每条消息。

关键字段：

```text
message_id
session_id
role              -- user | assistant | system | tool
content
created_at
metadata_json
```

### 6.3 memory_items

统一管理可被语义检索的个人记忆。

关键字段：

```text
memory_id
project_id
analyst_id
memory_type       -- qa | note | memo | fact | viewpoint | watch_alert
source_id
title
summary
content_md_path
entities_json
topics_json
metrics_json
tags_json
created_at
updated_at
```

作用：

```text
OpenViking 不直接扫所有业务表，而是索引 memory_items 对应的 markdown 内容和 summary。
```

### 6.4 facts

记录结构化事实、风险、催化剂、假设、观点。

关键字段：

```text
fact_id
project_id
analyst_id
entity
metric
value
unit
period
fact_type          -- metric | risk | catalyst | assumption | viewpoint | task
primary_citation_id
source_type        -- qa | memo | note | manual
source_id
confidence
needs_review
created_at
updated_at
```

原则：

```text
没有 citation 的事实不能进入可信 facts。
可以写入 facts，但必须 needs_review = true。
```

### 6.5 citations

记录个人研究输出和 company collection evidence 的关系。

关键字段：

```text
citation_id
project_id
analyst_id
source_type       -- qa_message | memo_section | personal_note | fact
source_id
evidence_id
doc_id
quote
reason
created_at
```

说明：

```text
evidence_id 指向 company_collection.evidence.evidence_id。
doc_id 指向 company_collection.documents.doc_id。
```

### 6.6 fact_citations

当一个 fact 有多个 citation 时使用。

关键字段：

```text
fact_id
citation_id
role              -- primary | supporting | conflicting
created_at
```

### 6.7 audit_trail

记录 QA、memo、watch trigger、memory write 的执行轨迹。

关键字段：

```text
audit_id
project_id
analyst_id
event_type        -- qa | memory_write | memo_generation | watch_check
session_id
message_id
query
rewritten_query
sub_queries_json
retrieved_evidence_json
used_evidence_json
answer
facts_written_json
citations_written_json
status
error
created_at
```

## 7. 写入链路

每次 QA 后的推荐写入流程：

```text
用户提问
-> 写 user message 到 messages.jsonl
-> 写 user message 到 qa_messages
-> 检索 company_collection evidence
-> 检索 analyst_space memory
-> 生成带 citation 的 answer
-> 写 assistant message 到 messages.jsonl
-> 写 assistant message 到 qa_messages
-> 更新 content.md
-> 写 citations
-> 抽取 facts / risks / catalysts / assumptions / viewpoints
-> 写 facts
-> 写 fact_citations
-> 写 audit_trail
-> 写 / 更新 memory_items
-> 更新 markdown_memory
-> 更新 OpenViking semantic index
```

## 8. 读取链路

### 8.1 精确查询

示例问题：

```text
极氪 FY2024 毛利率是多少？
```

读取方式：

```text
SQLite facts
-> citations
-> company_collection evidence
-> original document location
```

### 8.2 语义召回

示例问题：

```text
我之前是不是讨论过类似的极氪盈利能力问题？
```

读取方式：

```text
OpenViking semantic search
-> memory_items
-> content.md
-> qa_messages / memo_sections / notes
-> citations
-> evidence
```

### 8.3 混合查询

示例问题：

```text
之前关于毛利率趋势的分析在哪？
```

读取方式：

```text
SQLite facts 精确查 entity / metric
+ OpenViking 语义查相关 QA / memo / note
+ citations 回查证据
```

## 9. 和 Company Collection 的关系

Research Memory 不复制团队资料，只引用 company collection 的 evidence。

正确关系：

```text
analyst_space.qa_messages
analyst_space.facts
analyst_space.memo_sections
analyst_space.personal_notes
  -> analyst_space.citations
  -> company_collection.evidence
  -> company_collection.documents
  -> original file location
```

这样做的好处：

```text
原始证据只维护一份
个人观点和团队资料解耦
文件版本变化时可以检测 citation 是否过期
memo / QA / note 可以复用同一 evidence
```

## 10. 正确性验证

Memory 是否正确，不看是否“存了很多东西”，而看是否能稳定回答追溯问题。

### 10.1 原文回看测试

给定 `session_id`，系统必须能从以下位置完整还原对话：

```text
messages.jsonl
content.md
qa_messages
```

验收标准：

```text
用户问题、系统回答、时间、citation_ids 都能查回。
```

### 10.2 Fact 追溯测试

给定一个 `fact_id`，系统必须能查到：

```text
fact
-> primary_citation_id
-> citation
-> evidence_id
-> doc_id
-> original file location
```

验收标准：

```text
能定位到 PDF page、PPT slide、Word section 或 Excel sheet/cell。
```

### 10.3 Citation 完整性测试

所有可信 facts 必须有 citation。

验收标准：

```text
needs_review = false 的 fact 必须有 primary_citation_id。
没有 citation 的 fact 必须 needs_review = true。
```

### 10.4 Audit 回放测试

给定一个 `audit_id`，系统必须能看到：

```text
query
rewritten_query
sub_queries
retrieved evidence
used evidence
answer
facts written
citations written
status
```

验收标准：

```text
能够复盘“这次回答为什么这么答”。
```

### 10.5 语义召回测试

输入：

```text
我之前是不是讨论过类似的极氪盈利能力问题？
```

系统必须返回：

```text
相关 QA
相关 memo
相关 note
相关 facts
当时引用的 evidence
```

验收标准：

```text
不能只靠关键词匹配，语义相近的问题也应该能召回。
```

### 10.6 重启持久化测试

重启服务后，系统必须仍能查回：

```text
messages.jsonl
content.md
facts
citations
audit_trail
memory_items
OpenViking index
```

### 10.7 Memo 复用测试

生成 memo 时，系统必须能使用历史 QA memory。

验收标准：

```text
memo section 可以引用历史 QA 中形成的 facts。
memo 的核心结论仍然必须绑定 company_collection evidence。
```

## 11. 最小端到端验收

第一版完成后，必须跑通以下流程：

```text
1. 用户问：极氪 FY2024 毛利率变化怎么看？
2. 系统检索 company evidence。
3. 系统生成带 citation 的回答。
4. QA 原文写入 messages.jsonl。
5. QA 转成 content.md。
6. 系统抽取 gross margin 相关 fact。
7. fact 写入 SQLite facts。
8. citation 写入 SQLite citations。
9. audit 写入 audit_trail。
10. markdown 写入 markdown_memory。
11. OpenViking 更新语义索引。
12. 用户问：我之前是否讨论过极氪盈利能力？
13. 系统能召回刚才那次 QA，并返回对应 citation。
```

如果这 13 步能稳定跑通，Research Memory 第一版就是正确的。

## 12. 开发优先级

### 第一阶段：最小 QA Memory 闭环

```text
messages.jsonl
content.md
qa_sessions
qa_messages
facts
citations
fact_citations
audit_trail
memory_items
```

### 第二阶段：语义记忆

```text
markdown_memory
OpenViking semantic index
memory search API
```

### 第三阶段：研究增强

```text
watch_targets
watch_alerts
viewpoint_versions
memo memory reuse
```

### 第四阶段：高级能力

```text
观点冲突检测
长期 memory consolidation
Obsidian 双向同步
跨项目 memory
```

## 13. 关键原则

1. Research Memory 不是聊天记录备份。
2. 每次 QA 都必须同时写原文、markdown、结构化事实、引用、audit。
3. SQLite 负责精确记忆。
4. Markdown + OpenViking 负责语义记忆。
5. facts 和 citations 不建议完全合并。
6. 没有 citation 的 fact 不能作为可信事实。
7. citations 必须能回到 company_collection evidence。
8. audit_trail 不能省。
9. memo 可以复用 memory，但 memo 结论仍必须有 evidence citation。
10. 最终目标是让历史研究判断可复用，而不是让系统简单记得聊过什么。

