---
name: dianjin_credit_review_expert_pre_visit_credit_analysis
description: "授信走访前穿透式风险分析技能。整合企业工商、司法、舆情、行内存贷、外部征信五大数据维度,识别红旗/黄旗信号并逐一标注,生成结构化\"访前一页纸\",辅助客户经理带着问题走访、有的放矢。用于贷前背景调查、存量客户续贷前风险评估、不良预警客户走访准备。触发词包括:\"访前分析\"、\"走访前背景调查\"、\"访前穿透\"、\"pre-visit analysis\"、\"走访前帮我查一下\"、\"整理一下这个客户的情况\"、\"摸底企业风险\"、\"生成访前一页纸\"。不适用于:贷后风险分类调整、不良资产处置、授信审批决策、贷后监测(请使用loan-risk-monitor)、反欺诈多模态核验(请使用vlm-verifier)、或无"
version: 0.1.0
category: dianjin_finance
---

# 访前穿透分析

> Adapted from `DianJin-SKILLS/credit-review-expert/pre-visit-credit-analysis` at `fd9b51167d65`. The exact upstream text is retained in `references/UPSTREAM_SKILL.md` for review.

## FinSagent execution boundary

- Treat this package as an analysis workflow, not as authorization to call tools.
- Use only evidence already returned by the active dataset's Evidence Fusion pipeline.
- Never broaden company or document scope and never mix another company's evidence.
- Upstream tool names, shell commands, web search, databases, and message actions are unavailable unless the FinSagent runtime explicitly supplies an audited adapter.
- Preserve metric qualifiers, periods, units, currencies, actual/estimate labels, source document IDs, pages, and chunk citations.
- If required evidence is absent or conflicting, state the gap; do not estimate, fabricate, or silently substitute public data.
- Recommendations, ratings, target prices, compliance decisions, or high-risk actions require human review.

## Adapted workflow

# 访前穿透分析

在走访客户之前,对客户进行系统性的背景调查和风险筛查,确保走访目标明确、风险已知。

---

## 目标角色 (Target Role)

- **角色**: 对公客户经理、风险经理、信贷审批官
- **使用场景**: 新客户首次走访前背景调查、存量客户续贷前风险评估、不良预警客户走访准备、大额新增授信走访前摸底
- **输出用途**: 生成结构化"访前一页纸",用于走访计划制定、风险问题清单准备、走访重点方向确定
- **决策层级**: 触发一票否决(V1-V6)须上报风险管理部门,红旗信号须走访时重点核实,黄旗信号纳入常规关注
- **执行频率**: 每次实地走访前必做,新客户首笔授信/存量客户续贷/风险预警触发时强制使用

---

## 数据接入 (Data Sources)

### 必需数据
| 数据项 | 来源 | 获取方式 | 敏感级别 |
|--------|------|---------|----------|
| 企业工商数据 | 企查查/天眼查/国家企业信用信息公示系统 | API接口或MCP工具 | 公开 |
| 司法风险数据 | 凭安征信/企查查司法模块/法院公告网 | API接口或MCP工具 | 公开 |
| 舆情监控数据 | 百炼Web搜索/新闻舆情系统 | Web搜索或MCP工具 | 公开 |
| 行内存贷数据 | CRM系统/核心银行系统 | 内部API或MCP工具 | 内部 |
| 外部征信数据 | 人民银行征信系统 | 内部API(需客户书面授权) | 敏感 |

### 数据脱敏规则
- 客户名称、统一社会信用代码在输出中使用脱敏占位符(如"XX制造有限公司")
- 征信报告中的个人身份证号、银行账号须替换为`[证件号码]`、`[银行账号]`
- 行内存贷数据中的具体金额可使用区间描述(如"1000-2000万")

### 降级策略
1. **工商数据接口不可用**: 使用国家企业信用信息公示系统网页查询作为降级,标注"数据来源:网页查询,时效性可能延迟"
2. **行内CRM系统不可用**: 跳过行内数据分析,在报告中明确标注"行内数据不可用,建议走访时向客户索取",继续执行其他步骤
3. **征信系统不可用或未取得授权**: 记录"未取得征信授权,跳过征信查询",仅依赖公开数据(工商/司法/舆情),在报告中注明局限
4. **舆情搜索工具不可用**: 使用通用搜索引擎(Web Search)替代,扩大关键词范围,标注"舆情数据来源:通用搜索,覆盖度可能受限"

---

## 约束条件 (Constraints)

> 监管依据:《商业银行贷款业务管理办法》(银监会令2010年第2号)——贷前调查要求
> 《关于加强贷款风险管理的通知》(银监发〔2020〕22号)——风险识别与预警
> 《企业信用报告》查询合规要求——征信查询须取得书面授权

## 约束条件 (Constraints)

> 监管依据:《商业银行贷款业务管理办法》(银监会令2010年第2号)——贷前调查要求
> 《关于加强贷款风险管理的通知》(银监发〔2020〕22号)——风险识别与预警
> 《企业信用报告》查询合规要求——征信查询须取得书面授权
> 银行内部贷前调查操作规程——具体访前分析标准

1. **数据来源透明**:所有数据点须标注来源工具/渠道,不得臆造或推断数据
2. **授权合规**:查询征信报告需确认已取得客户书面授权,否则仅查公开信息
3. **红旗优先**:发现一票否决信号(V1-V6)须立即突出标注,不得在摘要中淡化
4. **工具失败不中断**:某数据源调用失败时,记录原因并继续其他步骤,不得因单一失败中止分析
5. **客观中立**:如实呈现数据,结论须有依据,不做过度主观推断
6. **禁止跳过步骤**:不得跳过步骤0(数据确认)和步骤6(一票否决自检),必须执行完整流程
7. **禁止越权建议**:仅输出访前风险分析,不提供授信审批决策、贷款定价建议或风险分类调整建议

---

## 执行流程 (Workflow)

> 📋 交互模式:模式A - 报告生成型(Report Generation)
> 监管依据:《商业银行贷款业务管理办法》(银监会令2010年第2号)——贷前调查要求

## 输出格式 (Output Format)

输出结构化"访前一页纸",包含以下章节:

| 章节 | 内容 | 数据类型 |
|------|------|----------|
| 报告基本信息 | 报告编号、生成时间、客户名称、走访目的 | 表格 |
| 企业概况 | 全称/统一信用代码/成立时间、法人/实控人(穿透至自然人)、注册资本(认缴/实缴)、经营范围、股权结构要点 | 表格 |
| 经营状况 | 主营业务、近期经营动态(舆情/公告/投资动向)、行内存贷数据摘要(存款余额/授信余额/占用率/近期还款)、资质荣誉(含有效期) | 表格 |
| 风险信号评级 | 红旗信号(重大风险)、黄旗信号(潜在风险)、正面信号(支持授信因素),逐条列出并注明数据来源 | 列表 |
| 一票否决检查 | V1-V6逐一比对结果,如触发须红色标注 | 表格 |
| 走访重点建议 | 必须核实的事项(针对红旗/黄旗)、建议了解的问题、建议收集的材料 | 列表 |
| 数据来源 | 五大数据维度(工商/司法/舆情/行内/征信)状态、来源工具/渠道、备注 | 表格 |

**报告模板示例**:

```markdown

## 踩坑记录 (Gotchas)
