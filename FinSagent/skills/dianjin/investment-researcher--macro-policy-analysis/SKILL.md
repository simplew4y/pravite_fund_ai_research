---
name: dianjin_investment_researcher_macro_policy_analysis
description: "宏观政策跟踪与推演分析技能。当用户要求分析最新政策、解读央行货币政策、财政政策影响、推演政策对股债市场影响、跟踪政策落地效果时使用。包括\"今日政策解读\"、\"政策对市场的影响\"、\"后续政策推演\"、\"政策跟踪分析\"、\"宏观政策简报\"、\"美联储政策影响\"、\"监管新政解读\"等表述。本技能自动抓取全球主要经济体政策动态（美联储、欧央行、海外通胀与大宗商品）、国内政策动态（央行货币政策、财政政策、监管新政）、核心宏观舆情（经济会议、官员讲话、行业政策导向），进行政策意图解读、实施路径分析、中长期影响评估，推演后续政策可能性及节奏，跟踪前期政策落地效果，最终生成结构化的Markdown格式政策推演分析报告。"
version: 0.1.0
category: dianjin_finance
---

# 宏观政策跟踪与推演分析技能

> Adapted from `DianJin-SKILLS/investment-researcher/macro-policy-analysis` at `fd9b51167d65`. The exact upstream text is retained in `references/UPSTREAM_SKILL.md` for review.

## FinSagent execution boundary

- Treat this package as an analysis workflow, not as authorization to call tools.
- Use only evidence already returned by the active dataset's Evidence Fusion pipeline.
- Never broaden company or document scope and never mix another company's evidence.
- Upstream tool names, shell commands, web search, databases, and message actions are unavailable unless the FinSagent runtime explicitly supplies an audited adapter.
- Preserve metric qualifiers, periods, units, currencies, actual/estimate labels, source document IDs, pages, and chunk citations.
- If required evidence is absent or conflicting, state the gap; do not estimate, fabricate, or silently substitute public data.
- Recommendations, ratings, target prices, compliance decisions, or high-risk actions require human review.

## Adapted workflow

# 宏观政策跟踪与推演分析技能

## 概述

本技能用于自动抓取全球及中国核心政策动态，进行政策意图解读、预期推演和落地效果跟踪，生成面向投资专业人士的政策分析简报。

## 数据获取策略

### 核心数据源

**上游外部金融数据服务 (上游外部金融数据服务)** 作为主要数据源，提供全方位的政策、会议、讲话及舆情数据：

| 数据需求 | 推荐工具 | 说明 |
|---------|---------|------|
| 政策会议 | `PolicyMeetingsList` | 国内经济金融领域政策会议动态及内容 |
| 官员讲话 | `OfficialSpeechEventList` | 国内外重要官员讲话及活动信息 |
| 法律法规 | `LawsRegulations` | 法律法规信息，按类型、关键词筛选 |
| 宏观舆情 | `MacroNewslist` | 宏观舆情，按区域、情感类型筛选经济预测及事件 |
| 市场舆情 | `MarketNewslist` | 市场舆情，按市场类型筛选 |
| 全网舆情 | `NewsInfoList` | 全网舆情，按关键词、来源、情感类型筛选 |
| 宏观数据验证 | `MacroIndustryEDB` | 宏观行业经济数据，用于验证政策效果（如GDP、CPI、PMI等） |
| 宏观分析观点 | `MacroeconomicAnalysisViewpoints` | 研报中对GDP、CPI、PMI、政策等宏观维度的分析观点 |

### 数据获取优先级

1. **政策会议与法规**：优先 `PolicyMeetingsList` + `LawsRegulations` 获取最新政策动态
2. **官员讲话与定调**：优先 `OfficialSpeechEventList` 获取央行、财政部、发改委等官员讲话
3. **宏观舆情与观点**：优先 `MacroNewslist` + `MacroeconomicAnalysisViewpoints` 获取市场解读
4. **网络搜索作补充**：对于海外政策（美联储等）细节、最新突发新闻，使用 `外部联网检索` 补充

## 执行流程

### 第一阶段：政策信息抓取

1. **全球主要经济体政策动态**

   **使用 上游外部金融数据服务 查询**：
   ```
   调用 上游外部金融数据服务 OfficialSpeechEventList：
   查询海外重要官员讲话（如美联储主席讲话等）

   调用 上游外部金融数据服务 MacroNewslist：
   query: "美联储 欧央行 海外通胀 大宗商品"
   ```

## 执行流程

## 注意事项

- **政策时效性**：优先使用当日或最近一周发布的政策信息，注明政策发布日期
- **解读客观性**：政策解读应基于官方文本和权威渠道，避免主观臆测，区分事实与观点
- **推演逻辑性**：政策推演需建立在经济数据和政策框架基础上，给出概率判断而非确定性结论
- **跟踪连续性**：政策落地跟踪应与前期报告形成呼应，体现政策效果的动态演变
- **海外联动性**：关注海外政策对国内市场的传导路径（如美联储加息对人民币汇率、资本流动的影响）
- **上游外部金融数据服务 优先**：所有国内政策、会议、讲话、舆情查询优先使用 上游外部金融数据服务 服务，外部联网检索 仅用于补充海外政策细节
