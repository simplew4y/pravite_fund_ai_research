---
name: dianjin_investment_researcher_market_sentiment_monitor
description: "市场情绪与风险预警技能。实时跟踪北向资金、两融余额、龙虎榜资金流向及波动率指标，生成情绪与风险预警信号，提示异常变动，适用于盘中监控与盘后复盘。当用户要求生成市场情绪日报、资金面监控报告、风险预警简报、龙虎榜分析、北向资金点评、两融数据分析、市场情绪体温报告时使用，包括\"市场情绪监控\"、\"今日资金面怎么样\"、\"北向资金流向\"、\"两融数据分析\"、\"龙虎榜解读\"、\"市场风险预警\"、\"情绪日报\"、\"盘中监控\"、\"盘后复盘\"等表述。即使用户只说\"看看今天情绪\"、\"资金面怎么样\"、\"有没有风险信号\"等简短表述也要触发。本技能自动通过 上游外部金融数据服务 专业金融数据服务获取核心情绪与资金数据，以md格"
version: 0.1.0
category: dianjin_finance
---

# 市场情绪与风险预警监控 (Market Sentiment & Risk Monitor)

> Adapted from `DianJin-SKILLS/investment-researcher/market-sentiment-monitor` at `fd9b51167d65`. The exact upstream text is retained in `references/UPSTREAM_SKILL.md` for review.

## FinSagent execution boundary

- Treat this package as an analysis workflow, not as authorization to call tools.
- Use only evidence already returned by the active dataset's Evidence Fusion pipeline.
- Never broaden company or document scope and never mix another company's evidence.
- Upstream tool names, shell commands, web search, databases, and message actions are unavailable unless the FinSagent runtime explicitly supplies an audited adapter.
- Preserve metric qualifiers, periods, units, currencies, actual/estimate labels, source document IDs, pages, and chunk citations.
- If required evidence is absent or conflicting, state the gap; do not estimate, fabricate, or silently substitute public data.
- Recommendations, ratings, target prices, compliance decisions, or high-risk actions require human review.

## Adapted workflow

# 市场情绪与风险预警监控 (Market Sentiment & Risk Monitor)

## 概述

本技能专注于**微观资金流向**与**市场情绪监控**，旨在为交易者和风控人员提供实时的市场体温计和风险雷达。通过对北向资金、两融杠杆、龙虎榜博弈、波动率等核心数据的量化分析，识别资金异常流动，提前预警潜在的流动性风险或情绪反转。

**所有数据查询必须使用 `上游外部金融数据服务` 服务**。

## 核心监控维度

### 1. 北向资金 (Northbound Capital) - "聪明钱"
* **监控指标**: 沪股通/深股通净流入、累计净流入、前十大成交活跃股。
* **预警信号**:
  * 🔴 **外资大幅流出**: 单日净流出 > 50 亿元，或连续 3 日净流出。
  * 🟡 **背离信号**: 指数上涨但北向资金持续流出（诱多嫌疑）。
  * 🟢 **外资持续流入**: 单日净流入 > 80 亿元，或连续 3 日流入。

### 2. 两融数据 (Margin Trading) - "杠杆情绪"
* **监控指标**: 融资余额、融券余额、融资买入额占比、融资偿还额。
* **预警信号**:
  * 🔴 **杠杆过热**: 融资余额单日增幅 > 1.5%，或融资买入占比突破历史高位。
  * 🟡 **去杠杆风险**: 融资余额连续下降，或融券余额异常激增（做空力量抬头）。
  * 🟢 **杠杆温和回升**: 融资余额稳步增长，配合指数上涨（良性上涨）。

### 3. 龙虎榜 (Dragon Tiger List) - "主力博弈"
* **监控指标**: 机构席位净买卖、知名游资动向、净买入/卖出前五名个股。
* **预警信号**:
  * 🔴 **机构出货**: 核心高位股出现机构大额净卖出（> 2 亿元）。
  * 🟡 **游资退潮**: 连板股炸板率飙升，龙虎榜显示知名游资锁仓失败或大幅砸盘。
  * 🟢 **机构加仓**: 低位绩优股出现机构大额净买入。

### 4. 波动率与情绪 (Volatility & Sentiment) - "市场恐慌度"
* **监控指标**: 中国波指 (iVIX)、上证 50 期权隐含波动率、涨跌停家数比、炸板率、全市场成交额。
* **预警信号**:
  * 🔴 **恐慌蔓延**: 波动率急剧上升，跌停家数 > 20 家。
  * 🟡 **变盘前兆**: 波动率处于历史极低位，成交量极度萎缩。
  * 🟢 **情绪回暖**: 涨停家数 > 50 家，炸板率 < 20%。

## 数据采集指引 (上游外部金融数据服务 工具映射)

**所有数据必须通过 `上游外部金融数据服务` 服务获取**，具体工具调用如下：

### 北向资金/沪深港通
```
上游工具命令 上游外部金融数据服务 HSGTTradeStats --body '{"tradeDate": "交易日期"}'

## 执行流程

1. **数据采集**:
   * 使用 `HSGTTradeStats` 获取北向资金流向数据
   * 使用 `MarginTradeStats` 获取两融余额及变动
   * 使用 `DailyStockHeroDetails` 获取龙虎榜机构与游资动向
   * 使用 `MarketLimitUpDownCount` 获取涨跌停家数与情绪指标
   * 使用 `StockMarketTradeStats` 获取全市场成交额与量能变化
   * 使用 `StockMarketCapitalFlow` 获取整体资金流向
   * 使用 `StockRiskAnalysis` 获取波动率与风险指标

2. **信号计算与判定**:
   * 将获取的数据与预设阈值进行比对
   * 识别异常变动（如：北向资金尾盘突然跳水、某板块两融余额激增）
   * 计算**综合情绪得分** (0-100 分)：
     * 0-20: 极度恐慌 (冰点)
     * 20-40: 偏冷
     * 40-60: 中性
     * 60-80: 偏暖
     * 80-100: 极度贪婪 (过热)

3. **报告生成**:
   * 使用 Markdown 格式生成结构化报告
   * 包含：**风险仪表盘**、**异常信号汇总**、**分项深度解析**、**情绪评分**、**交易建议**

## 注意事项

* **数据源唯一性**: 所有市场情绪与资金数据必须通过 `上游外部金融数据服务` 服务获取，确保数据权威性
* **数据时效性**: 明确标注数据截止时间（如"截至 15:00 收盘"或"盘中实时 14:30"）
* **阈值动态调整**: 根据市场整体水位（牛市/熊市/震荡市）动态调整预警阈值
* **交叉验证**: 单一指标可能存在噪音，需结合多指标（如北向流出 + 指数下跌 + 放量）确认风险信号
* **工具调用规范**: 调用 上游外部金融数据服务 工具时，日期格式需符合 API 要求（如 YYYY-MM-DD）
