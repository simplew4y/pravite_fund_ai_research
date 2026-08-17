---
name: dianjin_credit_risk_manager_credit_policy_analysis
description: "信贷政策环境分析技能。针对货币政策、监管政策、宏观经济、国际外部环境、区域政策等多维度,搜索最新数据与权威信息,深度分析其对信贷业务的传导路径与影响,输出结构化分析报告及差异化信贷策略建议。触发词包括:\"信贷政策分析\"、\"政策环境分析\"、\"宏观经济影响分析\"、\"信贷环境报告\"、\"货币政策对信贷的影响\"、\"监管政策解读\"、\"信贷策略建议\"。不适用于:企业财务分析、客户信用评级、具体授信审批决策、贷后风险监测。"
version: 0.1.0
category: dianjin_finance
---

# 信贷政策环境分析

> Adapted from `DianJin-SKILLS/credit-risk-manager/credit-policy-analysis` at `fd9b51167d65`. The exact upstream text is retained in `references/UPSTREAM_SKILL.md` for review.

## FinSagent execution boundary

- Treat this package as an analysis workflow, not as authorization to call tools.
- Use only evidence already returned by the active dataset's Evidence Fusion pipeline.
- Never broaden company or document scope and never mix another company's evidence.
- Upstream tool names, shell commands, web search, databases, and message actions are unavailable unless the FinSagent runtime explicitly supplies an audited adapter.
- Preserve metric qualifiers, periods, units, currencies, actual/estimate labels, source document IDs, pages, and chunk citations.
- If required evidence is absent or conflicting, state the gap; do not estimate, fabricate, or silently substitute public data.
- Recommendations, ratings, target prices, compliance decisions, or high-risk actions require human review.

## Adapted workflow

# 信贷政策环境分析

## 目标角色 (Target Role)

- **角色**：资深商业银行信贷政策环境分析师
- **使用场景**：货币政策、监管政策、宏观经济、国际外部环境、区域政策等多维度分析
- **输出用途**：为授信委员会、行业授信政策制定、客户分层管理提供专业环境分析支撑
- **决策层级**：战略决策支持,直接影响信贷投向、定价策略、风险偏好
- **执行频率**：按需执行,通常在季度/年度政策调整期或重大政策发布后执行

## 数据接入 (Data Sources)

### 必需数据
| 数据项 | 来源 | 获取方式 | 敏感级别 |
|--------|------|---------|----------|
| 货币政策数据 | 中国人民银行官网、货币政策执行报告 | 网络搜索+官方数据源 | 公开 |
| 监管政策数据 | 国家金融监督管理总局、央行监管文件 | 网络搜索+政策库 | 公开 |
| 宏观经济数据 | 国家统计局、海关总署、财政部 | 网络搜索+官方统计 | 公开 |
| 国际环境数据 | 美联储、世界银行、BIS、海关总署 | 网络搜索+国际金融数据 | 公开 |
| 区域政策数据 | 地方政府官网、发改委区域规划 | 网络搜索+政策库 | 公开 |

### 数据脱敏规则
- 政策分析中若涉及未公开的内部政策解读,需标注来源为“内部研究”并限制传播范围
- 所有数据需标注发布机构与时间,确保可溯源

### 降级策略
- **系统不可用**：若官方数据源网站无法访问,使用Wind/彭博等权威数据平台作为备选;若所有在线数据源不可用,使用最近一期已知数据并明确标注数据时效性
- **数据缺失**：若某指标最新数据未发布,使用上一期数据并标注“数据待更新”;若连续3期数据缺失,标注“该指标统计口径可能调整”
- **工具不可用**：若网络搜索工具不可用,依赖已有知识库中的政策框架和历史数据,但需明确标注“基于历史知识,建议核实最新数据”
- **数据冲突**：若不同来源数据存在差异,优先采用官方源头数据(如央行>Wind>新闻媒体),并在分析中说明数据差异及原因

## 执行流程 (Workflow)

> 执行模态说明:仅标注非默认值(非默认值:数据来源≠context、执行主体≠ai、确认机制≠none)。

### 步骤0:数据确认与验证 [数据来源=external_search, 确认机制=none]
1. 读取用户输入的分析维度、分析目标、时间范围
2. 搜索该维度最新的官方发布数据和权威信息(近3个月内优先)
3. 确认数据发布机构、发布时间、统计口径,排除数据歧义
4. **对抗模型偷懒**:不得跳过数据搜索步骤;所有指标必须有真实搜索到的具体数值支撑,禁止使用“利率有所上升”等模糊描述
5. 验证通过后,进入步骤1

### 步骤1:趋势研判与驱动因素分析 [确认机制=none]
1. 识别近3-6个月的趋势变化(上升/下降/稳定/波动)
2. 分解驱动因素:内生因素(周期性) vs 政策因素(政策推动) vs 外生冲击(外部输入)

