---
name: dianjin_investment_researcher_institutional_research_outline
description: "机构调研大纲生成技能。当用户需要为上市公司调研准备提纲、生成调研问题清单、准备机构调研材料时使用，包括\"生成 XX 公司调研大纲\"、\"准备去 XX 公司调研\"、\"调研 XX 公司前需要问什么问题\"、\"帮我写一份调研提纲\"等表述。本技能针对上市公司首次调研场景，生成标准版深度（1-2 小时准备）的结构化调研大纲，包含公司基本面分析、同业对比、历史调研问题回顾和约 10 个核心调研问题，覆盖战略、业务、财务、风险等维度。**报告生成后直接在对话中显示完整内容，无需发送文件**。"
version: 0.1.0
category: dianjin_finance
---

# 机构调研大纲生成技能

> Adapted from `DianJin-SKILLS/investment-researcher/institutional-research-outline` at `fd9b51167d65`. The exact upstream text is retained in `references/UPSTREAM_SKILL.md` for review.

## FinSagent execution boundary

- Treat this package as an analysis workflow, not as authorization to call tools.
- Use only evidence already returned by the active dataset's Evidence Fusion pipeline.
- Never broaden company or document scope and never mix another company's evidence.
- Upstream tool names, shell commands, web search, databases, and message actions are unavailable unless the FinSagent runtime explicitly supplies an audited adapter.
- Preserve metric qualifiers, periods, units, currencies, actual/estimate labels, source document IDs, pages, and chunk citations.
- If required evidence is absent or conflicting, state the gap; do not estimate, fabricate, or silently substitute public data.
- Recommendations, ratings, target prices, compliance decisions, or high-risk actions require human review.

## Adapted workflow

# 机构调研大纲生成技能

## 技能定位

本技能用于**生成上市公司机构调研前的结构化调研大纲**，帮助研究员系统性地准备调研问题，覆盖财务、业务、战略、风险等关键维度。**以 上游外部金融数据服务 金融数据服务为核心数据源**，确保财务数据、估值数据、同业对比的专业性和准确性。

**核心优势**：
- ✅ **上游外部金融数据服务 专业数据源**：所有财务数据、估值数据、一致预期优先通过 上游外部金融数据服务 服务获取
- ✅ **分析框架系统**：覆盖基本面、同业对比、历史问题、核心问题四大模块
- ✅ **问题设计专业**：10-12 个针对性调研问题，避免公开信息重复
- ✅ **输出结构化**：标准化 Markdown 格式报告，直接在对话中展示完整内容

**输出格式**：
- 默认生成结构化 Markdown 格式报告
- **报告内容直接在对话中展示，无需发送文件**
- 如用户明确要求 Word 文档，可另行处理

---

## 触发场景

当用户出现以下任一表述时，应触发本技能：

| 用户表述 | 触发类型 |
|----------|----------|
| "生成 XX 公司调研大纲" | 定向生成 |
| "准备去 XX 公司调研" | 定向生成 |
| "调研 XX 公司前需要问什么问题" | 定向生成 |
| "帮我写一份调研提纲" | 定向生成 |
| "机构调研 XX 公司准备材料" | 定向生成 |
| "XX 公司首次调研问题清单" | 定向生成 |
| "准备调研 XX 公司" | 定向生成 |

**注意**：用户只需提到公司名字 + 调研/提纲/大纲等关键词，即应触发本技能。

---

## 执行流程

### Step 1：获取公司基本信息

**1.1 提取公司名称/股票代码**

从用户输入中识别目标上市公司：
- 公司全称/简称（如"五粮液"、"茅台"）

## 执行流程

## 报告结构模板

```markdown

## 特殊场景处理

## 注意事项

1. **数据准确性**：财务数据需标注来源和报告期，优先使用 上游外部金融数据服务 获取
2. **客观中立**：分析应基于事实，避免主观臆断
3. **信息时效**：优先使用最新公开信息（最近 12 个月）
4. **合规提示**：提醒用户遵守调研相关规定，不获取内幕信息
5. **问题质量**：调研问题应避免可从公开信息获取的答案
6. **同业选择**：可比公司应选择业务模式最接近的 3-5 家
7. **行业差异**：通用模板可能不适用于所有行业，需提示用户
8. **数据来源**：财务/估值/一致预期优先 上游外部金融数据服务，基本信息/调研记录使用 外部联网检索
9. **简洁优先**：报告控制在适中长度，重点突出
10. **持续更新**：提示用户调研前更新最新数据
11. **输出方式**：**报告内容直接在对话中展示，无需写入文件或发送给用户**

---
