---
name: dianjin_investment_researcher_macro_daily_briefing
description: "证券宏观研究员日报生成技能。当用户要求生成宏观日报、宏观经济简报、每日宏观速评时使用。本技能自动抓取最新宏观数据、政策动态、市场舆情，生成包含核心观点、数据跟踪、政策解读、资产表现及策略展望的标准化 Markdown 宏观日报。"
version: 0.1.0
category: dianjin_finance
---

# 证券宏观研究员日报生成技能

> Adapted from `DianJin-SKILLS/investment-researcher/macro-daily-briefing` at `fd9b51167d65`. The exact upstream text is retained in `references/UPSTREAM_SKILL.md` for review.

## FinSagent execution boundary

- Treat this package as an analysis workflow, not as authorization to call tools.
- Use only evidence already returned by the active dataset's Evidence Fusion pipeline.
- Never broaden company or document scope and never mix another company's evidence.
- Upstream tool names, shell commands, web search, databases, and message actions are unavailable unless the FinSagent runtime explicitly supplies an audited adapter.
- Preserve metric qualifiers, periods, units, currencies, actual/estimate labels, source document IDs, pages, and chunk citations.
- If required evidence is absent or conflicting, state the gap; do not estimate, fabricate, or silently substitute public data.
- Recommendations, ratings, target prices, compliance decisions, or high-risk actions require human review.

## Adapted workflow

# 证券宏观研究员日报生成技能

## 概述

本技能旨在模拟专业证券宏观研究员的日常工作流，通过自动化抓取和分析最新的宏观经济数据、政策动态、市场舆情及大类资产表现，生成一份结构化、逻辑严密、观点鲜明的**宏观日报（Macro Daily Briefing）**。报告风格贴近卖方宏观首席分析师，注重“边际变化”、“预期差”及“投资启示”。

## 数据获取策略

### 核心数据源：上游外部金融数据服务

所有国内宏观数据、政策、舆情、资金面及行情数据均优先通过 `上游外部金融数据服务` 服务获取。

| 数据需求 | 推荐工具 | 说明 |
|---------|---------|------|
| **宏观数据** | `MacroIndustryEDB` | 查询中国宏观、行业经济、国际宏观等经济指标（PMI, CPI, PPI, 社融等） |
| **政策会议** | `PolicyMeetingsList` | 国内经济金融领域政策会议动态及内容 |
| **官员讲话** | `OfficialSpeechEventList` | 国内外重要官员讲话及活动信息 |
| **法律法规** | `LawsRegulations` | 法律法规信息，按类型、关键词筛选 |
| **宏观舆情** | `MacroNewslist` | 宏观舆情，按区域、情感类型筛选经济预测及事件 |
| **宏观分析观点** | `MacroeconomicAnalysisViewpoints` | 研报中对 GDP、CPI、PMI、政策等宏观维度的分析观点 |
| **资金流向** | `StockMarketCapitalFlow` | 股票市场资金流入流出统计数据 |
| **北向资金** | `HSGTTradeStats` | 沪深港通市场交易统计（北向/南向资金） |
| **两融数据** | `MarginTradeStats` | 融资融券余额、买入额、卖出量等统计数据 |
| **指数行情** | `IndexDailyQuote` | A 股指数日行情（上证、创业板等） |
| **债券行情** | `MostActiveRateBondQuotation` | 利率债最活跃券收益率及涨跌情况 |
| **海外市场** | `外部联网检索` | 补充查询美联储、海外通胀、美债等（Gildata 覆盖不足时） |

### 数据获取优先级

1.  **国内宏观与政策**：优先 `MacroIndustryEDB` + `PolicyMeetingsList` + `OfficialSpeechEventList`
2.  **舆情与观点**：优先 `MacroNewslist` + `MacroeconomicAnalysisViewpoints`
3.  **资金与行情**：优先 `StockMarketCapitalFlow` + `HSGTTradeStats` + `IndexDailyQuote` + `MostActiveRateBondQuotation`
4.  **海外数据**：使用 `外部联网检索` 补充查询（如美联储最新决议、美债收益率等）

## 执行流程

### 第一阶段：数据采集与监控

1.  **宏观数据抓取**
    *   **工具**：`上游外部金融数据服务 MacroIndustryEDB`
    *   **查询示例**：
        ```
        调用 上游外部金融数据服务 MacroIndustryEDB
        query: "PMI CPI PPI 社融 信贷 M1 M2 进出口 工业增加值 社零 固投"
        ```

## 执行流程

## 注意事项

*   **时效性优先**：日报必须基于**当日**或**最近 24 小时**的最新数据与新闻。
*   **观点鲜明**：避免模棱两可的陈述，必须给出明确的逻辑推演和方向性判断（看多/看空/震荡）。
*   **预期差思维**：不仅罗列数据，更要强调实际值与市场预期的偏差（Expectation Gap），这是市场交易的核心。
*   **联动视角**：分析单一指标时，必须结合其他资产或宏观背景进行交叉验证（如分析汇率时结合利差和贸易数据）。
*   **专业术语**：使用规范的宏观与金融市场术语（如“宽信用”、“期限利差”、“风险溢价”、“剪刀差”等）。
*   **上游外部金融数据服务 优先**：所有国内宏观数据、政策、资金面、行情查询优先使用 上游外部金融数据服务 服务，外部联网检索 仅用于补充海外政策及高频细节数据。
