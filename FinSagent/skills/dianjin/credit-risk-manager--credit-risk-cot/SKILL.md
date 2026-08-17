---
name: dianjin_credit_risk_manager_credit_risk_cot
description: "对公授信客户信贷风险逆向思维链(CoT)生成技能。给定原始信贷数据和目标风险点,深度模拟资深风险经理的研判逻辑,构建逻辑严密、证据确凿的推理链,解释为何从该数据能推导出该风险结论。触发词包括:\"风险推理链生成\"、\"思维链分析\"、\"CoT生成\"、\"帮我分析一下这个风险点\"、\"生成思维链\"、\"这个结论的数据支撑是什么\"、\"风险点数据支撑分析\"。不适用于:无原始数据的纯猜测分析、个人信贷风险评估、非风险类的正向财务分析、贷后风险监测(请使用loan-risk-monitor)。"
version: 0.1.0
category: dianjin_finance
---

# 目标角色 (Target Role)

> Adapted from `DianJin-SKILLS/credit-risk-manager/credit-risk-cot` at `fd9b51167d65`. The exact upstream text is retained in `references/UPSTREAM_SKILL.md` for review.

## FinSagent execution boundary

- Treat this package as an analysis workflow, not as authorization to call tools.
- Use only evidence already returned by the active dataset's Evidence Fusion pipeline.
- Never broaden company or document scope and never mix another company's evidence.
- Upstream tool names, shell commands, web search, databases, and message actions are unavailable unless the FinSagent runtime explicitly supplies an audited adapter.
- Preserve metric qualifiers, periods, units, currencies, actual/estimate labels, source document IDs, pages, and chunk citations.
- If required evidence is absent or conflicting, state the gap; do not estimate, fabricate, or silently substitute public data.
- Recommendations, ratings, target prices, compliance decisions, or high-risk actions require human review.

## Adapted workflow

## 目标角色 (Target Role)

- **角色**：信贷风险分析师 / 信审人员
- **使用场景**：贷前尽调、年度贷后复检、风险报告质检、授信审批答辩——需要向审贷委员会提交逻辑完整的风险分析
- **输出用途**：生成结构化推理链，作为风险结论的数据支撑和逻辑证据
- **决策层级**：信息辅助，为授信决策提供逻辑依据，不得直接作为审批结论
- **执行频率**：按需执行，每次授信申请或风险事件触发一次

## 数据接入 (Data Sources)

### 必需数据
| 数据项 | 来源 | 获取方式 | 敏感级别 |
|--------|------|---------|----------|
| 原始信贷数据（财务报表/信贷报告） | 用户上传 | 文件上传 | 内部 |
| 目标风险点 | 用户指定 | 对话输入 | 内部 |
| 行业背景信息 | 用户提供 / references/ | 对话输入或文件读取 | 公开 |
| 行业基准数据 | references/industry-benchmarks.md | 文件读取 | 公开 |

### 数据脱敏规则
- 企业统一社会信用代码：显示前 6 后 4，中间用 `*` 替代
- 银行账号：仅显示后 4 位
- 个人身份证号：显示前 3 后 4，中间用 `*` 替代
- 押品详细地址：不在输出中完整展示，仅展示区域和类型

### 降级策略
- 如果原始信贷数据为空或缺失：**必须立即终止分析，不输出任何内容**（核心约束）
- 如果行业背景信息缺失：标注"未纳入行业对标维度"，仅做个体分析
- 如果财务报表仅覆盖 1 年：标注"数据不足，趋势分析不可用"，仅做静态分析
- 如果报表口径不清晰（无法区分合并/母公司）：标注"报表口径存疑，分析基于合并报表假设"

## 术语消歧 (Terminology)

| 易混淆术语 | 本 Skill 中含义 |
|-----------|----------------|
| 合并报表 vs 母公司口径 | 合并报表数据只与合并报表数据对比，母公司口径只与母公司口径对比，严禁混用 |
| DSCR（债务覆盖率） | 经营现金流 / 当期应还本息，非 EBITDA/利息 |
| 净现比 | 经营现金流净额 / 净利润，衡量利润质量 |
| 在建工程 | 尚未完工转固的资本性支出，非存货或固定资产 |
| 产能利用率 | 实际产量 / 设计产能，行业对标关键指标 |
| 账龄 | 应收账款自确认之日起至分析时点的时间跨度，非逾期天数 |

## 执行流程 (Workflow)

> **先读后写**：在开始任何推理之前，必须先执行以下数据确认步骤：
> 1. 读取并列出所有输入数据（财务报表、信贷报告、目标风险点）

## 执行流程 (Workflow)

> **先读后写**：在开始任何推理之前，必须先执行以下数据确认步骤：
> 1. 读取并列出所有输入数据（财务报表、信贷报告、目标风险点）
> 2. 确认数据的时间范围、会计准则（CAS/IFRS）和报表口径（合并/母公司）
> 3. 运行 `scripts/validate_financial_data.py` 验证数据完整性和勾稽关系
> 4. 仅在验证通过后进入步骤 1

## 输出格式 (Output Format)

## 合规红线 (Constraints)

1. **无数据时终止**：若原始信贷数据为空或缺失，或推理过程出现"无法验证"、"数据不足"，必须立即终止该风险点分析，不输出任何内容（含标题），直接跳过。
2. **禁止捏造数据**：只能使用原始信贷数据中明确出现的数字，禁止虚构任何数字。引用数字必须与原文完全一致（含单位、小数位）。
3. **禁止收益承诺**：任何情况下不得出现"预计恢复"、"有望好转"、"回收率预计 X%"等确定性表述。
4. **禁止数据猜测**：缺失数据须按降级策略处理，严禁用行业平均值替代真实数据（行业平均值仅用于对标比较）。
5. **报表口径一致性**：合并报表数据只与合并报表数据对比，母公司口径数据只与母公司口径数据对比，严禁混用。
6. **数据时效性标注**：如果引用的行业基准数据超过标注有效期，必须在输出中标注"⚠️ 行业基准数据可能已过时"。
7. **六步全覆盖**：每份 CoT 输出须经过全部6步推导框架，缺少任意步骤须在报告中说明跳过原因。
8. **正反证据均衡**：每个风险点须同时呈现支持该风险的证据和可能弱化该风险的例外情形，避免单向强化。
9. **不确定性显式标注**：基于推断（非原文数据）的结论须标注"（推断）"，数据缺失段须标注"（数据不足，待核实）"。
10. **禁止越权审批**：本 Skill 仅生成推理链和授信建议，不得代替人工审批或自动执行授信调整。

## 踩坑记录 (Gotchas)
