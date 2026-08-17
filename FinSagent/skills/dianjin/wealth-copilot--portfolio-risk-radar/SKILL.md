---
name: dianjin_wealth_copilot_portfolio_risk_radar
description: "对投资组合进行专项风险扫描，识别集中度、相关性、流动性、 风格漂移等风险因子，输出风险预警和对冲建议。 当用户提到风险评估、组合风险、风险预警、集中度过高、 相关性分析、最大回撤时触发。 不用于全面持仓体检（由portfolio-health-check处理）。"
version: 0.1.0
category: dianjin_finance
---

# 组合风险雷达

> Adapted from `DianJin-SKILLS/wealth-copilot/L2-5_diagnosis/portfolio-risk-radar` at `fd9b51167d65`. The exact upstream text is retained in `references/UPSTREAM_SKILL.md` for review.

## FinSagent execution boundary

- Treat this package as an analysis workflow, not as authorization to call tools.
- Use only evidence already returned by the active dataset's Evidence Fusion pipeline.
- Never broaden company or document scope and never mix another company's evidence.
- Upstream tool names, shell commands, web search, databases, and message actions are unavailable unless the FinSagent runtime explicitly supplies an audited adapter.
- Preserve metric qualifiers, periods, units, currencies, actual/estimate labels, source document IDs, pages, and chunk citations.
- If required evidence is absent or conflicting, state the gap; do not estimate, fabricate, or silently substitute public data.
- Recommendations, ratings, target prices, compliance decisions, or high-risk actions require human review.

## Adapted workflow

# 组合风险雷达

## 可用工具

本技能可调用以下 MCP 数据服务，执行流程中按需选用：

**盈米金融数据（qieman）**
- 服务地址：`https://dashscope.aliyuncs.com/api/v1/mcps/Qieman/sse`
- 核心能力：基金搜索/诊断、组合分析/回测、资产配置方案、CFP 工具链、图表渲染
- 本技能主要工具：`AnalyzePortfolioRisk`, `AnalyzeFundRisk`, `GetFundsCorrelation`, `GetAssetAllocation`, `fund-equity-position`, `fund-recovery-ability`, `RenderEchart`

**恒生聚源金融数据（上游外部金融数据服务）**
- 服务地址：开通恒生聚源 MCP 服务后获取，格式为 `https://dashscope.aliyuncs.com/api/v1/mcps/<your-mcp-id>/mcp`
- 核心能力：个股研究(A/H/US)、财务报表、资金流向、研报舆情、理财产品、宏观数据
- 本技能可选工具：`MarketFundFlowRank`, `IndustryValuation`

## 核心原则

**图表优先，文字精简。** 风险评分、相关性矩阵等定量数据必须通过 `RenderEchart` 生成可视化图表呈现，文字仅用于解读预警要点和给出对冲建议。

## 输入要求

### 必填信息
- 持仓基金列表：基金代码 + 持有金额/权重

### 可选信息
- 客户风险等级（评估风险是否超标）
- 关注的具体风险维度

## 执行流程

### 第一步：解析持仓
- 提取基金代码和权重
- 如仅有金额，计算相对权重

### 第二步：风险维度扫描（尽量并行）

**qieman 数据源：**
- `AnalyzePortfolioRisk`：组合风险指标（风险评分、R方、残差方差）
- `AnalyzeFundRisk`：各基金风险评分
- `GetFundsCorrelation`：基金间相关性
- `GetAssetAllocation`：资产配置分析（含雷达图评分）
- `fund-equity-position`：权益仓位
- `fund-recovery-ability`：回撤修复能力

## 执行流程

## 输出模板

按以下结构输出，**图表嵌入对应章节，文字精简聚焦预警和建议**：

```markdown

## 注意事项

- **图表为必选项**：风险雷达图和基金风险对比柱状图为必须生成项
- 区分于全面诊断：本Skill聚焦风险维度，不做收益评价
- 不制造恐慌：客观陈述风险，不使用耸人听闻的表达
- 可操作性：每个风险点都要给出具体的对冲建议
- 文字精简：全文控制在600-1000字（不含图表）
