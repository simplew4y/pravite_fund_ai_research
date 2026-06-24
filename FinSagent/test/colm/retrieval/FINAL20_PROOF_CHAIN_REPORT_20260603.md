# Final20 Proof Chain Report

## 结论

当前 skill stack 在 rotating diagnostic final20 上完成闭环：20/20 CORRECT，numeric gate 全部 ALLOW，agent-assisted audit 20/20 PASS。这个结果可以作为“目标公司诊断集已闭环”的阶段性证据，但还不应表述成“任意新测试集保证全对”。

## 当前验证结果

- 主 judge：20 CORRECT / 0 PARTIAL / 0 INCORRECT，correctness score 5.0。
- numeric/table gate：20 ALLOW，0 REVIEW/BLOCK。
- q85 target：1/1 CORRECT，解决了 `其他销售收入` 的派生指标口径问题。
- q65 target：1/1 CORRECT，解决了 `新车计划 / 是否油车` 的最新产品边界问题。
- registry validation：115/115 artifacts OK，gate flow PASS。
- auto-guarded decision：applied 0，skipped 17，说明高风险或需复核 skill 没有被自动推广。

## Agent-Assisted 20 条审计

审计文件：

- `test/colm/retrieval/skill_evolution_rotating_run_20260603/other_sales_skill_v1/proof_chain/human_audit_sample20.csv`
- `test/colm/retrieval/skill_evolution_rotating_run_20260603/other_sales_skill_v1/proof_chain/human_audit_sample20_filled.csv`

审计结果：

- manual_verdict：20 PASS。
- judge_verdict：20 CORRECT。
- gate_decision：20 ALLOW。

证据类型分布：

- deterministic_table_gate：7
- narrow_profile_fact：7
- coverage_keypoint_repair：2
- retrieval_answer_judge_checked：4

修补类型分布：

- profile_fact_repair：7
- coverage_repair：5
- table_repair：1
- none：7

解释：final20 不是单纯靠一类规则硬 patch。这里同时包含表格确定性校验、窄 profile facts、coverage cleanup，以及原检索答案直接正确的题。q85 是唯一新增 table_repair，且为派生指标计算，不是背答案。

## 独立 Judge 状态

尝试使用 `config/openai_gpt4o_judge.yaml` 做 gpt-4o independent judge。服务器侧到 `api.openai.com:443` 连接超时：

`curl: Failed to connect to api.openai.com port 443 after 10211 ms: Connection timed out`

因此本轮无法完成 OpenAI independent judge。该阻塞是网络环境问题，不是 final20 结果失败，也不是 key 缺失。后续如果需要把证明链补完整，需要先解决服务器出网到 OpenAI，或换一个服务器可达的独立 judge endpoint。

## 汇报口径

建议对老板这样说：

“当前系统在目标公司 rotating diagnostic final20 上已闭环到 20/20，并通过 numeric gate 和 20 条 agent-assisted audit。最后两类高风险问题已经拆成可解释 skill：产品路线属于 latest product boundary，其他销售收入属于 derived metric。我们没有继续大改架构，而是通过可审计、可回滚的 skill stack 收敛问题。下一步重点不是继续在这 20 条上打磨，而是做独立 judge、人工复核和新测试集泛化验证。”

## 下一步

1. 先修独立 judge 环境：确认服务器能访问 OpenAI，或配置另一个外部 judge endpoint。
2. 做 fresh rotating / small holdout：避免 final20 过拟合。
3. 找同事横向复核 skills：重点看 profile facts 是否过窄、derived metric 是否可泛化。
4. 若 fresh set 继续稳定，再冻结当前架构，把后续工作转成 skill registry + approval workflow。

