# Skill 瘦身 / 抽象化审计 Brief

## 背景

当前系统已经积累了多个 deterministic verifier / repair / gate。优点是可控、可解释；风险是规则越来越长、越来越像人工校验，维护成本和过拟合风险上升。

你的任务不是删规则，而是判断哪些规则可以抽象、合并、参数化。

## 核心问题

1. 哪些 skills 其实属于同一个抽象模块？

可能的抽象模块：

- `annual_component_table_verifier`
- `quarterly_metric_verifier`
- `period_aware_retrieval`
- `source_conflict_reporter`
- `numeric_answer_gate`
- `coverage_keypoint_repair`
- `abstention_policy`

2. 哪些触发条件太硬？

例如：

- 只匹配英文 wording；
- 只匹配某家公司表格 label；
- 只靠几个关键词决定是否触发；
- 对 partial 的 required facts 太多；
- source recency / period cutoff 规则过度固定。

3. 哪些可以从 if-else 变成 schema？

例如一个 table skill 可以用结构定义：

```json
{
  "fact_type": "component_mix",
  "section": "cost of revenues",
  "rows": ["vehicle sales", "sales of batteries and other components"],
  "columns": ["RMB", "%"],
  "period": "annual_years"
}
```

4. 哪些必须保留 deterministic？

不要为了“看起来简洁”删掉高价值 safety gate：

- table numeric verifier
- source conflict reporter
- period cutoff/backfill
- unsupported uncertainty gate

## 输出目标

文件名：`SKILL_SLIMMING_AUDIT.md`

必须包含：

1. 当前 skills 的复杂度地图
2. 建议合并的 skills
3. 建议参数化的 trigger / fact type
4. 建议保留为 hard gate 的规则
5. 建议降级为 review-only 的规则
6. 一版“瘦身后 skill taxonomy”

## 推荐 taxonomy

可以先尝试把当前 10 个 skill 收敛成 5 类：

1. Retrieval structure
   - PageIndex hybrid
   - period cutoff/backfill

2. Deterministic table skills
   - table verification
   - source conflict
   - component mix

3. Answer quality control
   - coverage repair
   - unsupported uncertainty
   - abstention policy

4. Learning/offline enhancement
   - learning rescue scorer

5. Company customization
   - optional fact registry

## 判断标准

每个规则给出一个建议：

- `keep_as_gate`: 不能删，直接保护 correctness。
- `merge_into_table_schema`: 合并进表格 schema。
- `make_review_only`: 只提示，不自动改。
- `parameterize`: 改成配置项。
- `remove_or_defer`: 当前收益不足或过拟合风险高。

## 不要做什么

- 不要只按代码行数删逻辑。
- 不要把所有 deterministic checks 说成低含金量。
- 不要直接改主线代码。
- 不要用“更通用”作为理由牺牲高风险金融问答正确性。

## 推荐结论格式

| area | current issue | slimming action | expected benefit | risk |
| --- | --- | --- | --- | --- |
| component table skills | multiple fact-specific detectors | schema-driven annual/quarterly table verifier | fewer hardcoded branches | schema parser must be tested |
| coverage repair | judge-sensitive | keep manual-review only | avoids benchmark chasing | partial remains |
| source conflict | narrow but valuable | keep as explicit reporter | protects against forced reconciliation | may need per-company source labels |

