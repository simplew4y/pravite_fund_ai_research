---
name: dianjin_credit_risk_manager_credit_industry_rule_gen
description: "行业信贷风险审查规则生成技能。针对指定行业或产业,结合行业专业知识、产业链结构、政策环境,深度分析并生成结构化的信贷风险审查规则,涵盖基础事实核查类规则和深度推理类规则。触发词包括:\"行业信贷规则生成\"、\"信贷审查项生成\"、\"行业风控规则\"、\"风险审批规则\"、\"行业审查标准\"、\"补充行业规则\"、\"industry rule generation\"。不适用于:企业个体信用评估、具体授信审批决策、财务数据分析、贷后风险监测。"
version: 0.1.0
category: dianjin_finance
---

# 行业信贷风险审查规则生成

> Adapted from `DianJin-SKILLS/credit-risk-manager/credit-industry-rule-gen` at `fd9b51167d65`. The exact upstream text is retained in `references/UPSTREAM_SKILL.md` for review.

## FinSagent execution boundary

- Treat this package as an analysis workflow, not as authorization to call tools.
- Use only evidence already returned by the active dataset's Evidence Fusion pipeline.
- Never broaden company or document scope and never mix another company's evidence.
- Upstream tool names, shell commands, web search, databases, and message actions are unavailable unless the FinSagent runtime explicitly supplies an audited adapter.
- Preserve metric qualifiers, periods, units, currencies, actual/estimate labels, source document IDs, pages, and chunk citations.
- If required evidence is absent or conflicting, state the gap; do not estimate, fabricate, or silently substitute public data.
- Recommendations, ratings, target prices, compliance decisions, or high-risk actions require human review.

## Adapted workflow

# 行业信贷风险审查规则生成

## 目标角色 (Target Role)

- **角色**:资深商业银行信贷风控规则分析师,具备行业研究专家视角
- **使用场景**:针对特定行业或产业进行深度风险解构,从产业链结构、经营特征、监管合规、欺诈模式等多维度切入
- **输出用途**:将行业知识转化为信贷审查人员可直接执行的结构化规则,服务于贷前尽调、授信审批、信贷政策制定
- **决策层级**:风控标准制定,直接影响行业授信准入、审查标准、风险偏好
- **执行频率**:按需执行,通常在新行业授信准入、存量行业规则补充、行业信贷政策修订时执行

## 数据接入 (Data Sources)

### 必需数据
| 数据项 | 来源 | 获取方式 | 敏感级别 |
|--------|------|---------|----------|
| 行业政策数据 | 发改委、工信部、行业协会官网 | 网络搜索+政策库 | 公开 |
| 监管要求数据 | 金融监管总局、环保部、应急管理部 | 网络搜索+监管文件库 | 公开 |
| 行业统计数据 | Wind、行业协会年报、工信部运行监测 | 数据平台API+年报下载 | 内部 |
| 行业财务基准 | 上市公司年报、行业协会统计 | 数据提取+统计计算 | 公开 |
| 产业链信息 | 行业研究报告、产业链数据库 | 网络搜索+研报库 | 内部 |

### 数据脱敏规则
- 行业分析不涉及客户个体数据,无需客户信息脱敏
- 若引用企业内部数据(如龙头企业财务数据),须使用公开年报数据,不得使用未公开内部信息
- 测试用例中的数据须为模拟数据,不得与实际行业数据混淆

### 降级策略
- 如果行业统计数据不可用:使用近3年公开数据或行业协会发布的数据,明确标注数据年份和来源
- 如果监管政策缺失:使用通用监管框架(如环保法、安全生产法),并在规则中标注"需根据最新政策更新"
- 如果行业财务基准缺失:使用同类行业或上下游行业基准,明确标注"参考同类行业"
- 如果产业链信息不完整:基于公开行业报告和企业年报推断,标注"基于公开信息推断,需实地验证"

## 执行流程 (Workflow)

### 步骤 0: 数据确认与行业边界界定
> 📋 数据来源: `user_input` | 执行主体: `ai` | 确认机制: `none`

- 列出输入参数:行业名称、已有规则(如有)、企业规模、特殊关注点、地域范围
- 确认行业GB/T 4754-2017分类代码(精确至中类或小类),避免行业边界模糊
- 确认分析范围:全量生成或增量补充(如有已有规则)
- 验证行业名称有效性:如行业名称过于宽泛(如"制造业"),要求用户细化至子类