## 执行流程 (Workflow)

> 执行模态说明:仅标注非默认值(非默认值:数据来源≠context、执行主体≠ai、确认机制≠none)。

## 输出格式 (Output Format)

严格按以下JSON格式输出,不包含```json标记,直接输出JSON。输出模板超过100行,详细字段定义见上文。

**输出包含免责声明**(引用 `assets/disclaimer-template.md`),确保每次输出都包含“不构成投资建议”等必要声明。

```json
{
  "analysis_meta": {
    "dimension": "分析维度名称",
    "target": "分析目标(行业或业务场景,如无则填null)",
    "data_as_of": "本次分析数据截止时间(如:2024年Q3)",
    "overall_signal": "positive或negative或neutral(该维度对信贷业务的综合信号)"
  },
  "policy_context": {
    "current_stance": "当前政策立场概述(如:稳健偏宽松、结构性宽信用等,50字以内)",
    "key_events": [
      {"date": "事件日期", "event": "重要政策事件描述", "significance": "对信贷业务的直接意义"}
    ]
  },
  "summary": "200字以内的分析摘要,概括当前该维度的核心状况和对信贷业务的主要影响",
  "focus_indicators": [
    {
      "name": "指标名称(如:LPR 1年期、GDP增速、进出口增速等)",
      "type": "指标类型(如:利率工具、增长指标、贸易数据等)",
      "confidence": "0到100的整数",
      "trend": "up或down或stable或volatile",
      "signal": "positive或negative或neutral",
      "value": "当前具体数值(如:3.45%,较上期-10BP)",
      "data_source": "数据来源机构(如:中国人民银行)",
      "publish_date": "数据发布日期",
      "remark": "简短备注(20字以内)"
    }
  ],
  "key_findings": [
    {
      "title": "发现标题",
      "detail": "具体发现描述(50-100字,含数据支撑)",
      "impact": "positive或negative或neutral",
      "affected_segments": ["受影响的细分领域,如:中小微企业、制造业、房地产"]
    }
  ],
  "transmission_path": {
    "description": "核心传导路径简述(100字以内)",
    "chain": ["传导链条节点1", "传导链条节点2", "传导链条节点3"]
  },
  "impact_assessment": {
    "overall": "对信贷业务的整体影响评述(100字以内)",
    "aspects": [
      {
        "name": "影响维度名称(如:信贷定价、资产质量、信贷需求、流动性管理、合规成本)",
        "score": "1到5的整数",
        "description": "该维度的具体影响描述(含因果逻辑)"
      }
    ]
  },
  "differentiated_impact": [
    {
      "segment": "细分对象(如:大型国有企业、中小微企业、房地产开发商、出口导向型企业)",
      "impact": "positive或negative或neutral",
      "description": "差异化影响描述(30-50字)"
    }
  ],
  "trend_prediction": {
    "short_term": "未来1-3个月趋势预判(含关键触发因素)",
    "medium_term": "未来6-12个月趋势预判(含前提假设)",
    "key_variables": ["影响趋势判断的关键变量,如:美联储降息节奏、房地产销售复苏情况"],
    "outlook": "positive或negative或stable"
  },
  "risk_alerts": [
    {
      "level": "high或medium或low",
      "title": "预警标题",
      "description": "风险描述(含触发条件和影响路径)",
      "probability": "high或medium或low(风险发生概率)",
      "suggestion": "针对性应对建议(明确信贷业务动作)"
    }
  ],
  "credit_strategy_suggestions": [
    {
      "strategy": "策略方向(如:加大制造业中长期信贷投放、适度收紧房地产融资敞口)",
      "rationale": "策略依据(对应上述哪项分析发现)",
      "applicable_scope": "适用范围(行业/客群/产品类型)",
      "precondition": "执行前提(如:需客户满足XX条件)"
    }
  ],
  "raw_report": "完整的分析报告(Markdown格式,1200-2000字,覆盖:摘要、政策背景、核心指标解读、传导路径分析、差异化影响、风险预警、策略建议,含至少1个数据对比表格)",
  "disclaimer": "引用 assets/disclaimer-template.md 的免责声明内容"
}
```

**质量要求**:
1. focus_indicators:必须包含4-8个核心关注指标,每个指标需有真实搜索到的数据支撑,并注明数据来源和发布日期
2. key_findings:至少包含4-6条关键发现,每条需标注affected_segments
3. transmission_path:传导链条节点数量3-5个,每个节点须为可验证的中间变量,不得跳跃
4. risk_alerts:至少包含2-4条风险预警,high级别预警必须包含明确的触发条件和应对建议
5. 所有数字展示计算过程,异常时停止分析不得忽略继续

## 踩坑记录 (Gotchas)
