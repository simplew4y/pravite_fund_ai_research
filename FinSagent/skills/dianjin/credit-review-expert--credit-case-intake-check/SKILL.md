---
name: dianjin_credit_review_expert_credit_case_intake_check
description: "授信申请案件进件合规检查技能。对客户提交的授信申请材料进行完整性校验、基本信息有效性核查、申请金额合理性审查,输出材料清单状态(齐全/缺失)、缺失项严重度分级(阻断/建议补充/信息提示),并给出补充指引。触发词包括:\"进件检查\"、\"进件材料检查\"、\"case intake check\"、\"帮我检查一下进件材料\"、\"这个案子材料齐了吗\"、\"材料校验\"、\"进件合规检查\"、\"检查授信材料\"。不适用于:贷后管理、风险分类调整、不良资产处置、授信审批决策、客户经理访前分析(请使用pre-visit-credit-analysis)、或无具体案件背景的一般合规咨询。"
version: 0.1.0
category: dianjin_finance
---

# 案件进件检查

> Adapted from `DianJin-SKILLS/credit-review-expert/credit-case-intake-check` at `fd9b51167d65`. The exact upstream text is retained in `references/UPSTREAM_SKILL.md` for review.

## FinSagent execution boundary

- Treat this package as an analysis workflow, not as authorization to call tools.
- Use only evidence already returned by the active dataset's Evidence Fusion pipeline.
- Never broaden company or document scope and never mix another company's evidence.
- Upstream tool names, shell commands, web search, databases, and message actions are unavailable unless the FinSagent runtime explicitly supplies an audited adapter.
- Preserve metric qualifiers, periods, units, currencies, actual/estimate labels, source document IDs, pages, and chunk citations.
- If required evidence is absent or conflicting, state the gap; do not estimate, fabricate, or silently substitute public data.
- Recommendations, ratings, target prices, compliance decisions, or high-risk actions require human review.

## Adapted workflow

# 案件进件检查

在授信审查流程启动前,对客户提交的授信申请材料进行完整性校验和基本信息有效性核查,确保案件满足最低进件标准。

---

## 执行流程 (Workflow)

> 交互模式:模式 A - 报告生成型(Report Generation)

当用户要求检查授信申请案件进件材料时,按以下流程执行:

### 步骤 0:数据确认与验证(先读后写)

1. 确认客户身份:提取客户名称或ID
2. 确认案件编号:提取案件编号
3. 确认目标产品:提取产品名称或编码
4. 检查必填字段:客户名称、案件编号、目标产品、申请金额、申请材料清单
5. 运行验证脚本: `python scripts/validate_intake_check.py --check-customer --check-materials`
6. 若必填字段缺失,输出缺失清单,要求用户补充,停止后续流程
7. 验证通过后进入步骤1

> 📋 数据来源:`user_upload`
> 📋 执行主体:`ai`
> 📋 确认机制:`none`
> ⚠️ 强制指令:不得跳过必填字段检查,必须确认客户、案件和产品信息完整

### 步骤 1:客户基本信息有效性校验

> 获取客户基本信息,与官方证照比对有效性。
> *对接提示:映射到贵行客户信息系统(ECIF)、工商数据接口、身份核验系统,或等效数据聚合工具*

1. 提取客户基本信息(10个字段):客户名称、企业名称、统一社会信用代码、法定代表人、注册资本、成立日期、所属行业、经营地址、联系方式、实控人信息
2. 逐项校验(对照Step 1基础信息校验表):
   - 与营业执照逐字比对(企业名称、法定代表人、注册资本、成立日期、经营地址)
   - 统一社会信用代码校验(18位,符合GB 32100编码规则)
   - 身份证有效性校验(18位、校验码正确、未过期)
3. 标注校验结果(✅通过/❌不通过)及严重度(阻断/建议补充)
4. 信息一致性检查:与营业执照/身份证比对,不一致须标注具体不一致项

> 📋 数据来源:`system_api`(ECIF系统、工商数据接口、身份核验系统)
> 📋 执行主体:`ai`
> ⚠️ 强制指令:不得跳过信息一致性校验,必须逐字比对企业名称(含括号、有限公司等后缀)

### 步骤 2:申请材料完整性检查

## 执行流程 (Workflow)

> 交互模式:模式 A - 报告生成型(Report Generation)

当用户要求检查授信申请案件进件材料时,按以下流程执行:

## 约束条件 (Constraints)

> 监管依据:《商业银行贷款业务管理办法》(银监会令2010年第2号)——贷款申请与受理
> 《商业银行授信工作尽职指引》(银监发〔2004〕51号)——授信申请材料的完整性要求
> 《征信业管理条例》——征信查询须取得书面授权
> 银行内部授信业务操作规程——具体进件材料标准

1. **阻断级不降级**:标注为"阻断"的缺失项,必须补充完整后方可进入审查流程,不得例外放行
2. **信息一致性**:客户基本信息须与营业执照、身份证件等官方证照逐字比对,不一致须标注
3. **授权合规**:征信授权书须为原件扫描件,授权范围须覆盖本次授信查询,复印件/过期授权无效
4. **金额合理性**:申请金额须在产品政策范围内,用途须具体明确(不得写"流动资金"等笼统描述)
5. **时效性**:营业执照、身份证等证照须在有效期内;财务报表优先使用经审计的年度报表
6. **禁止跳过步骤**:不得跳过步骤0(数据确认)和步骤4(一票否决检查),必须执行完整流程
7. **红线执行强制**:如触发任何一票否决条件(I1-I6),必须立即停止后续流程,输出"禁止进件"结论,不得因"客户资质好"而忽略

---

## 踩坑记录 (Gotchas)
