# Skill Evolution MVP 落地说明

## 当前完成内容

已完成 Phase 1 的半自动 skill evolution MVP：系统可以读取已有 judge 结果，自动汇总非 CORRECT case，并把错题归因到候选 SEC QA pipeline skills。当前版本只生成 skill proposal、promotion gate 和 testset refresh 候选，不自动修改主链路代码，也不自动合入规则。

核心脚本：

```text
test/colm/retrieval/skill_evolution_analyzer.py
test/colm/retrieval/skill_evolution_gate.py
test/colm/retrieval/build_skill_evolution_testsets.py
```

当前输出：

```text
test/colm/retrieval/skill_evolution_mvp_20260602/
  skill_evolution_summary.json
  failure_cases.csv
  skill_proposals.md
  promotion_gate/
    promotion_gate.json
    promotion_gate.md

test/colm/retrieval/skill_evolution_testsets_20260602/
  unseen_pool.json
  rotating_diagnostic_candidates.json
  blind_holdout_candidates.json
  testset_refresh_summary.json
  testset_refresh_report.md
```

## 当前输入评测集

| run | 作用 | 结果 |
| --- | --- | --- |
| Zeekr small30 cap2 | 瘦身配置目标切片验证 | 30 CORRECT / 0 failure |
| Zeekr diagnostic holdout20 | 高风险题型诊断 | judge 重跑后为 5 CORRECT / 4 PARTIAL / 11 INCORRECT |
| NVIDIA mini10 sanity | 跨公司 sanity check | 9 CORRECT / 1 INCORRECT |

注：holdout20 原记录为 6 CORRECT / 4 PARTIAL / 10 INCORRECT；恢复 judge results 后重跑变为 5 / 4 / 11，说明 LLM judge 存在小幅波动。因此后续更适合把 holdout20 作为风险定位集，而不是精确排名指标；关键结论仍是失败集中在高风险题型。

## 自动归因出的候选 skills

| skill | 当前定位 | primary cases | 说明 |
| --- | --- | ---: | --- |
| Period Control Skill | 已有初版，继续增强 | 3 | 控制 filing 日期、财年、季度、事件时间线，防止后续披露污染历史题 |
| Table Verification Skill | 已有初版，继续增强 | 6 | 对表格数值、单位、期间、行列做程序化校验 |
| Narrow Fact Registry Skill | 候选 skill | 5 | 管理产品矩阵、董事会、生产地点、Zeekr Power 等高频稳定事实 |
| Coverage Skill | 已有初版，继续增强 | 2 | 检查多 key-point 问题是否漏答，必要时触发补证据 |
| Source Priority / Conflict Resolver Skill | 候选 skill | 二级信号 | 处理不同 filing、不同时间版本、表格和叙述摘要之间的冲突；它是跨切面的辅助 skill，不作为主分类 |

## Promotion gate

已生成 promotion gate preflight：

```text
test/colm/retrieval/skill_evolution_mvp_20260602/promotion_gate/promotion_gate.md
```

当前 gate 规则：

1. protected regression：Zeekr small30 不能从 30/30 回退；
2. development diagnostic：Zeekr diagnostic holdout 应减少失败或改善目标 bucket；
3. cross-company sanity：NVIDIA mini10 不能变差；
4. 对旧错题生成的 skill，必须再跑新的 rotating diagnostic；
5. blind holdout 不参与 skill 生成，只用于最终验证。

## Testset refresh

已完成一版测试集刷新候选：

```text
test/colm/retrieval/skill_evolution_testsets_20260602/testset_refresh_report.md
```

当前从 Zeekr GT 中排除 small30 和 diagnostic holdout 已用过的 50 题，剩余 unseen pool 为 82 题。自动抽出：

| set | 数量 | 用途 |
| --- | ---: | --- |
| rotating diagnostic candidates | 20 | 发现新失败模式，可用于生成下一轮 skill proposal |
| blind holdout candidates | 20 | 不参与开发，只在候选 skill 通过前置 gate 后做最终泛化验证 |

这一步是为了防止 overfitting：skills 可以进化，但测试集也必须更新，不能只围着旧错题反复优化。

## 这说明什么

这证明“未来半自动进化”的第一步已经可以工程化：系统不再只给一个分数，而是能把失败样本自动转成可执行的 skill proposal，并给出 promotion gate 与新测试集候选。下一步不是人工凭感觉改答案，而是让系统输出：

1. 哪些题失败；
2. 失败属于哪类 skill 缺口；
3. 应该新增或增强什么 skill；
4. 合入前需要跑哪些 regression gate；
5. 需要补哪些 rotating / blind 测试题来防止过拟合。

## 后续落地方向

建议下一阶段按 controlled evolution 做，而不是 fully autonomous evolution：

1. 自动跑评测集；
2. 自动聚合 PARTIAL / INCORRECT；
3. 自动归因到 period、table、fact、coverage、conflict 等 skill；
4. 自动生成 skill proposal；
5. 自动刷新 rotating diagnostic 和 blind holdout；
6. 自动跑 small30 / diagnostic holdout / cross-company sanity / fresh rotating set 回归；
7. 通过准确率、成本、无回退 gate 后，再人工确认合入。

## 汇报口径

可以对老板说：

```text
我们已经开始把“人工看错题、人工补规则”的流程工程化。当前 MVP 可以自动读取评测结果，把失败样本归因到候选 SEC QA skills，生成下一步 skill proposal，并配套 promotion gate 和新测试集候选。短期还是受控半自动：系统负责发现和提出，人、regression gate 和持续刷新的测试集负责防止过拟合和误上线。
```
