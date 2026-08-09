---
name: dianjin_investment_researcher_fixed_income_daily_brief
description: "固定收益研究员日报生成技能。当用户要求生成固收日报、债券市场日报、债市复盘、利率日报、资金面日报时使用，包括\"固收日报\"、\"债市日报\"、\"债券日报\"、\"利率市场日报\"、\"资金面日报\"、\"生成固收日报\"、\"今日债市复盘\"、\"固收日报速评\"、\"债市每日简报\"等表述。本技能自动获取资金面、债券市场、央行操作、信用债、同业存单、地方债、二级资本债、永续债、ABS等核心数据，结合市场情绪与政策动态，生成标准化Markdown格式固定收益日报。即使用户只说\"今天债市怎么样\"、\"生成债券日报\"、\"固收日报\"等简短表述也要触发。"
version: 0.1.0
category: dianjin_finance
---

# 固定收益日报生成技能

> Adapted from `DianJin-SKILLS/investment-researcher/fixed-income-daily-brief` at `fd9b51167d65`. The exact upstream text is retained in `references/UPSTREAM_SKILL.md` for review.

## FinSagent execution boundary

- Treat this package as an analysis workflow, not as authorization to call tools.
- Use only evidence already returned by the active dataset's Evidence Fusion pipeline.
- Never broaden company or document scope and never mix another company's evidence.
- Upstream tool names, shell commands, web search, databases, and message actions are unavailable unless the FinSagent runtime explicitly supplies an audited adapter.
- Preserve metric qualifiers, periods, units, currencies, actual/estimate labels, source document IDs, pages, and chunk citations.
- If required evidence is absent or conflicting, state the gap; do not estimate, fabricate, or silently substitute public data.
- Recommendations, ratings, target prices, compliance decisions, or high-risk actions require human review.

## Adapted workflow

# 固定收益日报生成技能

## 技能概述

本技能面向证券固定收益研究员，自动生成标准化的固定收益市场日报。通过 `上游外部金融数据服务` 专业金融数据服务获取权威数据，覆盖资金面、利率债、信用债、同业存单、地方债、二级资本债、永续债、ABS、央行操作及重要政策舆情，输出专业、结构化的Markdown格式日报。

## 触发场景

- 用户要求生成固收日报、债市日报、债券日报、利率日报、资金面日报
- 用户询问"今天债市情况"、"资金面如何"、"债券市场复盘"
- 用户需要每日固定收益市场回顾与展望
- 用户要求生成固收晨报、债市早报、固收晚报
- 即使用户表述简短如"固收日报"、"债市日报"、"今天债券市场"也要触发

## 数据获取流程

### 第一步：获取当前日期

使用 `time` 工具获取当前日期，确定报告覆盖的交易日。

### 第二步：资金面数据

使用 `上游工具命令 上游外部金融数据服务 MacroIndustryEDB` 获取资金面核心指标：

```bash
# 获取DR系列利率（银行间质押式回购利率）
上游工具命令 上游外部金融数据服务 MacroIndustryEDB --body '{"query": "DR001 DR007 DR014 银行间质押式回购利率"}'

# 获取R系列利率（存款类金融机构质押式回购利率）
上游工具命令 上游外部金融数据服务 MacroIndustryEDB --body '{"query": "R001 R007 R014 质押式回购利率"}'

# 获取SHIBOR利率
上游工具命令 上游外部金融数据服务 MacroIndustryEDB --body '{"query": "SHIBOR 隔夜 7天 14天 1个月"}'

# 获取同业拆借利率
上游工具命令 上游外部金融数据服务 MacroIndustryEDB --body '{"query": "同业拆借利率 隔夜 7天"}'
```

### 第三步：国债收益率曲线

使用 `上游工具命令 上游外部金融数据服务 MostActiveRateBondQuotation` 获取利率债最活跃券行情：

```bash
# 获取利率债最活跃券收益率
上游工具命令 上游外部金融数据服务 MostActiveRateBondQuotation --body '{"query": "国债 活跃券 收益率 1年 3年 5年 7年 10年 30年"}'

## 报告结构

报告必须严格按照以下模板生成，使用专业、简洁的固收研究员语言风格：

```markdown

## 数据获取注意事项

1. **数据准确性优先**：如果某些数据无法获取，应明确标注"数据待更新"或"暂无数据"，不要编造数据
2. **多源交叉验证**：对关键数据（如10年期国债收益率）应从多个工具交叉验证
3. **时效性**：优先获取当日最新数据，如无当日数据可使用最近交易日数据并注明
4. **单位统一**：利率统一用百分比(%)，利差和变动用基点(BP)，金额用亿元
5. **专业性**：使用固收研究员常用的专业术语，如"资金面收敛/宽松"、"曲线牛陡/熊平"、"资产荒"等
