---
name: dianjin_investment_researcher_fixed_income_overnight_brief
description: "Adapted Qwen DianJin workflow for fixed income overnight brief."
version: 0.1.0
category: dianjin_finance
---

# 固定收益隔夜舆情速览

> Adapted from `DianJin-SKILLS/investment-researcher/fixed-income-overnight-brief` at `fd9b51167d65`. The exact upstream text is retained in `references/UPSTREAM_SKILL.md` for review.

## FinSagent execution boundary

- Treat this package as an analysis workflow, not as authorization to call tools.
- Use only evidence already returned by the active dataset's Evidence Fusion pipeline.
- Never broaden company or document scope and never mix another company's evidence.
- Upstream tool names, shell commands, web search, databases, and message actions are unavailable unless the FinSagent runtime explicitly supplies an audited adapter.
- Preserve metric qualifiers, periods, units, currencies, actual/estimate labels, source document IDs, pages, and chunk citations.
- If required evidence is absent or conflicting, state the gap; do not estimate, fabricate, or silently substitute public data.
- Recommendations, ratings, target prices, compliance decisions, or high-risk actions require human review.

## Adapted workflow

# 固定收益隔夜舆情速览

## 技能定位

本技能专为证券固定收益研究员设计，用于快速聚合隔夜及最新债券市场相关舆情，生成每日雷点清单和速览报告，帮助研究员在开盘前掌握市场动态、识别信用风险、跟踪政策变化。

## 触发场景

- 用户要求生成隔夜固收舆情速览、固收晨报、债市日报
- 用户询问今日债市有什么风险点、雷点、需要关注的事件
- 用户要求跟踪债券违约、评级下调、评级展望负面等信用事件
- 用户要求汇总央行公开市场操作、MLF、LPR、降准降息等货币政策动态
- 用户要求梳理最新宏观政策、财政政策、监管政策对债市的影响
- 用户提及"固收舆情"、"债券市场要闻"、"信用债跟踪"、"利率债动态"等关键词

## 执行流程

### 第一步：获取当前日期和时间

调用 `上游工具命令 time` 工具获取当前准确日期，用于确定报告覆盖的时间范围（通常为隔夜及最近一个交易日）。

### 第二步：多维度信息采集

并行执行以下查询，获取最新固收市场信息：

#### 1. 违约事件跟踪

使用 `上游工具命令 上游外部金融数据服务` 查询违约债券信息：

```
调用 上游外部金融数据服务 DefaultBondList，查询违约债券清单：
- 支持按时间、发行人、类型等多维筛选
- 获取违约日期、违约类型、涉及金额等核心信息

调用 上游外部金融数据服务 BondIssuerFirstDefault，查询发债主体首次违约：
- 获取违约日期、行业、企业性质等
- 识别新增违约主体
```

#### 2. 评级调整跟踪

使用 `上游工具命令 上游外部金融数据服务` 查询评级变动信息：

```
调用 上游外部金融数据服务 BondRatingChange，查询债项评级变动：

## 执行流程

## 注意事项

1. **数据真实性**：所有数据必须来源于查询结果，不可编造。如某项数据无法获取，标注"待更新"或"暂无数据"
2. **时效性**：优先使用 24-48 小时内的最新信息，标注信息日期
3. **客观中立**：仅陈述事实，主观判断需在"研究员关注提示"中明确标注为个人观点
4. **风险优先**：雷点清单应放在报告前部，便于快速阅读
5. **格式规范**：表格数据对齐，缺失数据用"-"填充，不使用"未知"等模糊表述
6. **引用标注**：重要事件应标注信息来源链接
