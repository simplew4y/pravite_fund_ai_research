---
name: dianjin_wealth_copilot_portfolio_health_check
description: "对客户全部持仓进行穿透式体检，从资产配置、基金相关性、回测表现、风险暴露四个维度 输出诊断报告和可视化图表。 当用户提到持仓分析、组合诊断、持仓体检、配置检视、帮我看看持仓时触发。 不用于单只基金分析（由fund-deep-research处理）， 不用于专项风险排查（由portfolio-risk-radar处理）。"
version: 0.1.0
category: dianjin_finance
---

# 持仓健康诊断

> Adapted from `DianJin-SKILLS/wealth-copilot/L2-5_diagnosis/portfolio-health-check` at `fd9b51167d65`. The exact upstream text is retained in `references/UPSTREAM_SKILL.md` for review.

## FinSagent execution boundary

- Treat this package as an analysis workflow, not as authorization to call tools.
- Use only evidence already returned by the active dataset's Evidence Fusion pipeline.
- Never broaden company or document scope and never mix another company's evidence.
- Upstream tool names, shell commands, web search, databases, and message actions are unavailable unless the FinSagent runtime explicitly supplies an audited adapter.
- Preserve metric qualifiers, periods, units, currencies, actual/estimate labels, source document IDs, pages, and chunk citations.
- If required evidence is absent or conflicting, state the gap; do not estimate, fabricate, or silently substitute public data.
- Recommendations, ratings, target prices, compliance decisions, or high-risk actions require human review.

## Adapted workflow

# 持仓健康诊断

## 可用工具

本技能可调用以下 MCP 数据服务，执行流程中按需选用：

**盈米金融数据（qieman）**
- 服务地址：`https://dashscope.aliyuncs.com/api/v1/mcps/Qieman/sse`
- 核心能力：基金搜索/诊断、组合分析/回测、资产配置方案、CFP 工具链、图表渲染
- 本技能主要工具：`DiagnoseFundPortfolio`, `GetFundAssetClassAnalysis`, `BatchGetFundsDetail`, `GetBatchFundPerformance`, `AnalyzePortfolioRisk`, `GetFundsCorrelation`, `GetFundsBackTest`, `GuessFundCode`, `RenderEchart`

**恒生聚源金融数据（上游外部金融数据服务）**
- 服务地址：开通恒生聚源 MCP 服务后获取，格式为 `https://dashscope.aliyuncs.com/api/v1/mcps/<your-mcp-id>/mcp`
- 核心能力：个股研究(A/H/US)、财务报表、资金流向、研报舆情、理财产品、宏观数据
- 本技能可选工具：`IndustryValuation`, `ProductBasicInfoList`

## 核心原则

**图表优先，文字精简。** 所有定量数据必须通过 `RenderEchart` 生成可视化图表来呈现，文字仅用于解读关键洞察，不要大段重复图表中已展示的数据。整份报告力求直观、简洁、可操作。

## 输入要求

### 必填信息
- 持仓产品列表：产品名称 + 基金代码 + 持有金额

### 可选信息
- 客户风险等级、投资目标
- 需要重点关注的维度

如果用户仅提供基金名称未提供代码，先调用 `GuessFundCode` 匹配。如果用户未提供任何持仓信息，主动追问。

## 执行流程

### 第一步：信息收集
- 解析持仓列表，提取基金代码，计算各基金持有权重（金额占比）
- 如持仓中包含理财产品（非基金），可调用 `ProductBasicInfoList`（上游外部金融数据服务）获取产品基本信息

### 第二步：多维度数据采集（尽量并行调用）
- `DiagnoseFundPortfolio`：传入基金代码和持有金额，获取资产配置/相关性/回测三维评分及诊断建议
- `GetFundAssetClassAnalysis`：穿透分析资产大类分布（股票/债券/现金/另类各占比）
- `BatchGetFundsDetail`：各基金基本信息（类型、风险等级）
- `GetBatchFundPerformance`：各基金近期业绩（近1月/3月/1年收益、同类排名）
- `AnalyzePortfolioRisk`：组合整体风险指标
- `GetFundsCorrelation`：基金间相关性系数
- `GetFundsBackTest`：组合回测（年化收益、最大回撤、夏普比率）

## 执行流程

## 输出模板

按以下结构输出，**图表嵌入对应章节，文字控制在每个章节2-4句话**：

```markdown

## 注意事项

- **图表为必选项**：资产配置饼图、业绩对比柱状图、诊断雷达图为必须生成项，不得用文字表格替代
- 合规要求：不得包含收益承诺，建议用"建议考虑"而非"应该买"
- 措辞温和：如亏损较大，避免"亏损严重""配置混乱"等刺激性表述
- 文字精简：全文控制在800-1200字（不含图表），每个章节不超过4句话
- 数据完整性：如部分基金代码无法识别，标注并说明
