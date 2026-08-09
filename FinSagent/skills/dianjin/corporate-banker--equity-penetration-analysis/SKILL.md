---
name: dianjin_corporate_banker_equity_penetration_analysis
description: "尽调报告-股权穿透图及关联方分析技能。对目标企业进行股权架构逐层穿透至自然人或终极控制人,绘制Mermaid股权架构图,认定实际控制人及一致行动人,识别法定与隐性关联方,分析关联交易公允性与利益输送风险,输出综合评估报告。触发词包括:\"股权穿透\"、\"equity penetration\"、\"关联方分析\"、\"实控人认定\"、\"关联关系图谱\"、\"集团架构穿透\"、\"关联担保网络\"、\"股权穿透分析\"。不适用于:非股权类数据分析、市场调研、行业宏观分析、简单工商信息查询、无具体企业背景的泛泛咨询、个人信贷股权穿透。"
version: 0.1.0
category: dianjin_finance
---

# 股权穿透图及关联方分析(Equity Penetration Analysis)

> Adapted from `DianJin-SKILLS/corporate-banker/equity-penetration-analysis` at `fd9b51167d65`. The exact upstream text is retained in `references/UPSTREAM_SKILL.md` for review.

## FinSagent execution boundary

- Treat this package as an analysis workflow, not as authorization to call tools.
- Use only evidence already returned by the active dataset's Evidence Fusion pipeline.
- Never broaden company or document scope and never mix another company's evidence.
- Upstream tool names, shell commands, web search, databases, and message actions are unavailable unless the FinSagent runtime explicitly supplies an audited adapter.
- Preserve metric qualifiers, periods, units, currencies, actual/estimate labels, source document IDs, pages, and chunk citations.
- If required evidence is absent or conflicting, state the gap; do not estimate, fabricate, or silently substitute public data.
- Recommendations, ratings, target prices, compliance decisions, or high-risk actions require human review.

## Adapted workflow

# 股权穿透图及关联方分析(Equity Penetration Analysis)

## 目标角色 (Target Role)

- **角色**:对公客户经理、信贷审批官、风险经理
- **使用场景**:贷前股权尽调、集团授信穿透、股权质押贷款、IPO/重组前尽调、贷后风险排查
- **输出用途**:生成结构化股权穿透及关联方分析报告,为授信决策和风险评估提供股权与控制权维度的专业支持
- **决策层级**:信贷审批核心参考材料,风险等级 high,需信贷审批官复核
- **执行频率**:每次授信申请前执行一次,贷后风险排查按需执行

## 数据接入 (Data Sources)

### 必需数据
| 数据项 | 来源 | 获取方式 | 敏感级别 |
|--------|------|---------|----------|
| 工商登记信息 | 国家企业信用信息公示系统/天眼查/企查查 | API/爬虫 | 公开 |
| 企业年报/招股说明书 | 证监会/交易所公告 | 文件读取 | 公开 |
| 征信系统记录 | 人行征信/法院被执行人名单 | API | 内部/敏感 |
| 行内关联交易记录 | 行内关联交易登记系统 | API | 机密 |
| 历史尽调报告 | 影像档案系统 | 文件读取 | 内部 |

### 数据脱敏规则
- 实际控制人身份证号:显示前3后4,中间用 * 替代
- 银行账号:仅显示后4位
- 关联方联系方式:不在输出中出现
- 客户敏感财务数据(如关联交易金额):仅在内部报告中使用,不得外传
- 隐性关联方信息:仅在内部记录中标注,不对外披露

### 降级策略
- 如果征信系统不可用:标注"征信数据未核验",基于工商信息继续分析
- 如果行内关联交易记录不可用:标注"行内关联交易数据未纳入",基于公开信息识别关联方
- 如果历史尽调报告不可用:标注"无历史尽调参考",从头开始分析
- 如果工商数据仅有1年:标注"数据不足,股权变更时间线不完整",仅做静态分析
- 如果商业数据库超时:使用国家企业信用信息公示系统(免费但较慢),并明确标注数据来源

---

## 约束条件 (Constraints)

> 监管依据:《公司法》第216条关联方定义、《商业银行法》第40条关联交易管控、
> 银监会《商业银行与内部人和股东关联交易管理办法》、证监会《上市公司信息披露管理办法》

1. **穿透完整性**:穿透须至自然人或国资委等终极控制人,中途不得以"公众公司"为由截止(上市公司公众持股部分除外)
2. **多源交叉验证**:关联方认定须来自两个以上独立信息源,单一商业数据库不得作为唯一依据
3. **动态时间线**:股权变更分析必须覆盖近3年,重大事项(融资/IPO/重组)前后的变更需标注动机

## 约束条件 (Constraints)

> 监管依据:《公司法》第216条关联方定义、《商业银行法》第40条关联交易管控、
> 银监会《商业银行与内部人和股东关联交易管理办法》、证监会《上市公司信息披露管理办法》

1. **穿透完整性**:穿透须至自然人或国资委等终极控制人,中途不得以"公众公司"为由截止(上市公司公众持股部分除外)
2. **多源交叉验证**:关联方认定须来自两个以上独立信息源,单一商业数据库不得作为唯一依据
3. **动态时间线**:股权变更分析必须覆盖近3年,重大事项(融资/IPO/重组)前后的变更需标注动机
4. **不确定性显式标注**:信息缺失或存疑的关联关系,须以"疑似/待核实"标注,禁止直接定性
5. **利益输送量化**:关联交易异常须给出具体偏离量(如"定价较市场价偏高37%"),禁止仅凭定性描述下结论
6. **数据可溯源性**:所有结论须明确标注数据来源(工商登记/年报/征信系统/尽调报告),引用具体页码或科目
7. **信贷视角聚焦**:风险评估须结合贷款申请金额与企业净资产比例,输出授信决策参考依据
8. **禁止跳过步骤**:必须按步骤0→1→2→...→9顺序执行,不得跳过股权穿透、实控人认定、关联方识别等核心步骤
9. **红线执行强制**:如触发任何红线(R1-R6),必须在报告开头显著标注,并建议暂缓授信

## 分析原则 (Analysis Principles)

- **穿透看实质**:不被表面的法律主体和持股比例迷惑,追溯至真实利益归属
- **控制权优先**:关注实际控制力而非仅看持股比例,重视协议控制、一致行动等安排
- **利益链追踪**:关注资金流向和利益分配路径,识别异常利益输送
- **合规审视**:以监管视角审视股权安排的合规性和信息披露充分性
- **动态分析**:关注股权变更的时间线和动机,而非仅看静态结构
- **完整拼图**:将碎片化信息拼接为完整的股权关系网络

## 执行流程 (Workflow)

## 输出格式 (Output Format)

使用 `assets/equity-penetration-template.md` 模板。

**结构化输出要求**:
- 股权穿透图:Mermaid代码块(可被下游Skill解析)
- 关联方清单:表格格式(包含关联方名称、关联类型、关联依据、风险等级)
- 风险矩阵:表格格式(包含风险类型、风险表现、评估维度、等级)
- 红线核查结果:表格格式(包含红线编号、触发状态、详细说明、处理建议)

**下游兼容性**:
- 本输出可被 submit-credit-application 解析使用(股权结构、实控人信息、风险等级)
- 本输出可被 financial-report-analysis 解析使用(关联方清单、关联交易数据)

**免责声明**:
输出结尾必须引用 `shared/disclaimer-template.md` 模板,确保每次输出都包含"不构成投资建议"等必要声明。

---

## 踩坑记录 (Gotchas)
