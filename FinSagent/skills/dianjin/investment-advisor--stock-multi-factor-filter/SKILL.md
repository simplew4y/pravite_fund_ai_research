---
name: dianjin_investment_advisor_stock_multi_factor_filter
description: "通过自然语言查询进行 A 股股票筛选技能，支持行情指标、技术形态、财务指标、行业概念等多条件组合筛选。返回符合条件的相关股票数据。当用户询问针对行情、财务数据、技术指标、行业概念等 A 股股票筛选相关问题时，必须使用此技能。"
version: 0.1.0
category: dianjin_finance
---

# A 股智能选股技能

> Adapted from `DianJin-SKILLS/investment-advisor/stock-multi-factor-filter` at `fd9b51167d65`. The exact upstream text is retained in `references/UPSTREAM_SKILL.md` for review.

## FinSagent execution boundary

- Treat this package as an analysis workflow, not as authorization to call tools.
- Use only evidence already returned by the active dataset's Evidence Fusion pipeline.
- Never broaden company or document scope and never mix another company's evidence.
- Upstream tool names, shell commands, web search, databases, and message actions are unavailable unless the FinSagent runtime explicitly supplies an audited adapter.
- Preserve metric qualifiers, periods, units, currencies, actual/estimate labels, source document IDs, pages, and chunk citations.
- If required evidence is absent or conflicting, state the gap; do not estimate, fabricate, or silently substitute public data.
- Recommendations, ratings, target prices, compliance decisions, or high-risk actions require human review.

## Adapted workflow

# A 股智能选股技能

## 概述
本技能专注于**多维度 A 股股票筛选**。通过整合市场行情、技术形态、财务基本面、行业概念及资金流向等数据，帮助用户快速从数千只股票中精准定位符合特定投资逻辑的标的。

## 数据工具集 (上游外部金融数据服务)

| 工具名称 | 核心作用 | 关键参数 |
|----------|----------|----------|
| `StockMultipleFactorFilter` | **智能选股** | 接收自然语言查询，返回符合多条件筛选的股票列表 |

## 核心筛选维度

### 1. 行情与量价指标
*   **涨跌幅**：今日/近期涨幅、跌幅、连板天数。
*   **量价关系**：放量突破、缩量回调、量价齐升。
*   **市值规模**：总市值、流通市值（大盘/中盘/小盘/微盘）。
*   **价格区间**：股价高低、创历史新高/新低。

### 2. 技术形态与指标
*   **均线系统**：多头排列、站上/跌破均线（MA5/MA20/MA60）。
*   **技术指标**：MACD 金叉/死叉、KDJ 超买/超卖、RSI 强弱。
*   **形态特征**：突破压力位、回踩支撑位、底部放量。

### 3. 财务与估值指标
*   **盈利能力**：ROE、毛利率、净利率、净利润增长率。
*   **估值水平**：市盈率 (PE)、市净率 (PB)、股息率。
*   **财务健康**：资产负债率、现金流状况。

### 4. 行业与概念题材
*   **行业板块**：申万/中信行业分类（如半导体、新能源、医药）。
*   **概念题材**：热点概念（如人工智能、低空经济、华为产业链）。
*   **市场风格**：高股息/红利、专精特新、中字头、国企改革。

### 5. 资金与筹码
*   **资金流向**：主力资金净流入、北向资金增持。
*   **筹码结构**：股东户数减少、机构重仓。

## 工作流程

1.  **意图识别**：从用户自然语言中提取筛选条件（如“PE 小于 20 且 ROE 大于 15% 的半导体股票”）。
2.  **构建查询**：将提取的条件组合成自然语言查询语句。
3.  **调用工具**：调用 `StockMultipleFactorFilter` 获取筛选结果。
4.  **结果解析**：解析返回的股票列表，提取关键指标（代码、名称、现价、涨跌幅、核心筛选指标值）。
5.  **生成报告**：输出结构化的选股结果表格，并附带简要的投资逻辑分析。

## 工作流程

1.  **意图识别**：从用户自然语言中提取筛选条件（如“PE 小于 20 且 ROE 大于 15% 的半导体股票”）。
2.  **构建查询**：将提取的条件组合成自然语言查询语句。
3.  **调用工具**：调用 `StockMultipleFactorFilter` 获取筛选结果。
4.  **结果解析**：解析返回的股票列表，提取关键指标（代码、名称、现价、涨跌幅、核心筛选指标值）。
5.  **生成报告**：输出结构化的选股结果表格，并附带简要的投资逻辑分析。

## 报告输出模板

```markdown
