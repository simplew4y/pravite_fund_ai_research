---
name: dianjin_investment_advisor_stock_fund_analysis
description: "股票资金流向分析技能。专业诊断主力资金流向、北向/机构资金、量能换手率、资金趋势与筹码集中度四大核心维度，客观判断资金认可度与进出意图。当用户询问股票资金流向、主力资金、北向资金、机构持仓、筹码分布、量价关系、资金面分析、个股资金诊断时使用。即使用户没有明确说\"资金分析\"，只要涉及股票资金面研判就应触发。"
version: 0.1.0
category: dianjin_finance
---

# 股票资金分析技能

> Adapted from `DianJin-SKILLS/investment-advisor/stock-fund-analysis` at `fd9b51167d65`. The exact upstream text is retained in `references/UPSTREAM_SKILL.md` for review.

## FinSagent execution boundary

- Treat this package as an analysis workflow, not as authorization to call tools.
- Use only evidence already returned by the active dataset's Evidence Fusion pipeline.
- Never broaden company or document scope and never mix another company's evidence.
- Upstream tool names, shell commands, web search, databases, and message actions are unavailable unless the FinSagent runtime explicitly supplies an audited adapter.
- Preserve metric qualifiers, periods, units, currencies, actual/estimate labels, source document IDs, pages, and chunk citations.
- If required evidence is absent or conflicting, state the gap; do not estimate, fabricate, or silently substitute public data.
- Recommendations, ratings, target prices, compliance decisions, or high-risk actions require human review.

## Adapted workflow

# 股票资金分析技能

## 概述

本技能专注于**股票资金面分析**，通过四大核心维度对个股或板块的资金动向进行系统性诊断，帮助判断主力资金意图与市场认可度。

**重要原则：本技能仅提供资金面客观数据分析，不构成任何投资建议。所有分析结论均需结合基本面、技术面、消息面综合判断。**

## 四大核心分析维度

### 维度一：主力资金流向诊断

追踪大资金进出轨迹，识别主力控盘程度与操作意图。

#### 数据采集

使用 `上游外部金融数据服务` 服务获取以下数据：

| 工具 | 用途 | 查询参数 |
|------|------|----------|
| `RealStockFundFlow` | 实时资金流向 | 股票名称或代码 |
| `AStockCashFlow` | 历史资金流向+北向资金 | 股票名称或代码 |
| `StockBlockTrade` | 大宗交易明细 | 股票名称或代码 |
| `DailyStockHeroDetails` | 龙虎榜当日明细 | 股票名称或代码 |
| `RangeStockHeroStatistics` | 龙虎榜区间统计 | 股票名称或代码 + 时间区间 |

#### 分析要点

**资金流向判断标准：**
- **主力净流入持续为正**：资金持续流入，主力可能处于建仓或拉升阶段
- **主力净流出持续为负**：资金持续流出，主力可能处于派发或减仓阶段
- **北向资金与主力资金同向**：内外资共振，信号较强
- **北向资金与主力资金背离**：需警惕，可能是诱多或诱空信号
- **大宗交易折价成交**：通常视为利空，可能是股东减持或机构调仓
- **大宗交易溢价成交**：通常视为利好，可能是机构抢筹

**龙虎榜解读：**
- 机构专用席位买入为主 → 机构看好，中线逻辑
- 游资营业部频繁上榜 → 短线博弈，波动加大
- 买一金额远大于卖一 → 主力控盘度提升
- 买卖金额接近 → 分歧较大，方向不明

### 维度二：北向资金与机构资金分析

追踪"聪明钱"动向，识别机构持仓变化趋势。

## 注意事项

1. **数据时效性**：资金流向数据具有较强时效性，分析时应注明数据截止日期
2. **多维度交叉验证**：单一维度信号可能存在误导，需多维度交叉验证
3. **结合基本面**：资金面分析需结合公司基本面、行业趋势综合判断
4. **警惕异常波动**：对于换手率异常、资金流向剧烈波动的股票，应提示风险
5. **不构成投资建议**：所有分析结论仅供参考，不构成买卖建议
