---
name: dianjin_investment_researcher_macro_weekly_briefing
description: "证券宏观研究员周报生成技能。当用户要求生成宏观周报、每周宏观经济回顾、周度宏观策略报告时使用。本技能自动抓取本周宏观数据、政策动态、市场舆情及大类资产表现，生成包含核心观点、数据回顾、政策梳理、资产复盘及下周展望的标准化 Markdown 宏观周报。"
version: 0.1.0
category: dianjin_finance
---

# 证券宏观研究员周报生成技能

> Adapted from `DianJin-SKILLS/investment-researcher/macro-weekly-briefing` at `fd9b51167d65`. The exact upstream text is retained in `references/UPSTREAM_SKILL.md` for review.

## FinSagent execution boundary

- Treat this package as an analysis workflow, not as authorization to call tools.
- Use only evidence already returned by the active dataset's Evidence Fusion pipeline.
- Never broaden company or document scope and never mix another company's evidence.
- Upstream tool names, shell commands, web search, databases, and message actions are unavailable unless the FinSagent runtime explicitly supplies an audited adapter.
- Preserve metric qualifiers, periods, units, currencies, actual/estimate labels, source document IDs, pages, and chunk citations.
- If required evidence is absent or conflicting, state the gap; do not estimate, fabricate, or silently substitute public data.
- Recommendations, ratings, target prices, compliance decisions, or high-risk actions require human review.

## Adapted workflow

# 证券宏观研究员周报生成技能

## 概述

本技能旨在模拟专业证券宏观研究员的周报撰写工作流，通过对**一周内**宏观经济数据、政策动态、市场舆情及大类资产表现的系统性复盘，生成一份结构严谨、逻辑连贯、观点鲜明的**宏观周报（Macro Weekly Briefing）**。

与日报不同，周报更侧重于**“趋势的确认”**、**“逻辑的连贯性”**以及**“下周的前瞻性”**。报告风格贴近卖方宏观首席分析师，注重将周度高频数据串联成宏观叙事，并给出明确的投资策略建议。

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

### 第一阶段：数据采集与监控

1.  **本周宏观数据抓取**
    *   **工具**：`上游外部金融数据服务 MacroIndustryEDB`
    *   **查询示例**：
        ```
        调用 上游外部金融数据服务 MacroIndustryEDB

## 执行流程

## 注意事项

*   **周度视角**：周报必须基于**本周（通常为周一至周五）**的数据与新闻，侧重总结一周的趋势变化，而非单日的波动。
*   **上游外部金融数据服务 优先**：所有国内宏观数据、政策、资金、行情查询优先使用 上游外部金融数据服务 服务，外部联网检索 仅用于补充海外政策及高频细节数据。
*   **逻辑连贯**：强调数据与政策之间的内在逻辑联系，构建完整的宏观叙事（如“数据走弱 -> 政策预期升温 -> 债市上涨”）。
*   **前瞻性强**：必须包含“下周重要日程与前瞻”模块，为用户提供未来一周的交易日历和预期管理。
*   **预期差思维**：重点捕捉数据与 Wind/彭博一致预期的偏差（Expectation Gap），这是市场交易的核心驱动力。
*   **专业术语**：使用规范的宏观与金融市场术语（如“宽信用”、“期限利差”、“风险溢价”、“剪刀差”、“削峰填谷”等）。
