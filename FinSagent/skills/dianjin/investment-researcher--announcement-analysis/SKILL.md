---
name: dianjin_investment_researcher_announcement_analysis
description: "解读上市公司重大公告（年报、季报、业绩预告、并购重组、定增、增减持、股权激励、重大合同等），生成结构化的解读报告。适用于基金研究员、投资经理等需要快速理解公告核心信息、分析预期差、提炼投资要点的场景。当用户提到公告解读、公告分析、公告点评、研报点评、业绩解读、财报分析、定增分析、减持分析、股权激励分析、重大合同分析、并购重组分析、回购分析、股权质押分析、诉讼处罚分析时使用此 skill。默认输出结构化 Markdown 格式报告。"
version: 0.1.0
category: dianjin_finance
---

# 重大公告解读技能

> Adapted from `DianJin-SKILLS/investment-researcher/announcement-analysis` at `fd9b51167d65`. The exact upstream text is retained in `references/UPSTREAM_SKILL.md` for review.

## FinSagent execution boundary

- Treat this package as an analysis workflow, not as authorization to call tools.
- Use only evidence already returned by the active dataset's Evidence Fusion pipeline.
- Never broaden company or document scope and never mix another company's evidence.
- Upstream tool names, shell commands, web search, databases, and message actions are unavailable unless the FinSagent runtime explicitly supplies an audited adapter.
- Preserve metric qualifiers, periods, units, currencies, actual/estimate labels, source document IDs, pages, and chunk citations.
- If required evidence is absent or conflicting, state the gap; do not estimate, fabricate, or silently substitute public data.
- Recommendations, ratings, target prices, compliance decisions, or high-risk actions require human review.

## Adapted workflow

# 重大公告解读技能

## 技能定位

本技能帮助基金行业研究员、投资经理等专业人士快速、专业地解读上市公司重大公告，**以 上游外部金融数据服务 金融数据服务为核心数据源**，生成结构化的解读报告。核心方法论采用券商研报的标准点评框架，注重边际变化提取和预期差分析。

**核心优势**：
- ✅ **上游外部金融数据服务 专业数据源**：所有财务数据、估值数据、一致预期优先通过 上游外部金融数据服务 服务获取
- ✅ **分析框架专业**：采用券商研报标准点评框架，注重边际变化和预期差分析
- ✅ **覆盖场景全面**：支持 13 种公告类型的专项分析模板
- ✅ **输出结构化**：标准化 Markdown 格式报告，适合投资决策参考

**输出格式**：
- 默认生成结构化 Markdown 格式报告
- 如用户明确要求 Word 文档，可调用相关工具生成
- 报告内容包含核心公告概览、财务数据分析、投资要点总结、风险提示等完整内容

## 触发场景

当用户提出以下任一需求时，应触发本技能：

| 场景类型 | 典型表述 |
|----------|----------|
| 公告解读 | "帮我解读一下 XX 公司的公告"、"这个公告什么意思"、"分析一下这个公告" |
| 业绩分析 | "XX 公司业绩怎么样"、"财报解读"、"业绩预告分析"、"业绩快报点评" |
| 资本运作 | "定增怎么看"、"并购重组分析"、"可转债点评"、"配股影响" |
| 股权变动 | "大股东减持怎么看"、"增持分析"、"回购点评"、"股权质押风险" |
| 经营事项 | "重大合同影响"、"对外投资分析"、"股权激励怎么样" |
| 风险事件 | "被处罚了影响多大"、"诉讼风险分析"、"退市风险" |

## 工作流程

### Step 1：评估输入信息

**首先向用户确认以下信息：**

1. **公告来源**：用户是否提供了公告原文文件（PDF/文本）、公告链接，或仅提供了公司名称和公告类型？
2. **公司信息**：公司名称和股票代码（如用户未提供，需询问）
3. **公告类型**：属于哪一类（若用户未说明，根据公告内容自动识别）

**信息获取策略：**

- 若用户已提供公告文件/链接 → 直接进入 Step 2
- 若用户仅提供公司名称 + 公告类型 → **优先使用 上游外部金融数据服务 服务查询公告信息**，辅以 `外部联网检索` 搜索最新公告
- 若信息不足 → 向用户询问

## 工作流程

## 报告结构（Markdown 格式）

## 注意事项

1. 若用户未提供公告原文，提示用户上传或提供链接
2. 专业术语首次出现时简要解释
3. 报告末尾必须添加免责声明
4. 解读日期使用当前日期
5. **数据来源优先级：上游外部金融数据服务 > 公司公告 > 券商研报 > 财经新闻**
6. 多公告场景下，使用表格对比展示各公告核心信息
7. 使用 √ 和 △ 符号标记亮点和风险，增强可读性
8. 如用户明确要求 Word 文档，可告知用户当前默认输出为 Markdown 格式，如需 Word 可另行处理
9. **数据缺失处理**：如 上游外部金融数据服务 部分数据无法获取，在对应位置标注"未披露"，不可编造数据

---
