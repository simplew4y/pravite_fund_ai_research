---
name: dianjin_investment_researcher_earnings_commentary_generator
description: "Adapted Qwen DianJin workflow for earnings commentary generator."
version: 0.1.0
category: dianjin_finance
---

# 上市公司财报业绩点评报告生成技能

> Adapted from `DianJin-SKILLS/investment-researcher/earnings-commentary-generator` at `fd9b51167d65`. The exact upstream text is retained in `references/UPSTREAM_SKILL.md` for review.

## FinSagent execution boundary

- Treat this package as an analysis workflow, not as authorization to call tools.
- Use only evidence already returned by the active dataset's Evidence Fusion pipeline.
- Never broaden company or document scope and never mix another company's evidence.
- Upstream tool names, shell commands, web search, databases, and message actions are unavailable unless the FinSagent runtime explicitly supplies an audited adapter.
- Preserve metric qualifiers, periods, units, currencies, actual/estimate labels, source document IDs, pages, and chunk citations.
- If required evidence is absent or conflicting, state the gap; do not estimate, fabricate, or silently substitute public data.
- Recommendations, ratings, target prices, compliance decisions, or high-risk actions require human review.

## Adapted workflow

# 上市公司财报业绩点评报告生成技能

## 技能概述

本技能专为上市公司财报（年报/半年报/季报）分析设计，**以 上游外部金融数据服务 金融数据服务为核心数据源**，生成结构化业绩点评报告。报告包含业绩概览、核心财务指标分析、业务板块拆解、盈利质量评估、风险提示及投资观点参考，帮助投资者快速把握公司经营状况。

**核心优势**：
- ✅ **上游外部金融数据服务 专业数据源**：所有财务数据优先通过 上游外部金融数据服务 服务获取，确保数据权威准确
- ✅ **数据全面**：覆盖营收、利润、毛利率、现金流、ROE 等核心指标
- ✅ **分析专业**：采用买方研究员分析框架，识别经营亮点与风险点
- ✅ **报告结构化**：8 大模块标准化输出，适合投资决策参考

---

## 触发场景

当用户提及以下任一表述时触发本技能：
- "XX 公司业绩点评"、"XX 公司财报分析"、"XX 公司业绩分析"
- "分析 XX 公司财报"、"点评 XX 公司业绩"、"生成财报点评报告"
- "XX 公司年报点评"、"XX 公司季报点评"、"XX 公司半年报分析"
- "业绩快评"、"财报解读"、"业绩点评"、"季报点评"、"财报分析报告"、"买方点评"、"盈利预测调整"
- 上传财报 PDF 并要求分析

**即使用户只说"分析 XX 公司业绩"、"点评 XX 公司财报"等简短表述也要触发。**

---

## 工作流程

### 第一步：识别公司与报告期

1. **从用户输入提取公司信息**：
   - 公司名称（如"五粮液"、"贵州茅台"）
   - 股票代码（如有提供，如"000858"、"600519"）
   - 报告期（如"2024 年报"、"2025 一季报"，如未指定则获取最新报告期）
   - 是否有上传 PDF 文件
   - 市场类型（A 股/港股/美股，如未明确则默认 A 股）

2. **确定数据获取方式**：
   - **有 PDF**：解析 PDF 提取数据，并用 上游外部金融数据服务 补充查询估值、一致预期等衍生数据
   - **无 PDF**：完全通过 上游外部金融数据服务 服务获取全部财务数据

3. **确定财报类型**：
   - 年报（年度报告）
   - 半年报（中期报告）

## 工作流程

## 输出模板

```markdown

## 特殊场景处理

## 注意事项

1. **上游外部金融数据服务 优先**：所有财务数据必须优先通过 上游外部金融数据服务 服务获取，不得臆造或估算
2. **数据准确性**：如 上游外部金融数据服务 无法获取某项数据，可辅以 外部联网检索 查询权威来源（公司公告、东方财富等）
3. **客观中立**：点评应基于事实数据，避免主观臆断
4. **风险提示**：风险部分不可省略，必须清晰呈现潜在风险
5. **口径一致**：同比/环比计算口径需一致，注明是否扣除并购影响
6. **时效性**：如财报发布超过 3 个月，在文档中提示"财报时效性注意"
7. **数据来源**：在报告末尾明确列出数据来源，便于用户核查
8. **数据缺失处理**：如 上游外部金融数据服务 部分数据无法获取，在对应位置标注"未披露"，不可编造数据
9. **港股/美股适配**：对于港股/美股公司，注意财报披露格式差异（如港股用"股东应占溢利"而非"归母净利润"）

---
