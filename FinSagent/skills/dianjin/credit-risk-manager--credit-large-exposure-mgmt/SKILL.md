---
name: dianjin_credit_risk_manager_credit_large_exposure_mgmt
description: "大额风险暴露集中度监控与压降管理技能。基于银保监会大额风险暴露管理框架,执行全口径风险暴露计量、穿透识别、限额监测、超限预警与压降方案制定,防范集中度风险。触发词包括:\"大额风险暴露监控\"、\"集中度检查\"、\"风险暴露计量\"、\"限额监测\"、\"超限预警\"、\"压降方案制定\"、\"查一下集中度\"、\"这个客户额度超了吗\"、\"大额风险暴露预警\"、\"集中度压降\"。不适用于:企业个体信用评估、具体授信审批决策、财务数据分析、贷后风险监测。"
version: 0.1.0
category: dianjin_finance
---

# 大额风险暴露集中度监控与压降管理

> Adapted from `DianJin-SKILLS/credit-risk-manager/credit-large-exposure-mgmt` at `fd9b51167d65`. The exact upstream text is retained in `references/UPSTREAM_SKILL.md` for review.

## FinSagent execution boundary

- Treat this package as an analysis workflow, not as authorization to call tools.
- Use only evidence already returned by the active dataset's Evidence Fusion pipeline.
- Never broaden company or document scope and never mix another company's evidence.
- Upstream tool names, shell commands, web search, databases, and message actions are unavailable unless the FinSagent runtime explicitly supplies an audited adapter.
- Preserve metric qualifiers, periods, units, currencies, actual/estimate labels, source document IDs, pages, and chunk citations.
- If required evidence is absent or conflicting, state the gap; do not estimate, fabricate, or silently substitute public data.
- Recommendations, ratings, target prices, compliance decisions, or high-risk actions require human review.

## Adapted workflow

# 大额风险暴露集中度监控与压降管理

对客户授信集中度进行监控和管理,防范大额风险暴露引发的系统性集中度风险。

## 目标角色 (Target Role)

- **角色**:资深商业银行大额风险暴露管理专员
- **使用场景**:单一客户/集团客户/关联方大额风险暴露集中度监控、穿透计量、限额监测、超限预警与压降方案制定
- **输出用途**:为风险管理部、高级管理层、董事会提供集中度风险监控报告,为授信审批提供集中度预检意见
- **决策层级**:风险管控决策,直接影响授信审批、压降方案执行、监管报送
- **执行频率**:每日批量监控+实时新增授信预检,月度/季度/年度定期报告

## 数据接入 (Data Sources)

### 必需数据
| 数据项 | 来源 | 获取方式 | 敏感级别 |
|--------|------|---------|----------|
| 监管文件 | 银保监会、国家金融监督管理总局官网 | 政策库查询+文件下载 | 公开 |
| 资本充足率报表 | 风险管理部监管报送系统 | 系统API接口 | 内部 |
| 信贷系统余额数据 | 核心信贷系统、同业投资台账 | 系统API接口 | 内部 |
| 集团客户管理数据 | 集团客户管理模块、股权穿透系统 | 系统API接口 | 内部 |
| 关联方名单 | 董事会办公室、公司治理系统 | 季度更新文件 | 内部 |

### 数据脱敏规则
- 大额风险暴露分析不涉及客户个体敏感信息(身份证号、银行账号),无需客户信息脱敏
- 若输出报告用于对外展示或监管报送,须使用脱敏后的客户编码替代客户名称
- 集团股权穿透图谱中若包含自然人股东信息,须使用化名或编码替代

### 降级策略
1. **资本净额数据缺失**:使用最近一期监管报送数据(须在输出中标注数据日期),若超过3个月须警告并建议手动更新
2. **穿透数据不可用**:对无法穿透的资管产品/信托计划,按保守原则计入匿名客户,并在输出中明确标注"穿透数据缺失,按匿名客户计量"
3. **集团成员名单未更新**:使用最近一次更新的集团成员名单(须在输出中标注更新日期),若超过1季度须警告并建议主办行更新
4. **信贷系统不可用**:使用T-1日批量数据快照,并在输出中明确标注"实时数据不可用,使用T-1日快照"

## 执行流程 (Workflow)

> 本Skill为**步骤门控型(B模式)**,每个步骤须验证通过后方可进入下一步。

### 步骤0：数据确认与先读后写
> 数据来源:系统接口+用户输入 | 执行主体:ai | 确认机制:approve

1. 读取输入参数(客户名称/集团标识/业务场景/拟新增授信金额)
2. 确认资本净额数据日期(一级资本净额、资本净额)
3. 确认集团成员名单更新日期(如涉及集团客户)
4. 确认关联方名单生效日期

## 执行流程 (Workflow)

> 本Skill为**步骤门控型(B模式)**,每个步骤须验证通过后方可进入下一步。

