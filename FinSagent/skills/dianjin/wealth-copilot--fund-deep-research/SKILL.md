---
name: dianjin_wealth_copilot_fund_deep_research
description: "对单只基金进行全面尽调分析，按基金类型（股票型/债券型/混合型/指数型）自动选择分析路径， 输出业绩、风险、持仓、基金经理能力四维诊断报告。 当用户提到分析基金、基金怎么样、能不能买、基金诊断、基金尽调、这个基金经理靠谱吗时触发。 不用于多只基金的组合持仓分析（由portfolio-health-check处理）。"
version: 0.1.0
category: dianjin_finance
---

# 基金深度尽调

> Adapted from `DianJin-SKILLS/wealth-copilot/L2-5_diagnosis/fund-deep-research` at `fd9b51167d65`. The exact upstream text is retained in `references/UPSTREAM_SKILL.md` for review.

## FinSagent execution boundary

- Treat this package as an analysis workflow, not as authorization to call tools.
- Use only evidence already returned by the active dataset's Evidence Fusion pipeline.
- Never broaden company or document scope and never mix another company's evidence.
- Upstream tool names, shell commands, web search, databases, and message actions are unavailable unless the FinSagent runtime explicitly supplies an audited adapter.
- Preserve metric qualifiers, periods, units, currencies, actual/estimate labels, source document IDs, pages, and chunk citations.
- If required evidence is absent or conflicting, state the gap; do not estimate, fabricate, or silently substitute public data.
- Recommendations, ratings, target prices, compliance decisions, or high-risk actions require human review.

## Adapted workflow

# 基金深度尽调

## 可用工具

本技能可调用以下 MCP 数据服务，执行流程中按需选用：

**盈米金融数据（qieman）**
- 服务地址：`https://dashscope.aliyuncs.com/api/v1/mcps/Qieman/sse`
- 核心能力：基金搜索/诊断、组合分析/回测、资产配置方案、CFP 工具链、图表渲染
- 本技能主要工具：`SearchFunds`, `GuessFundCode`, `BatchGetFundsDetail`, `GetBatchFundPerformance`, `AnalyzeFundRisk`, `GetFundDiagnosis`, `BatchGetFundsHolding`, `getFundIndustryAllocation`, `getFundIndustryConcentration`, `getFundTurnoverRate`, `getFundBrinsonIndicator`, `getMarketTimingIndicator`, `getBondAllocationByFundCode`, `getBondFundCreditRatingLevel`, `getBondIndicator`, `getFundCampisiIndicator`, `RenderEchart`

**恒生聚源金融数据（上游外部金融数据服务）**
- 服务地址：开通恒生聚源 MCP 服务后获取，格式为 `https://dashscope.aliyuncs.com/api/v1/mcps/<your-mcp-id>/mcp`
- 核心能力：个股研究(A/H/US)、财务报表、资金流向、研报舆情、理财产品、宏观数据
- 本技能主要工具：`FundManagerInfoReport`, `FundManagerImageReport`, `ManagerProductsIncome`, `CompanyBasicInfo`, `ConsensusExpectation`, `FundAnnouncement`

## 核心原则

**图表优先，文字精简。** 业绩对比、行业配置等定量数据必须通过 `RenderEchart` 生成可视化图表呈现，文字仅用于解读关键洞察。

## 输入要求

### 必填信息
- 基金代码或基金名称（至少提供一个）

### 可选信息
- 分析侧重点（如"重点看风险""关注经理能力"）
- 对比基准或同类基金
- 客户风险等级（影响适配性评价）

如果用户提供基金名称但未提供代码，调用 `GuessFundCode` 或 `SearchFunds` 匹配。

## 执行流程

### 第一步：确定基金代码与类型
- 通过 `SearchFunds` 或 `GuessFundCode` 确认基金代码
- 调用 `BatchGetFundsDetail` 获取基金基本信息，确定基金类型

### 第二步：全维度数据采集（根据基金类型调整）

**通用数据（所有类型，qieman）：**
- `BatchGetFundsDetail`：基本概况、规模、基准、风险等级、经理信息
- `GetBatchFundPerformance`：各阶段收益、业绩分析指标
- `AnalyzeFundRisk`：风险评分、R方、残差方差
- `GetFundDiagnosis`：综合诊断、估值、盈利概率

## 执行流程

## 输出模板

按以下结构输出，**图表嵌入对应章节，文字每章节控制在2-4句话**：

```markdown

## 注意事项

- **图表为必选项**：业绩对比柱状图、配置饼图、四维雷达图为必须生成项
- 合规底线：不得出现"推荐买入""建议加仓"等直接投资建议用语
- 客观中立：优势和风险点都要提及，不做单方面美化
- 类型适配：根据基金类型（股/债/混合/QDII）自动调整分析框架
- 文字精简：全文控制在800-1200字（不含图表），每章节不超过4句话
- 数据源分工：基金维度数据用 qieman，经理画像和重仓股基本面用 上游外部金融数据服务
