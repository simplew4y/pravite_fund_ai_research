---
name: anthropic_initiating_coverage
description: "编排公司研究、财务预测、估值、图表和首次覆盖报告组装。用于深度研报、首次覆盖或完整公司研究交付；当前仅生成有检查点的任务计划，不自动写文件。"
version: 0.1.0-pf1
---

# 首次覆盖研究（FinSagent 下游适配）

本技能是有依赖关系的编排规范，不替代各子技能。

1. `research`: 公司、业务、行业、竞争、管理层、风险；所有论断绑定 evidence ID。
2. `model`: 调用三表模型规范，产出经过勾稽的预测和假设登记表。
3. `valuation`: 运行 DCF 和显式授权范围内的 Comps，形成目标价和敏感性。
4. `visuals`: 只从已验证的结构化事实生成图表规格，不让图表引入新事实。
5. `assembly`: 组装观点、财务、估值、催化剂和风险；执行数字一致性与引用门禁。

每阶段必须产生版本化 artifact manifest，并在进入下一阶段前验证依赖。当前 prompt runtime 只输出计划、所需输入和质量门禁；实际 XLSX/DOCX/PDF 由未来 artifact workflow 执行。
