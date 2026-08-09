---
name: dianjin_investment_advisor_stock_shareholder_analysis
description: "公司股东股本查询分析技能。查询股本结构、股权结构、股东户数、前十大股东/流通股东、主要持有人、实控人等股权信息，支持自然语言问句输入，返回相关股东股本数据结果。当用户询问股本结构、股东户数、前十大股东、股权质押、实控人、主要持有人等股东股本数据查询问题时，必须使用此技能。"
version: 0.1.0
category: dianjin_finance
---

# 公司股东股本查询分析技能

> Adapted from `DianJin-SKILLS/investment-advisor/stock-shareholder-analysis` at `fd9b51167d65`. The exact upstream text is retained in `references/UPSTREAM_SKILL.md` for review.

## FinSagent execution boundary

- Treat this package as an analysis workflow, not as authorization to call tools.
- Use only evidence already returned by the active dataset's Evidence Fusion pipeline.
- Never broaden company or document scope and never mix another company's evidence.
- Upstream tool names, shell commands, web search, databases, and message actions are unavailable unless the FinSagent runtime explicitly supplies an audited adapter.
- Preserve metric qualifiers, periods, units, currencies, actual/estimate labels, source document IDs, pages, and chunk citations.
- If required evidence is absent or conflicting, state the gap; do not estimate, fabricate, or silently substitute public data.
- Recommendations, ratings, target prices, compliance decisions, or high-risk actions require human review.

## Adapted workflow

# 公司股东股本查询分析技能

## 概述
本技能专注于**上市公司股东与股本结构**的深度查询与分析。通过整合股本数据、股东名单、持股变动及质押风险等信息，帮助用户快速透视一家公司的**股权架构**与**筹码分布**特征，辅助判断公司治理质量及潜在的投资风险/机会。

## 数据工具集 (上游外部金融数据服务)

| 工具名称 | 核心作用 | 关键参数 |
|----------|----------|----------|
| `StockShareStructure` | **股本结构** | 获取总股本、流通股本、限售股及变动原因 |
| `Top10ShareHolders` | **十大股东** | 获取前十大股东名称、持股数量及比例 |
| `Top10FloatShareHolders` | **十大流通股东** | 获取前十大流通股东名称、持股数量及比例 |
| `ShareholderNum` | **股东户数** | 获取股东户数变化、户均持股，分析筹码集中度 |
| `StockPledge` | **股权质押** | 获取股东质押明细，评估股权爆仓风险 |
| `CompanyBasicInfo` | **公司实控人** | 获取公司简介、实控人信息及核心高管 |

## 核心分析维度

### 1. 股本结构分析 (Share Structure)
*   **流通盘大小**：流通股占总股本的比例。比例越高，市场化定价越充分；比例过低可能存在解禁压力。
*   **限售股解禁**：关注未来是否有大规模限售股解禁，这通常会对股价构成供给端压力。

### 2. 股东名册分析 (Top Shareholders)
*   **股东性质**：区分国资、外资、公募基金、社保、险资、私募及牛散。
    *   *机构抱团*：多家知名机构重仓通常代表基本面获认可。
    *   *牛散入驻*：知名牛散现身可能带来题材炒作预期。
*   **股权集中度**：前十大股东持股比例之和。比例越高（如 >70%），说明筹码高度集中，主力控盘度高，但也可能导致流动性不足。

### 3. 股东户数与筹码 (Shareholder Count)
*   **户数变化趋势**：
    *   *户数锐减*：筹码向少数人集中（主力收集筹码），通常是利好信号。
    *   *户数激增*：筹码分散到散户手中（主力派发），通常是见顶或利空信号。
*   **户均持股**：户均持股数上升意味着人均持仓增加，主力控盘增强。

### 4. 股权质押风险 (Pledge Risk)
*   **质押比例**：大股东质押股份数量占其持股总数的比例。
    *   *高危线*：若质押比例超过 **50%-60%**，需警惕股价下跌引发的平仓风险（爆仓）。
*   **质押用途**：了解质押资金是用于上市公司经营还是股东个人用途。

### 5. 实控人与背景 (Actual Controller)
*   **实控人性质**：国企/央企（稳健、政策导向） vs 民企（灵活、但也可能存在治理问题）。
*   **一致行动人**：识别实控人的一致行动人，准确计算实际控制的股权比例。

## 工作流程

## 工作流程

1.  **识别意图**：从用户自然语言中提取目标股票名称/代码。
2.  **并行查询**：
    *   调用 `StockShareStructure` 获取股本详情。
    *   调用 `Top10ShareHolders` 和 `Top10FloatShareHolders` 获取股东名单。
    *   调用 `ShareholderNum` 获取户数变化。
    *   调用 `StockPledge` 获取质押情况。
    *   调用 `CompanyBasicInfo` 获取实控人信息。
3.  **数据清洗与整合**：将多源数据整合为结构化的股权画像。
4.  **生成报告**：输出包含“股本结构、股东名单、筹码集中度、风险提示”的分析报告。

## 报告输出模板

```markdown
