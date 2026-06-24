# ablation lambda

* 用之前生成run3(multi-role + offline calibration)的subquery和activated agent，固定其他agent的lambda，调整其中一个的lambda，看retrieve的gt是否变化

画图：`python test/colm/ablation/lambda/parse_results.py`

* `replay_run3_retrieve_evidence.py`
    * 重新用run3里面生成的sub-query，做一次检索，比较和之前检索的是否一致。

## 实验

* 命令：
```bash
python test/colm/ablation/lambda/replay_agent_lambda_ablation.py --benchmarks lotus finder --agents quant legal_risk company_researcher market_researcher --lambda-values 0 0.1 0.2 0.3 0.6 --workers 6
```

* 结果：`test/colm/ablation/lambda/agent_lambda_ablation_20260330_130534.json`
