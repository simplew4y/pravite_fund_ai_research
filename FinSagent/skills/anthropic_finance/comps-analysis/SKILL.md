---
name: anthropic_comps_analysis
description: "执行可比公司筛选、口径标准化、经营指标和估值倍数比较，并形成隐含估值区间。用于 trading comps、同业估值和估值足球场；当前仅影子评估。"
version: 0.1.1-pf1
---

# 可比公司估值（FinSagent 下游适配）

> 来源：Anthropic Financial Services `comps-analysis`；与千问可比公司技能互补但不替代数据边界。

1. 明确目标公司、估值日期、市场、币种和 Actual/LTM/NTM/FY 口径。
2. 可比公司必须基于业务模式、地域、规模、增长、利润率和资本密集度解释选择理由。
3. 跨公司证据只能来自显式获准的 comparable dataset；不得从其他 active dataset 项目偷取同名指标。
4. 标准化 Revenue、EBITDA、净利润、净债务和稀释股数，区分报告值与调整值。
5. 计算 EV/Revenue、EV/EBITDA、P/E、P/B 等适用倍数，展示中位数、四分位和异常值处理。
6. 将选定倍数应用于目标公司匹配期间指标，完成 EV 到股权价值桥和每股价值。
7. 输出 peer rationale、标准化表、隐含价值区间、来源映射和局限性。

未获得跨公司授权时，只能输出所需数据清单和方法，不能生成伪造的同业结论。
