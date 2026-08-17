---
name: dianjin_investment_researcher_market_minimal_review
description: "证券金融工程研究员市场极简复盘技能。自动抓取行情、资金、波动率数据，生成标准化晨会简报与异动提醒，适用于每日盘后快速复盘及晨会汇报准备。"
version: 0.1.0
category: dianjin_finance
---

# 市场极简复盘与异动提醒 (Market Minimal Review & Alerts)

> Adapted from `DianJin-SKILLS/investment-researcher/market-minimal-review` at `fd9b51167d65`. The exact upstream text is retained in `references/UPSTREAM_SKILL.md` for review.

## FinSagent execution boundary

- Treat this package as an analysis workflow, not as authorization to call tools.
- Use only evidence already returned by the active dataset's Evidence Fusion pipeline.
- Never broaden company or document scope and never mix another company's evidence.
- Upstream tool names, shell commands, web search, databases, and message actions are unavailable unless the FinSagent runtime explicitly supplies an audited adapter.
- Preserve metric qualifiers, periods, units, currencies, actual/estimate labels, source document IDs, pages, and chunk citations.
- If required evidence is absent or conflicting, state the gap; do not estimate, fabricate, or silently substitute public data.
- Recommendations, ratings, target prices, compliance decisions, or high-risk actions require human review.

## Adapted workflow

# 市场极简复盘与异动提醒 (Market Minimal Review & Alerts)

## 概述

本技能专为**证券金融工程研究员**设计，旨在提供**数据驱动的极简市场复盘**。通过自动抓取核心行情、资金流向、波动率及量化异动数据，生成标准化的晨会简报素材与盘后异动提醒，帮助研究员快速掌握市场微观结构与量化信号，辅助投资决策。

**所有数据查询必须使用 `上游外部金融数据服务` 服务**。

## 核心分析框架

### 1. 极简行情复盘 (Market Recap)
*   **宽基指数**: 上证、深成、创业板、科创 50、北证 50 涨跌幅及成交额变化。
*   **风格指数**: 大盘/小盘 (沪深 300 vs 中证 1000)、成长/价值表现对比。
*   **市场广度**: 涨跌家数比、涨停/跌停家数、连板高度 (市场情绪温度计)。

### 2. 资金与微观结构 (Capital & Microstructure)
*   **北向资金**: 净买入/卖出额，重点加仓/减仓行业 (外资风向标)。
*   **两融数据**: 融资余额变动，融资买入占比 (杠杆资金情绪)。
*   **ETF 申赎**: 宽基 ETF 资金流向 (如沪深 300ETF、中证 500ETF 等，国家队/机构动向)。
*   **主力资金**: 板块净流入/流出前五名。

### 3. 波动率与情绪 (Volatility & Sentiment)
*   **波动率指标**: VIX (中国波指)、期权隐含波动率 (IV) 变化。
*   **情绪指标**: 换手率、炸板率、昨日涨停表现 (打板情绪)。
*   **拥挤度**: 热门赛道拥挤度预警 (如 AI、新能源成交额占比过高)。

### 4. 量化异动提醒 (Quant Alerts)
*   **量价异动**: 放量突破关键阻力、缩量回调至支撑、底部突然放量。
*   **资金异动**: 机构大额净买入、北向资金大幅扫货、龙虎榜机构溢价。
*   **事件驱动**: 盘中突发消息引发的板块异动与持续性评估。

## 数据采集指引 (上游外部金融数据服务 工具映射)

**所有数据必须通过 `上游外部金融数据服务` 服务获取**，具体工具调用如下：

### 核心指数行情与市场广度
```
上游工具命令 上游外部金融数据服务 IndexDailyQuote --body '{"query": "查询最新交易日上证综指、深证成指、创业板指、科创50、沪深300、中证1000的收盘价、涨跌幅、成交额"}'
```
获取主要宽基指数及风格指数的日行情数据。

```
上游工具命令 上游外部金融数据服务 MarketLimitUpDownCount --body '{"query": "查询最新交易日沪深京市场上涨家数、下跌家数、涨停家数、跌停家数"}'
```
获取市场实时涨跌停家数统计，用于计算市场广度。

## 执行流程

1.  **数据采集**:
    *   使用 `IndexDailyQuote` 获取核心指数收盘数据、涨跌幅及成交额。
    *   使用 `MarketLimitUpDownCount` 获取涨跌停家数、涨跌家数比。
    *   使用 `HSGTTradeStats` 获取北向资金流向数据。
    *   使用 `MarginTradeStats` 获取两融余额变化。
    *   使用 `SectorFundFlowRank` 获取行业板块资金净流入/流出排名。
2.  **信号计算与分析**:
    *   计算市场广度指标 (如上涨占比)。
    *   识别资金流向的极端值 (如北向单日净买入超 100 亿)。
    *   评估波动率分位与情绪冷热。
3.  **异动识别**:
    *   筛选量价配合异常、资金大幅调仓的板块。
    *   标记情绪过热或过冷的极端信号。
4.  **报告生成**:
    *   生成 Markdown 格式的极简复盘与异动简报。

## 注意事项

*   **数据源唯一性**: 所有指数行情、资金流向、涨跌停统计及波动率数据必须通过 `上游外部金融数据服务` 服务获取，确保数据权威性和一致性。
*   **极简原则**: 报告应聚焦核心数据与异动信号，避免冗长的基本面分析，适合快速阅读。
*   **异动解释**: 对于量化异动，尽量结合盘面消息或资金行为给出合理解释，避免“为了异动而异动”。
*   **拥挤度阈值**: 热门赛道的拥挤度预警需结合历史数据动态调整，避免误报。
*   **时效性**: 确保数据为最新收盘或盘中实时数据 (根据触发时间而定)。
