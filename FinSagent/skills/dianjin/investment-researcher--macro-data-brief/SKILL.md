---
name: dianjin_investment_researcher_macro_data_brief
description: "宏观经济数据解读与市场分析技能。当用户要求生成宏观数据解读、宏观经济简报、当日经济数据点评、宏观数据对股债影响分析、经济数据速评时使用。包括\"今日宏观数据解读\"、\"XX月经济数据点评\"、\"宏观数据对股市影响\"、\"生成宏观数据简报\"、\"最新PMI/CPI/社融数据解读\"等表述。本技能自动搜索当日或最新发布的中国核心宏观经济数据（PMI、CPI、PPI、社融、M2、进出口、工业增加值、固定资产投资、社零等），对比市场预期值，解读数据含义与预期偏差，分析对货币政策和财政政策的传导逻辑，评估对股市、债市的即时影响，最终生成结构化的Markdown格式宏观数据解读简报。"
version: 0.1.0
category: dianjin_finance
---

# 宏观经济数据解读简报生成技能

> Adapted from `DianJin-SKILLS/investment-researcher/macro-data-brief` at `fd9b51167d65`. The exact upstream text is retained in `references/UPSTREAM_SKILL.md` for review.

## FinSagent execution boundary

- Treat this package as an analysis workflow, not as authorization to call tools.
- Use only evidence already returned by the active dataset's Evidence Fusion pipeline.
- Never broaden company or document scope and never mix another company's evidence.
- Upstream tool names, shell commands, web search, databases, and message actions are unavailable unless the FinSagent runtime explicitly supplies an audited adapter.
- Preserve metric qualifiers, periods, units, currencies, actual/estimate labels, source document IDs, pages, and chunk citations.
- If required evidence is absent or conflicting, state the gap; do not estimate, fabricate, or silently substitute public data.
- Recommendations, ratings, target prices, compliance decisions, or high-risk actions require human review.

## Adapted workflow

# 宏观经济数据解读简报生成技能

## 概述

本技能用于自动抓取中国核心宏观经济数据，进行预期对比、政策解读和市场影响分析，生成面向投资专业人士的宏观数据解读简报。

## 数据获取策略

### 核心数据源

**上游外部金融数据服务 (上游外部金融数据服务)** 作为主要数据源，提供全方位的宏观经济数据与投研分析工具：

| 数据需求 | 推荐工具 | 说明 |
|---------|---------|------|
| 宏观行业经济数据 | `MacroIndustryEDB` | PMI、CPI、PPI、社融、M2、进出口、工业增加值等 |
| 宏观分析观点 | `MacroeconomicAnalysisViewpoints` | 研报中对GDP、CPI、PMI、政策等宏观维度的分析观点 |
| 宏观舆情 | `MacroNewslist` | 宏观舆情，按区域、情感类型筛选经济预测及事件 |
| 政策会议 | `PolicyMeetingsList` | 国内经济金融领域政策会议动态及内容 |
| 官员讲话 | `OfficialSpeechEventList` | 国内外重要官员讲话及活动信息 |
| 法律法规 | `LawsRegulations` | 法律法规信息，按类型、关键词筛选 |
| 全网舆情 | `NewsInfoList` | 全网舆情，按关键词、来源、情感类型筛选 |
| 市场舆情 | `MarketNewslist` | 市场舆情，按市场类型筛选 |

### 数据获取优先级

1. **宏观核心数据**：优先 `MacroIndustryEDB` 查询 PMI、CPI、PPI、社融、M2 等
2. **宏观观点解读**：优先 `MacroeconomicAnalysisViewpoints` 获取专业分析观点
3. **宏观舆情与政策**：优先 `MacroNewslist` + `PolicyMeetingsList`
4. **网络搜索作补充**：对于市场预期值、最新政策细节等，使用 `外部联网检索` 补充

## 执行流程

### 第一阶段：数据抓取与整理

1. **搜索最新宏观数据**

   **使用 上游外部金融数据服务 查询**：
   ```
   调用 上游外部金融数据服务 MacroIndustryEDB：
   query: "PMI 制造业 非制造业 最新"
   query: "CPI PPI 通胀 最新"
   query: "社融 M2 M1 金融数据 最新"
   query: "工业增加值 固定资产投资 社零 最新"
   query: "进出口 贸易顺差 最新"
   ```

## 执行流程

## 注意事项

- **数据时效性**：优先使用最新发布的月度/季度数据，注明数据所属期（如"2026年3月数据"）
- **预期值来源**：如无法获取精确的市场共识预期，可参考主流券商研报预测或财经媒体汇总的预期区间
- **解读客观性**：数据解读应保持客观中立，避免过度推断，区分事实与观点
- **不确定性提示**：对于存在较大不确定性或数据矛盾之处，应明确提示风险
- **数据缺失处理**：如部分指标当日未发布，可在表格中标注"未发布"或跳过该指标
- **上游外部金融数据服务 优先**：所有宏观数据查询优先使用 上游外部金融数据服务 服务，外部联网检索 仅作为补充获取市场预期值
