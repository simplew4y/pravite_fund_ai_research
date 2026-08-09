---
name: dianjin_wealth_copilot_competitor_product_compare
description: "对比同类基金产品，从收益、风险、费率、流动性、基金经理能力五个维度 生成对比报告，帮助客户经理回应\"别家产品更好\"的异议。 当用户提到跟XX比怎么样、竞品对比、同类比较、为什么选我们、 两只基金比较时触发。 不用于单只基金分析（由fund-deep-research处理）。"
version: 0.1.0
category: dianjin_finance
---

# 竞品对比分析

> Adapted from `DianJin-SKILLS/wealth-copilot/L2-3_strategy/competitor-product-compare` at `fd9b51167d65`. The exact upstream text is retained in `references/UPSTREAM_SKILL.md` for review.

## FinSagent execution boundary

- Treat this package as an analysis workflow, not as authorization to call tools.
- Use only evidence already returned by the active dataset's Evidence Fusion pipeline.
- Never broaden company or document scope and never mix another company's evidence.
- Upstream tool names, shell commands, web search, databases, and message actions are unavailable unless the FinSagent runtime explicitly supplies an audited adapter.
- Preserve metric qualifiers, periods, units, currencies, actual/estimate labels, source document IDs, pages, and chunk citations.
- If required evidence is absent or conflicting, state the gap; do not estimate, fabricate, or silently substitute public data.
- Recommendations, ratings, target prices, compliance decisions, or high-risk actions require human review.

## Adapted workflow

# 竞品对比分析

## 可用工具

本技能可调用以下 MCP 数据服务，执行流程中按需选用：

**盈米金融数据（qieman）**
- 服务地址：`https://dashscope.aliyuncs.com/api/v1/mcps/Qieman/sse`
- 核心能力：基金搜索/诊断、组合分析/回测、资产配置方案、CFP 工具链、图表渲染
- 本技能主要工具：`SearchFunds`, `GuessFundCode`, `BatchGetFundsDetail`, `GetBatchFundPerformance`, `AnalyzeFundRisk`, `BatchGetFundTradeRules`, `RenderEchart`

**恒生聚源金融数据（上游外部金融数据服务）**
- 服务地址：开通恒生聚源 MCP 服务后获取，格式为 `https://dashscope.aliyuncs.com/api/v1/mcps/<your-mcp-id>/mcp`
- 核心能力：个股研究(A/H/US)、财务报表、资金流向、研报舆情、理财产品、宏观数据
- 本技能可选工具：`FundManagerInfoReport`, `FundIncomeRiskReport`, `ProductBasicInfoList`

## 核心原则

**图表优先，文字精简。** 产品对比的核心是一眼看出差异——五维评分雷达图和业绩对比柱状图必须通过 `RenderEchart` 生成，文字仅用于点出关键差异和话术建议。

## 输入要求

### 必填信息
- 至少2只产品的名称或代码（支持基金 vs 基金，也支持基金 vs 理财产品的跨品类对比）

### 可选信息
- 对比侧重点（收益/风险/费率）
- 客户风险等级（影响适配性评价）

## 执行流程

### 第一步：确认产品代码
- 对每只基金调用 `SearchFunds` 或 `GuessFundCode` 确认代码
- 如涉及理财产品，调用 `ProductBasicInfoList`（上游外部金融数据服务）获取产品信息

### 第二步：并行采集数据

**基金类（qieman）：**
- `BatchGetFundsDetail`：基本信息
- `GetBatchFundPerformance`：业绩对比
- `AnalyzeFundRisk`：风险评估
- `BatchGetFundTradeRules`：交易规则和费率

**经理能力增强（上游外部金融数据服务，可选）：**
- `FundManagerInfoReport`：经理详细从业背景、管理规模、获奖情况

## 执行流程

## 输出模板

按以下结构输出，**图表嵌入对应章节，文字精简聚焦差异**：

```markdown

## 注意事项

- **图表为必选项**：五维雷达图和业绩对比柱状图为必须生成项
- 客观中立：不刻意贬低竞品或美化自家产品
- 数据说话：对比基于客观数据，不做主观评判
- 合规要求：不诋毁竞争对手，不误导客户
- 文字精简：全文控制在600-1000字（不含图表）
- 跨品类对比：如涉及基金 vs 理财产品，需说明两者的本质差异（如开放/封闭、净值/预期收益等）
