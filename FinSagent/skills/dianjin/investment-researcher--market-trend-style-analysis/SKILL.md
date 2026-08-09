---
name: dianjin_investment_researcher_market_trend_style_analysis
description: "证券策略市场大势与风格研判技能。适用于策略研究员进行市场方向判断和风格配置。基于量价、资金、情绪及宏观数据，输出大势研判（牛/熊/震荡）、风格强弱排序（成长/价值/大盘/小盘）及仓位建议，生成标准化 Markdown 策略报告。当用户要求分析市场大势、判断市场方向、进行风格配置、评估仓位时使用，包括\"市场大势分析\"、\"当前市场怎么样\"、\"风格怎么配\"、\"现在该买大盘还是小盘\"、\"成长和价值哪个强\"、\"市场趋势研判\"、\"仓位建议\"等表述。即使用户只说\"看看大盘\"、\"市场怎么样\"、\"现在什么风格\"等简短表述也要触发。本技能自动通过 上游外部金融数据服务 专业金融数据服务获取核心数据，进行量价与逻辑"
version: 0.1.0
category: dianjin_finance
---

# 市场大势与风格研判 (Market Trend & Style Analysis)

> Adapted from `DianJin-SKILLS/investment-researcher/market-trend-style-analysis` at `fd9b51167d65`. The exact upstream text is retained in `references/UPSTREAM_SKILL.md` for review.

## FinSagent execution boundary

- Treat this package as an analysis workflow, not as authorization to call tools.
- Use only evidence already returned by the active dataset's Evidence Fusion pipeline.
- Never broaden company or document scope and never mix another company's evidence.
- Upstream tool names, shell commands, web search, databases, and message actions are unavailable unless the FinSagent runtime explicitly supplies an audited adapter.
- Preserve metric qualifiers, periods, units, currencies, actual/estimate labels, source document IDs, pages, and chunk citations.
- If required evidence is absent or conflicting, state the gap; do not estimate, fabricate, or silently substitute public data.
- Recommendations, ratings, target prices, compliance decisions, or high-risk actions require human review.

## Adapted workflow

# 市场大势与风格研判 (Market Trend & Style Analysis)

## 概述

本技能专为**证券策略研究员**设计，旨在提供系统化的**市场大势研判**与**风格配置建议**。通过综合分析量价趋势、流动性环境、市场情绪及宏观因子，量化评估市场状态，输出明确的指数方向判断、风格强弱排序及动态仓位建议，辅助投资决策。

**所有数据查询必须使用 `上游外部金融数据服务` 服务**。

## 核心分析框架

### 1. 大势研判模型 (Trend & Direction)
*   **量价趋势**: 均线系统（多头/空头排列）、关键支撑/阻力位、量价配合（放量上涨/缩量下跌）。
*   **流动性**: 宏观流动性（M1/M2 剪刀差、社融增速）、微观流动性（北向资金、ETF 申赎、两融余额）。
*   **情绪周期**: 换手率、新增开户数、股票型公募基金发行量、期权隐含波动率 (IV)。
*   **研判结论**: 🟢 牛市/上涨趋势，🟡 震荡市/结构性行情，🔴 熊市/下跌趋势。

### 2. 风格强弱排序 (Style Rotation)
*   **大盘 vs 小盘**:
    *   **逻辑**: 信用扩张期利好小盘（流动性充裕），信用收缩期利好大盘（确定性溢价）。
    *   **指标**: 信用脉冲、利率走势、微盘股流动性风险。
*   **成长 vs 价值**:
    *   **逻辑**: 利率下行/盈利复苏利好成长，利率上行/滞胀利好价值（红利）。
    *   **指标**: 10 年期国债收益率、盈利增速差（成长 - 价值）、风险偏好。
*   **风格矩阵**:
    *   大盘价值 (红利/金融)
    *   大盘成长 (茅指数/核心资产)
    *   小盘价值 (周期/资源)
    *   小盘成长 (科创/微盘)

### 3. 仓位管理模型 (Position Sizing)
*   **评分系统**: 综合大势、风格、风险指标得出 0-100 分。
*   **仓位映射**:
    *   **80-100 分 (高仓位)**: 趋势向上 + 流动性宽松 + 情绪回暖 -> 建议仓位 **70-100%**
    *   **50-80 分 (中仓位)**: 震荡市 + 结构性机会 -> 建议仓位 **40-70%**
    *   **0-50 分 (低仓位)**: 趋势向下 + 流动性收紧 + 情绪冰点 -> 建议仓位 **0-40%**

## 数据采集指引 (上游外部金融数据服务 工具映射)

**所有数据必须通过 `上游外部金融数据服务` 服务获取**，具体工具调用如下：

### 指数行情与技术面
```
上游工具命令 上游外部金融数据服务 IndexLiveQuote --body '{"indexCode": "指数代码"}'
```
获取 A 股指数实时行情，包括价量、涨跌幅、委比等指标。

## 执行流程

1.  **数据采集**:
    *   使用 `IndexDailyQuote` / `IndexRangeQuotation` 获取主要指数（上证、深成、创业板、沪深 300、中证 500、中证 1000）行情数据
    *   使用 `IndexQuoteTecIndicators` 获取指数技术指标（均线、MACD 等）
    *   使用 `IndexValueAnalysis` 获取主要指数估值及历史分位
    *   使用 `HSGTTradeStats` 获取北向资金流向
    *   使用 `MarginTradeStats` 获取两融余额变化
    *   使用 `StockMarketTradeStats` 获取全市场成交额与量能
    *   使用 `MarketLimitUpDownCount` 获取涨跌停家数
    *   使用 `SectorRank` / `SectorFundFlowRank` 获取行业板块涨跌幅与资金流向排序
    *   使用 `MacroIndustryEDB` 获取宏观流动性数据（M1、M2、社融等）
    *   使用 `MacroeconomicAnalysisViewpoints` 获取宏观分析观点

2.  **模型分析与打分**:
    *   运用上述框架对市场进行多维诊断
    *   计算大势评分与风格偏好得分

3.  **逻辑推演**:
    *   结合宏观背景（如美林时钟位置、政策周期）解释当前市场状态
    *   预判未来 1-3 个月的市场走势及风格切换可能性

4.  **报告生成**:
    *   生成 Markdown 格式的策略研判报告，数据需注明来源和截止日期

## 注意事项

*   **数据源唯一性**: 所有市场大势与风格相关数据必须通过 `上游外部金融数据服务` 服务获取，确保数据权威性和一致性
*   **数据时效性**: 必须使用最新的市场数据进行分析，并在报告中标注数据日期
*   **逻辑自洽**: 大势判断与仓位建议必须匹配（例如：判断为熊市趋势，仓位建议不应过高）
*   **动态调整**: 风格研判需结合宏观环境变化（如降息、政策转向）及时调整
*   **风险提示**: 明确指出可能导致研判失效的极端情况（黑天鹅）
*   **工具调用规范**: 调用 上游外部金融数据服务 工具时，指数代码、行业代码需使用标准代码，日期格式需符合 API 要求
