---
name: dianjin_corporate_banker_financial_report_analysis
description: "尽调报告-财报分析技能。对上市公司或目标企业的财务报表进行全面深度分析。涵盖资产负债表、利润表、现金流量表三大核心报表的解读,通过计算盈利能力、偿债能力、运营效率、成长能力等关键财务指标,结合杜邦分析法拆解ROE驱动力,评估盈利质量(收现比/净现比),进行财务粉饰识别与风险预警,最终输出结构化的财务健康评估报告,为投资决策和经营管理提供数据支撑。当用户上传财务报表、提供公司名称或股票代码并要求进行财务分析时使用此技能。触发词包括:\"财报分析\"、\"财务报表分析\"、\"financial analysis\"、\"财务分析\"、\"分析财报\"、\"解读财报\"、\"财报解读\"、\"财务健康评估\"。不适用于:非财务数"
version: 0.1.0
category: dianjin_finance
---

# 财务报表深度分析(Financial Report Analysis)

> Adapted from `DianJin-SKILLS/corporate-banker/financial-report-analysis` at `fd9b51167d65`. The exact upstream text is retained in `references/UPSTREAM_SKILL.md` for review.

## FinSagent execution boundary

- Treat this package as an analysis workflow, not as authorization to call tools.
- Use only evidence already returned by the active dataset's Evidence Fusion pipeline.
- Never broaden company or document scope and never mix another company's evidence.
- Upstream tool names, shell commands, web search, databases, and message actions are unavailable unless the FinSagent runtime explicitly supplies an audited adapter.
- Preserve metric qualifiers, periods, units, currencies, actual/estimate labels, source document IDs, pages, and chunk citations.
- If required evidence is absent or conflicting, state the gap; do not estimate, fabricate, or silently substitute public data.
- Recommendations, ratings, target prices, compliance decisions, or high-risk actions require human review.

## Adapted workflow

# 财务报表深度分析(Financial Report Analysis)

## 目标角色 (Target Role)

- **角色**:对公客户经理、信贷审批官、风险经理
- **使用场景**:贷前尽调财务分析、年度贷后检视、大额授信审批、重组/展期评估
- **输出用途**:生成结构化财务健康评估报告,为授信决策和投资决策提供数据支撑
- **决策层级**:信贷审批核心参考材料,风险等级 high,需信贷审批官复核
- **执行频率**:每次授信申请前执行一次,贷后每年至少执行一次

## 数据接入 (Data Sources)

### 必需数据
| 数据项 | 来源 | 获取方式 | 敏感级别 |
|--------|------|---------|----------|
| 财务报表三表 | 用户上传/公开披露 | 文件读取(PDF/Excel) | 内部 |
| 报表附注 | 用户上传/公开披露 | 文件读取 | 内部 |
| 审计报告 | 用户上传/公开披露 | 文件读取 | 内部 |
| 行业财务基准 | Wind/同花顺 | API/数据订阅 | 公开 |
| 历史财务分析报告 | 行内影像档案系统 | API: /api/reports/list | 内部 |

### 数据脱敏规则
- 客户身份证号:显示前3后4,中间用 * 替代
- 银行账号:仅显示后4位
- 客户商业机密信息(如核心客户名单、供应商明细):在报告中使用"某客户/某供应商"代替
- 敏感财务数据(如未公开业绩):仅在内部报告中使用,不得外传
- 关联方信息:在内部报告中标注全名,对外报告使用"关联方A/B/C"

### 降级策略
- 如果审计报告不可用:标注"审计意见未核实",基于财报继续分析,但降低信用评级
- 如果报表附注缺失:标注"附注未提供,部分科目明细无法核实",仅分析三表数据
- 如果行业基准数据不可用:标注"行业对标数据未获取",仅做纵向趋势分析
- 如果历史财务报告不可用:标注"无历史报告对比",仅做本期静态分析
- 如果财务数据仅有1年:标注"数据不足,趋势分析不可用",仅做单期分析
- 如果系统不可用(Wind/同花顺):使用最近一次下载的行业基准数据(标注数据日期)

---

## 执行流程 (Workflow)

### 步骤 0:数据确认与验证

列出输入参数:企业名称、股票代码(如有)、报告期、分析场景(贷前尽调/贷后检视/风险预警)。
确认数据时间范围(近3-5年)和会计准则(企业会计准则/国际财务报告准则)。
运行 `scripts/validate_financial_report.py` 检查输入参数完整性和三表勾稽关系。

## 执行流程 (Workflow)

## 输出格式 (Output Format)

使用 `assets/financial-report-template.md` 模板。
报告必须包含以下章节:

1. 公司概况与分析框架
2. 盈利能力分析(含驱动力拆解、质量评估、可持续性判断)
3. 资产质量分析(核心资产、应收账款、存货、商誉)
4. 负债与偿债能力(结构分析、偿债压力、期限匹配)
5. 现金流分析(三大现金流概览、经营现金流质量、自由现金流)
6. 杜邦分析(ROE三因素拆解、变动归因、同业对标)
7. 财务预警扫描(异常信号清单、勾稽关系验证、盈余管理迹象)
8. 综合评价与建议(财务健康度、核心优势与风险、跟踪指标、决策参考)

所有数据标注:数据来源 + 报告期 + 是否经审计。

**下游兼容性**:本输出可被 `submit-credit-application` 解析使用,关键字段包括:
- 财务健康评级(字符串:优秀/良好/一般/警示/危险)
- 核心财务指标(表格:ROE、毛利率、净利率、资产负债率、DSCR等)
- 红线触发清单(数组:如触发,列出 R1-R8 编号)
- 审计意见类型(字符串:标准无保留/带强调段/保留意见/否定意见/无法表示意见)

**免责声明**:报告末尾必须引用 `shared/disclaimer-template.md`,确保包含"本分析不构成投资建议"等必要声明。

---

## 约束条件 (Constraints)

1. **数据可溯源性**:所有结论须明确标注数据来源(年报/季报/审计报告/附注),引用具体页码或科目
2. **不确定性显式标注**:对数据缺失、口径不一致或无法核实的科目,须以"待核实/数据缺失"显式标注,禁止推测填充
3. **时效性要求**:所有财务数据须标注报告期,分析结论须覆盖近3年(信贷场景要求近5年),跨期对比须统一口径
4. **量化结论优先**:所有风险定性判断(如"盈利能力下降")须附具体量化指标(如"毛利率3年累计下滑8.2pct"),禁止仅凭定性描述下结论
5. **中立审慎立场**:对乐观数据保持审慎,对正面解读提供反向验证,避免管理层叙事主导分析结论
6. **三表勾稽验证**:资产负债表期末与期初差 = 现金流量表期末现金;利润表净利润与资产负债表权益变动匹配
7. **行业对标**:ROE、毛利率、资产负债率等核心指标须提供行业均值参考
8. **禁止跳过步骤**:不得跳过 Workflow 中的任何步骤,特别是数据质量评估、盈利质量评估、红线自检、勾稽验证
9. **红线执行强制**:如触发任何红线(R1-R8),必须在报告开头显著标注,并建议暂停授信决策

## 分析原则

- **实质重于形式**:穿透会计处理看经营实质,关注现金流而非仅看利润
- **横纵对比**:纵向看趋势变化,横向对标同业,在比较中发现问题
- **异常驱动**:重点关注异常波动的科目,分析其背后的业务逻辑
- **保守审慎**:对乐观数据持审慎态度,对风险信号保持高度敏感
- **勾稽验证**:通过报表间的勾稽关系交叉验证数据合理性
- **量化结论**:所有定性判断需有定量数据支持

## 踩坑记录 (Gotchas)
