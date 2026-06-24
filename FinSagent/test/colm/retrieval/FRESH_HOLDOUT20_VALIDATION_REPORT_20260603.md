# Fresh Holdout20 Validation Report

## 结论

final20 已闭环到 20/20，但不应直接外推成“新测试集必然全对”。本轮把 final skill stack 应用到 full132 后，选取未参与 final20 修补的 blind_holdout20 做一次只评估、不修补的 fresh validation，结果为 10 CORRECT / 7 PARTIAL / 2 INCORRECT / 1 FAILURE，correctness score 3.65。

这说明当前系统在目标公司诊断集上已经可控，但泛化仍有明确风险。下一步应做小而通用的边界修复和 coverage 扩展，而不是继续大改主检索架构。

## 评测设置

- 输入：`test/colm/retrieval/e2e_rescue_full_20260524_160443/e2e_rescue_full132.json`
- final stack 输出：`test/colm/retrieval/final_stack_validation_20260603/full132_pipeline/full132_final_stack_repaired.json`
- fresh slice：`test/colm/retrieval/final_stack_validation_20260603/blind_holdout20_final_stack_repaired.json`
- holdout indexes：16, 18, 28, 29, 48, 55, 64, 71, 77, 81, 82, 87, 88, 92, 100, 112, 115, 116, 119, 130
- 与 final20 重叠：0
- judge：`config/production_pageindex_fast.yaml`
- OpenAI independent judge：仍因服务器无法访问 `api.openai.com:443` 阻塞，本轮未使用。

## 结果

- Judge：10 CORRECT / 7 PARTIAL / 2 INCORRECT / 1 FAILURE
- Score：3.65
- Numeric gate：19 ALLOW / 1 REVIEW
- Gate failure：q116 capitalization，缺 accumulated deficit 等 required table facts
- 平均耗时：98.6s/题，p95 200.1s/题

## 失败类型

- skill boundary false positive：q116。`vie` intent 误命中英文 `view`，把 capitalization 问题改成 VIE 结构答案。这是通用触发器边界 bug，不是公司 factbook 问题。
- date cutoff / source conflict：q100。2024 Q1 gross margin 应按 2025-03-20 前口径取 11.8%，答案引入后续 16.3% 形成冲突。
- numeric unit scaling / renderer gap：q130。capitalization 数字单位表达被 judge 判为放大或口径混乱，需要 renderer 更明确保留 RMB thousands / US$ thousands。
- latest cash balance coverage gap：q29、q71。问题问现金/现金流状态，gold 实际要 2025-03-31 cash + restricted cash 余额 RMB 9,898m。
- market / competitor coverage gap：q28、q64。缺 tech-savvy/family users、Waymo/US、Mobileye/NVIDIA、RMB 300k+ premium segment 等关键点。
- quarterly growth metric coverage gap：q87。答出 Q2 2024 vehicle sales revenue，但漏同比 59.0% 和环比 64.4%。
- entity alias coverage gap：q18。Viridi / 威睿能源别名关系答得过于保守，漏 49% 吉利持股和交易日期。
- profile fact coverage gap：q48。VIE 答案方向正确，但漏 ADS 间接持有和外资所有权限制边界。

## 判断

这次 holdout 的问题大多不是“主检索架构整体崩掉”，而是可分类的尾部风险：

- 一类是 skill 触发边界 bug，例如 q116。
- 一类是日期 cutoff 和来源口径，例如 q100。
- 一类是覆盖项不足，例如现金余额、竞争对手、增长率。
- 一类是表格 renderer 单位表达不够稳，例如 q130。

因此继续大改架构不是最佳路线。更合适的是按风险桶做少量通用 skill 修补，然后用新的 fresh slice 验证，而不是在同一个 holdout 上反复追满分。

## 下一步建议

1. 修通用边界 bug：把 profile intent 的 `vie` substring 改为词边界，避免 `view` 误触发。
2. 增加 date cutoff 规则：同一指标多来源冲突时，优先满足题目 cutoff，而不是混入后续披露。
3. 增加小型 coverage skills：cash balance latest snapshot、market/competitor profile、quarterly growth metrics。
4. 保留 holdout20 为诊断记录，不在本轮继续追 20/20；下一轮应使用新的 fresh slice 或人工定义小测试集验证修补是否泛化。

