---
name: dianjin_investment_researcher_valuation_prosperity_tracking
description: "证券策略行业估值与景气度跟踪技能。适用于策略研究员进行行业比较和轮动决策。自动获取并分析行业估值分位、高频景气数据，对比历史数据，预警估值泡沫与景气拐点，生成标准化 Markdown 跟踪报告。"
version: 0.1.0
category: dianjin_finance
---

# 行业估值与景气跟踪 (Valuation & Prosperity Tracking)

> Adapted from `DianJin-SKILLS/investment-researcher/valuation-prosperity-tracking` at `fd9b51167d65`. The exact upstream text is retained in `references/UPSTREAM_SKILL.md` for review.

## FinSagent execution boundary

- Treat this package as an analysis workflow, not as authorization to call tools.
- Use only evidence already returned by the active dataset's Evidence Fusion pipeline.
- Never broaden company or document scope and never mix another company's evidence.
- Upstream tool names, shell commands, web search, databases, and message actions are unavailable unless the FinSagent runtime explicitly supplies an audited adapter.
- Preserve metric qualifiers, periods, units, currencies, actual/estimate labels, source document IDs, pages, and chunk citations.
- If required evidence is absent or conflicting, state the gap; do not estimate, fabricate, or silently substitute public data.
- Recommendations, ratings, target prices, compliance decisions, or high-risk actions require human review.

## Adapted workflow

# 行业估值与景气跟踪 (Valuation & Prosperity Tracking)

## 概述

本技能专为**证券策略研究员**设计，旨在提供系统化的**行业估值分位监控**与**高频景气度跟踪**。通过实时采集与分析多维数据，识别行业性价比，预警估值泡沫与景气拐点，辅助行业配置与轮动决策。

**所有数据查询必须使用 `上游外部金融数据服务` 服务**。

## 核心分析框架

### 1. 估值跟踪模型 (Valuation Monitoring)
*   **绝对估值**: PE (TTM)、PB (MRQ)。
*   **相对估值**: 历史分位数 (1年、3年、5年、10年)，风险溢价 (ERP)。
*   **泡沫预警**:
    *   🟢 **低估区**: 分位 < 20% (安全边际高)
    *   🟡 **合理区**: 20% <= 分位 <= 80%
    *   🔴 **高估/泡沫区**: 分位 > 80% (警惕回撤风险)
    *   📉 **极度泡沫**: 分位 > 95% (强烈建议减仓)

### 2. 景气度跟踪模型 (Prosperity Tracking)
*   **量价指标**:
    *   **价格**: 大宗商品价格 (铜、铝、原油、煤炭)、产品价格 (化工品、建材、面板等)、运价指数 (集运、干散货)。
    *   **销量/开工率**: 汽车销量、挖掘机开工小时数、高炉开工率、房地产销售面积等。
*   **盈利预期**: 分析师一致预期净利润增速变化 (上调/下调家数占比)。
*   **拐点预警**:
    *   📈 **景气上行**: 核心指标连续 2 期环比上升，或同比由负转正。
    *   📉 **景气下行**: 核心指标连续 2 期环比下降，或跌破长期均线。
    *   ⚠️ **背离信号**: 估值高位 + 景气下行 (卖出信号)；估值低位 + 景气上行 (买入信号)。

### 3. 行业性价比评分 (Value-for-Money Scoring)
*   **评分公式**: 综合得分 = (景气度得分 * 0.6) + (估值性价比得分 * 0.4)
*   **矩阵分类**:
    *   🌟 **双优 (高景气 + 低估值)**: 核心超配方向
    *   💎 **低估值 + 景气改善**: 潜在反转机会
    *   ⚠️ **高估值 + 景气恶化**: 坚决回避
    *   📦 **高景气 + 高估值**: 需警惕业绩兑现不及预期

## 数据采集指引 (上游外部金融数据服务 工具映射)

**所有数据必须通过 `上游外部金融数据服务` 服务获取**，具体工具调用如下：

### 行业估值分析
```
上游工具命令 上游外部金融数据服务 IndustryValuation --body '{"industryCode": "行业代码", "tradeDate": "交易日期"}'
```

## 执行流程

1.  **数据采集**:
    *   使用 `IndustryValuation` 获取全行业最新估值数据 (PE, PB, 分位数)。
    *   使用 `SectorRank` 获取行业近期涨跌幅排名。
    *   使用 `SectorFundFlowRank` 获取行业资金流向排名。
    *   使用 `MacroIndustryEDB` 获取各行业核心高频景气指标 (价格、销量、开工率等)。
    *   使用 `IndustryAnalysisViewpoints` 获取各行业最新分析师观点与盈利预测调整方向。
2.  **数据清洗与计算**:
    *   计算估值历史分位。
    *   计算景气指标环比、同比增速。
    *   识别异常值与拐点信号。
3.  **预警与信号生成**:
    *   生成“估值泡沫预警名单” (分位 > 90%)。
    *   生成“景气恶化预警名单” (核心指标连续下滑)。
    *   生成“景气反转信号名单” (底部企稳回升)。
4.  **报告生成**:
    *   生成 Markdown 格式的估值与景气跟踪报告。

## 注意事项

*   **数据源唯一性**: 所有行业估值、景气指标、资金流向及分析师观点必须通过 `上游外部金融数据服务` 服务获取，确保数据权威性和一致性。
*   **高频数据代表性**: 选择对行业盈利影响最直接的核心指标 (如白酒的批价、化工的价差、光伏的硅料价格)。
*   **动态阈值**: 估值分位的阈值可根据市场整体水位动态调整 (如全市场低估值时，80% 分位可能才是泡沫线)。
*   **逻辑一致性**: 估值与景气的背离是重点分析对象 (如戴维斯双击/双杀)。
*   **工具调用规范**: 调用 `上游外部金融数据服务` 工具时，行业代码需使用标准代码，日期格式需符合 API 要求。
