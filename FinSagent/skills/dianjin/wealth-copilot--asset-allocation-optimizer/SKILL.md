---
name: dianjin_wealth_copilot_asset_allocation_optimizer
description: "基于客户风险偏好和当前持仓，结合市场环境和量化模型， 生成个性化资产配置方案并模拟预期收益分布。 当用户提到资产配置、配置优化、怎么调仓、投资方案设计、配置方案时触发。 不用于单只基金分析（由fund-deep-research处理）， 不用于具体产品推荐（由smart-product-matching处理）。"
version: 0.1.0
category: dianjin_finance
---

# 资产配置优化

> Adapted from `DianJin-SKILLS/wealth-copilot/L2-6_allocation/asset-allocation-optimizer` at `fd9b51167d65`. The exact upstream text is retained in `references/UPSTREAM_SKILL.md` for review.

## FinSagent execution boundary

- Treat this package as an analysis workflow, not as authorization to call tools.
- Use only evidence already returned by the active dataset's Evidence Fusion pipeline.
- Never broaden company or document scope and never mix another company's evidence.
- Upstream tool names, shell commands, web search, databases, and message actions are unavailable unless the FinSagent runtime explicitly supplies an audited adapter.
- Preserve metric qualifiers, periods, units, currencies, actual/estimate labels, source document IDs, pages, and chunk citations.
- If required evidence is absent or conflicting, state the gap; do not estimate, fabricate, or silently substitute public data.
- Recommendations, ratings, target prices, compliance decisions, or high-risk actions require human review.

## Adapted workflow

# 资产配置优化

## 可用工具

本技能可调用以下 MCP 数据服务，执行流程中按需选用：

**盈米金融数据（qieman）**
- 服务地址：`https://dashscope.aliyuncs.com/api/v1/mcps/Qieman/sse`
- 核心能力：基金搜索/诊断、组合分析/回测、资产配置方案、CFP 工具链、图表渲染
- 本技能主要工具：`GetAssetAllocationPlan`, `GetCompositeModel`, `GetFundAssetClassAnalysis`, `MonteCarloSimulate`, `GetLatestQuotations`, `RenderEchart`

**恒生聚源金融数据（上游外部金融数据服务）**
- 服务地址：开通恒生聚源 MCP 服务后获取，格式为 `https://dashscope.aliyuncs.com/api/v1/mcps/<your-mcp-id>/mcp`
- 核心能力：个股研究(A/H/US)、财务报表、资金流向、研报舆情、理财产品、宏观数据
- 本技能可选工具：`MacroIndustryEDB`, `IndustryValuation`

## 核心原则

**图表优先，文字精简。** 资产配置比例、调仓缺口、收益模拟等定量数据必须通过 `RenderEchart` 生成可视化图表呈现，文字仅用于解读配置逻辑和实施建议。

## 输入要求

### 必填信息
- 客户风险等级：R1-R5
- 可投资金额或AUM

### 可选信息
- 当前持仓概况（用于分析配置缺口）
- 投资期限偏好
- 预期年化收益率或可承受最大回撤
- 特殊需求（如"不要权益""想加黄金"）

如果用户仅说"帮我做个配置方案"，追问风险等级和可投资金额。

## 执行流程

### 第一步：信息收集与需求确认
- 解析客户上下文，提取风险等级、AUM、当前持仓
- 确定配置约束条件

### 第二步：获取基准配置方案
- 调用 `GetAssetAllocationPlan` 传入投资三性参数（预期收益率 / 最大回撤 / 投资期限，至少一个）

### 第三步：落地到具体产品
- 调用 `GetCompositeModel` 通过方案ID获取复合模型

## 执行流程

## 输出模板

按以下结构输出，**图表嵌入对应章节，文字精简**：

```markdown

## 注意事项

- **图表为必选项**：配置饼图和收益模拟图为必须生成项
- 合规要求：收益模拟明确标注"模拟"性质，不等于收益承诺
- 适当性匹配：方案风险等级不得超过客户风险等级
- 流动性保障：现金管理类资产占比不低于5-10%
- 文字精简：全文控制在800-1200字（不含图表）
