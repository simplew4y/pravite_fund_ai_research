# FinSagent Skill Combo 场景组合库

适用分支：`RAG`
版本：v1
运行约束：`max_skills_per_request=8`

## 1. 设计原则

1. Skill重叠不扣分；重叠用于构造可解释的增量链。
2. 检索消融与Skill消融分开。Skill组合测试固定使用Evidence Fusion和同一模型。
3. C0是共同基线；专业组合只运行对应场景题，不做无意义的18×全题笛卡尔积。
4. 事实准确率、引用质量、污染率、触发准确率、研报质量和延迟分别报告。
5. 点金Skills当前多为`experimental`，结果必须标注状态；外部行情、工商或宏观数据依赖单独记录。

## 2. 组合总览

| ID | 组合 | 主要场景 | 核心对照 |
| --- | --- | --- | --- |
| C0 | 无Skills融合基线 | 全部 | 共同基线 |
| C1 | 财务数字口径对齐 | 精确指标、期间混合 | C0→C1 |
| C2 | 财务证据闭环 | 36项硬指标、多值问题 | C1→C2 |
| C3 | 防幻觉与拒答 | 无答案、修饰词、错误期间 | C0→C3 |
| C4 | 跨公司污染防护 | 同名指标、公司/doc_id边界 | C0→C4 |
| C5 | 财报深读 | 三表、盈利质量、偿债与ROE | C2→C5 |
| C6 | 季度业绩点评 | 业绩变化、预期差、催化剂 | C2→C6 |
| C7 | 公司一页纸 | 快速投研摘要 | C0/C2→C7 |
| C8 | 公司深度研报 | 投资价值分析 | C5→C8 |
| C9 | 多文档完整投研 | 财务、业务、治理、风险综合 | C2/C8→C9 |
| C10 | 可比公司估值 | PE/PB/经营指标比较 | C2→C10 |
| C11 | 行情与估值联动 | V1–V7、行情和成交数据 | C10→C11 |
| C12 | 行业估值与景气 | 行业分位、景气与配置 | C0→C12 |
| C13 | 管理层与公司事实 | CEO、任免、生效日 | C4→C13 |
| C14 | 股权穿透与关联方 | 实控人、股东、关联方 | C4→C14 |
| C15 | 重大公告解读 | 合同、并购、增减持、激励 | C0/C6→C15 |
| C16 | 机构调研准备 | 背景、疑点、问题和材料清单 | C7/C8→C16 |
| C17 | 企业信用尽调 | 财务、治理、关联方、授信风险 | C5/C14→C17 |
| C18 | 产业债财务排雷 | 现金流、债务、偿债和风险信号 | C5→C18 |

## 3. 可执行allowlist

### C0 无Skills融合基线

```yaml
runtime_enabled: false
allow: []
```

### C1 财务数字口径对齐

```yaml
allow: [period_alignment, finskillops_financial_numeric_synthesis]
```

### C2 财务证据闭环

```yaml
allow:
  - period_alignment
  - finskillops_financial_numeric_synthesis
  - table_evidence_verifier
  - source_conflict
  - answer_coverage
```

### C3 防幻觉与拒答

```yaml
allow:
  - period_alignment
  - table_evidence_verifier
  - source_conflict
  - company_profile_boundary
```

### C4 跨公司污染防护

```yaml
allow:
  - finskillops_source_grounded_issuer_profile
  - company_profile_boundary
  - source_conflict
  - period_alignment
  - finskillops_financial_numeric_synthesis
```

### C5 财报深读

```yaml
allow:
  - period_alignment
  - finskillops_financial_numeric_synthesis
  - table_evidence_verifier
  - source_conflict
  - answer_coverage
  - dianjin_corporate_banker_financial_report_analysis
```

### C6 季度业绩点评

```yaml
allow:
  - period_alignment
  - finskillops_financial_numeric_synthesis
  - table_evidence_verifier
  - source_conflict
  - dianjin_investment_researcher_earnings_commentary_generator
```

### C7 公司一页纸

```yaml
allow:
  - finskillops_source_grounded_issuer_profile
  - period_alignment
  - finskillops_financial_numeric_synthesis
  - source_conflict
  - dianjin_investment_researcher_company_one_page_analysis
```

### C8 公司深度研报

