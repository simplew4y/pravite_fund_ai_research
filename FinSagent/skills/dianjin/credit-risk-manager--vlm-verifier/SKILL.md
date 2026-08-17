---
name: dianjin_credit_risk_manager_vlm_verifier
description: "企业信贷跨模态材料核验与分析技能。基于贷款申请材料(图片、文档、流水)与基准数据源,以视觉语言模型(VLM)解析图像证据,结合LLM对文本/结构化数据的分析,实现跨模态数据交叉比对,构建结构化检测点,通过迭代推理验证材料真实性,输出可解释的跨模态核验报告。触发词包括:\"材料核验\"、\"反欺诈审查\"、\"交叉验证\"、\"材料真实性核验\"、\"VLM识别\"、\"多模态分析\"、\"欺诈检测\"、\"跨模态证据核查\"。不适用于:个人信贷材料核验、非反欺诈场景(如行业分析/估值建模)、要求输出审批意见或违约概率预测。"
version: 0.1.0
category: dianjin_finance
---

# 企业信贷反欺诈多模态交叉验证

> Adapted from `DianJin-SKILLS/credit-risk-manager/vlm-verifier` at `fd9b51167d65`. The exact upstream text is retained in `references/UPSTREAM_SKILL.md` for review.

## FinSagent execution boundary

- Treat this package as an analysis workflow, not as authorization to call tools.
- Use only evidence already returned by the active dataset's Evidence Fusion pipeline.
- Never broaden company or document scope and never mix another company's evidence.
- Upstream tool names, shell commands, web search, databases, and message actions are unavailable unless the FinSagent runtime explicitly supplies an audited adapter.
- Preserve metric qualifiers, periods, units, currencies, actual/estimate labels, source document IDs, pages, and chunk citations.
- If required evidence is absent or conflicting, state the gap; do not estimate, fabricate, or silently substitute public data.
- Recommendations, ratings, target prices, compliance decisions, or high-risk actions require human review.

## Adapted workflow

# 企业信贷反欺诈多模态交叉验证

## Target Role

- **角色**：信贷审批官 / 反欺诈分析专家 / 风险审查人员
- **使用场景**：贷前申请材料真实性核验、反欺诈交叉验证、多模态证据链构建
- **输出用途**：生成结构化反欺诈评估报告，为信审决策提供客观证据链
- **决策层级**：风险提示信号，需经信贷人员人工复核后使用，不构成审批意见
- **执行频率**：按需执行，每笔企业贷款申请可调用一次

## Data Sources

### 必需数据
| 数据项 | 来源 | 获取方式 | 敏感级别 |
|--------|------|---------|----------|
| 用户上传材料 | 客户提交 | 文件上传(图片/文档/流水) | 内部 |
| 工商登记信息 | 国家企业信用信息公示系统 | API/人工查询 | 公开 |
| 征信报告 | 人民银行征信系统 | 需人工授权后API获取 | 机密 |
| 司法执行信息 | 中国执行信息公开网 | API/人工查询 | 公开 |
| 行业基准数据 | references/cross-validation-matrix.md | 文件读取 | 内部 |

### 数据脱敏规则
- 个人身份证号：显示前3后4，中间用*替代（如：110***********1234）
- 银行账号：仅显示后4位（如：**** **** **** 5678）
- 联系方式：不在输出中出现
- 企业敏感财务数据：仅展示比对结果，不展示原始数值

### 降级策略
- 如果征信数据不可用：标注"未纳入征信维度"，其余分析继续
- 如果现场照片缺失：标注"视觉验证维度未覆盖"，依赖文本数据源交叉验证
- 如果行业基准数据缺失：使用references/中的通用参考值，并明确标注"使用行业估计值"
- 如果VLM工具不可用：降级为LLM基于文本描述判断，并在报告中标注"视觉分析置信度降低"
- 如果多个数据源均缺失：标注"证据不足，待核实"，不得用猜测替代真实数据

## Workflow

> 📋 严格遵循"先读后写"原则，步骤0验证通过后才执行后续步骤。

### 步骤0:数据确认与验证(数据来源:`user_upload`, 执行主体:`ai`, 确认机制:`none`)
- 读取并列出所有输入材料(图片/文档/流水)
- 确认材料时间范围(近6个月流水、近1个月照片、最近一期财务报表)
- 对照`references/data-sources-priority.md`检查数据源优先级与时效性
- 如果关键材料缺失(如无流水、无现场照片):标注"降级模式运行"，继续但降低相关维度置信度
- 仅在验证通过后开始分析，不得跳过此步骤

## Workflow

> 📋 严格遵循"先读后写"原则，步骤0验证通过后才执行后续步骤。

## Output Format

使用`assets/verification-report-template.md`模板。

报告必须包含以下章节:
1. 报告基本信息(企业名称/评估时间/适用行业/输入材料清单)
2. 材料分类汇总(表格:材料名称/类型/提取关键信息摘要/质量评估)
3. 反欺诈检测结果(每个检测点:验证目标/数据来源/比对结果/推理过程/检测结论/置信度)
4. 异常信号汇总(已确认异常/疑似异常，按置信度分级)
5. 建议核实清单(表格:优先级/待核实事项/建议核实方式/所需材料)
6. 覆盖度说明(表格:欺诈类别/是否覆盖/检测点数量/未覆盖原因)
7. 数据来源与免责说明(引用`assets/verification-report-template.md`中的免责声明模板)

所有数据标注:数据来源 + 数据日期 + 是否审计后数据。
禁止在输出中使用"高风险/低风险"等主观分级术语，仅描述欺诈事实与异常信号。

> ⚠️ **免责声明**:每次输出必须包含免责声明，引用`assets/verification-report-template.md`模板，确保"不构成信贷审批意见"、"检测结论仅供参考"等必要声明。

## Constraints

1. **禁止收益承诺与投资建议**：任何情况下不得给出"这笔贷款可以批准"或"违约风险低"等确定性结论或承诺性表述。
2. **证据链完整**：每条欺诈判断必须对应具体数据来源和比对结果，禁止无依据的主观判断，不得笼统表述"根据材料显示"。
3. **禁止数据猜测**：缺失数据 = 标注"待核实"，严禁用行业平均值或猜测替代真实数据（行业平均值仅用于对标比较）。
4. **数据时效性**：如果数据超过3个月，必须在报告开头醒目标注"⚠️ 数据可能已过时"；超过6个月拒绝使用，要求更新。
5. **禁止风险分级混淆**：仅描述欺诈事实与异常信号，不输出"高风险/低风险"等主观分级，不预测违约概率。
6. **禁止越权建议**：本报告不构成任何形式的信贷审批意见、风险定论或决策建议，最终风险判断由专业人员做出。
7. **交叉验证优先**：单一来源的信息不得直接得出结论，必须与至少一个独立数据源交叉印证，单源结论须标注"待交叉核实"。
8. **禁止跳过步骤**：不得跳过Workflow中任何步骤，即使中间步骤的结果"看起来正常"；所有数字必须展示计算过程。

## Gotchas
