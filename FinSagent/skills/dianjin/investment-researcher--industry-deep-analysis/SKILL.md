---
name: dianjin_investment_researcher_industry_deep_analysis
description: "行业深度分析技能。当用户要求对某个行业进行深度分析、全面研究、行业投资价值分析时使用，包括\"分析 XX 行业\"、\"对 XX 行业做深度研究\"、\"XX 行业投资价值分析\"、\"XX 行业深度分析\"、\"XX 行业全面分析\"、\"帮我深度研究一下 XX 行业\"等表述。本技能从行业概况、市场规模、产业链分析、竞争格局、行业趋势、进入壁垒、风险因素、投资机会八大维度，利用 上游外部金融数据服务 专业金融数据服务获取权威数据，生成面向专业研究员的结构化 Markdown 行业深度研究报告。**报告生成后直接在对话中显示完整内容，无需发送文件**。"
version: 0.1.0
category: dianjin_finance
---

# 行业深度分析技能

> Adapted from `DianJin-SKILLS/investment-researcher/industry-deep-analysis` at `fd9b51167d65`. The exact upstream text is retained in `references/UPSTREAM_SKILL.md` for review.

## FinSagent execution boundary

- Treat this package as an analysis workflow, not as authorization to call tools.
- Use only evidence already returned by the active dataset's Evidence Fusion pipeline.
- Never broaden company or document scope and never mix another company's evidence.
- Upstream tool names, shell commands, web search, databases, and message actions are unavailable unless the FinSagent runtime explicitly supplies an audited adapter.
- Preserve metric qualifiers, periods, units, currencies, actual/estimate labels, source document IDs, pages, and chunk citations.
- If required evidence is absent or conflicting, state the gap; do not estimate, fabricate, or silently substitute public data.
- Recommendations, ratings, target prices, compliance decisions, or high-risk actions require human review.

## Adapted workflow

# 行业深度分析技能

## 技能定位

本技能面向**专业研究员、投资机构、产业分析师**，提供全方位行业深度分析。通过调用多个专业金融数据工具和行业数据库，从八大维度系统性地分析行业投资价值、竞争格局和发展趋势，生成机构级行业深度研究报告。

## 触发场景

当用户出现以下任一表述时触发本技能：
- "对 XX 行业做深度分析"
- "分析 XX 行业"
- "XX 行业深度研究"
- "研究 XX 行业的投资价值"
- "XX 行业全面分析"
- "帮我深度研究一下 XX 行业"
- "XX 行业投资机会分析"
- "XX 行业发展趋势分析"
- 其他要求对行业进行多维度深度分析的请求

**适用行业类型**：
- A 股/港股/美股相关行业（如白酒行业、新能源汽车行业、半导体行业等）
- 新兴产业（如人工智能、云计算、生物医药等）
- 传统行业（如房地产、银行、保险、煤炭等）
- 细分赛道（如光伏逆变器、锂电隔膜、CXO 等）

## 数据获取策略

本技能采用多工具协同的数据获取策略，确保数据权威性和全面性：

### 核心数据源

**核心原则：所有行业数据、市场规模、竞争格局、财务估值数据优先通过 上游外部金融数据服务 服务获取。**

| 数据源 | 用途 | 优先级 |
|--------|------|--------|
| **上游外部金融数据服务** | 行业概览、市场规模、竞争格局、行业趋势、成分股筛选、财务估值 | **第一优先级** |
| `外部联网检索` | 行业政策信息、最新研究报告、国际对比数据、补充信息 | 补充数据源 |
| `上游工商数据服务` | 行业内主要企业工商信息、股权穿透、基础信息 | 辅助数据源 |

### 数据获取优先级

1. **行业数据与规模**：优先 上游外部金融数据服务 `IndustryOverview` / `IndustryMarketScale`
2. **竞争格局与成分股**：优先 上游外部金融数据服务 `IndustryCompetition` / `StockPool`
3. **行业趋势与研报**：优先 上游外部金融数据服务 `IndustryTrend` / `ResearchReport`
4. **企业信息**：上游外部金融数据服务 `CompanyProfile` 或 上游工商数据服务

## 报告输出格式

生成结构化 Markdown 报告，包含以下章节：

```markdown

## 执行流程

## 注意事项

1. **数据时效性**
   - 优先使用最新数据（2024 年、2025 年、2026 年）
   - 标注数据截止日期
   - 对于预测数据明确说明是预测值

2. **数据交叉验证**
   - 关键行业数据从多个来源验证
   - 发现数据冲突时，以权威机构数据为准
   - 在报告中标注数据来源

3. **专业性与客观性**
   - 使用专业术语，但避免过度晦涩
   - 保持客观中立，避免过度乐观/悲观
   - 明确区分事实和观点

4. **风险提示**
   - 风险揭示必须充分
   - 不提供确定性收益承诺
   - 明确说明"不构成投资建议"

5. **工具使用优先级**
   - 行业数据：优先 **上游外部金融数据服务** 相关工具
   - 企业信息：优先 **上游外部金融数据服务** StockPool 或 上游工商数据服务
   - 行业趋势/政策：可结合 外部联网检索
   - 避免过度依赖单一数据源

6. **报告交付要求**
   - **直接在对话中显示完整报告内容**
   - 不需要发送文件
   - 对话显示使用标准 Markdown 格式

7. **行业边界界定**
   - 对于宽泛行业（如"科技行业"），需要进一步细化
   - 对于细分行业，需要说明与所属行业的关系
   - 明确行业统计口径
