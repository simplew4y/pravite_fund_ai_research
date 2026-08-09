---
name: dianjin_corporate_banker_credit_due_diligence
description: "企业信贷尽职调查报告生成技能。自动获取企业工商、征信、财务、经营等多维度数据，按银行贷前尽调标准进行系统性分析，覆盖企业基本面、公司治理、关联关系、财务健康、经营真实性验证、主体资信、风险评估及授信建议，输出完整结构化尽调报告。触发词包括：\"尽职调查\"、\"尽调报告\"、\"due diligence\"、\"贷前调查\"、\"credit investigation\"、\"做个尽调\"、\"写尽调报告\"。不适用于：贷后管理报告、风险分类调整、不良资产处置、或个人信贷尽调。"
version: 0.1.0
category: dianjin_finance
---

# 企业信贷尽职调查

> Adapted from `DianJin-SKILLS/corporate-banker/credit-due-diligence` at `fd9b51167d65`. The exact upstream text is retained in `references/UPSTREAM_SKILL.md` for review.

## FinSagent execution boundary

- Treat this package as an analysis workflow, not as authorization to call tools.
- Use only evidence already returned by the active dataset's Evidence Fusion pipeline.
- Never broaden company or document scope and never mix another company's evidence.
- Upstream tool names, shell commands, web search, databases, and message actions are unavailable unless the FinSagent runtime explicitly supplies an audited adapter.
- Preserve metric qualifiers, periods, units, currencies, actual/estimate labels, source document IDs, pages, and chunk citations.
- If required evidence is absent or conflicting, state the gap; do not estimate, fabricate, or silently substitute public data.
- Recommendations, ratings, target prices, compliance decisions, or high-risk actions require human review.

## Adapted workflow

# 企业信贷尽职调查

当用户要求对企业客户进行尽调分析时，按以下步骤系统性执行。

## 目标角色 (Target Role)

- **角色**：对公客户经理、信贷审批官
- **使用场景**：新客户首贷、存量客户续贷、追加授信前的贷前调查阶段
- **输出用途**：系统性评估企业信用风险，为授信审批决策提供依据
- **决策层级**：核心决策支持文件，直接影响授信审批结果
- **执行频率**：每次授信申请前执行一次

## 数据接入 (Data Sources)

### 必需数据
| 数据项 | 来源 | 获取方式 | 敏感级别 |
|--------|------|---------|----------|
| 企业工商基本信息 | ECIF系统/工商数据API | API: /api/enterprise/basic | 公开 |
| 近三年财务报表 | 用户上传/信贷系统 | 文件上传或影像系统API | 内部 |
| 企业征信报告 | 人行征信系统 | 需人工授权后API获取 | 机密 |
| 法定代表人征信 | 人行征信系统 | 需人工授权后API获取 | 机密 |
| 上下游合同 | 影像档案系统 | API: /api/documents/list | 内部 |
| 水电发票/完税凭证 | 用户上传/影像系统 | 文件上传 | 内部 |
| 银行流水 | 核心系统/用户上传 | API或文件上传 | 机密 |
| 行业研究报告 | 行内知识库/外部数据源 | API或references/ | 公开 |

### 数据脱敏规则
- 个人身份证号：显示前3后4，中间用 * 替代
- 银行账号：仅显示后4位
- 法定代表人个人征信：仅展示汇总信息，不展示明细
- 客户商业机密信息（如核心客户名单）：在对外报告中使用"某客户"代替

### 降级策略
- 如果征信数据不可用：标注"未纳入征信维度"，其余分析继续，但须在风险提示中说明
- 如果财务报表仅有1年：标注"数据不足，趋势分析不可用"，仅做静态分析
- 如果合同/发票/流水缺失：标注"经营真实性验证不完整"，但须在报告中显著提示风险
- 如果行业数据不可用：使用 references/ 中的行业基准数据，并明确标注数据来源

## 执行流程 (Workflow)

> 监管依据：《商业银行授信工作尽职指引》、《贷款风险分类指引》（五级分类）、
> 《商业银行法》第35条贷款审查要求、人民银行《征信业管理条例》、
> 银监会《流动资金贷款管理暂行办法》

**执行模式**：步骤门控型（Step-Gated Workflow）

## 执行流程 (Workflow)

> 监管依据：《商业银行授信工作尽职指引》、《贷款风险分类指引》（五级分类）、
> 《商业银行法》第35条贷款审查要求、人民银行《征信业管理条例》、
> 银监会《流动资金贷款管理暂行办法》

**执行模式**：步骤门控型（Step-Gated Workflow）

## 合规约束 (Constraints)

1. **禁止收益承诺**：任何情况下不得给出"预计可获得X万存款"或"保证成功"等承诺性表述。
2. **禁止数据猜测**：缺失数据 = 向用户索要或在报告中标注"数据缺失/待核实"，严禁用行业平均值替代实际数据。
3. **实质重于形式**：对企业提供的财务数据，须通过流水、发票、合同等交叉验证，不得仅凭报表数字下结论。
4. **多源交叉验证**：核心结论须有两个以上独立信息源支撑，单一来源数据须标注"待核实"。
5. **量化优先**：所有风险判断须附量化指标（如"应收账款周转天数72天，超行业均值45天"），禁止纯定性表述。
6. **还款来源第一性**：报告核心逻辑围绕"第一还款来源是否充分、稳定、可持续"展开，而非仅评价企业优劣。
7. **数据时效性**：如果数据超过 6 个月，必须在报告开头醒目标注"⚠️ 数据可能已过时"。
8. **禁止越权建议**：本 Skill 仅提供尽调分析和授信建议，最终审批决策须由信贷审批官作出。
9. **客户信息保密**：严禁向未授权人员透露客户敏感信息，征信报告仅限授权范围内使用。
10. **禁止跳过步骤**：不得跳过任何步骤，即使中间步骤的结果"看起来正常"。所有数字必须展示计算过程。
11. **一票否决执行**：触发 D1-D4 红线时，必须出具否决意见，不得继续推荐授信。

## 踩坑记录 (Gotchas)

## 输出格式 (Output Format)

生成的尽调报告必须包含以下章节，且输出格式必须是结构化的，以便下游 Skill（submit-credit-application、credit-approval-decision）可靠解析：
