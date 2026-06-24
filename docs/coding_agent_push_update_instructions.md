# 员工 Coding Agent Push 更新说明

## 1. 使用对象

本文档给每位员工自己的 coding agent 使用。每个 agent 在开发前必须先读取：

```text
README.md
自己负责的模块设计文档
本更新说明
```

负责人和模块：

```text
雷雷   -> docs/project_db_and_personal_memory_design.md
廖     -> docs/research_memory_design.md
朝龙   -> docs/memo_generation_design.md
程景逸 -> docs/evidence_schema_design.md
```

## 2. 每次开发前

执行：

```bash
git pull --rebase origin main
```

确认当前分支和工作区：

```bash
git status -sb
```

建议分支命名：

```text
{owner}/{module}/{YYYYMMDD-short-task}
```

示例：

```text
liao/research-memory/20260624-qa-writer
chengjingyi/evidence-schema/20260624-excel-adapter
```

## 3. 每次更新必须包含的内容

每次 push 至少更新三类内容：

```text
1. 模块代码或模块设计文档
2. README.md 中对应负责人的更新记录
3. README.md 中“模块进度看板”的状态
4. test/ 下对应模块目录中的测试、fixture、验证脚本或验证说明
```

如果只改代码不更新 README，视为不完整提交。
如果只改功能不补充对应测试目录内容，也视为不完整提交。

模块测试目录：

```text
雷雷   -> test/project_db/
廖     -> test/research_memory/
朝龙   -> test/memo_generation/
程景逸 -> test/evidence_schema/
```

## 4. README 更新格式

在自己负责人的“更新记录”下追加一行：

```markdown
| YYYY-MM-DD | 本次做了什么 | `影响文件1`, `影响文件2` | 如何验证 | status |
```

`status` 只允许使用：

```text
todo
in_progress
review
blocked
done
```

示例：

```markdown
| 2026-06-24 | 实现 QA 写入 messages.jsonl 和 qa_messages 表。 | `src/research_memory/qa_writer.py`, `test/research_memory/test_qa_writer.py`, `README.md` | 运行 `pytest test/research_memory/test_qa_writer.py`，确认重启后可查回 QA。 | in_progress |
```

同时更新 README 的“模块进度看板”：

```text
阶段目标
下一步
阻塞项
```

如有阻塞，必须写清楚：

```text
缺什么输入
卡在哪个接口
需要谁协助
```

## 5. Commit Message 格式

格式：

```text
[module][owner] concise summary
```

示例：

```text
[memory][liao] add qa memory writer and audit records
[evidence][chengjingyi] add excel evidence adapter draft
[memo][chaolong] add fixed coverage memo template
[db][leilei] add initial sqlite schema
```

## 6. Push 说明格式

每次 push 后，在团队群或任务系统中贴以下说明：

```markdown
### Push Summary

- Owner:
- Module:
- Branch:
- Commit:
- Changed files:
- What changed:
- How verified:
- README updated: yes/no
- Blockers:
- Next step:
```

示例：

```markdown
### Push Summary

- Owner: 廖
- Module: Research Memory
- Branch: liao/research-memory/20260624-qa-writer
- Commit: abc1234
- Changed files: `src/research_memory/qa_writer.py`, `README.md`
- What changed: QA 后写入 messages.jsonl、content.md、qa_messages。
- How verified: 本地运行 memory writer fixture，确认 session_id 可查回完整 QA。
- README updated: yes
- Blockers: OpenViking 写入接口待确认
- Next step: 接入 memory_items 和 semantic index
```

## 7. 验证要求

每个模块至少满足自己的最小验证。

### 7.1 雷雷：Project DB

必须能验证：

```text
documents -> document_versions -> evidence -> citations -> original file location
```

最低验收：

```text
给定 citation_id，可以查回 document、version、location。
```

### 7.2 廖：Research Memory

必须能验证：

```text
QA 原文写入 messages.jsonl
QA 转成 content.md
facts 写入 SQLite
citations 可回到 evidence
audit_trail 可复盘 query / retrieved evidence / answer
```

最低验收：

```text
重启系统后，问“之前是否讨论过某问题”，能召回历史 QA。
```

### 7.3 朝龙：Memo Generation

必须能验证：

```text
memo 有 section
核心 section 有 citation
citation 能回到 evidence
无证据 claim 被 needs_review 标记
memo 写入 markdown_memory
```

最低验收：

```text
输入 company_id，能生成一版带 citation 的 memo.md。
```

### 7.4 程景逸：Evidence Schema

必须能验证：

```text
PDF / PPT / Word / Excel / Markdown parser 输出统一 evidence
evidence 有 location
citation display 可渲染
Excel evidence 能返回 sheet/cell/value/formula
```

最低验收：

```text
给定 evidence_id，可以定位到原始文件位置。
```

## 8. 跨模块变更规则

跨模块改动必须在 README 对应更新记录中说明原因。

例如：

```text
Memo 模块为了 citation gate 修改了 Evidence Schema 字段。
```

这种情况需要：

```text
1. 在自己的更新记录中写明
2. 在被影响模块负责人的部分增加备注或开 issue
3. 在 Push Summary 的 Blockers / Next step 中说明
```

## 9. 不允许的提交

以下提交不允许：

```text
只改代码不更新 README
只写“update docs”但不说明验证方式
删除其他负责人文档
绕过 citation / evidence 追溯链
把无 citation 的 fact 当作可信 fact
memo 核心结论没有 citation 且没有 needs_review
```

## 10. 每个 agent 的工作原则

最终所有模块都要服务同一个目标：

```text
任何一个研究结论，都能回到 citation、evidence、document、version 和原始文件位置。
```

如果某次实现不能维护这条链路，需要在 README 中标记为 `blocked` 或 `needs_review`，不能假装完成。
