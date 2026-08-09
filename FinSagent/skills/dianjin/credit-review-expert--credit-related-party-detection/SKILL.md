---
name: dianjin_credit_review_expert_credit_related_party_detection
description: "企业客户关联交易识别与关联风险排查技能。通过股权穿透、管理层任职、家族关系、交易集中度、担保链条等多维度识别关联方,检测资金空转、转移定价、虚构交易、利润转移等异常特征,评估关联风险对授信安全的影响,输出结构化关联方图谱与风险报告。用于贷前关联排查、贷中关联交易监测、贷后风险预警。触发词包括:\"关联关系识别\"、\"关联交易分析\"、\"关联风险排查\"、\"related party detection\"、\"关联图谱\"、\"查一下这家企业的关联关系\"、\"关联交易分析一下\"、\"担保链分析\"。不适用于:贷后风险分类调整、不良资产处置、授信审批决策、股权穿透分析(请使用equity-penetration-an"
version: 0.1.0
category: dianjin_finance
---

# 关联交易识别与关联风险排查

> Adapted from `DianJin-SKILLS/credit-review-expert/credit-related-party-detection` at `fd9b51167d65`. The exact upstream text is retained in `references/UPSTREAM_SKILL.md` for review.

## FinSagent execution boundary

- Treat this package as an analysis workflow, not as authorization to call tools.
- Use only evidence already returned by the active dataset's Evidence Fusion pipeline.
- Never broaden company or document scope and never mix another company's evidence.
- Upstream tool names, shell commands, web search, databases, and message actions are unavailable unless the FinSagent runtime explicitly supplies an audited adapter.
- Preserve metric qualifiers, periods, units, currencies, actual/estimate labels, source document IDs, pages, and chunk citations.
- If required evidence is absent or conflicting, state the gap; do not estimate, fabricate, or silently substitute public data.
- Recommendations, ratings, target prices, compliance decisions, or high-risk actions require human review.

## Adapted workflow

# 关联交易识别与关联风险排查

对企业客户进行全面的关联关系排查和关联交易识别，防范关联风险向授信主体传导。排查须贯穿贷前、贷中、贷后全流程。

---

## 目标角色 (Target Role)

- **角色**: 信贷审批官、风险经理、对公客户经理、合规审查岗
- **使用场景**: 贷前关联排查(新客户首笔授信)、贷中关联交易监测(存续期监控)、贷后风险预警触发时深度排查、大额授信/集团客户授信专项评估
- **输出用途**: 生成结构化关联方图谱与关联风险报告,用于授信审批决策参考、风险定价调整、担保方案设计
- **决策层级**: 高风险(R1-R6触发)须上报合规部门和风险管理部门,中风险须增加担保或压缩额度,低风险纳入常规贷后监测
- **执行频率**: 新客户首笔授信必做、存量客户每半年复核一次、股权变更/高管变动/风险预警触发时临时排查

---

## 数据接入 (Data Sources)

### 必需数据
| 数据项 | 来源 | 获取方式 | 敏感级别 |
|--------|------|---------|----------|
| 客户基本信息 | ECIF系统、工商数据接口 | API调用/文件导入 | 内部 |
| 股权穿透图 | 天眼查/企查查API、工商登记系统 | API调用 | 公开 |
| 征信报告关联信息 | 人民银行征信系统 | 征信查询接口(需授权) | 敏感 |
| 企业财务报表与交易流水 | 信贷系统、核心银行系统 | 数据库查询/文件导入 | 内部 |
| 监管文件与关联方认定标准 | 知识库/references/ | 文件引用 | 公开 |

### 数据脱敏规则
- 客户名称、身份证号、银行账号等敏感信息在报告和日志中须使用占位符(如`[客户名称]`、`[证件号码]`)
- 征信查询须取得客户书面授权,未经授权不得查询

### 降级策略
- **股权穿透API不可用**: 使用最近一次缓存的股权穿透图,标注"数据非实时,建议人工核实"
- **征信系统不可用**: 基于客户提供的财务报表和担保合同进行初步排查,标注"征信数据缺失,排查结果可能不完整"
- **交易流水不可用**: 基于客户提供的纳税申报表和财报进行关联交易占比估算,标注"交易流水缺失,关联交易识别可能不完整"
- **工商数据不可用**: 使用客户提供的营业执照和公司章程进行股权关联排查,标注"工商数据缺失,隐性关联可能遗漏"

---

## 约束条件 (Constraints)

> 监管依据:《商业银行集团客户授信业务风险管理指引》(银监发〔2010〕92号)——集团客户与关联授信集中度
> 《商业银行大额风险暴露管理办法》(银保监会令2018年第1号)——关联客户风险暴露限额
> 《企业会计准则第36号——关联方披露》——关联方认定标准
> 银行内部关联交易管理办法——具体排查标准与报告要求

## 约束条件 (Constraints)

> 监管依据:《商业银行集团客户授信业务风险管理指引》(银监发〔2010〕92号)——集团客户与关联授信集中度
> 《商业银行大额风险暴露管理办法》(银保监会令2018年第1号)——关联客户风险暴露限额
> 《企业会计准则第36号——关联方披露》——关联方认定标准
> 银行内部关联交易管理办法——具体排查标准与报告要求

1. **穿透至自然人**:股权关联须穿透至最终自然人实控人,不得停留在中间层法人
2. **全维度覆盖**:六类关联关系(股权/管理层/家族/交易/担保/隐性)须全部排查,不得选择性忽略
3. **隐性关联必查**:相同注册地址、联系电话、财务人员等隐性关联信号须单独标注
4. **四流合一验证**:关联交易识别须合同流、发票流、物流/服务流、资金流交叉验证,不得仅凭两流匹配判定真实
5. **动态更新**:关联方信息变化时(股权变更、高管变动、新设企业)须及时更新排查结果
6. **禁止越权**:本技能仅提供关联风险排查结果,不得直接作出授信审批决策
7. **红线执行强制**:如触发任何一票否决条件(R1-R6),必须立即在报告顶部红色标注,不得因"客户关系好"而忽略

---

## 踩坑记录 (Gotchas)

## 输出格式 (Output Format)

输出结构化关联方图谱与关联风险报告,包含以下章节:

| 章节 | 内容 | 数据类型 |
|------|------|----------|
| 报告基本信息 | 报告编号、生成时间、排查时点、客户名称 | 表格 |
| 关联方清单 | 逐笔列示六维关联方(股权/管理层/家族/交易/担保/隐性),含关联关系类型和穿透深度 | 表格 |
| 关联交易异常特征 | 逐项列示识别到的异常特征(资金空转/转移定价/虚构交易/利润转移/担保链风险/资金占用),含四流合一验证结果 | 表格 |
| 关联风险评估 | 授信集中度、经营独立性、担保链风险、关联群体财务健康评估结果 | 表格 |
| 风险分级与处置建议 | 风险等级(高/中/低)、处置建议(暂停授信/增加担保/压缩额度/加强监测/正常授信) | 表格 |
| 一票否决触发情况 | R1-R6触发情况(如有) | 表格 |
| 数据缺失与降级处理 | 数据源不可用情况及降级处理措施(如有) | 表格 |

**下游兼容性**: 本输出可被 credit-approval 和 credit-collateral-risk-mgmt Skill 解析使用。

**免责声明**: 本报告仅用于授信审批参考,不构成授信决策依据。关联交易识别基于可用数据,可能因数据缺失或更新延迟导致遗漏。引用 `shared/disclaimer-template.md` 模板。

---
