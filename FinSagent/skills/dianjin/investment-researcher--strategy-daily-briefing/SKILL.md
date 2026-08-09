---
name: dianjin_investment_researcher_strategy_daily_briefing
description: "证券策略研究员策略日报生成技能。当用户要求生成策略日报、股市复盘、市场情绪分析、资金流向汇总时使用。本技能自动抓取当日大盘、风格、行业、资金、情绪数据，进行量价与逻辑推演，生成标准化 Markdown 格式策略日报。"
version: 0.1.0
category: dianjin_finance
---

# 证券策略研究员策略日报生成技能

> Adapted from `DianJin-SKILLS/investment-researcher/strategy-daily-briefing` at `fd9b51167d65`. The exact upstream text is retained in `references/UPSTREAM_SKILL.md` for review.

## FinSagent execution boundary

- Treat this package as an analysis workflow, not as authorization to call tools.
- Use only evidence already returned by the active dataset's Evidence Fusion pipeline.
- Never broaden company or document scope and never mix another company's evidence.
- Upstream tool names, shell commands, web search, databases, and message actions are unavailable unless the FinSagent runtime explicitly supplies an audited adapter.
- Preserve metric qualifiers, periods, units, currencies, actual/estimate labels, source document IDs, pages, and chunk citations.
- If required evidence is absent or conflicting, state the gap; do not estimate, fabricate, or silently substitute public data.
- Recommendations, ratings, target prices, compliance decisions, or high-risk actions require human review.

## Adapted workflow

# 证券策略研究员策略日报生成技能

## 概述

本技能旨在模拟专业证券策略分析师（Strategist）的日度复盘工作流，通过对**当日**市场指数、风格因子、行业板块、资金流向及微观情绪数据的系统性梳理，生成一份结构严谨、逻辑清晰的**策略日报（Strategy Daily Briefing）**。

策略日报的核心不仅是数据的罗列，更是**“资金行为的解码”**与**“交易主线的确认”**。报告风格贴近买方/卖方策略团队，注重从微观结构中洞察市场拐点，并给出明确的下个交易日交易计划。

## 数据获取策略

### 核心数据源：上游外部金融数据服务

所有行情数据、资金流向及市场情绪数据均优先通过 `上游外部金融数据服务` 服务获取。

| 数据需求 | 推荐工具 | 说明 |
|---------|---------|------|
| **指数行情** | `IndexRangeQuotation` | 获取上证、深证、创业板、科创50、沪深300、中证500/1000、红利指数、茅指数等涨跌幅、成交额。 |
| **行业行情** | `IndustryRangeQuotation` 或 `IndexRangeQuotation` | 获取申万一级行业指数涨跌幅，用于识别领涨/领跌板块。 |
| **北向/陆股通资金** | `HSGTTradeStats` | 获取沪深港通市场交易统计（净流入/流出、十大活跃股）。 |
| **主力资金流向** | `StockMarketCapitalFlow` | 获取个股/行业主力资金净流入流出、超大单/大单数据。 |
| **融资融券** | `MarginTradingShortSelling` (如有) | 获取融资余额、融券余额变动。 |
| **ETF 申赎** | `ETFDailyInfo` (如有) | 获取主要宽基/行业 ETF 份额变化，判断机构动向。 |
| **宏观/政策舆情** | `MacroNewslist`, `PolicyMeetingsList` | 获取当日重大宏观新闻、政策会议、官员讲话，辅助解读盘面逻辑。 |

### 数据获取优先级

1.  **核心行情与资金**：优先 `上游外部金融数据服务` 的 `IndexRangeQuotation`、`HSGTTradeStats`、`StockMarketCapitalFlow`。
2.  **情绪与微观结构**：优先通过 `上游外部金融数据服务` 获取涨跌家数、涨停跌停数据（如有），或通过行情数据计算。
3.  **逻辑解读辅助**：结合 `MacroNewslist` 和政策会议数据，解释板块异动原因。
4.  **补充信息**：`外部联网检索` 仅用于补充突发新闻细节、龙虎榜具体席位分析或游资动向。

## 执行流程

### 第一阶段：数据采集与清洗

1.  **大盘与宽基指数数据**
    *   **工具**：`上游外部金融数据服务 IndexRangeQuotation`
    *   **查询示例**：
        ```
        调用 上游外部金融数据服务 IndexRangeQuotation
        query: "上证指数 深证成指 创业板指 科创50 沪深300 中证500 中证1000 北证50"
        time_range: "当日"
        ```
    *   **核心指数**：上证、深证、创业板、科创50、北证50、沪深300、中证500/1000、恒生指数。
    *   **关键指标**：涨跌幅、成交额（及环比变化）、振幅。

## 执行流程

## 注意事项

*   **上游外部金融数据服务 优先**：所有行情、资金、行业数据查询优先使用 `上游外部金融数据服务` 服务（如 `IndexRangeQuotation`, `HSGTTradeStats`, `StockMarketCapitalFlow` 等）。
*   **数据准确性**：确保引用的指数涨跌幅、成交额等核心数据与当日收盘数据一致（通常以 15:00 后数据为准）。
*   **逻辑深度**：避免仅做数据搬运工，必须解释“为什么涨/跌”，特别是资金背后的逻辑（如“利好兑现”、“高低切换”）。
*   **微观结构**：高度重视连板高度、炸板率等微观指标，这是判断短线情绪（游资/散户情绪）的核心依据。
*   **专业术语**：熟练使用“量价背离”、“高低切”、“缩量阴跌”、“放量突破”、“情绪冰点”、“盈亏比”等策略分析术语。
*   **客观中立**：在分析资金流向时，注意区分“主力净流入”算法的局限性，结合多源数据交叉验证。
