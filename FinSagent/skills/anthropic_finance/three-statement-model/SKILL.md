---
name: anthropic_three_statement_model
description: "基于限定数据集的历史财务和假设，规划并审查利润表、资产负债表、现金流量表的联动模型。用于三表模型、财务预测、模型填充与勾稽检查；当前仅影子评估，不直接写入 Excel。"
version: 0.1.1-pf1
---

# 三表模型（FinSagent 下游适配）

> 来源：Anthropic Financial Services `3-statement-model`，固定于 manifest 的 commit/path/hash。此文件是产品专属改写，不是上游原文。

## 边界

- 只使用 `active_dataset` 的 evidence fusion 结果；不得自行访问 SEC、Web、MCP 或其他公司数据。
- 历史值必须保留公司、期间、单位、币种、Actual/Estimate 和 evidence ID。
- 缺少历史三表或关键附注时输出缺口，不用默认比例补值。
- 当前运行时只生成建模计划、公式规范和校验要求；不得声称已创建或修改 Excel。

## 工作流

1. 映射现有模板的工作表、期间、单位、输入格和公式格；没有模板时只输出建议结构。
2. 将历史事实按利润表、资产负债表、现金流量表和附表归类，先进行期间与币种对齐。
3. 形成 Base/Bull/Bear 的驱动假设，并为每个假设绑定 evidence ID 或标记为 analyst assumption。
4. 建立公式链：收入与成本 → EBIT/税/净利润 → 营运资本与资产负债 → 现金流与期末现金。
5. 强制执行：资产=负债+权益、现金流期末现金=资产负债表现金、净利润跨表一致、留存收益滚动一致。
6. 输出 `model_spec`、`assumption_register`、`formula_plan`、`validation_checks` 和未解决缺口。

## 禁止项

- 不覆盖现有公式、不将预测结果硬编码为常数。
- 不跨公司补数，不混用不可比期间，不把市场一致预期冒充公司实际值。
- 不在未通过勾稽检查时进入估值阶段。