### 步骤 1: 行业解构与风险画像建立
> 📋 数据来源: `context` | 执行主体: `ai` | 确认机制: `none`

## 执行流程 (Workflow)

## 核心约束 (Constraints)

1. **规则可执行性**:每条规则必须明确"用什么数据、通过什么方法、验证什么事实",禁止空泛描述
2. **量化判定标准**:check_rules必须包含量化指标或明确判定标准,不允许仅有定性描述
3. **行业专属性**:规则必须体现该行业的特殊风险点,不得输出适用于任何行业的通用规则
4. **禁止收益承诺**:不得在规则中包含任何确定性收益承诺或保底条款
5. **禁止数据猜测**:若行业数据缺失,须在规则中标注"数据缺失,需实地核查",严禁使用行业平均值替代
6. **数据时效性标注**:所有行业基准数据、政策文件须标注发布日期,超过2年的数据须明确标注并说明原因
7. **禁止越权建议**:仅生成风险审查规则,不得提供具体的授信审批意见、定价建议或投资决策
8. **一票否决清晰**:每条规则必须包含至少1条明确的一票否决条件,不得模糊表述

## 输出格式 (Output Format)

严格按以下JSON格式输出,不包含```json标记,直接输出JSON。输出模板超过100行,详细字段定义见上文。

**输出包含免责声明**(引用 `assets/disclaimer-template.md`),确保每次输出都包含"不构成投资建议"等必要声明。

```json
{
  "industry": "行业名称",
  "industry_analysis": {
    "overview": "行业概述（150-250字，含行业规模、经营特征、产业链特点、发展趋势）",
    "lifecycle_stage": "初创期/成长期/成熟期/衰退期",
    "risk_characteristics": ["行业特有风险特征1", "行业特有风险特征2"],
    "regulatory_requirements": ["监管合规要求1（含发证机关）", "监管合规要求2"],
    "key_risk_factors": ["信贷核心风险因素1", "信贷核心风险因素2"]
  },
  "industry_chain": {
    "upstream": "上游供应结构描述（原材料来源、集中度、价格传导）",
    "downstream": "下游客户结构描述（客户类型、账期、集中度风险）",
    "key_pain_points": ["产业链核心痛点1", "产业链核心痛点2"],
    "cash_cycle_days": "行业典型现金转换周期（天数估算，如：60-90天）"
  },
  "risk_profile": {
    "main_fraud_patterns": ["该行业常见造假手法1", "该行业常见造假手法2"],
    "seasonal_risk": "季节性风险描述（高峰期、资金缺口规律）",
    "collateral_quality": "行业典型抵押物评估（变现能力、折价率参考）",
    "benchmark_metrics": {
      "gross_margin": "行业毛利率基准区间（如：15%-25%）",
      "ar_days": "行业应收账款平均天数（如：45-60天）",
      "inventory_days": "行业存货周转天数（如：30-45天）"
    }
  },
  "basic_check_rules": [
    {
      "name": "规则名称（专业信贷术语，体现行业专属性）",
      "description": "规则详细描述（说明为什么需要这条规则，针对哪种造假风险或核查目标）",
      "rule_type": "数据校验/资产核验/文件校验/资质核验",
      "category": "行业项",
      "risk_target": "本条规则针对的具体风险",
      "check_method": "具体检查方法（明确数据来源、执行动作、比对逻辑）",
      "check_rules": [
        "量化检查标准1（含阈值）",
        "量化检查标准2",
        "一票否决条件"
      ],
      "confidence": 85
    }
  ],
  "deep_analysis_rules": [
    {
      "name": "规则名称（如：产量-价格-收入三角交叉验证）",
      "description": "规则详细描述（含验证逻辑和风险目标）",
      "rule_type": "交叉核验/趋势分析/风险模型/压力测试",
      "category": "行业项",
      "risk_target": "本条规则针对的具体风险",
      "check_method": "推理逻辑说明（用A数据和B数据，通过C公式/模型，验证D事实）",
      "check_rules": [
        "引入的多维数据类型及来源",
        "逻辑自洽的容忍偏差阈值",
        "异常情况的定性判定标准及处置建议"
      ],
      "confidence": 82
    }
  ],
  "summary": "规则挖掘总结（80-120字）",
  "disclaimer": "本规则集由AI辅助生成,基于公开行业数据和政策信息分析,仅供参考,不构成任何授信决策依据。使用前请核实最新数据和政策。"
}
```

## 踩坑记录 (Gotchas)
