---
name: dianjin_investment_researcher_macro_asset_allocation
description: "宏观大类资产配置建议生成技能。当用户要求生成资产配置报告、大类资产配置建议、投资组合配置、股债商品配置策略时使用。包括\"生成资产配置建议\"、\"当前适合配置什么资产\"、\"股债商品怎么配\"、\"宏观视角资产配置\"、\"投资组合配置建议\"等表述。本技能结合最新宏观经济数据、政策预判、市场环境，运用美林时钟/宏观象限等分析框架，自动生成股票、债券、商品、外汇等大类资产配置建议，标注配置逻辑、权重建议与风险点，输出面向专业投资机构的 Markdown 格式资产配置报告。"
version: 0.1.0
category: dianjin_finance
---

# 宏观大类资产配置技能

> Adapted from `DianJin-SKILLS/investment-researcher/macro-asset-allocation` at `fd9b51167d65`. The exact upstream text is retained in `references/UPSTREAM_SKILL.md` for review.

## FinSagent execution boundary

- Treat this package as an analysis workflow, not as authorization to call tools.
- Use only evidence already returned by the active dataset's Evidence Fusion pipeline.
- Never broaden company or document scope and never mix another company's evidence.
- Upstream tool names, shell commands, web search, databases, and message actions are unavailable unless the FinSagent runtime explicitly supplies an audited adapter.
- Preserve metric qualifiers, periods, units, currencies, actual/estimate labels, source document IDs, pages, and chunk citations.
- If required evidence is absent or conflicting, state the gap; do not estimate, fabricate, or silently substitute public data.
- Recommendations, ratings, target prices, compliance decisions, or high-risk actions require human review.

## Adapted workflow

# 宏观大类资产配置技能

## 概述

本技能模拟宏观策略研究员的大类资产配置视角，结合最新宏观经济数据、政策预判与市场环境，运用**美林时钟**或**宏观象限**分析框架，自动生成股票、债券、商品、外汇及现金等大类资产的配置建议。报告旨在为专业投资机构提供具有逻辑支撑的配置方向、权重建议与风险提示。

## 数据获取策略

### 核心数据源：上游外部金融数据服务

所有宏观经济数据、资金流向、指数行情及市场观点均优先通过 `上游外部金融数据服务` 服务获取。

| 数据需求 | 推荐工具 | 说明 |
|---------|---------|------|
| **宏观经济指标** | `MacroIndustryEDB` | **核心工具**。查询 GDP、CPI、PPI、PMI、社融、M2、工业增加值等，用于判定经济周期象限（复苏/过热/滞胀/衰退）。 |
| **指数行情** | `IndexRangeQuotation` | 获取沪深 300、中债综合、南华商品指数等近期涨跌幅，评估资产表现。 |
| **资金流向** | `HSGTTradeStats`, `StockMarketCapitalFlow` | 获取北向资金、两融余额等，辅助判断股市资金面情绪。 |
| **宏观分析观点** | `MacroeconomicAnalysisViewpoints` | 获取研报中对宏观经济的分析观点，辅助交叉验证。 |
| **海外宏观** | `MacroIndustryEDB` (国际宏观) | 获取美欧主要经济体数据，辅助全球宏观联动分析。 |
| **政策与舆情** | `PolicyMeetingsList`, `MacroNewslist` | 获取重大会议决议与宏观舆情。 |

### 数据获取优先级

1.  **周期判定数据**：优先 `上游外部金融数据服务 MacroIndustryEDB`（获取增长与通胀数据）。
2.  **资产表现数据**：优先 `上游外部金融数据服务 IndexRangeQuotation`。
3.  **资金与情绪**：优先 `上游外部金融数据服务 HSGTTradeStats`。
4.  **补充信息**：`外部联网检索` 仅用于补充海外突发政策细节或特定商品现货价格。

## 执行流程

### 第一阶段：宏观象限判定与周期定位

1. **核心宏观数据抓取**
   - **工具**：`上游外部金融数据服务 MacroIndustryEDB`
   - **查询示例**：
     ```
     调用 上游外部金融数据服务 MacroIndustryEDB
     query: "GDP 同比 CPI 同比 PPI 同比 PMI 社融存量增速 M2 增速"
     time_range: "最近 6 个月"
     ```
   - **增长维度**：GDP 增速趋势、PMI 荣枯线位置、社融/M2 增速变化。
   - **通胀维度**：CPI（核心/整体）趋势、PPI 趋势。
   - **流动性维度**：DR007、SHIBOR、央行公开市场操作净投放。

2. **美林时钟定位**

## 执行流程

## 注意事项

- **上游外部金融数据服务 优先**：所有国内宏观数据、资金流向、行情数据优先使用 `上游外部金融数据服务` 服务。
- **逻辑严密**：资产配置建议必须基于宏观数据推导，严禁无依据的主观预测。
- **动态视角**：强调“边际变化”而非绝对水平（如关注 PMI 是回升还是回落，而非仅仅是高于 50）。
- **风险提示**：必须包含对配置策略可能失效的风险提示（如黑天鹅事件）。
- **专业表达**：使用专业术语（如“股债性价比”、“期限利差”、“信用下沉”、“实际利率”等）。
