---
name: anthropic_ic_memo
description: "根据尽调、财务模型、交易条款和回报分析起草 PE 投资委员会 Memo。用于 PE deal、收购、LBO 或正式投委会材料；不要用于二级市场多空股票 Memo。"
version: 0.1.0-pf1
---

# PE IC Memo（FinSagent 下游适配）

## 适用边界

仅适用于存在明确交易条款、价格、资本结构和回报模型的 PE/并购项目。二级市场多空观点应路由到 `private-fund-memo`，避免把 Sources & Uses、LBO 杠杆等结构强塞入股票 Memo。

## 结构

1. Executive Summary：公司、交易理由、关键条款、回报、前三项风险。
2. 公司与行业：业务、客户、竞争、管理层、市场和监管。
3. 财务与尽调：历史表现、QoE 调整、营运资本、CapEx、法律及经营发现。
4. 投资逻辑与价值创造：3–5 个支柱、100 日计划和可验证里程碑。
5. 交易结构：EV、倍数、Sources & Uses、杠杆和关键条款。
6. 回报：Base/Upside/Downside 的 IRR、MOIC、敏感性和关键假设。
7. 风险与缓释：严重度、概率、mitigant、deal breaker。
8. 结论：Proceed / Pass / Conditional Proceed 及条件。

所有财务表必须与模型一致；缺失条款或回报输入时列出缺口，不能代填。
