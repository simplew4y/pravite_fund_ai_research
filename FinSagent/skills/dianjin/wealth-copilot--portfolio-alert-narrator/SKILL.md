---
name: dianjin_wealth_copilot_portfolio_alert_narrator
description: "监测持仓基金异动信号（净值大幅波动、分红公告、基金经理变更）， 生成客户可理解的解读和应对建议。 当用户提到基金跌了怎么办、净值异动、基金分红了、 基金经理换了、基金有什么公告时触发。 不用于系统性市场事件解读（由market-event-interpreter处理）。"
version: 0.1.0
category: dianjin_finance
---

# 持仓异动解读

> Adapted from `DianJin-SKILLS/wealth-copilot/L2-8_companion/portfolio-alert-narrator` at `fd9b51167d65`. The exact upstream text is retained in `references/UPSTREAM_SKILL.md` for review.

## FinSagent execution boundary

- Treat this package as an analysis workflow, not as authorization to call tools.
- Use only evidence already returned by the active dataset's Evidence Fusion pipeline.
- Never broaden company or document scope and never mix another company's evidence.
- Upstream tool names, shell commands, web search, databases, and message actions are unavailable unless the FinSagent runtime explicitly supplies an audited adapter.
- Preserve metric qualifiers, periods, units, currencies, actual/estimate labels, source document IDs, pages, and chunk citations.
- If required evidence is absent or conflicting, state the gap; do not estimate, fabricate, or silently substitute public data.
- Recommendations, ratings, target prices, compliance decisions, or high-risk actions require human review.

## Adapted workflow

# 持仓异动解读

## 可用工具

本技能可调用以下 MCP 数据服务，执行流程中按需选用：

**盈米金融数据（qieman）**
- 服务地址：`https://dashscope.aliyuncs.com/api/v1/mcps/Qieman/sse`
- 核心能力：基金搜索/诊断、组合分析/回测、资产配置方案、CFP 工具链、图表渲染
- 本技能主要工具：`BatchGetFundNavHistory`, `GetFundAnnouncements`, `GetAnnouncementContent`, `BatchGetFundsDetail`, `getBondFundWithAlertRecord`, `getFundDiveCount`

**恒生聚源金融数据（上游外部金融数据服务）**
- 服务地址：开通恒生聚源 MCP 服务后获取，格式为 `https://dashscope.aliyuncs.com/api/v1/mcps/<your-mcp-id>/mcp`
- 核心能力：个股研究(A/H/US)、财务报表、资金流向、研报舆情、理财产品、宏观数据
- 本技能可选工具：`FundAnnouncement`, `StockNewslist`

## 输入要求

### 必填信息
- 基金名称或代码
- 异动类型或用户关注的情况

### 可选信息（通过上下文注入）
- 客户持有金额
- 客户风险等级

## 执行流程

### 第一步：异动信息采集

**qieman 数据源：**
- 调用 `BatchGetFundNavHistory` 获取近期净值走势，识别异常波动
- 调用 `GetFundAnnouncements` 查询近期公告
- 如有异动公告，调用 `GetAnnouncementContent` 获取公告详情
- 调用 `BatchGetFundsDetail` 获取基金最新信息
- 调用 `getBondFundWithAlertRecord` 检查债券基金异动告警（如为债基）
- 调用 `getFundDiveCount` 获取跳水/异动次数

**上游外部金融数据服务 数据源（异动原因补充，可选）：**
- 调用 `FundAnnouncement` 获取更全面的基金公告信息
- 调用 `StockNewslist` 获取重仓股相关新闻，辅助分析净值异动是否与重仓股事件有关

### 第二步：异动分析
- 判断异动类型：
  - 净值大跌（>2%单日跌幅）

## 执行流程

## 输出模板

```markdown

## 注意事项

- 及时性：异动解读需要快速响应
- 不恐慌：即使是负面异动，也要理性分析
- 区分系统性和个别性：市场整体下跌 vs 基金个股问题
- 有预案：针对客户可能的反应准备话术
