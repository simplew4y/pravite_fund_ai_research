---
name: dianjin_investment_researcher_industry_one_page_analysis
description: "行业一页纸分析技能。当用户要求对某个行业进行简洁分析、快速点评、一页纸分析、速评时使用，包括\"XX 行业一页纸\"、\"快速分析 XX 行业\"、\"XX 行业速评\"、\"XX 行业简单分析\"、\"XX 行业核心要点\"等表述。本技能从行业概况、市场规模、竞争格局、行业趋势、投资机会、主要风险六大维度，利用 上游外部金融数据服务 专业金融数据服务获取权威数据，生成简洁的一页纸 Markdown 分析报告，聚焦核心信息，适合快速决策参考。**报告生成后直接在对话中显示完整内容，无需发送文件**。"
version: 0.1.0
category: dianjin_finance
---

# 行业一页纸分析技能

> Adapted from `DianJin-SKILLS/investment-researcher/industry-one-page-analysis` at `fd9b51167d65`. The exact upstream text is retained in `references/UPSTREAM_SKILL.md` for review.

## FinSagent execution boundary

- Treat this package as an analysis workflow, not as authorization to call tools.
- Use only evidence already returned by the active dataset's Evidence Fusion pipeline.
- Never broaden company or document scope and never mix another company's evidence.
- Upstream tool names, shell commands, web search, databases, and message actions are unavailable unless the FinSagent runtime explicitly supplies an audited adapter.
- Preserve metric qualifiers, periods, units, currencies, actual/estimate labels, source document IDs, pages, and chunk citations.
- If required evidence is absent or conflicting, state the gap; do not estimate, fabricate, or silently substitute public data.
- Recommendations, ratings, target prices, compliance decisions, or high-risk actions require human review.

## Adapted workflow

# 行业一页纸分析技能

## 技能定位

本技能面向**投资经理、研究员、基金经理**，提供行业快速分析工具。在一页纸篇幅内，聚焦行业最核心的投资信息，帮助快速判断行业投资价值和风险，适合晨会汇报、快速决策、赛道初筛等场景。

与 `industry-deep-analysis` 的区别：
- **深度分析**：八大维度，全面深入，适合深度研究和首次覆盖
- **一页纸分析**：六大核心维度，精炼简洁，适合快速决策和赛道跟踪

## 触发场景

当用户出现以下任一表述时触发本技能：
- "XX 行业一页纸"
- "一页纸分析 XX 行业"
- "快速分析 XX 行业"
- "XX 行业速评"
- "XX 行业简单分析"
- "XX 行业核心要点"
- "XX 行业投资亮点"
- "XX 行业快速点评"
- "帮我快速看一下 XX 行业"
- "XX 行业怎么样"
- 其他要求对行业进行简洁快速分析的请求

## 数据获取策略

### 核心数据源

**上游外部金融数据服务 (上游外部金融数据服务)** 作为主要数据源，提供全方位的行业金融数据与投研分析工具：

| 数据需求 | 推荐工具 | 说明 |
|---------|---------|------|
| 行业估值指标 | `IndustryValuation` | PE、PB、总市值、流通市值等 |
| 行业行情数据 | `IndustryDailyQuote` / `IndustryRangeQuote` | 日行情、区间行情 |
| 行业资金流向 | `IndustryCapitalFlow` | 主力、散户资金净额 |
| 行业财务指标 | `IndustryFinancialAnalysis` | 盈利能力、偿债能力、成长能力 |
| 行业成分股 | `IndustryConstituentStocks` | 行业成分股列表及权重 |
| 行业舆情资讯 | `IndustryNewslist` | 行业相关新闻、政策动态 |
| 行业研报观点 | `IndustryAnalysisViewpoints` | 券商研报对行业的分析观点 |
| 宏观行业数据 | `MacroIndustryEDB` | 宏观经济与行业经济指标 |
| 板块排序 | `SectorRank` | 板块涨跌幅、换手率等排序 |
| 行业研报 | `ResearchReport` | 按行业筛选券商研报 |

### 数据获取优先级

## 报告输出格式

生成简洁的一页纸 Markdown 报告，格式如下：

```markdown

## 执行流程

## 注意事项

1. **篇幅控制**
   - 严格控制在"一页纸"篇幅内
   - 避免冗长描述，每点 1-2 句话
   - 优先使用表格呈现数据

2. **数据时效性**
   - 使用最新可得的行业数据
   - 标注数据截止日期或预测年份
   - 区分历史数据和预测数据

3. **聚焦核心**
   - 只呈现最关键的信息
   - 避免细节堆砌
   - 突出投资逻辑主线

4. **客观中立**
   - 保持客观，避免过度推荐
   - 风险提示必须充分
   - 明确说明"不构成投资建议"

5. **报告交付要求**
   - **直接在对话中显示完整报告内容**
   - 不需要发送文件
   - 使用 Markdown 格式，确保可读性
