---
name: dianjin_investment_researcher_lgt_debt_risk_analysis
description: "Adapted Qwen DianJin workflow for lgt debt risk analysis."
version: 0.1.0
category: dianjin_finance
---

# 城投主体债务排雷分析技能

> Adapted from `DianJin-SKILLS/investment-researcher/lgt-debt-risk-analysis` at `fd9b51167d65`. The exact upstream text is retained in `references/UPSTREAM_SKILL.md` for review.

## FinSagent execution boundary

- Treat this package as an analysis workflow, not as authorization to call tools.
- Use only evidence already returned by the active dataset's Evidence Fusion pipeline.
- Never broaden company or document scope and never mix another company's evidence.
- Upstream tool names, shell commands, web search, databases, and message actions are unavailable unless the FinSagent runtime explicitly supplies an audited adapter.
- Preserve metric qualifiers, periods, units, currencies, actual/estimate labels, source document IDs, pages, and chunk citations.
- If required evidence is absent or conflicting, state the gap; do not estimate, fabricate, or silently substitute public data.
- Recommendations, ratings, target prices, compliance decisions, or high-risk actions require human review.

## Adapted workflow

# 城投主体债务排雷分析技能

## 技能概述

本技能面向证券固定收益研究员，提供城投平台（地方政府融资平台）债务风险的自动化排雷分析能力。通过多维度数据交叉验证，识别潜在信用风险，生成结构化风险报告。

## 核心分析维度

### 1. 区域财政实力评估
- 一般公共预算收入及增速
- 政府性基金收入（土地出让金）
- 财政自给率（一般公共预算收入/一般公共预算支出）
- 上级转移支付依赖度

### 2. 债务压力分析
- 地方政府债务余额及债务率（债务余额/综合财力）
- 城投平台有息债务规模
- 宽口径债务率（地方政府债务+城投有息债务）/综合财力
- 债务期限结构与偿债高峰

### 3. 化债进度跟踪
- 特殊再融资债券发行情况
- 债务置换与展期进展
- 央行 SPV 工具使用情况
- 地方化债政策与具体措施

### 4. 主体信用排查
- 工商基本信息与股权穿透
- 司法诉讼与被执行人记录
- 行政处罚与经营异常
- 主体评级与评级展望
- 债券发行与兑付记录

## 执行流程

### 第一步：明确分析对象

从用户输入中提取：
- **城投主体名称**（如：XX 市城市建设投资集团）
- **所属区域**（省/市/区县）
- 如用户未指定具体主体，则按区域维度进行整体分析

### 第二步：获取区域财政与债务数据

使用 `上游工具命令 上游外部金融数据服务 RegionalEconomicData` 查询目标区域的宏观经济与财政数据：

## 执行流程

## 注意事项

- 城投债务数据部分为非公开信息，宽口径债务率可能需要估算
- 化债政策变化较快，需关注最新政策动态
- 主体司法信息可能存在滞后，建议定期复查
- 风险等级仅为参考，实际投资决策需结合更多定性分析
