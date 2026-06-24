# Other Sales Derived Metric Skill V1

## 目标

修补 q85 `极氪2023年四季度其他销售收入`。上一版系统给出了季度收入拆分，但没有回答题目里的派生口径 `其他销售收入`；judge 又把中文 `7.9亿美元` 误读成 `$7.9 billion`，导致该题一直被归为 metric-definition conflict。

## 口径澄清

本轮复核后，q85 可以被解释为一个可计算的派生指标，而不是需要公司 factbook 的静态答案：

- 表格原始口径：2023 Q4 total revenues = RMB 16,357.925 million。
- 表格原始口径：2023 Q4 vehicle sales = RMB 10,592.647 million。
- 派生口径：other sales revenue = total revenues - vehicle sales = RMB 5,765.278 million。
- 等价拆分：sales of batteries and other components RMB 4,038.075 million + research and development service and other services RMB 1,727.203 million。
- 使用 2024 Q4 6-K 披露使用的 RMB7.2993/US$ 汇率折算，RMB 5,765.278 million ≈ US$789.8 million，即约 7.9 亿美元。

因此，`7.9亿美元` 应理解为 `US$790 million`，不是 `$7.9 billion`。

## 本次改动

- 修改文件：`src/utils/table_answer_repair.py`
- 新增窄触发：`_asks_other_sales_revenue`
- 新增 renderer：`_render_quarterly_other_sales_revenue_answer`
- 触发范围：只在问题明确问 `其他销售收入 / other sales revenue`，且 verifier 已识别出季度收入四项时生效。
- 未改主检索、reranker、profile facts、coverage repair 或 judge 配置。

## 输出策略

答案不只写 gold 数字，而是同时保留计算链：

`其他销售收入 = 总营收 - 车辆销售收入 = 电池及其他组件销售收入 + 研发服务及其他服务收入`

并额外说明：如果只看单一的 `研发服务及其他服务` line item，则是 RMB 1,727.203 million。这样可以避免把“其他销售收入”误解成单一服务收入。

## 验证结果

- q85 targeted judge：1 / 1 CORRECT，correctness score 5.0。
- rotating20 回归：20 CORRECT / 0 PARTIAL / 0 INCORRECT，correctness score 5.0。
- 相比 product-roadmap baseline：improved 1，same 19，regressed 0。
- numeric gate：20 ALLOW，0 REVIEW/BLOCK。
- table repair applied count：1 / 20，只修 q85。

## 风险与边界

该 skill 是 deterministic derived metric，而不是公司 factbook。它的风险不在数值计算，而在 `other sales revenue` 的业务定义。因此建议状态为 candidate / review_required，待人工确认该口径可以推广后再进入 guarded promotion。

不要把该规则扩展成所有 `其他收入` 问法；只有当问题明确是 `其他销售收入 / other sales revenue`，并且表格同时给出 total revenues、vehicle sales、sales of batteries and other components、research and development service and other services 时，才允许派生。

## 收手标准

本 skill 达到本轮收手标准：目标题通过，rotating20 已到 20/20，只有 1 条答案被重写，且无回归。后续不应继续在 q85 上局部打磨；应转向更高层的泛化验证、独立 judge/人工抽检，或把该派生指标规则纳入 skill registry 的人工审批流程。

