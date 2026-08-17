---
name: anthropic_audit_xls
description: "审计财务模型的公式、硬编码、跨表链接、单位、期间、三表勾稽、场景响应和估值合理性。用于 Excel 模型 QA、交付前检查和模型错误定位；当前仅影子评估。"
version: 0.1.1-pf1
---

# 财务模型审计（FinSagent 下游适配）

按严重度输出可定位问题：`blocker / high / medium / low`。

强制检查：

- 公式错误：`#REF!/#DIV0!/#VALUE!/#NAME?`、断链、异常硬编码、跨期公式不一致。
- 三表：资产负债平衡、现金勾稽、净利润链接、留存收益、债务和利息。
- 口径：单位、币种、财年、Actual/Estimate、GAAP/Adjusted。
- 场景：Bear/Base/Bull 开关是否真正驱动全部下游输出，方向是否合理。
- DCF：UFCF、WACC、终值、净债务、稀释股数、敏感性中心格是否一致。
- 来源：每个硬编码输入是否有 evidence ID 或 analyst-assumption 标记。

没有工作簿内容或执行器时，明确说明无法完成文件级审计；不得仅凭文字宣称模型通过。
