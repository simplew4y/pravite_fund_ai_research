---
name: dianjin_corporate_banker_credit_industry_analysis
description: "尽调报告-信贷行业深度分析技能。对特定行业进行系统性研究，运用PEST宏观环境分析、波特五力竞争模型、产业链价值链拆解等经典框架，从市场规模测算（TAM/SAM/SOM）、竞争格局演变、供需平衡推演、政策环境梳理、技术趋势研判等多维度全面刻画行业现状，并通过情景分析法对行业短中长期发展趋势进行前瞻预判，为授信决策和行业理解提供专业研究支持。触发词包括：\"行业分析\"、\"industry analysis\"、\"行业研究\"、\"行业评估\"、\"行业尽调\"、\"行业准入\"、\"行业授信政策\"、\"行业风险排查\"。不适用于：企业财务数据分析、股权穿透分析、产品营销方案设计、市场调研、个人信贷行业咨询。"
version: 0.1.0
category: dianjin_finance
---

# 行业分析（Industry Analysis）

> Adapted from `DianJin-SKILLS/corporate-banker/credit-industry-analysis` at `fd9b51167d65`. The exact upstream text is retained in `references/UPSTREAM_SKILL.md` for review.

## FinSagent execution boundary

- Treat this package as an analysis workflow, not as authorization to call tools.
- Use only evidence already returned by the active dataset's Evidence Fusion pipeline.
- Never broaden company or document scope and never mix another company's evidence.
- Upstream tool names, shell commands, web search, databases, and message actions are unavailable unless the FinSagent runtime explicitly supplies an audited adapter.
- Preserve metric qualifiers, periods, units, currencies, actual/estimate labels, source document IDs, pages, and chunk citations.
- If required evidence is absent or conflicting, state the gap; do not estimate, fabricate, or silently substitute public data.
- Recommendations, ratings, target prices, compliance decisions, or high-risk actions require human review.

## Adapted workflow

# 行业分析（Industry Analysis）

## 目标角色 (Target Role)

- **角色**：对公客户经理、信贷审批官、行业研究员、风险经理
- **使用场景**：贷前行业准入评估、授信政策年度调整、特定客户行业背景分析、不良贷款成因分析、新兴行业准入研究
- **输出用途**：生成结构化行业深度分析报告，为授信决策和行业理解提供专业研究支持
- **决策层级**：信贷审批核心参考材料，风险等级 medium，须信贷审批官复核
- **执行频率**：每次授信申请前执行一次，授信政策年度调整时执行一次

## 数据接入 (Data Sources)

### 必需数据
| 数据项 | 来源 | 获取方式 | 敏感级别 |
|--------|------|---------|----------|
| 行业统计数据 | 国家统计局/行业协会 | API/文件读取 | 公开 |
| 上市公司财务数据 | Wind/同花顺/年报 | API/文件读取 | 公开 |
| 产业政策文件 | 发改委/工信部/财政部 | 文件读取 | 公开 |
| 产能利用率数据 | 工信部/行业协会 | API/文件读取 | 公开/内部 |
| 历史行业分析报告 | 行内知识库 | 文件读取 | 内部 |

### 数据脱敏规则
- 企业内部未公开财务数据：仅在内部报告中使用，不得外传
- 客户商业机密信息（如核心技术参数）：在对外报告中使用"某技术"代替
- 敏感政策文件（未公开）：仅在内部记录中标注，不对外披露
- 第三方商业数据：标注来源机构，不得擅自传播
- 行业集中度数据：使用区间值（如"CR5=40%-50%"）而非精确值

### 降级策略
- 如果 Wind/同花顺数据不可用：标注"行业财务数据未纳入"，基于公开数据继续分析
- 如果行业协会数据不可用：标注"行业统计数据缺失"，使用国家统计局数据替代
- 如果历史行业报告不可用：标注"无历史对比数据"，仅做当期分析
- 如果产能利用率数据不可用：标注"产能数据未核实"，基于企业调研数据估算
- 如果政策文件仅有1年：标注"政策历史数据不足"，仅做当期政策分析

---

## 约束条件 (Constraints)

> 监管依据：银监会《商业银行授信工作尽职指引》、人民银行《贷款通则》、
> 国家统计局《国民经济行业分类》（GB/T 4754-2017）、
> 发改委《产业结构调整指导目录》（现行版）、
> 工信部《重点行业领域产能过剩预警机制》

1. **行业边界清晰化**：分析前须明确界定行业口径（按 GB/T 4754-2017 四位代码），避免将相邻赛道混同分析

## 约束条件 (Constraints)

> 监管依据：银监会《商业银行授信工作尽职指引》、人民银行《贷款通则》、
> 国家统计局《国民经济行业分类》（GB/T 4754-2017）、
> 发改委《产业结构调整指导目录》（现行版）、
> 工信部《重点行业领域产能过剩预警机制》

1. **行业边界清晰化**：分析前须明确界定行业口径（按 GB/T 4754-2017 四位代码），避免将相邻赛道混同分析
2. **数据时效性要求**：定量数据须注明来源和截止日期，超过2年的数据须标注"历史参考"并提示可能已失效
3. **观点与事实分离**：客观事实（有来源数据支撑）与分析师推断（基于逻辑推演）须用不同措辞区分（推断用"预计/判断/估计"）
4. **量化结论优先**：所有方向性判断（如"竞争激烈/市场向好"）须附具体量化指标（如"CR5=47%，HHI=980"），禁止纯定性表述
5. **风险均衡呈现**：对存在争议的行业趋势，须同时呈现乐观与悲观依据，避免单一视角误导信贷决策
6. **数据来源分级**：一级来源（国家统计局/央行/上市公司公告）> 二级来源（行业协会）> 三级来源（商业研报），三级来源须标注机构及发布日期
7. **情景分析差异性**：乐观/中性/悲观三情景的核心假设须有实质差异（增速区间至少相差5pct），禁止伪情景分析
8. **禁止跳过步骤**：不得跳过任何分析步骤，即使中间结果"看起来正常"。所有数字必须展示计算过程。
9. **红线执行强制**：如触发6条行业红线（I1-I6）中任何一条，必须在报告开头显著标注，不得隐藏在正文中。

## 执行流程 (Workflow)

## 输出格式 (Output Format)

使用 `assets/industry-analysis-template.md` 模板。
报告必须包含以下章节：

1. 行业概况（行业定义与分类、生命周期定位、市场规模与增速、核心跟踪指标）
2. 产业链分析（产业链全景图、价值链利润池分布、上下游分析、关键瓶颈与国产替代）
3. 竞争格局（市场集中度与演变趋势、竞争要素与核心壁垒、主要企业深度对标、波特五力定量评估）
4. 宏观环境（PEST：政策/经济/社会/技术）
5. 供需分析（供给侧现状与展望、需求侧驱动力拆解、供需平衡表与价格趋势）
6. 驱动因素与风险（增长驱动力、风险矩阵、敏感性分析）
7. 发展趋势与展望（短期/中期/长期趋势、三种情景分析）
8. 结论与建议（行业评级、推荐关注的细分赛道、关键假设与风险提示）

所有数据标注：数据来源 + 数据日期 + 是否最新数据。

**免责声明**：报告末尾必须引用 `shared/disclaimer-template.md` 模板，确保包含"不构成投资建议"等必要声明。

**下游兼容性**：本输出可被 credit-due-diligence 和 submit-credit-application Skill 解析使用。关键输出字段（行业评级、红线触发状态、产能利用率）采用结构化表格格式，禁止仅放在自然语言段落中。

---

## 踩坑记录 (Gotchas)
