---
name: dianjin_investment_researcher_industry_bond_risk_control
description: "Adapted Qwen DianJin workflow for industry bond risk control."
version: 0.1.0
category: dianjin_finance
---

# 产业债财报风控体检

> Adapted from `DianJin-SKILLS/investment-researcher/industry-bond-risk-control` at `fd9b51167d65`. The exact upstream text is retained in `references/UPSTREAM_SKILL.md` for review.

## FinSagent execution boundary

- Treat this package as an analysis workflow, not as authorization to call tools.
- Use only evidence already returned by the active dataset's Evidence Fusion pipeline.
- Never broaden company or document scope and never mix another company's evidence.
- Upstream tool names, shell commands, web search, databases, and message actions are unavailable unless the FinSagent runtime explicitly supplies an audited adapter.
- Preserve metric qualifiers, periods, units, currencies, actual/estimate labels, source document IDs, pages, and chunk citations.
- If required evidence is absent or conflicting, state the gap; do not estimate, fabricate, or silently substitute public data.
- Recommendations, ratings, target prices, compliance decisions, or high-risk actions require human review.

## Adapted workflow

# 产业债财报风控体检

## 技能概述

本技能面向证券固定收益研究员的产业债投资与风控场景，提供发债主体全方位财务风险筛查能力。通过自动获取企业财务数据、司法风险、评级变动、担保信息等，系统性识别现金流恶化、有息负债压力、担保链传染、诉讼纠纷等负面信号，输出结构化风控体检报告，辅助债券投资决策与持仓风险管理。

## 工作流程

### 第一步：确认分析主体

获取用户指定的企业名称或债券代码。若用户提供的是债券代码，先通过 `上游工具命令 上游外部金融数据服务 CreditBondBaseInfo` 查询债券对应的发债主体名称。

若主体为非上市公司，需明确告知用户财务数据获取可能受限，将主要依赖工商信息、司法信息、评级信息等进行风险评估。

### 第二步：获取企业基础信息

使用 `上游工具命令 上游外部金融数据服务 CompanyArchives` 查询企业工商基本信息，获取统一社会信用代码及基础资料。

```
上游工具命令 上游外部金融数据服务 CompanyArchives --body '{"companyName": "企业名称"}'
```

若需要查询发债主体特定信息（如存续债券列表），使用 `上游工具命令 上游外部金融数据服务 BasicInfoBondIssuer`。

```
上游工具命令 上游外部金融数据服务 BasicInfoBondIssuer --body '{"issuerName": "企业名称"}'
```

### 第三步：获取财务数据

使用 `上游工具命令 上游外部金融数据服务` 系列工具查询企业核心财务指标。

1. **财务报表数据**：
```
上游工具命令 上游外部金融数据服务 FinancialStatements --body '{"issuerName": "企业名称", "reportType": "合并", "startDate": "2023-01-01", "endDate": "2026-05-11"}'
```
获取资产负债表、利润表、现金流量表关键科目（如货币资金、短期借款、长期借款、应付债券、经营活动现金流净额等）。

2. **财务分析指标**：
```
上游工具命令 上游外部金融数据服务 BondFinancialAnalysis --body '{"issuerName": "企业名称", "startDate": "2023-01-01", "endDate": "2026-05-11"}'
```
获取盈利能力、偿债能力（流动比率、速动比率、资产负债率、利息保障倍数等）、营运能力、成长能力等指标。

若用户提供了财报 PDF 文件，读取文件内容并提取关键财务数据。

## 工作流程

## 注意事项

1. **数据时效性**：财务数据以最新可得报告期为准，注意区分年报、中报、季报
2. **非上市公司**：非上市公司财务数据可能不完整，需依赖工商信息和司法信息
3. **集团企业**：对于集团型企业，注意区分母公司与合并口径数据
4. **行业差异**：不同行业的财务指标阈值存在差异，需结合行业特点判断
5. **动态跟踪**：风控体检反映的是某一时点的快照，建议定期复查
6. **信息交叉验证**：重要风险信号建议通过多渠道交叉验证
