---
name: dianjin_investment_advisor_fund_multi_factor_filter
description: "通过自然语言查询进行公募基金筛选技能。根据基金类型、业绩、基金经理、风险、持仓、资产配置等多维度组合筛选公募基金。返回符合条件的相关基金数据。当用户询问基金筛选问题时，必须使用此技能。"
version: 0.1.0
category: dianjin_finance
---

# 公募基金智能选基技能

> Adapted from `DianJin-SKILLS/investment-advisor/fund-multi-factor-filter` at `fd9b51167d65`. The exact upstream text is retained in `references/UPSTREAM_SKILL.md` for review.

## FinSagent execution boundary

- Treat this package as an analysis workflow, not as authorization to call tools.
- Use only evidence already returned by the active dataset's Evidence Fusion pipeline.
- Never broaden company or document scope and never mix another company's evidence.
- Upstream tool names, shell commands, web search, databases, and message actions are unavailable unless the FinSagent runtime explicitly supplies an audited adapter.
- Preserve metric qualifiers, periods, units, currencies, actual/estimate labels, source document IDs, pages, and chunk citations.
- If required evidence is absent or conflicting, state the gap; do not estimate, fabricate, or silently substitute public data.
- Recommendations, ratings, target prices, compliance decisions, or high-risk actions require human review.

## Adapted workflow

# 公募基金智能选基技能

## 概述
本技能专注于**多维度公募基金筛选**。通过整合业绩表现、风险控制、基金经理能力、资产配置、行业偏好等数据，帮助用户快速从海量公募基金中精准定位符合特定投资逻辑的标的。

## 数据工具集 (上游外部金融数据服务)

| 工具名称 | 核心作用 | 关键参数 |
|----------|----------|----------|
| `FundMultipleFactorFilter` | **智能选基** | 接收自然语言查询，返回符合多条件筛选的基金列表 |

## 核心筛选维度

### 1. 业绩与收益指标
*   **阶段收益**：近1月、近3月、近6月、近1年、近3年、今年以来收益率。
*   **同类排名**：在同类基金中的收益排名（如“排名前 10%"）。
*   **超额收益**：超越业绩比较基准的幅度。
*   **历史胜率**：不同持有期下的盈利概率。

### 2. 风险与回撤控制
*   **最大回撤**：历史最大回撤幅度（如“最大回撤小于 20%"）。
*   **夏普比率**：风险调整后收益指标（如“夏普比率大于 1"）。
*   **波动率**：净值波动的剧烈程度。
*   **卡玛比率**：年化收益与最大回撤之比。

### 3. 基金经理维度
*   **从业年限**：基金经理管理该基金或总从业年限（如“从业超过 5 年”）。
*   **管理规模**：基金经理当前管理的总规模。
*   **投资风格**：价值型、成长型、均衡型、大盘/小盘风格。
*   **代表作**：是否有长期业绩优秀的代表产品。

### 4. 基金类型与资产配置
*   **基金分类**：股票型、混合型、债券型、指数型、QDII、FOF、货币型等。
*   **资产分布**：股票仓位、债券仓位、现金比例。
*   **行业偏好**：重仓行业（如“主要持仓在新能源、半导体”）。
*   **持仓集中度**：前十大重仓股占净值比例。

### 5. 规模与费率
*   **基金规模**：最新资产规模（如“规模大于 10 亿”）。
*   **费率结构**：管理费、托管费、申购赎回费。

## 工作流程

1.  **意图识别**：从用户自然语言中提取筛选条件（如“近一年收益排名前 10% 且最大回撤小于 15% 的混合型基金”）。
2.  **构建查询**：将提取的条件组合成自然语言查询语句。

## 工作流程

1.  **意图识别**：从用户自然语言中提取筛选条件（如“近一年收益排名前 10% 且最大回撤小于 15% 的混合型基金”）。
2.  **构建查询**：将提取的条件组合成自然语言查询语句。
3.  **调用工具**：调用 `FundMultipleFactorFilter` 获取筛选结果。
4.  **结果解析**：解析返回的基金列表，提取关键指标（代码、名称、类型、最新净值、阶段收益、回撤、夏普比率、基金经理等）。
5.  **生成报告**：输出结构化的选基结果表格，并附带简要的投资逻辑分析。

## 报告输出模板

```markdown
