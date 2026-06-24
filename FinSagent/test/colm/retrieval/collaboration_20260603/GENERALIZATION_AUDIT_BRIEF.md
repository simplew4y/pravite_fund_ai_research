# 泛化 / 反过拟合审计 Brief

## 背景

当前系统已经在 Zeekr protected small30 上通过，并通过 rotating20 暴露和修复了一批结构化表格问题。现在需要独立审计：这些 skills 到底是 SEC 通用能力，还是 Zeekr 单公司题库修补。

你不需要继续修 Zeekr 分数。你的任务是横向挑战系统。

## 核心问题

1. 哪些 skills 看起来是 SEC 通用结构？
   - annual table component mix
   - quarterly metric extraction
   - source conflict reporting
   - period cutoff/backfill
   - capitalization / cash / delivery 等表格校验

2. 哪些 skills 看起来像 Zeekr-only？
   - 触发条件包含具体公司事实？
   - hard-code 了 benchmark answer wording？
   - 只在某一题或某一页有效？
   - 对其他公司可能误触发？

3. 当前 gates 是否过严？
   - 是否把 partial 也当 failure？
   - 是否要求答案列出过多细节？
   - 是否会把合理概括挡掉？

4. 有没有跨公司 regression？
   - NVIDIA mini10 当前 gate pass，但样本较小。
   - 建议再选 10-20 条另一家公司 high-risk SEC QA 做 smoke test。

## 建议测试设计

优先做 small but sharp，不要一上来全量：

- 5 条 annual table / component mix
- 5 条 quarterly metric / period control
- 5 条 company structure / governance
- 5 条 narrative coverage / risk factor

如果时间不够，先做 10 条：

- 4 table
- 3 period
- 3 narrative/governance

## 判断标准

把每个 skill 标成一类：

- `general_sec_skill`: 明显可迁移的 SEC 表格/时间/证据结构。
- `company_adaptable_skill`: 逻辑通用，但需要换公司表格路径或别名。
- `zeekr_specific_risk`: 可能依赖 Zeekr 特有题型、答案、文件。
- `over_strict_gate`: 规则可能正确但过度保守。
- `unsafe_to_generalize`: 不建议跨公司默认启用。

## 必须输出

文件名：`GENERALIZATION_AUDIT.md`

内容包括：

1. 测试公司、测试集、题型分布
2. 每个 skill 的泛化判断
3. 误触发案例
4. 未触发但应该触发的案例
5. 建议保留、降级、改名或参数化的 skills
6. 是否建议进入 blind holdout

## 不要做什么

- 不要直接改主线 production config。
- 不要为了新公司临时写公司 factbook。
- 不要用 blind holdout 来开发 skill。
- 不要只给最终分数，要解释失败桶。

## 推荐结论格式

| skill | judgment | evidence | risk | recommendation |
| --- | --- | --- | --- | --- |
| component_mix_table_v1 | general_sec_skill | annual component table pattern appears in multiple filings | low | keep guarded |
| source_conflict_v1 | company_adaptable_skill | needs conflict evidence in both sources | medium | keep manual review |
| coverage_repair_v1 | over_strict_gate | may chase benchmark keypoints | medium | keep but do not auto-promote |

