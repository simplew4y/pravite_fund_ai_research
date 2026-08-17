---
name: dianjin_investment_advisor_fund_diagnosis
description: "公募基金单基金综合诊断能力。适用于用户提出\"这只基金怎么样\"\"适不适合继续持有\"\"风险和收益特征如何\"\"帮我看看这只基金\"\"XX基金好不好\"\"XX基金值得买吗\"\"XX基金最近表现如何\"\"帮我分析一下XX基金\"等泛化诊断问题时，返回结构化的Markdown诊断报告。 当用户询问某只具体基金的整体评价、持有建议、风险收益特征、基金经理能力、持仓结构、业绩表现等综合性问题时必须使用此技能。 即使用户没有明确说\"诊断\"\"分析\"，只要涉及单基金的综合性评价就应触发。 覆盖场景：基金评价、持有建议、风险评估、业绩解读、经理分析、持仓解读、基金体检等。 每次仅分析一只基金，不处理多基金对比与量化建模。 不适"
version: 0.1.0
category: dianjin_finance
---

# 公募基金单基金综合诊断

> Adapted from `DianJin-SKILLS/investment-advisor/fund-diagnosis` at `fd9b51167d65`. The exact upstream text is retained in `references/UPSTREAM_SKILL.md` for review.

## FinSagent execution boundary

- Treat this package as an analysis workflow, not as authorization to call tools.
- Use only evidence already returned by the active dataset's Evidence Fusion pipeline.
- Never broaden company or document scope and never mix another company's evidence.
- Upstream tool names, shell commands, web search, databases, and message actions are unavailable unless the FinSagent runtime explicitly supplies an audited adapter.
- Preserve metric qualifiers, periods, units, currencies, actual/estimate labels, source document IDs, pages, and chunk citations.
- If required evidence is absent or conflicting, state the gap; do not estimate, fabricate, or silently substitute public data.
- Recommendations, ratings, target prices, compliance decisions, or high-risk actions require human review.

## Adapted workflow

# 公募基金单基金综合诊断

## 技能定位

本技能专注于**单只公募基金**的全面诊断分析，通过多维度数据整合，为用户提供结构化的基金评估报告。

**核心原则：每次仅分析一只基金，不处理多基金对比。**

## 触发场景

当用户提出以下类型的问题时触发本技能：

- "这只基金怎么样？"
- "XX基金适不适合继续持有？"
- "帮我看看XX基金的风险和收益特征"
- "XX基金值得买入吗？"
- "XX基金最近表现如何？"
- "XX基金好不好？"
- 其他针对单只基金的概括性评价请求

**不触发的场景：**
- 多基金对比分析（如"A基金和B基金哪个好"）
- 基金筛选（如"帮我选几只好的债券基金"）
- 具体指标计算（如"XX基金的夏普比率是多少"）
- 回测建模（如"帮我回测XX基金过去三年的表现"）

## 诊断流程

### 第一步：识别基金

从用户输入中提取基金名称或基金代码。如果用户只提供了基金名称，需要先通过 `FundBasicInfoReport` 确认基金代码。

**注意：** 如果用户输入模糊或存在多只同名基金，应主动询问用户确认具体是哪一只基金。

### 第二步：数据采集

按以下维度依次查询基金数据，所有数据查询优先使用 `上游外部金融数据服务` 服务：

| 诊断维度 | 查询工具 | 说明 |
|---------|---------|------|
| 基本信息 | `FundBasicInfoReport` | 基金类型、成立时间、规模、费率、业绩基准等 |
| 阶段业绩 | `StageIncreaseReport` | 近1月、3月、6月、1年、2年、3年收益率及同类排名 |
| 风险收益 | `FundIncomeRiskReport` | 夏普比率、最大回撤、波动率、Calmar比率等 |
| 动态回撤 | `FundDynamicRetracementReport` | 历史回撤走势与关键回撤事件 |
| 基金经理 | `FundManagerInfoReport` | 现任经理背景、从业年限、管理规模 |

## 报告结构

```markdown

## 注意事项

1. **数据时效性**：所有数据均为历史数据，反映的是过去表现，不代表未来
2. **客观中立**：报告应保持客观中立，避免过度乐观或悲观的表述
3. **免责声明**：每份报告末尾必须附加投资风险提示和免责声明
4. **单基金限制**：本技能每次仅分析一只基金，如涉及多只基金，应告知用户本技能限制并建议分别诊断
5. **数据缺失处理**：如某项数据查询失败或缺失，应在报告中标注"数据暂缺"，不影响其他维度的分析
6. **基金类型适配**：根据基金类型（股票型/混合型/债券型/指数型/FOF等）调整分析重点，债券型基金侧重信用风险和久期分析，股票型基金侧重选股能力和行业配置
