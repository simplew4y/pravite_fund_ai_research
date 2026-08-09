---
name: dianjin_investment_researcher_global_macro_linkage
description: "海外宏观联动分析技能。当用户要求分析海外宏观数据、美联储政策、美国经济对国内影响、中美联动、外资流向、汇率波动对 A 股债市影响时使用。包括“分析美联储最新决议影响”、“美国经济衰退对中国影响”、“中美宏观联动分析”、“海外宏观周报”、“外资流向分析”、“汇率波动对资产影响”等表述。本技能自动跟踪海外核心宏观指标与政策动态，分析其通过汇率、贸易、情绪、通胀等渠道对国内经济和资本市场的传导影响，输出结构化 Markdown 联动分析简报。"
version: 0.1.0
category: dianjin_finance
---

# 海外宏观联动分析技能

> Adapted from `DianJin-SKILLS/investment-researcher/global-macro-linkage` at `fd9b51167d65`. The exact upstream text is retained in `references/UPSTREAM_SKILL.md` for review.

## FinSagent execution boundary

- Treat this package as an analysis workflow, not as authorization to call tools.
- Use only evidence already returned by the active dataset's Evidence Fusion pipeline.
- Never broaden company or document scope and never mix another company's evidence.
- Upstream tool names, shell commands, web search, databases, and message actions are unavailable unless the FinSagent runtime explicitly supplies an audited adapter.
- Preserve metric qualifiers, periods, units, currencies, actual/estimate labels, source document IDs, pages, and chunk citations.
- If required evidence is absent or conflicting, state the gap; do not estimate, fabricate, or silently substitute public data.
- Recommendations, ratings, target prices, compliance decisions, or high-risk actions require human review.

## Adapted workflow

# 海外宏观联动分析技能

## 概述

本技能模拟证券宏观研究员的海外研究视角，自动抓取全球核心宏观数据与政策动态，深入剖析海外经济对中国宏观经济、货币政策及资本市场的多维传导路径，输出专业的**海外 - 国内宏观联动分析简报**。

## 数据获取策略

### 核心数据源：上游外部金融数据服务

所有宏观数据、政策、资金流向、行情及舆情数据均优先通过 `上游外部金融数据服务` 服务获取。

| 数据需求 | 推荐工具 | 说明 |
|---------|---------|------|
| **海外/国内宏观数据** | `MacroIndustryEDB` | 查询国际宏观（美/欧/日 GDP、CPI、PMI、非农等）及中国宏观经济指标 |
| **海外政策/央行** | `MacroIndustryEDB` + `外部联网检索` | 美联储利率决议等结构化数据通过 EDB 获取，细节纪要补充 外部联网检索 |
| **国内政策会议** | `PolicyMeetingsList` | 国内经济金融领域政策会议动态 |
| **官员讲话** | `OfficialSpeechEventList` | 国内外重要官员讲话 |
| **宏观舆情** | `MacroNewslist` | 宏观舆情，按区域、情感类型筛选 |
| **宏观分析观点** | `MacroeconomicAnalysisViewpoints` | 研报中对宏观维度的分析观点 |
| **北向资金/外资** | `HSGTTradeStats` | 沪深港通市场交易统计（北向资金流向） |
| **资金流向** | `StockMarketCapitalFlow` | 股票市场资金流入流出统计 |
| **汇率/利率** | `MacroIndustryEDB` + `MostActiveRateBondQuotation` | 汇率及中美利差数据通过 EDB 获取，国内活跃券收益率通过债券工具获取 |
| **指数行情** | `IndexRangeQuotation` | A 股指数行情 |

### 数据获取优先级

1.  **宏观数据（含海外）**：优先 `上游外部金融数据服务 MacroIndustryEDB`（支持国际宏观数据库查询）
2.  **资金与行情**：优先 `上游外部金融数据服务` (HSGTTradeStats, StockMarketCapitalFlow, MostActiveRateBondQuotation)
3.  **政策与舆情**：优先 `上游外部金融数据服务` (PolicyMeetingsList, MacroNewslist, MacroeconomicAnalysisViewpoints)
4.  **补充信息**：`外部联网检索` 仅用于补充海外政策细节、地缘政治突发新闻等 EDB 未覆盖内容。

## 执行流程

### 第一阶段：海外核心数据与政策扫描

1. **美国核心宏观数据**
   - **工具**：`上游外部金融数据服务 MacroIndustryEDB`
   - **查询示例**：
     ```
     调用 上游外部金融数据服务 MacroIndustryEDB
     query: "美国 GDP CPI PMI 非农就业 零售销售"
     time_range: "最近 3 个月"
     ```
   - **增长**：GDP（季调环比/同比）、ISM 制造业/服务业 PMI、零售销售、个人消费支出。

## 执行流程

## 注意事项

- **上游外部金融数据服务 优先**：所有国内宏观数据、政策、资金、行情查询优先使用 `上游外部金融数据服务` 服务，海外宏观数据同样优先通过其国际宏观数据库（EDB）获取。
- **数据时效性**：优先使用最新发布的海外数据（如非农、CPI 公布当日），注明数据发布时间。
- **逻辑严谨性**：传导分析必须建立在经济学逻辑之上，避免简单线性外推，考虑二阶效应。
- **概率思维**：海外经济充满不确定性，使用情景分析（软着陆/硬着陆）而非单一结论。
- **国内视角**：始终落脚于“对中国的影响”，强调“以我为主”的政策定力与资产韧性。
- **跨境联动**：关注离岸/在岸汇率价差、北向资金流向、中美利差倒挂程度等高频指标。
