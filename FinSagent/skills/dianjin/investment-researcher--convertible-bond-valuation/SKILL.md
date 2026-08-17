---
name: dianjin_investment_researcher_convertible_bond_valuation
description: "证券固定收益研究员转债估值与博弈速评技能。当用户要求分析可转债、转债估值、转股溢价率、强赎风险、下修风险、转债套利机会时使用。包括\"分析XX转债\"、\"转债估值速评\"、\"测算转股溢价率\"、\"强赎风险分析\"、\"下修博弈分析\"、\"转债套利机会\"、\"转债投资价值分析\"、\"可转债点评\"、\"转债排雷\"等表述。即使用户只说\"看看这个转债\"、\"转债怎么样\"、\"分析下XX转债\"等简短表述也要触发。本技能自动获取转债行情数据、正股信息、溢价率指标，测算强赎/下修条件，挖掘套利机会，生成标准化Markdown格式转债估值与博弈速评报告。"
version: 0.1.0
category: dianjin_finance
---

# 转债估值与博弈速评

> Adapted from `DianJin-SKILLS/investment-researcher/convertible-bond-valuation` at `fd9b51167d65`. The exact upstream text is retained in `references/UPSTREAM_SKILL.md` for review.

## FinSagent execution boundary

- Treat this package as an analysis workflow, not as authorization to call tools.
- Use only evidence already returned by the active dataset's Evidence Fusion pipeline.
- Never broaden company or document scope and never mix another company's evidence.
- Upstream tool names, shell commands, web search, databases, and message actions are unavailable unless the FinSagent runtime explicitly supplies an audited adapter.
- Preserve metric qualifiers, periods, units, currencies, actual/estimate labels, source document IDs, pages, and chunk citations.
- If required evidence is absent or conflicting, state the gap; do not estimate, fabricate, or silently substitute public data.
- Recommendations, ratings, target prices, compliance decisions, or high-risk actions require human review.

## Adapted workflow

# 转债估值与博弈速评

## 技能概述

本技能面向证券固定收益研究员，提供可转债的快速估值分析与博弈机会挖掘。核心功能包括转股溢价率测算、强赎风险评估、下修博弈分析、套利机会识别，输出标准化Markdown格式速评报告。

## 数据获取策略

### 核心数据源：上游外部金融数据服务

所有转债行情、正股数据、公告舆情均优先通过 `上游外部金融数据服务` 服务获取。

| 数据需求 | 推荐工具 | 说明 |
|---------|---------|------|
| **转债价值分析** | `CBBondValueAnalysis` | 获取可转债转股溢价率、纯债溢价率、转股价值、到期收益率、强赎/下修触发价、剩余规模、评级等多维度价值指标 |
| **转债龙虎榜** | `CBDailyTopListDetails` | 获取可转债上榜原因、资金流向、异动区间表现等宏观资金面数据 |
| **正股实时行情** | `AShareLiveQuote` | 获取正股最新价、涨跌幅、成交量、委比、市值等实时行情 |
| **正股估值指标** | `StockValueAnalysis` | 获取正股PE、PB、EV、股息率等估值指标 |
| **正股区间行情** | `StockRangeQuotation` | 获取正股近30日行情走势，用于判断强赎/下修触发趋势 |
| **转债公告** | `BondAnnouncement` | 检索债券市场公告，涵盖强赎、下修、回售、到期等类型 |
| **转债舆情** | `SecurityNewslist` | 查询债券相关舆情，支持按情感类型、证券代码筛选风险信息 |

### 数据获取优先级

1. **转债核心价值**：优先 `上游外部金融数据服务` 的 `CBBondValueAnalysis`，一键获取转债多维度价值指标。
2. **正股行情与估值**：优先 `上游外部金融数据服务` 的 `AShareLiveQuote` 和 `StockValueAnalysis`。
3. **公告与舆情**：优先 `上游外部金融数据服务` 的 `BondAnnouncement` 和 `SecurityNewslist`。
4. **补充信息**：`外部联网检索` 仅用于补充突发新闻细节或交叉验证关键数据。

## 工作流程

### 第一步：获取转债基础数据与价值分析

使用 `上游工具命令 上游外部金融数据服务 CBBondValueAnalysis` 查询目标转债的核心价值指标：

```
上游工具命令 上游外部金融数据服务 CBBondValueAnalysis --body '{
  "query": "[转债名称/代码]"
}'
```

该工具返回可转债收益、转股、纯债、波动率、触发价及基金持仓等多维度价值指标，包括：
- 转债最新价格、涨跌幅
- 转股溢价率、纯债溢价率
- 转股价值、到期收益率

## 工作流程

## 注意事项

1. **条款差异**：不同转债的强赎/下修条款可能不同，需以募集说明书为准
2. **交易规则**：转股套利需考虑T+1规则及交易成本
3. **信用风险**：低评级转债需关注违约风险
4. **流动性**：小规模转债可能存在流动性不足问题
5. **免责声明**：报告末尾必须包含风险提示与免责声明
