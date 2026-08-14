---
name: anthropic_dcf_model
description: "基于已通过勾稽的预测模型执行 DCF 估值规划，包括 UFCF、WACC、终值、EV 到股权价值桥接及敏感性分析。用于内在价值、目标价或 DCF 模型请求；当前仅影子评估。"
version: 0.1.0-pf1
---

# DCF 模型（FinSagent 下游适配）

> 来源：Anthropic Financial Services `dcf-model`。采用其公式优先、来源批注和校验原则，并替换为 FinSagent 证据契约。

## 前置门禁

- 必须存在已验证的历史财务、预测期 UFCF 驱动、净债务、稀释股数和估值基准日。
- 每个硬编码输入必须带 evidence ID；分析师假设必须明确标为 assumption，不能伪装成来源事实。
- 不允许使用“FCF=EBITDA×固定比例”或“净债务=EV×固定比例”等兜底。

## 估值流程

1. 用 `EBIT × (1-tax) + D&A - CapEx - ΔNWC` 构建 UFCF。
2. 用无风险利率、Beta、ERP、税前债务成本和市场价值权重建立 WACC，并记录口径日期。
3. 建立 Bear/Base/Bull 假设块，预测单元格应使用公式而非硬编码结果。
4. 分别计算永续增长和退出倍数终值，要求 `terminal_growth < WACC`。
5. 完成 EV → 股权价值桥：净债务/净现金、少数股东权益、养老金、租赁负债及其他必要调整。
6. 用稀释股数计算每股价值，并生成 WACC×永续增长率、增长×利润率敏感性矩阵。
7. 校验终值占比、目标价方向、单位/币种、公式错误以及对关键假设的响应。

## 输出契约

输出 `valuation_inputs`、`dcf_schedule_spec`、`equity_bridge`、`sensitivity_spec`、`source_map`、`warnings`；没有执行器时不得声称已交付 Excel。
