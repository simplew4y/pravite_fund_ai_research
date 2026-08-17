---
name: dianjin_investment_researcher_company_deep_analysis
description: "上市公司深度分析技能。当用户要求对公司进行深度分析、全面研究、投资价值分析时使用，包括\"分析 XX 公司\"、\"对 XX 公司做深度研究\"、\"研究 XX 公司的投资价值\"、\"XX 公司深度分析\"、\"XX 公司全面分析\"、\"帮我深度研究一下 XX 公司\"等表述。本技能从财务分析、业务分析、行业分析、估值分析、风险分析、管理层分析、政策风险七大维度，利用东方财富妙想、企业工商查询等工具获取权威数据，生成面向专业研究员的结构化 Markdown 深度研究报告。**报告生成后直接在对话中显示完整内容，无需发送文件**。"
version: 0.1.0
category: dianjin_finance
---

# 上市公司深度分析技能

> Adapted from `DianJin-SKILLS/investment-researcher/company-deep-analysis` at `fd9b51167d65`. The exact upstream text is retained in `references/UPSTREAM_SKILL.md` for review.

## FinSagent execution boundary

- Treat this package as an analysis workflow, not as authorization to call tools.
- Use only evidence already returned by the active dataset's Evidence Fusion pipeline.
- Never broaden company or document scope and never mix another company's evidence.
- Upstream tool names, shell commands, web search, databases, and message actions are unavailable unless the FinSagent runtime explicitly supplies an audited adapter.
- Preserve metric qualifiers, periods, units, currencies, actual/estimate labels, source document IDs, pages, and chunk citations.
- If required evidence is absent or conflicting, state the gap; do not estimate, fabricate, or silently substitute public data.
- Recommendations, ratings, target prices, compliance decisions, or high-risk actions require human review.

## Adapted workflow

# 上市公司深度分析技能

## 技能定位

本技能面向**专业研究员**，提供上市公司全方位深度分析。通过调用 `上游外部金融数据服务` 专业金融数据服务与 `上游工商数据服务` 企业工商查询工具，从七大维度系统性地分析公司投资价值，生成机构级深度研究报告。

**核心优势**：
- ✅ **上游外部金融数据服务 专业数据源**：所有财务数据、估值数据、一致预期优先通过 上游外部金融数据服务 服务获取
- ✅ **分析框架系统**：覆盖财务、业务、行业、估值、风险、管理层、政策七大维度
- ✅ **深度逻辑推演**：不仅罗列数据，更注重数据背后的商业逻辑与投资价值
- ✅ **输出结构化**：标准化 Markdown 格式报告，直接在对话中展示完整内容

**输出格式**：
- 默认生成结构化 Markdown 格式报告
- **报告内容直接在对话中展示，无需发送文件**
- 如用户明确要求 Word 文档，可另行处理

---

## 触发场景

当用户出现以下任一表述时，应触发本技能：

| 用户表述 | 触发类型 |
|----------|----------|
| "分析 XX 公司" | 定向分析 |
| "对 XX 公司做深度研究" | 定向分析 |
| "研究 XX 公司的投资价值" | 定向分析 |
| "XX 公司深度分析" | 定向分析 |
| "XX 公司全面分析" | 定向分析 |
| "帮我深度研究一下 XX 公司" | 定向分析 |
| "XX 公司投资价值分析" | 定向分析 |

**注意**：用户只需提到公司名字 + 分析/研究/投资价值等关键词，即应触发本技能。

---

## 执行流程

### Step 1：获取公司核心数据

**1.1 提取公司名称/股票代码**

从用户输入中识别目标上市公司：
- 公司全称/简称（如"五粮液"、"茅台"）

## 执行流程

## 报告结构模板

```markdown

## 特殊场景处理

## 注意事项

1. **数据准确性**：财务数据需标注来源和报告期，优先使用 上游外部金融数据服务 获取
2. **客观中立**：分析应基于事实，避免主观臆断
3. **信息时效**：优先使用最新公开信息（最近 12 个月）
4. **逻辑严密**：投资逻辑需有数据支撑，避免空泛描述
5. **风险提示**：必须充分揭示风险，不回避负面信息
6. **同业选择**：可比公司应选择业务模式最接近的 3-5 家
7. **行业差异**：通用模板可能不适用于所有行业（如金融、地产需特殊处理），需提示用户
8. **数据来源**：财务/估值/一致预期优先 上游外部金融数据服务，基本信息/新闻使用 外部联网检索
9. **简洁优先**：报告控制在适中长度，重点突出核心逻辑
10. **持续更新**：提示用户投资需跟踪最新数据
11. **输出方式**：**报告内容直接在对话中展示，无需写入文件或发送给用户**

---
