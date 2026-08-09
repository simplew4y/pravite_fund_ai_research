---
name: dianjin_investment_researcher_fixed_income_rate_review
description: "Adapted Qwen DianJin workflow for fixed income rate review."
version: 0.1.0
category: dianjin_finance
---

# 固定收益研究员资金面&利率复盘简报

> Adapted from `DianJin-SKILLS/investment-researcher/fixed-income-rate-review` at `fd9b51167d65`. The exact upstream text is retained in `references/UPSTREAM_SKILL.md` for review.

## FinSagent execution boundary

- Treat this package as an analysis workflow, not as authorization to call tools.
- Use only evidence already returned by the active dataset's Evidence Fusion pipeline.
- Never broaden company or document scope and never mix another company's evidence.
- Upstream tool names, shell commands, web search, databases, and message actions are unavailable unless the FinSagent runtime explicitly supplies an audited adapter.
- Preserve metric qualifiers, periods, units, currencies, actual/estimate labels, source document IDs, pages, and chunk citations.
- If required evidence is absent or conflicting, state the gap; do not estimate, fabricate, or silently substitute public data.
- Recommendations, ratings, target prices, compliance decisions, or high-risk actions require human review.

## Adapted workflow

# 固定收益研究员资金面&利率复盘简报

## 技能概述

本技能面向证券固定收益研究员，自动化生成资金面与利率复盘简报。通过获取银行间市场核心利率数据、分析利率变动逻辑、结合宏观与政策因素，输出结构化的复盘报告。

## 数据获取流程

### 第一步：获取当前日期

使用 `上游工具命令 time` 获取当前日期，确定复盘的交易日。

### 第二步：获取资金面核心数据

使用 `上游工具命令 上游外部金融数据服务` 查询以下数据：

1. **DR 系列利率**：DR001、DR007、DR014、DR021、DR1M
   ```
   调用 上游外部金融数据服务 MacroIndustryEDB，查询银行间回购利率：
   - 获取 DR 系列利率的最新数据
   - 支持时间序列查询，可获取日度、周度、月度数据
   ```

2. **同业存单利率**：1M、3M、6M、9M、1Y 同业存单发行利率/到期收益率
   ```
   调用 上游外部金融数据服务 NCDIssueRate，查询同业存单发行利率：
   - 获取按日统计的同业存单平均发行利率
   - 支持按期限（1M/3M/6M/9M/1Y）、主体评级、银行类别筛选
   - 获取发行规模及只数统计
   ```

3. **国债收益率曲线**：1Y、2Y、3Y、5Y、7Y、10Y、30Y 国债到期收益率
   ```
   调用 上游外部金融数据服务 MostActiveRateBondQuotation，查询利率债最活跃券行情：
   - 获取各期限最活跃国债的收益率及涨跌情况
   - 反映市场资金面风向和收益率曲线形态
   调用 上游外部金融数据服务 BondDailyClosingQuotes，查询债券日收盘行情：
   - 获取指定日期国债的收盘行情，包括到期收益率及久期
   ```

4. **SHIBOR 利率**：O/N、1W、2W、1M、3M
   ```
   调用 上游外部金融数据服务 MacroIndustryEDB，查询 SHIBOR 利率：
   - 获取 SHIBOR 各期限品种的报价数据
   - 支持时间序列查询

### 报告结构

按照以下模板生成 Markdown 格式报告：

```markdown

## 注意事项

- 利率变动单位统一使用 BP（1BP = 0.01%）
- 数据缺失时标注"数据暂缺"，不可编造数据
- 复盘结论需有数据支撑，避免主观臆断
- 交易建议仅供参考，不构成投资建议
- 报告生成后直接在对话中显示完整内容，无需发送文件
