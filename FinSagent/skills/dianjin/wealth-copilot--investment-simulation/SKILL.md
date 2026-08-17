---
name: dianjin_wealth_copilot_investment_simulation
description: "运用蒙特卡洛模拟对拟投资组合进行多周期收益概率测算， 可视化乐观/中性/悲观三种情景，帮助客户理解预期风险收益。 当用户提到收益模拟、能赚多少、预期收益、蒙特卡洛、 投资回报、投多少能赚多少时触发。 不用于资产配置方案设计（由asset-allocation-optimizer处理）。"
version: 0.1.0
category: dianjin_finance
---

# 投资收益模拟

> Adapted from `DianJin-SKILLS/wealth-copilot/L2-6_allocation/investment-simulation` at `fd9b51167d65`. The exact upstream text is retained in `references/UPSTREAM_SKILL.md` for review.

## FinSagent execution boundary

- Treat this package as an analysis workflow, not as authorization to call tools.
- Use only evidence already returned by the active dataset's Evidence Fusion pipeline.
- Never broaden company or document scope and never mix another company's evidence.
- Upstream tool names, shell commands, web search, databases, and message actions are unavailable unless the FinSagent runtime explicitly supplies an audited adapter.
- Preserve metric qualifiers, periods, units, currencies, actual/estimate labels, source document IDs, pages, and chunk citations.
- If required evidence is absent or conflicting, state the gap; do not estimate, fabricate, or silently substitute public data.
- Recommendations, ratings, target prices, compliance decisions, or high-risk actions require human review.

## Adapted workflow

# 投资收益模拟

## 可用工具

本技能可调用以下 MCP 数据服务，执行流程中按需选用：

**盈米金融数据（qieman）**
- 服务地址：`https://dashscope.aliyuncs.com/api/v1/mcps/Qieman/sse`
- 核心能力：基金搜索/诊断、组合分析/回测、资产配置方案、CFP 工具链、图表渲染
- 本技能主要工具：`MonteCarloSimulate`, `GetFundsBackTest`, `AnalyzePortfolioRisk`, `RenderEchart`

**恒生聚源金融数据（上游外部金融数据服务）**
- 服务地址：开通恒生聚源 MCP 服务后获取，格式为 `https://dashscope.aliyuncs.com/api/v1/mcps/<your-mcp-id>/mcp`
- 核心能力：个股研究(A/H/US)、财务报表、资金流向、研报舆情、理财产品、宏观数据
- 本技能可选工具：`IndexDailyQuote`

## 核心原则

**图表优先，文字精简。** 收益模拟的核心价值在于可视化——概率分布、三情景对比等必须通过 `RenderEchart` 生成图表呈现，文字仅用于通俗解读。

## 输入要求

### 必填信息
- 投资组合或资产配置方案（基金代码+权重 或 大类资产+权重）
- 投资金额

### 可选信息
- 投资期限（默认1年/3年/5年三档）
- 定投模式（每月追加金额）
- 目标收益率

## 执行流程

### 第一步：解析投资方案
- 提取资产配置权重
- 如传入基金代码，映射到大类资产

### 第二步：蒙特卡洛模拟
- 调用 `MonteCarloSimulate` 传入资产权重配置
- 获取不同周期（1年/3年/5年）的收益分布
- 提取关键分位数：5%/25%/50%/75%/95%

### 第三步：补充历史回测
- 调用 `GetFundsBackTest` 对组合做历史回测
- 调用 `AnalyzePortfolioRisk` 获取组合风险指标

## 执行流程

## 输出模板

按以下结构输出，**图表嵌入对应章节，文字通俗精简**：

```markdown

## 注意事项

- **图表为必选项**：收益模拟柱状图、配置饼图、盈亏概率图为必须生成项
- 不是收益承诺：反复强调"模拟""概率""参考"
- 通俗解读：将概率数据翻译成客户能理解的具体金额和生活化语言
- 展示风险面：不仅展示收益，也展示亏损概率
- 文字精简：全文控制在600-1000字（不含图表）
