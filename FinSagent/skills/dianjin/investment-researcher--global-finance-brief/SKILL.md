---
name: dianjin_investment_researcher_global_finance_brief
description: "全球财经要闻自动抓取与简报生成技能。当用户询问财经热点、财经新闻、市场动态、投资热点、生成财经简报，或要求查看今天/最近金融市场有什么大事时触发。即使用户只说\"财经热点\"、\"财经新闻汇总\"等简短表述也要触发。本技能自动搜索最新财经资讯（24-72 小时），智能筛选高影响力事件，按宏观/市场/行业/公司分类汇总，生成结构化简要报告，包含核心头条、市场表现、行业动态、投资机会和风险提示。支持定时任务创建。"
version: 0.1.0
category: dianjin_finance
---

# 全球财经要闻简报技能

> Adapted from `DianJin-SKILLS/investment-researcher/global-finance-brief` at `fd9b51167d65`. The exact upstream text is retained in `references/UPSTREAM_SKILL.md` for review.

## FinSagent execution boundary

- Treat this package as an analysis workflow, not as authorization to call tools.
- Use only evidence already returned by the active dataset's Evidence Fusion pipeline.
- Never broaden company or document scope and never mix another company's evidence.
- Upstream tool names, shell commands, web search, databases, and message actions are unavailable unless the FinSagent runtime explicitly supplies an audited adapter.
- Preserve metric qualifiers, periods, units, currencies, actual/estimate labels, source document IDs, pages, and chunk citations.
- If required evidence is absent or conflicting, state the gap; do not estimate, fabricate, or silently substitute public data.
- Recommendations, ratings, target prices, compliance decisions, or high-risk actions require human review.

## Adapted workflow

# 全球财经要闻简报技能

## 技能定位

本技能用于**自动抓取全球最新财经要闻**，通过 `上游外部金融数据服务` 金融数据服务获取结构化数据与舆情，智能筛选高影响力事件，生成**结构化简要总结报告**。适用于用户快速获取每日财经热点、市场动态和投资机会参考。

**核心特点**：
- 自动捕获最新财经资讯（24-72 小时内）
- 智能筛选高影响力事件
- 结构化分类汇总
- 简洁易懂的简报格式

---

## 触发场景

当用户出现以下任一表述时，应触发本技能：

| 用户表述 | 触发类型 |
|----------|----------|
| "今天有什么财经热点" | 主动捕获 |
| "全球财经要闻汇总" | 定向搜索 |
| "财经新闻总结" | 主动捕获 |
| "帮我看看今天金融市场有什么大事" | 主动捕获 |
| "最近有什么投资热点" | 主动捕获 |
| "XX 行业最近有什么新闻" | 定向搜索 |
| "生成一份财经简报" | 主动捕获 |
| "今天市场有什么动静" | 主动捕获 |

**注意**：即使用户只说"财经热点"、"财经新闻"等简短表述，只要意图是获取最新财经资讯，也应触发本技能。

---

## 执行流程

### Step 1：确定搜索范围和时间

**1.1 获取当前日期**

调用 `上游工具命令 time` 获取当前日期，用于确定新闻时间范围。

```bash
上游工具命令 time
```

## 执行流程

### Step 5：特殊场景处理

**场景一：用户指定行业/主题**

当用户指定特定行业或主题时（如"半导体行业新闻"、"新能源汽车最新动态"）：

1. 提取用户指定的关键词
2. 针对性搜索该领域新闻（如 `IndustryNewslist`）
3. 报告结构保持不变，但内容聚焦指定领域
4. 增加该领域的深度分析

**场景二：用户要求定时推送**

当用户要求每日/每周定时推送财经简报时：

1. 使用 `cron` 工具创建定时任务
2. 任务 payload 中包含调用本技能的指令
3. 设置合适的推送时间（如交易日早 8 点）

示例：
```bash
cron --action add --taskName "每日财经简报" --description "每个交易日早晨生成全球财经要闻简报" --schedule '{"triggerType": "CRON", "cron": "0 0 8 * * MON-FRI"}' --payload '{"userInput": "生成一份最近 24 小时的全球财经要闻简报，包含核心头条、市场表现、宏观政策、行业动态、投资机会和风险提示。"}'
```

**场景三：重大突发事件**

当检测到重大突发事件（如战争、金融危机、政策突变）时：

1. 在报告开头增加"⚠️ 突发重大事件"板块
2. 详细说明事件背景、进展和潜在影响
3. 增加风险提示的权重
4. 建议用户密切关注后续发展

**场景四：市场休市/节假日**

当遇市场休市或节假日时：

1. 在报告中说明休市情况
2. 汇总休市期间的重要新闻
3. 提示下周开市后的关注要点

---

## 注意事项

1. **数据时效性**：行情数据需标注具体时间，避免误导用户
2. **客观中立**：分析应基于事实，避免主观臆断和情绪化表达
3. **风险充分**：必须提示主要风险点，尤其是重大不确定性事件
4. **免责声明**：每份报告必须包含免责声明
5. **简洁优先**：简报控制在 1500 字以内为佳，重点突出
6. **来源权威**：优先使用 `上游外部金融数据服务` 金融数据服务
7. **多源验证**：重要新闻建议多数据源交叉验证
8. **敏感信息**：涉及地缘政治等敏感话题，保持客观陈述
9. **用户定制**：根据用户历史偏好调整报告详细程度和关注领域
10. **Fallback 机制**：当 `上游外部金融数据服务` 无法获取某些数据时，自动降级使用 `外部联网检索`

---

> **技能版本**：v2.0 (重构版)
> **最后更新**：2026-04-28
> **维护者**：点金智能助理
