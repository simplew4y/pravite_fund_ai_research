---
name: dianjin_credit_risk_manager_credit_risk_extraction
description: "历史报告信贷风险分析框架提取技能。基于企业基本情况描述和已知风险情况，输出企业标签画像与风险结构化分析两大部分，遵循GB/T 4754-2017国标行业分类标准，将抽象风险转化为数据可验证的具体规则。当用户提供企业信贷报告、风险评价文本、授信材料，或要求进行企业风险分析、生成风险提取报告时使用此技能。触发词包括:\"风险分析\"、\"风险提取\"、\"风险结构化\"、\"标签画像\"、\"信贷报告分析\"。Do NOT triggering for:贷后风险监测（请使用loan-risk-monitor）、反欺诈多模态核验（请使用vlm-verifier）、要求输出风险分级或审批意见。"
version: 0.1.0
category: dianjin_finance
---

# 信贷风险结构化提取

> Adapted from `DianJin-SKILLS/credit-risk-manager/credit-risk-extraction` at `fd9b51167d65`. The exact upstream text is retained in `references/UPSTREAM_SKILL.md` for review.

## FinSagent execution boundary

- Treat this package as an analysis workflow, not as authorization to call tools.
- Use only evidence already returned by the active dataset's Evidence Fusion pipeline.
- Never broaden company or document scope and never mix another company's evidence.
- Upstream tool names, shell commands, web search, databases, and message actions are unavailable unless the FinSagent runtime explicitly supplies an audited adapter.
- Preserve metric qualifiers, periods, units, currencies, actual/estimate labels, source document IDs, pages, and chunk citations.
- If required evidence is absent or conflicting, state the gap; do not estimate, fabricate, or silently substitute public data.
- Recommendations, ratings, target prices, compliance decisions, or high-risk actions require human review.

## Adapted workflow

# 信贷风险结构化提取

## 目标角色 (Target Role)

- **角色**：风险分析专家 / 信贷审批官 / 风控规则数据化专家
- **场景**：贷前尽调报告结构化、审批委员会材料准备、贷后风险台账维护、风险报告质量审核、行业风险知识库建设
- **输出用途**：生成企业标签画像与风险结构化分析报告，将抽象风险转化为数据可验证的具体规则
- **决策层级**：辅助决策（输出供信审人员参考，不直接用于审批决策）
- **执行频率**：按需执行，通常在贷前尽调或定期风险回顾时调用

## 数据接入 (Data Sources)

### 必需数据
| 数据项 | 来源 | 获取方式 | 敏感级别 |
|--------|------|---------|----------|
| 企业信贷报告/风险评价文本 | 用户上传 | `file read` | 内部 |
| 企业基本情况描述 | 用户上传 | `file read` | 内部 |
| GB/T 4754-2017国标行业分类 | 上下文/参考资料 | `context` | 公开 |
| 公开信息源（工商/征信/舆情） | 外部API/网络搜索 | `api call` / `web search` | 公开 |

### 数据脱敏规则
- **客户名称**：替换为 `[客户名称]`
- **银行账号**：替换为 `[银行账号]`
- **个人身份证号**：替换为 `[证件号码]`
- **联系电话**：替换为 `[联系电话]`
- **详细地址**：保留省市区，详细地址替换为 `[详细地址]`

### 降级策略
- 如果企业信贷报告缺失：输出错误提示"缺少必需输入：企业信贷报告/风险评价文本"，拒绝执行
- 如果企业基本情况描述缺失：要求用户提供，或仅执行风险点提取（跳过标签画像填充）
- 如果公开信息源不可用：仅基于用户提供的文本执行提取，标注"未使用外部数据源验证"
- 如果GB/T 4754-2017标准不可用：使用内置的行业分类参考（查阅 `references/tag-system.md`），并在输出中标注"行业分类基于内置参考，建议核实"
- 如果原文风险点数量不明确：执行自动计数，并在输出中声明"风险点数量由系统自动计数，建议用户核实"

## 执行流程 (Workflow)

> 📋 严格遵循 METHODOLOGY.md 定义的 12 项标准。

### 步骤0：数据确认（先读后写）（数据来源:`user_upload`, 执行主体:`ai`, 确认机制:`none`）
- 列出输入文件：企业信贷报告/风险评价文本、企业基本情况描述
- 确认原文是否包含"授信业务关键风险评价"、"建议关注事项"、"风险提示"等章节
- 若风险点数量由用户提供，记录为 N；若未提供，执行自动计数
- **验证通过后才执行后续步骤**：若缺少企业信贷报告，输出错误提示并终止

### 步骤1：信息提取与风险点计数（数据来源:`user_upload`, 执行主体:`ai`, 确认机制:`none`）

## 执行流程 (Workflow)

> 📋 严格遵循 METHODOLOGY.md 定义的 12 项标准。

## 输出格式 (Output Format)

输出为完整Markdown风险结构化提取报告，模板引用 `assets/risk-extraction-report-template.md`。

## 合规约束 (Constraints)

1. **禁止风险分级**：严禁出现"高风险"、"中风险"、"低风险"等分级表述，仅客观描述风险事实
2. **行业分类精细化**：必须采用GB/T 4754-2017，展示顺序：门类→大类→中类→小类，不得止于大类或中类
3. **标签体系完整**：必须包含资本属性、集团属性等扩展标签，标签必须有依据
4. **禁用模糊词汇**：严禁使用"相关"、"某些"、"适当"、"尽量"、"原则上"
5. **内容完整性**：原文有N点风险，输出必须覆盖N点，遗漏将导致严重后果
6. **禁止收益承诺**：不得在输出中包含任何确定性收益承诺或投资建议
7. **数据时效性标注**：若使用外部数据源（如工商/征信数据），必须标注数据查询日期
8. **禁止越权建议**：只能提供风险识别与结构化建议，不得跨越到信贷审批、授信决策等越权领域

## 踩坑记录 (Gotchas)
