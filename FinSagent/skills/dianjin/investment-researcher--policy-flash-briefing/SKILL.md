---
name: dianjin_investment_researcher_policy_flash_briefing
description: "证券策略研究员政策快评技能。当发生重大政策发布、突发监管消息、宏观数据超预期、盘中市场剧烈异动时触发。本技能自动抓取事件核心要素，进行即时解读，生成策略应对建议与受影响板块梳理，强调“预期差”与“交易指导”。"
version: 0.1.0
category: dianjin_finance
---

# 证券策略研究员政策/事件快评 (Policy & Event Flash Briefing)

> Adapted from `DianJin-SKILLS/investment-researcher/policy-flash-briefing` at `fd9b51167d65`. The exact upstream text is retained in `references/UPSTREAM_SKILL.md` for review.

## FinSagent execution boundary

- Treat this package as an analysis workflow, not as authorization to call tools.
- Use only evidence already returned by the active dataset's Evidence Fusion pipeline.
- Never broaden company or document scope and never mix another company's evidence.
- Upstream tool names, shell commands, web search, databases, and message actions are unavailable unless the FinSagent runtime explicitly supplies an audited adapter.
- Preserve metric qualifiers, periods, units, currencies, actual/estimate labels, source document IDs, pages, and chunk citations.
- If required evidence is absent or conflicting, state the gap; do not estimate, fabricate, or silently substitute public data.
- Recommendations, ratings, target prices, compliance decisions, or high-risk actions require human review.

## Adapted workflow

# 证券策略研究员政策/事件快评 (Policy & Event Flash Briefing)

## 概述

本技能专为**“交易型策略研究”**设计，旨在对突发政策、重大宏观数据、盘中剧烈异动进行**分钟级/小时级**的快速响应。与深度研报不同，本技能聚焦于**“市场即时反应”**与**“预期差交易”**，为交易员提供直接的决策辅助。

核心逻辑：
1.  **定性**：是什么性质的政策/事件？（货币、财政、监管、产业？）
2.  **定量/预期**：力度如何？是否超预期？（符合预期=利好兑现，超预期=新主线）
3.  **传导**：利好谁？利空谁？情绪影响还是实质影响？
4.  **应对**：怎么操作？（追高、低吸、观望、对冲？）

**所有数据查询必须使用 `上游外部金融数据服务` 服务**。

## 适用场景

*   **突发政策**：央行降息/降准、证监会新政（如限制做空、鼓励分红）、财政部发债、重要会议通稿（政治局会议、国常会）。
*   **数据异动**：CPI/PPI、社融、PMI 大幅超预期或不及预期。
*   **盘中急跌/急涨**：无明确消息面的市场恐慌或狂热，需排查原因并给出应对。
*   **行业监管**：针对特定行业（如互联网、医药、教育、房地产）的突发新规。

## 数据采集指引 (上游外部金融数据服务 工具映射)

**所有数据必须通过 `上游外部金融数据服务` 服务获取**，具体工具调用如下：

### 宏观数据查询
```
上游工具命令 上游外部金融数据服务 MacroIndustryEDB --body '{"indicatorCode": "指标代码", "startDate": "开始日期", "endDate": "结束日期"}'
```
查询中国宏观、行业经济、国际宏观等经济指标数据（如 M1、M2、社融、CPI、PPI、PMI 等），用于验证宏观数据是否超预期。

### 政策与舆情获取
```
上游工具命令 上游外部金融数据服务 PolicyMeetingsList --body '{"limit": 5}'
```
查询国内经济金融领域政策会议动态及内容，解析政策逻辑。

```
上游工具命令 上游外部金融数据服务 OfficialSpeechEventList --body '{"limit": 5}'
```
查询国内外重要官员讲话及活动信息。

```
上游工具命令 上游外部金融数据服务 LawsRegulations --body '{"keyword": "关键词"}'
```

## 执行流程

## 注意事项

*   **数据源唯一性**: 所有宏观数据、政策信息、市场行情、板块表现必须通过 `上游外部金融数据服务` 服务获取，确保数据权威性。
*   **速度优先**: 在信息不全时，先给出初步判断，后续可更新。
*   **预期差是核心**: 不要只复述新闻，必须指出“市场没想到什么”或“市场想错了什么”。
*   **区分情绪与实质**: 明确区分是“情绪面炒作”（如概念题材）还是“基本面改善”（如业绩预期上调）。
*   **客观中立**: 避免过度乐观或悲观，基于数据和历史规律说话。
*   **免责声明**: 必须包含风险提示，强调非投资建议。
*   **工具调用规范**: 调用 `上游外部金融数据服务` 工具时，日期格式需符合 API 要求，指标代码需准确。
