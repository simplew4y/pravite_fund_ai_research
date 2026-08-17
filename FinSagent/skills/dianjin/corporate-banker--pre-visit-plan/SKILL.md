---
name: dianjin_corporate_banker_pre_visit_plan
description: "客户经理访前规划技能。基于客户全量数据(行内系统、影像档案、NFS文件、风险预警、行业信息),系统性生成访前准备报告,涵盖客户基本面回顾、近期动态分析、拜访目标设定、材料准备清单、沟通策略与风险提示。当用户要求生成拜访前准备报告、制定客户拜访计划、整理客户背景资料、规划营销拜访策略时使用此技能。触发词包括:\"拜访前准备\"、\"访前规划\"、\"visit planning\"、\"customer visit preparation\"、\"拜访计划\"、\"客户背景分析\"。不适用于:拜访后报告生成、授信审批决策、贷款审查、个人信贷访前规划、或无具体客户背景的一般行业研究。"
version: 0.1.0
category: dianjin_finance
---

# 访前规划 (Pre-Visit Planning)

> Adapted from `DianJin-SKILLS/corporate-banker/pre-visit-plan` at `fd9b51167d65`. The exact upstream text is retained in `references/UPSTREAM_SKILL.md` for review.

## FinSagent execution boundary

- Treat this package as an analysis workflow, not as authorization to call tools.
- Use only evidence already returned by the active dataset's Evidence Fusion pipeline.
- Never broaden company or document scope and never mix another company's evidence.
- Upstream tool names, shell commands, web search, databases, and message actions are unavailable unless the FinSagent runtime explicitly supplies an audited adapter.
- Preserve metric qualifiers, periods, units, currencies, actual/estimate labels, source document IDs, pages, and chunk citations.
- If required evidence is absent or conflicting, state the gap; do not estimate, fabricate, or silently substitute public data.
- Recommendations, ratings, target prices, compliance decisions, or high-risk actions require human review.

## Adapted workflow

# 访前规划 (Pre-Visit Planning)

## 目标角色 (Target Role)

- **角色**:对公客户经理
- **使用场景**:拜访客户前的准备阶段,通常在拜访前1-3天执行
- **输出用途**:了解客户全貌,设定拜访目标,准备营销话术和产品推荐方案
- **决策层级**:信息辅助和策略指导,不涉及授信审批决策
- **执行频率**:每次客户拜访前执行一次

---

## 数据接入 (Data Sources)

### 必需数据
| 数据项 | 来源 | 获取方式 | 敏感级别 |
|--------|------|---------|----------|
| 客户基本信息 | 行内客户信息系统 | API: /api/customer/basic | 内部 |
| 存款与AUM数据 | 核心银行系统 | API: /api/customer/deposits | 内部 |
| 授信使用情况 | 信贷管理系统 | API: /api/customer/credit | 机密 |
| 交易流水 | 核心银行系统 | API: /api/customer/transactions | 机密 |
| 历史尽调/拜访记录 | 影像档案系统 | 文件读取 | 内部 |
| 风险预警信息 | 风险预警系统/外部工商司法平台 | API/爬虫 | 公开/内部 |
| 行业动态 | 行研知识库/外部资讯 | 检索/联网搜索 | 公开 |

### 数据脱敏规则
- 个人身份证号:显示前3后4,中间用 * 替代
- 银行账号:仅显示后4位
- 联系方式:不在输出中出现
- 客户敏感财务数据:仅在内部报告中使用,不得外传

### 降级策略
- 如果风险预警数据不可用:标注"未纳入风险预警维度",其余分析继续
- 如果历史拜访记录缺失:标注"无历史拜访记录",基于公开信息生成首次拜访策略
- 如果行业数据源超时:使用公开信息简要分析,并明确标注"行业分析基于公开信息"
- 如果客户财务数据仅有1年:标注"数据不足,趋势分析不可用",仅做静态分析
- 如果客户360系统不可用:标注"客户基础数据未核验",基于客户经理口述信息继续
- 如果影像档案系统不可用:标注"历史文档未查阅",提示客户经理手动提供关键信息

---

## 执行流程 (Workflow)

### 步骤 0:数据确认与验证

## 执行流程 (Workflow)

## 输出格式 (Output Format)

使用 `assets/visit-plan-template.md` 模板。
报告必须包含以下章节:

```

## 合规约束 (Constraints)

1. **禁止收益承诺**:任何情况下不得给出"预计可获得X万存款"或"保证成功营销"等承诺性表述。
2. **禁止数据猜测**:缺失数据 = 向用户索要或在报告中标注"数据缺失",严禁用行业平均值替代实际数据。
3. **数据时效性**:如果数据超过 6 个月,必须在报告开头醒目标注"⚠️ 数据可能已过时"。
4. **风险前置**:如发现风险信号,必须在报告开头以醒目方式标注,不得隐没在正文中。
5. **目标明确**:每次拜访必须设定1-3个主目标,不得泛泛罗列。
6. **个性化**:报告内容须体现该客户的具体特征,禁止套用通用模板词句。
7. **禁止越权建议**:本 Skill 仅提供拜访策略建议,不涉及授信审批决策或额度批准。
8. **禁止跳过步骤**:不得跳过 Workflow 中的任何步骤,必须按顺序执行。
9. **红线执行强制**:如触发任何红线(R1-R3),必须在报告开头显著标注并暂停后续分析。

## 踩坑记录 (Gotchas)
