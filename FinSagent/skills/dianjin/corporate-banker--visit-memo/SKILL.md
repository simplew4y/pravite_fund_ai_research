---
name: dianjin_corporate_banker_visit_memo
description: "客户经理走访纪要生成技能。将现场拜访的口述观察结构化记录为贷前尽调笔记,支持多轮增量更新与持久化保存。当用户在客户拜访现场口述企业经营状况、厂区观察、财务线索、风险信号、人物印象等信息,或要求记录、整理、更新拜访笔记时使用此技能。触发词包括:\"拜访记录\"、\"走访纪要\"、\"visit memo\"、\"现场记录\"、\"记录拜访\"、\"整理笔记\"、\"拜访纪要\"、\"visit record\"。不适用于:拜访前规划、授信审批决策、贷后管理报告、正式尽调报告生成、或无具体客户背景的一般咨询。"
version: 0.1.0
category: dianjin_finance
---

# 拜访记录（Visit Memo）

> Adapted from `DianJin-SKILLS/corporate-banker/visit-memo` at `fd9b51167d65`. The exact upstream text is retained in `references/UPSTREAM_SKILL.md` for review.

## FinSagent execution boundary

- Treat this package as an analysis workflow, not as authorization to call tools.
- Use only evidence already returned by the active dataset's Evidence Fusion pipeline.
- Never broaden company or document scope and never mix another company's evidence.
- Upstream tool names, shell commands, web search, databases, and message actions are unavailable unless the FinSagent runtime explicitly supplies an audited adapter.
- Preserve metric qualifiers, periods, units, currencies, actual/estimate labels, source document IDs, pages, and chunk citations.
- If required evidence is absent or conflicting, state the gap; do not estimate, fabricate, or silently substitute public data.
- Recommendations, ratings, target prices, compliance decisions, or high-risk actions require human review.

## Adapted workflow

# 拜访记录（Visit Memo）

当用户在客户拜访现场口述信息或要求记录拜访笔记时，按以下流程执行。

## 目标角色 (Target Role)

- **角色**：对公客户经理、风险经理
- **使用场景**：贷前尽调现场拜访、客户实地走访、风险排查拜访
- **输出用途**：将口述观察快速结构化为符合贷前尽调规范的记录
- **决策层级**：贷前调查基础材料，为尽调报告和授信申请提供依据
- **执行频率**：每次拜访现场执行，支持多轮增量更新

## 数据接入 (Data Sources)

### 必需数据
| 数据项 | 来源 | 获取方式 | 敏感级别 |
|--------|------|---------|----------|
| 客户经理口述信息 | 现场对话 | 语音转文本或手动输入 | 内部 |
| 客户基础档案 | ECIF系统 | API: /api/customer/profile | 内部 |
| 历史拜访记录 | 信贷系统影像档案 | API: /api/notes/list | 内部 |
| 风险预警信号 | 风险管理系统 | API: /api/risk/alerts | 机密 |

### 数据脱敏规则
- 客户身份证号：显示前3后4，中间用 * 替代
- 银行账号：仅显示后4位
- 客户商业机密信息（如核心客户名单）：在记录中使用"某客户"代替
- 敏感风险信号：仅在内部记录中标注，不对外披露

### 降级策略
- 如果 ECIF 系统不可用：标注"客户基础档案未核验"，继续记录口述信息
- 如果历史拜访记录不可用：标注"首次拜访，无历史记录"，从头开始记录
- 如果风险预警系统不可用：标注"风险预警未纳入"，仅基于现场观察识别风险
- 如果语音转文本不可用：提示用户手动输入或稍后补充

---

## 约束条件 (Constraints)

1. **忠实记录**:仅记录用户口述内容,不添加推断或评价,事实与判断分开标注
2. **追问克制**:每轮最多追问 1-2 个问题,优先追问风险维度,不打断用户叙述节奏
3. **增量合并**:新信息与已有记录合并,不覆盖、不丢失,修正时明确标注"(已更正)"
4. **风险前置**:观察到风险信号时,在记录末尾单独标注 ⚠️,不淹没在正文中
5. **模式灵活**:用户说"先不保存"时只展示不保存;用户转换话题时正常响应,无需退出仪式
6. **数据溯源**:每条记录须标注信息来源(口述/现场观察/系统查询)和时间戳
7. **合规边界**:不得在现场记录中做出授信决策建议,仅记录客观事实

## 约束条件 (Constraints)

1. **忠实记录**:仅记录用户口述内容,不添加推断或评价,事实与判断分开标注
2. **追问克制**:每轮最多追问 1-2 个问题,优先追问风险维度,不打断用户叙述节奏
3. **增量合并**:新信息与已有记录合并,不覆盖、不丢失,修正时明确标注"(已更正)"
4. **风险前置**:观察到风险信号时,在记录末尾单独标注 ⚠️,不淹没在正文中
5. **模式灵活**:用户说"先不保存"时只展示不保存;用户转换话题时正常响应,无需退出仪式
6. **数据溯源**:每条记录须标注信息来源(口述/现场观察/系统查询)和时间戳
7. **合规边界**:不得在现场记录中做出授信决策建议,仅记录客观事实
8. **禁止跳过步骤**:不得跳过步骤0(数据确认)和步骤4(风险信号扫描),必须执行完整流程
9. **红线执行强制**:如触发任何红线(R1-R3),必须立即停止记录并提示用户,不得继续

## 执行流程 (Workflow)

> 交互模式:模式 D - 对话辅助型(Dialogue-Assisted)

当用户在客户拜访现场口述信息或要求记录拜访笔记时,按以下流程执行:

## 输出格式 (Output Format)

> 本输出可被 credit-due-diligence Skill 和 submit-credit-application Skill 解析使用

使用 `assets/visit-memo-template.md` 模板。输出必须包含以下7个章节:

| 章节 | 内容 | 下游可解析字段 |
|------|------|----------------|
| 1.企业概况 | 厂区/员工/生产/经营活跃度 | `factory_area`(string)、`employee_count`(int)、`production_lines`(int) |
| 2.财务线索 | 营收/利润/资金/负债/票据 | `annual_revenue`(number)、`gross_margin`(percent)、`cashflow_status`(enum) |
| 3.上下游关系 | 客户/供应商/行业地位/话语权 | `top3_customer_concentration`(percent)、`payment_terms`(string) |
| 4.担保物与资产 | 不动产/设备/其他资产/已有抵押 | `real_estate_ownership`(enum)、`existing_mortgage`(array) |
| 5.人物印象 | 实控人/财务负责人/其他关键人 | `controller_profile`(string)、`cooperation_level`(enum) |
| 6.本次拜访成果 | 目标达成/资料清单/承诺约定 | `goals_achieved`(bool)、`materials_obtained`(array) |
| 7.风险信号 | 经营类/财务类/关联方/法律合规类 | `risk_signals`(array)、`risk_level`(enum) |

**输出要求**:
- 每条信息必须标注来源:(企业方口述)/(现场观察)/(CM判断)
- 所有数字必须带单位(万元/亿元/平方米/天)
- 风险信号必须在末尾单独以 ⚠️ 标注,不淹没在正文中
- 最多2个追问,精准指向缺失维度

**免责声明**:
本记录仅为贷前调查基础材料,不构成审批依据。所有记录须经过客户经理确认后,才能用于后续尽调报告生成。

---

## 踩坑记录 (Gotchas)
