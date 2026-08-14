---
name: anthropic_model_update
description: "用新财报实际值、管理层指引和分析师假设更新已有财务模型，记录旧值、新值、差异、来源及估值影响。用于财报后模型更新、预测调整和目标价变更；当前仅影子评估。"
version: 0.1.0-pf1
---

# 模型更新（FinSagent 下游适配）

1. 固定更新前模型版本、目标公司、报告期、币种和估值日期。
2. 从 active dataset 提取新实际值，并与旧预测形成 `prior / actual / delta / evidence_id`。
3. 分开记录 reported、adjusted、one-off 与 analyst assumption，禁止静默覆盖。
4. 更新分部、利润率、营运资本、现金债务、股数和关键 KPI 后，再调整前瞻预测。
5. 重新运行三表勾稽、DCF/Comps 和目标价桥，输出旧/新预测及变化原因。
6. 生成版本变更集、估值影响、thesis impact、未解决冲突和回滚信息。

没有受控工作簿执行器时，只输出更新计划和 cell-level change set，不声称文件已修改。
