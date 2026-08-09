---
name: dianjin_investment_researcher_macro_risk_monitor
description: "宏观风险预警监控技能。当用户要求监控宏观经济数据、预警经济下行/通胀/通缩风险、提示政策转向信号、生成宏观预警报告时使用。本技能实时抓取核心宏观指标，通过对比预期与历史数据识别异动，研判经济衰退、滞胀、通缩或政策收紧风险，并输出包含风险等级、传导逻辑、资产影响及应对建议的结构化 Markdown 预警报告。"
version: 0.1.0
category: dianjin_finance
---

# 宏观风险预警监控技能

> Adapted from `DianJin-SKILLS/investment-researcher/macro-risk-monitor` at `fd9b51167d65`. The exact upstream text is retained in `references/UPSTREAM_SKILL.md` for review.

## FinSagent execution boundary

- Treat this package as an analysis workflow, not as authorization to call tools.
- Use only evidence already returned by the active dataset's Evidence Fusion pipeline.
- Never broaden company or document scope and never mix another company's evidence.
- Upstream tool names, shell commands, web search, databases, and message actions are unavailable unless the FinSagent runtime explicitly supplies an audited adapter.
- Preserve metric qualifiers, periods, units, currencies, actual/estimate labels, source document IDs, pages, and chunk citations.
- If required evidence is absent or conflicting, state the gap; do not estimate, fabricate, or silently substitute public data.
- Recommendations, ratings, target prices, compliance decisions, or high-risk actions require human review.

## Adapted workflow

# 宏观风险预警监控技能

## 概述

本技能模拟宏观策略研究员的风险监控视角，通过持续跟踪核心宏观经济指标，自动识别数据异动（如大幅低于/高于预期、趋势性拐点），精准预警经济下行、通胀抬头、通缩螺旋及政策转向等关键风险，并输出专业的**宏观经济风险预警报告**。

## 数据获取策略

### 核心数据源：上游外部金融数据服务

所有国内宏观数据、政策、舆情、资金面及行情数据均优先通过 `上游外部金融数据服务` 服务获取。

| 数据需求 | 推荐工具 | 说明 |
|---------|---------|------|
| **宏观数据** | `MacroIndustryEDB` | 查询中国宏观、行业经济、国际宏观等经济指标（支持周度/月度数据） |
| **政策会议** | `PolicyMeetingsList` | 国内经济金融领域政策会议动态及内容 |
| **官员讲话** | `OfficialSpeechEventList` | 国内外重要官员讲话及活动信息 |
| **法律法规** | `LawsRegulations` | 法律法规信息，按类型、关键词筛选 |
| **宏观舆情** | `MacroNewslist` | 宏观舆情，按区域、情感类型筛选经济预测及事件 |
| **宏观分析观点** | `MacroeconomicAnalysisViewpoints` | 研报中对 GDP、CPI、PMI、政策等宏观维度的分析观点 |
| **资金流向** | `StockMarketCapitalFlow` | 股票市场资金流入流出统计数据 |
| **北向资金** | `HSGTTradeStats` | 沪深港通市场交易统计（北向/南向资金） |
| **两融数据** | `MarginTradeStats` | 融资融券余额、买入额、卖出量等统计数据 |
| **指数区间行情** | `IndexRangeQuotation` | A 股指数区间行情（周报专用，获取周涨跌幅） |
| **债券行情** | `MostActiveRateBondQuotation` | 利率债最活跃券收益率及涨跌情况 |
| **海外市场** | `外部联网检索` | 补充查询美联储、海外通胀、美债等（Gildata 覆盖不足时） |

### 数据获取优先级

1.  **国内宏观与政策**：优先 `MacroIndustryEDB` + `PolicyMeetingsList` + `OfficialSpeechEventList`
2.  **舆情与观点**：优先 `MacroNewslist` + `MacroeconomicAnalysisViewpoints`
3.  **资金与行情**：优先 `StockMarketCapitalFlow` + `HSGTTradeStats` + `IndexRangeQuotation` + `MostActiveRateBondQuotation`
4.  **海外数据**：使用 `外部联网检索` 补充查询（如美联储最新决议、美债收益率等）

## 执行流程

### 第一阶段：核心数据抓取与异动识别

1. **核心宏观指标监控**
   - **工具**：`上游外部金融数据服务 MacroIndustryEDB`
   - **查询示例**：
     ```
     调用 上游外部金融数据服务 MacroIndustryEDB
     query: "GDP PMI CPI PPI 社融 M1 M2 进出口 工业增加值 社零"
     time_range: "最近 3 个月"

## 执行流程

## 注意事项

- **上游外部金融数据服务 优先**：所有国内宏观数据、政策、资金、行情查询优先使用 `上游外部金融数据服务` 服务，`外部联网检索` 仅用于补充海外政策及高频细节数据。
- **数据时效性**：必须使用最新发布的数据，若数据尚未公布，需注明“待公布”或使用高频数据替代（如高炉开工率、地铁客运量、票房收入等）。
- **逻辑一致性**：风险研判必须基于数据异动，避免主观臆断。资产影响分析需符合经典宏观经济学逻辑（如美林时钟、股债性价比）。
- **区分短期与长期**：明确风险是短期扰动（如天气、基数效应）还是趋势性拐点（如人口结构、债务周期），应对策略应有所区分。
- **情景分析**：对于不确定性较高的风险，提供“基准情景”与“极端情景”的应对差异。
