---
name: dianjin_wealth_copilot_smart_product_matching
description: "从客户配置缺口出发筛选匹配产品，经尽调验证后输出推荐方案和 \"为什么适合您\"的销售话术。支持基金、理财产品、债券等多品类匹配。 当用户提到推荐产品、该买什么、产品匹配、有什么好产品、推荐基金、理财产品推荐时触发。 不用于已持有产品的诊断分析（由portfolio-health-check处理）， 不用于资产配置方案设计（由asset-allocation-optimizer处理）。"
version: 0.1.0
category: dianjin_finance
---

# 产品智能匹配

> Adapted from `DianJin-SKILLS/wealth-copilot/L2-6_allocation/smart-product-matching` at `fd9b51167d65`. The exact upstream text is retained in `references/UPSTREAM_SKILL.md` for review.

## FinSagent execution boundary

- Treat this package as an analysis workflow, not as authorization to call tools.
- Use only evidence already returned by the active dataset's Evidence Fusion pipeline.
- Never broaden company or document scope and never mix another company's evidence.
- Upstream tool names, shell commands, web search, databases, and message actions are unavailable unless the FinSagent runtime explicitly supplies an audited adapter.
- Preserve metric qualifiers, periods, units, currencies, actual/estimate labels, source document IDs, pages, and chunk citations.
- If required evidence is absent or conflicting, state the gap; do not estimate, fabricate, or silently substitute public data.
- Recommendations, ratings, target prices, compliance decisions, or high-risk actions require human review.

## Adapted workflow

# 产品智能匹配

## 可用工具

本技能可调用以下 MCP 数据服务，执行流程中按需选用：

**盈米金融数据（qieman）**
- 服务地址：`https://dashscope.aliyuncs.com/api/v1/mcps/Qieman/sse`
- 核心能力：基金搜索/诊断、组合分析/回测、资产配置方案、CFP 工具链、图表渲染
- 本技能主要工具：`SearchFunds`, `GetPopularFund`, `BatchGetFundsDetail`, `GetBatchFundPerformance`, `AnalyzeFundRisk`, `GetFundDiagnosis`, `RenderEchart`

**恒生聚源金融数据（上游外部金融数据服务）**
- 服务地址：开通恒生聚源 MCP 服务后获取，格式为 `https://dashscope.aliyuncs.com/api/v1/mcps/<your-mcp-id>/mcp`
- 核心能力：个股研究(A/H/US)、财务报表、资金流向、研报舆情、理财产品、宏观数据
- 本技能主要工具：`FundMultipleFactorFilter`, `FinancialProductFilter`, `ProductBasicInfoList`, `CreditBondBaseInfo`

## 核心原则

**图表优先，文字精简。** 推荐产品的业绩对比数据必须通过 `RenderEchart` 生成可视化图表，让客户经理一眼看出产品优劣，文字聚焦匹配理由和话术。

## 输入要求

### 必填信息
- 客户风险等级（R1-R5）
- 需求描述（产品类型/配置缺口/投资金额，至少一项）

### 可选信息
- 当前持仓概况（避免推荐重复或高相关的产品）
- AUM、客户层级
- 排除条件（如"不要封闭式""不要新基金"）
- 产品品类偏好（基金/理财产品/债券）

如果用户仅说"推荐几只基金"，追问风险等级和产品类型需求。

## 执行流程

### 第一步：需求解析
- 确定筛选维度：产品类型、风险约束、规模要求、流动性需求
- 确定产品品类：基金 / 理财产品 / 债券 / 综合匹配

### 第二步：产品筛选（按品类路由）

**基金类需求（qieman + 上游外部金融数据服务）：**
- `SearchFunds`（qieman）：按条件搜索基金
- `GetPopularFund`（qieman）：获取热门基金作为补充候选

## 执行流程

## 输出模板

按以下结构输出，**图表嵌入对应章节，每只产品的推荐理由精简**：

```markdown

## 注意事项

- **图表为必选项**：推荐产品业绩对比柱状图为必须生成项
- 合规红线：不使用"推荐买入"，使用"供参考""可以关注"
- 适当性匹配：推荐产品风险等级不得高于客户风险等级
- 客观呈现：每只产品都呈现优势和风险点
- 推荐数量：一般推荐3只（给选择空间但不造成选择困难）
- 文字精简：全文控制在800-1200字（不含图表）
- 品类标注：明确标注每只推荐产品的品类（基金/理财产品/债券），方便客户经理区分