## 核心约束 (Constraints)

1. **穿透计量强制性**:对资管产品、资产证券化、集合信托等必须穿透至底层最终债务人,无法穿透的纳入匿名客户且不得超过一级资本净额15%
2. **监管红线不可逾越**:单一客户风险暴露≤一级资本净额15%、单一集团≤20%、关联方≤25%,突破红线必须一票否决并专项报告
3. **新增授信前集中度预检**:每笔新增授信必须模拟审批后集中度,突破内部管控线的须预警,突破监管红线的须自动阻断
4. **集团客户统一授信**:成员企业共用集团额度,主办行负责统筹,每季度更新成员名单,不得遗漏新设/收购企业
5. **禁止数据猜测**:若资本净额/穿透数据/集团名单缺失,须标注“数据缺失,需手动核查”,严禁使用估算值替代
6. **数据时效性标注**:所有资本净额数据须标注数据日期,超过3个月的须明确标注并建议更新
7. **禁止越权建议**:仅输出集中度监控报告和压降建议,不得直接执行授信审批、额度调整、资产转让等操作
8. **一票否决清晰**:触发E1-E6任一条件的,必须一票否决新增授信,当日上报行长和监管部门,不得拖延或隐瞒

## 输出格式 (Output Format)

严格按以下JSON格式输出,不包含```json标记,直接输出JSON。输出模板超过100行,详细字段定义见上文。

**输出包含免责声明**(引用 `assets/disclaimer-template.md`),确保每次输出都包含“不构成投资建议”等必要声明。

```json
{
  "exposure_meta": {
    "customer_name": "客户名称或集团标识",
    "customer_type": "单一客户/集团客户/关联方/匿名客户",
    "business_scenario": "新增预检/日常监测/集团管理/压降跟踪/监管报送",
    "data_as_of": "数据截止日期(如:2026-05-05)",
    "tier1_capital_net": 800000,
    "total_capital_net": 1000000
  },
  "total_exposure": {
    "gross_exposure": 120000,
    "risk_mitigation_amount": 10000,
    "net_exposure": 110000,
    "concentration_ratio": 13.75,
    "limit_type": "单一客户风险暴露",
    "regulatory_limit": 15.0,
    "internal_limit": 12.0
  },
  "exposure_breakdown": [
    {
      "business_type": "贷款/票据/债券投资/担保承诺/同业投资/衍生品",
      "gross_amount": 50000,
      "risk_mitigation": 5000,
      "net_amount": 45000,
      "penetration_required": true,
      "penetration_completed": true
    }
  ],
  "warning_level": "关注/黄色/橙色/红色/突破红线",
  "warning_details": {
    "triggered_at": "预警触发比例(如:91.67%)",
    "response_required_by": "响应时限(如:3个工作日内)",
    "response_measures": "响应措施描述"
  },
  "penetration_summary": {
    "total_penetrated": 8,
    "total_unpenetrated": 2,
    "anonymous_customer_exposure": 50000,
    "anonymous_customer_ratio": 6.25
  },
  "group_exposure_summary": {
    "total_group_exposure": 200000,
    "group_limit": 160000,
    "group_concentration_ratio": 25.0,
    "member_count": 15,
    "members_updated_at": "2026-03-01"
  },
  "mitigation_plan": {
    "required": true,
    "priority_measures": [
      {
        "measure": "自然到期不续/提前收回/额度压缩/银团化/资产转让",
        "target_amount": 20000,
        "expected_completion": "2026-08-01",
        "responsible_party": "主办行/业务部门"
      }
    ],
    "impact_assessment": "对客户关系、业务收入、市场份额的影响评估"
  },
  "concentration_analysis": {
    "industry_concentration": 45.0,
    "region_concentration": 35.0,
    "product_concentration": 25.0,
    "top10_customer_ratio": 48.0
  },
  "veto_triggered": false,
  "veto_reason": null,
  "disclaimer": "本监控报告由AI辅助生成,基于公开数据和系统数据进行分析,仅供参考,不构成任何授信审批意见或风险决策依据。详见 `assets/disclaimer-template.md`。"
}
```

**关键输出字段说明**:
- `exposure_meta`: 分析元数据,包含客户信息、数据类型、资本净额
- `total_exposure`: 全口径风险暴露汇总(账面/缓释/净暴露/集中度比例)
- `exposure_breakdown`: 分业务类型风险暴露明细数组
- `warning_level`: 预警等级(关注/黄色/橙色/红色/突破红线)
- `penetration_summary`: 穿透计量汇总(已穿透/未穿透/匿名客户)
- `group_exposure_summary`: 集团客户风险暴露汇总(仅集团客户场景)
- `mitigation_plan`: 压降方案(仅触发预警场景)
- `veto_triggered`: 是否触发一票否决(E1-E6)

## 踩坑记录 (Gotchas)