```yaml
allow:
  - finskillops_source_grounded_issuer_profile
  - period_alignment
  - finskillops_financial_numeric_synthesis
  - table_evidence_verifier
  - source_conflict
  - dianjin_corporate_banker_financial_report_analysis
  - dianjin_investment_researcher_company_deep_analysis
```

### C9 多文档完整投研

```yaml
allow:
  - finskillops_source_grounded_issuer_profile
  - period_alignment
  - finskillops_financial_numeric_synthesis
  - table_evidence_verifier
  - source_conflict
  - dianjin_corporate_banker_financial_report_analysis
  - dianjin_investment_researcher_earnings_commentary_generator
  - dianjin_investment_researcher_company_deep_analysis
```

### C10 可比公司估值

```yaml
allow:
  - period_alignment
  - finskillops_financial_numeric_synthesis
  - table_evidence_verifier
  - source_conflict
  - dianjin_investment_advisor_comparable_company_analysis
```

### C11 行情与估值联动

```yaml
allow:
  - finskillops_financial_numeric_synthesis
  - table_evidence_verifier
  - source_conflict
  - dianjin_investment_advisor_stock_quote_analysis
  - dianjin_investment_advisor_comparable_company_analysis
```

### C12 行业估值与景气

```yaml
allow:
  - dianjin_investment_researcher_industry_deep_analysis
  - dianjin_investment_researcher_valuation_prosperity_tracking
  - dianjin_investment_researcher_sector_allocation
  - dianjin_investment_researcher_global_macro_linkage
  - source_conflict
```

### C13 管理层与公司事实

```yaml
allow:
  - finskillops_source_grounded_issuer_profile
  - company_profile_boundary
  - source_conflict
  - period_alignment
  - dianjin_investment_researcher_announcement_analysis
```

### C14 股权穿透与关联方

```yaml
allow:
  - finskillops_source_grounded_issuer_profile
  - company_profile_boundary
  - source_conflict
  - dianjin_investment_advisor_stock_shareholder_analysis
  - dianjin_corporate_banker_equity_penetration_analysis
```

### C15 重大公告解读

```yaml
allow:
  - finskillops_source_grounded_issuer_profile
  - period_alignment
  - source_conflict
  - finskillops_financial_numeric_synthesis
  - dianjin_investment_researcher_announcement_analysis
  - dianjin_investment_researcher_earnings_commentary_generator
```

### C16 机构调研准备

```yaml
allow:
  - finskillops_source_grounded_issuer_profile
  - period_alignment
  - finskillops_financial_numeric_synthesis
  - source_conflict
  - dianjin_investment_researcher_company_deep_analysis
  - dianjin_investment_researcher_institutional_research_outline
  - dianjin_corporate_banker_pre_visit_plan
```

### C17 企业信用尽调

```yaml
allow:
  - finskillops_source_grounded_issuer_profile
  - finskillops_financial_numeric_synthesis
  - table_evidence_verifier
  - source_conflict
  - dianjin_corporate_banker_financial_report_analysis
  - dianjin_corporate_banker_equity_penetration_analysis
  - dianjin_credit_risk_manager_credit_risk_extraction
  - dianjin_corporate_banker_credit_due_diligence
```

### C18 产业债财务排雷

```yaml
allow:
  - period_alignment
  - finskillops_financial_numeric_synthesis
  - table_evidence_verifier
  - source_conflict
  - dianjin_corporate_banker_financial_report_analysis
  - dianjin_credit_risk_manager_credit_risk_extraction
  - dianjin_investment_researcher_industry_bond_risk_control
```

## 4. 数据依赖分层

- 离线文档可完整测试：C0–C9、C13、C15、C16，以及C17/C18中的文档分析部分。
- 需要行情接口：C10、C11、C12中的当前估值、股价、成交量和成交额。
- 需要工商/股东外部数据：C14、C17的外部穿透部分。
- 需要实时宏观与行业数据：C12。

外部数据不可用时必须记录`dependency_unavailable`，不得判为模型事实错误，也不得允许模型自行补数。

## 5. 组合成功标准

- 相对C0在目标任务族上有正向答案或研报质量增益。
- 不增加严重事实错误、公司污染和无答案编造。
- Skill触发F1提高，且非目标题错误触发受控。
- 延迟增量与质量增益同时报告。
