---
name: dianjin_investment_researcher_company_one_page_analysis
description: "上市公司一页纸分析技能。当用户要求对公司进行简洁分析、快速点评、一页纸分析、速评时使用，包括\"XX 公司一页纸\"、\"快速分析 XX 公司\"、\"XX 公司速评\"、\"XX 公司简单分析\"、\"XX 公司核心要点\"等表述。本技能从核心财务、业务亮点、估值水平、投资逻辑、主要风险五大维度，利用 上游外部金融数据服务 专业金融数据服务获取核心财务与估值数据，生成简洁的一页纸 Markdown 分析报告，聚焦核心信息，适合快速决策参考。**报告生成后直接在对话中显示完整内容，无需发送文件**。"
version: 0.1.0
category: dianjin_finance
---

# 上市公司一页纸分析技能

> Adapted from `DianJin-SKILLS/investment-researcher/company-one-page-analysis` at `fd9b51167d65`. The exact upstream text is retained in `references/UPSTREAM_SKILL.md` for review.

## FinSagent execution boundary

- Treat this package as an analysis workflow, not as authorization to call tools.
- Use only evidence already returned by the active dataset's Evidence Fusion pipeline.
- Never broaden company or document scope and never mix another company's evidence.
- Upstream tool names, shell commands, web search, databases, and message actions are unavailable unless the FinSagent runtime explicitly supplies an audited adapter.
- Preserve metric qualifiers, periods, units, currencies, actual/estimate labels, source document IDs, pages, and chunk citations.
- If required evidence is absent or conflicting, state the gap; do not estimate, fabricate, or silently substitute public data.
- Recommendations, ratings, target prices, compliance decisions, or high-risk actions require human review.

## Adapted workflow

# 上市公司一页纸分析技能

## 技能定位

本技能面向**投资经理、研究员、基金经理**，提供上市公司快速分析工具。在一页纸篇幅内，聚焦公司最核心的投资信息，帮助快速判断公司投资价值和风险，适合晨会汇报、快速决策、标的初筛等场景。

**核心优势**：
- ✅ **上游外部金融数据服务 专业数据源**：所有财务数据、估值数据优先通过 上游外部金融数据服务 服务获取
- ✅ **精炼高效**：五大核心维度，一页纸篇幅，直击投资要点
- ✅ **快速决策**：适合晨会汇报、标的跟踪、快速初筛

与 `company-deep-analysis` 的区别：
- **深度分析**：七大维度，全面深入，适合深度研究和首次覆盖
- **一页纸分析**：五大核心维度，精炼简洁，适合快速决策和标的跟踪

---

## 触发场景

当用户出现以下任一表述时触发本技能：
- "XX 公司一页纸"
- "一页纸分析 XX 公司"
- "快速分析 XX 公司"
- "XX 公司速评"
- "XX 公司简单分析"
- "XX 公司核心要点"
- "XX 公司投资亮点"
- "XX 公司快速点评"
- "帮我快速看一下 XX 公司"
- 其他要求对公司进行简洁快速分析的请求

---

## 数据获取策略

### 核心数据源

**核心原则：所有财务数据、估值数据优先通过 上游外部金融数据服务 服务获取。**

| 数据源 | 用途 | 优先级 |
|--------|------|--------|
| **上游外部金融数据服务** | 财务报表、财务分析指标、估值数据、一致预期 | **第一优先级** |
| `外部联网检索` | 公司基本信息、最新新闻、行业政策、风险信息 | 补充数据源 |
| `上游工商数据服务` | 企业工商基本信息、司法风险（如需） | 辅助数据源 |

## 报告输出格式

生成简洁的一页纸 Markdown 报告，格式如下：

```markdown

## 执行流程

## 注意事项

1. **篇幅控制**
   - 严格控制在"一页纸"篇幅内
   - 避免冗长描述，每点 1-2 句话
   - 优先使用表格呈现数据

2. **数据时效性**
   - 使用最新可得的财务数据
   - 标注数据截止日期
   - 估值数据使用最新行情

3. **聚焦核心**
   - 只呈现最关键的信息
   - 避免细节堆砌
   - 突出投资逻辑主线

4. **客观中立**
   - 保持客观，避免过度推荐
   - 风险提示必须充分
   - 明确说明"不构成投资建议"

5. **报告交付要求**
   - **直接在对话中显示完整报告内容**
   - 不需要发送文件
   - 使用 Markdown 格式，确保可读性

6. **数据准确性**
   - 财务数据需标注来源和报告期，优先使用 上游外部金融数据服务 获取
   - 估值数据为最新值
   - 不编造数据，数据暂缺时明确标注

---
