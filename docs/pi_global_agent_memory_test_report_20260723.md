# 📝 Pi 全局 Agent 与跨会话记忆测试报告

> 📝 日期：2026-07-23
> 📝 分支：`codex/pi-global-agent-memory`
> 📝 被测版本：Pi `0.81.1`、`pi-memory@0.4.0`
> 📝 测试计划：`docs/pi_global_agent_memory_test_plan_20260723.md`

## 📝 1. 最终结论

- 📝 代码回归、真实 Pi 安装、记忆生命周期、项目隔离、并发写入、全局编排、权限策略、私募证据边界和故障恢复均已通过。
- 📝 真实 Pi 全量运行 `20260723-222519-507760b4` 为 `39 PASS / 0 FAIL / 0 BLOCKED`。
- 📝 Pi 隔离长稳运行 `20260723-230508-ea6bab52` 实际持续 1800 秒，共完成 70 轮“写入 → 新会话读取”，成功率 100%，没有持续延迟恶化。
- 📝 LLM 全并发阶梯运行 `20260723-213338-d10362` 为 `PASS`：并发 `1/2/4/8/16` 共 100/100 请求成功，指令、溯源、请求隔离、推理隐藏和工具准确率均为 100%。
- 📝 模型代理隔离长稳 `20260723-233615-05a852` 实际持续 1800 秒，并发 2 下完成 1016/1016 请求，成功率、指令、溯源、请求隔离和推理隐藏均为 100%。
- 📝 测试计划内所有用例均已完成且通过。本分支可进入评审；生产批量调度仍需遵守已测得的持续并发预算。
- 📝 额外的共享容量实验同时运行 Pi soak 与模型并发 8 soak，模型 3329 请求成功率为 49.98%，Pi 36 轮成功率为 69.44%；失败全部来自 LiteLLM 明确返回的 `429 Too many requests`。该结果证明当前本地代理不支持两类高压任务叠加，不属于记忆串库或权限失败。

## 📝 2. 用例状态矩阵

### 📝 2.1 代码、安装与记忆

| ID | 状态 | 结果 |
| --- | --- | --- |
| `REG-01` | PASS | Pi/私募相关定向回归 191/191 通过 |
| `REG-02` | PASS | Native session 大回归 390/390 通过 |
| `REG-03` | PASS | Ruff、核心 MyPy、Node syntax 与 diff check 通过 |
| `PKG-01` | PASS | 真实 CLI 严格为 `0.81.1` |
| `PKG-02` | PASS | 隔离受管目录真实安装并加载 `pi-memory` |
| `PKG-03` | PASS | 配置权限 `0700/0600`，无指向用户全局目录的 symlink |
| `PKG-04` | PASS | 重启复用 settings、models、package 与记忆 |
| `PKG-05` | PASS | `pi-memory` 精确 `0.4.0`；兼容 peer 为 `0.81.1`；`protobufjs` 为 `7.6.5` |
| `MEM-01` | PASS | 长期记忆真实写入 |
| `MEM-02` | PASS | 新 Pi 会话精确召回 nonce |
| `MEM-03` | PASS | daily 日志跨会话写入/读取 |
| `MEM-04` | PASS | scratchpad add/done/undo/clear |
| `MEM-05` | PASS | forget 删除并生成 recovery |
| `MEM-06` | PASS | restore 恢复且重复执行幂等 |
| `MEM-07` | PASS | stable snapshot 跨会话刷新 |
| `MEM-08` | PASS | per-turn snapshot 跨会话刷新 |
| `MEM-09` | PASS | qmd 缺失时核心读写正常、降级明确 |
| `MEM-10` | PASS | qmd keyword 精确检索 |
| `MEM-11` | PASS | qmd semantic/deep 可用或按无向量契约自愈 |

### 📝 2.2 隔离、并发与编排

| ID | 状态 | 结果 |
| --- | --- | --- |
| `ISO-01` | PASS | 同一 Git repo 主工作区/worktree 解析到相同记忆目录 |
| `ISO-02` | PASS | 两个同名但不同 Git repo 解析到不同目录 |
| `ISO-03` | PASS | 两个同名非 Git 路径解析到不同目录 |
| `ISO-04` | PASS | 项目 B 的工具结果、文件与回答均不含项目 A nonce |
| `CON-01` | PASS | 4 个同项目 Pi 进程并发写入无丢失 |
| `CON-02` | PASS | 4 个隔离项目并发读写串库率为 0 |
| `CON-03` | PASS | 8 个真实 Pi 并发请求成功率 100% |
| `ORCH-01` | PASS | Agent/session/async/timer/terminal/OS/private-fund 工具齐全，share 缺失 |
| `ORCH-02` | PASS | Agent 与 session 全局发现 |
| `ORCH-03` | PASS | 子会话 create/send/history/info/close 生命周期 |
| `ORCH-04` | PASS | 四路子任务 fan-out 与结果 ID 关联 |
| `ORCH-05` | PASS | 异步 inbox、结果读取与取消 |
| `ORCH-06` | PASS | timer set/触发/查询/cancel，无重复触发 |
| `ORCH-07` | PASS | 受控 OS 只读路径可用，拒绝动作不执行 |
| `ORCH-08` | PASS | 子任务失败不终止主 Agent，任务完成回收 |

### 📝 2.3 策略、证据、模型与长稳

| ID | 状态 | 结果 |
| --- | --- | --- |
| `SAFE-01` | PASS | `sys_session_share` 未注册且不可调用 |
| `SAFE-02` | PASS | DENY fail-closed，relay 执行次数为 0 |
| `SAFE-03` | PASS | relay 不可达时工具显式失败 |
| `SAFE-04` | PASS | 记忆/证据提示注入不改变工具和权限边界 |
| `EVID-01` | PASS | 虚假投资记忆未进入事实结论 |
| `EVID-02` | PASS | 投资事实强制调用 `private_fund_*` |
| `EVID-03` | PASS | 最终重大事实只引用 relay 白名单 evidence ID |
| `EVID-04` | PASS | 跨公司 nonce、dataset 与 evidence 隔离 |
| `LLM-01` | PASS | smoke 普通/流式请求成功，工具能力预检为 AVAILABLE |
| `LLM-02` | PASS | 100/100 成功；质量、溯源、隔离、推理隐藏、工具准确率全部 100% |
| `SOAK-01` | PASS | 1800 秒、70/70 轮成功，无持续延迟恶化 |
| `SOAK-02` | PASS | 隔离并发 2 持续 1800 秒，1016/1016 成功，nonce 串线率为 0 |
| `CHAOS-01` | PASS | qmd 离线不影响 memory read/write |
| `CHAOS-02` | PASS | relay 中断 fail-closed，恢复后新请求正常 |
| `CHAOS-03` | PASS | 超时 Pi 子进程被回收，无孤儿 marker |

## 📝 3. 关键量化结果

### 📝 3.1 真实 Pi 全量

- 📝 目录：`output/pi_global_agent_test_runs/20260723-222519-507760b4/`
- 📝 结果：39/39 PASS。
- 📝 并发批次：8 个请求，成功率 100%，p50 `10259.7 ms`，p95 `13861.3 ms`。
- 📝 研究证据：错误记忆中的 `999` 未被采用，最终使用结构化工具返回的 `12.5` 与 `chunk:verified-alpha-001`。

### 📝 3.2 Pi 隔离长稳

- 📝 目录：`output/pi_global_agent_test_runs/20260723-230508-ea6bab52/`
- 📝 轮次：70；成功率：100%。
- 📝 p50：`23607.6 ms`；p95：`34288.3 ms`。
- 📝 四分位均值：`21625.3 / 24364.1 / 25440.6 / 23643.9 ms`；未出现连续单向恶化。
- 📝 前半均值：`22888.2 ms`；后半均值：`25015.2 ms`。
- 📝 最终记忆文件总量：`85800 bytes`；子进程累计峰值 RSS 指标：`490208 KB`。

### 📝 3.3 LLM 全阶梯

- 📝 目录：`output/llm_stress_runs/20260723-213338-d10362/`。
- 📝 总请求：100；成功：100；总 token：47834；总耗时：163.198 秒。
- 📝 p95 延迟：并发 1/2/4/8/16 分别为 `6939.9 / 4613.0 / 6948.1 / 4479.4 / 3790.9 ms`。
- 📝 并发 16 相对并发 1 的 p95 退化为 `0.546x`，低于 `3x` 门槛。
- 📝 指令遵循、provenance、request isolation、no reasoning leak、tool accuracy 均为 1.0。

### 📝 3.4 模型代理隔离长稳

- 📝 目录：`output/llm_stress_runs/20260723-233615-05a852/`。
- 📝 并发：2；持续时间：1808.327 秒；请求：1016；成功率：100%。
- 📝 p50：`3169.2 ms`；p95：`6682.6 ms`；p99：`10156.1 ms`；吞吐：`0.564 RPS`。
- 📝 指令遵循、provenance、request isolation、no reasoning leak 和质量通过率均为 1.0。
- 📝 总 token：590358。soak 套件不重复执行工具轨迹，因此总标签为 `COMPLETED_WITH_BLOCKED_CAPABILITY`；计划内 `SOAK-02` 不要求工具轨迹，且 `LLM-02` 已单独验证工具准确率为 1.0。

### 📝 3.5 共享容量负向实验

- 📝 模型目录：`output/llm_stress_runs/20260723-223402-62b5bf/`。
- 📝 Pi 目录：`output/pi_global_agent_test_runs/20260723-223402-4402db5a/`。
- 📝 模型并发 8 持续 1800 秒：3329 请求，1664 成功、1665 个 429，成功率 49.98%；请求隔离与推理隐藏仍为 100%。
- 📝 同期 Pi：36 轮，成功率 69.44%；失败轮次直接记录到 qwen3-max 的 429。
- 📝 结论：短突发可到并发 16，但当前本地代理的持续配额不支持并发 8 soak 与 Pi soak 叠加。生产批量任务需要并发预算、排队或上游配额提升。

## 📝 4. 安全审计

- 📝 原 CI 固定的 Pi `0.75.5` 落在
  [CVE-2026-54328](https://github.com/advisories/GHSA-jfgx-wxx8-mp94) 与
  [auth.json 竞态公告](https://github.com/advisories/GHSA-r95r-rj6r-c39x)
  的受影响范围，已升级到修复版本 `0.81.1`。
- 📝 `pi-memory@0.4.0` 原本会自动安装废弃的 `@mariozechner/pi-coding-agent@0.73.1`。现在旧 `pi-ai` 名称指向维护版 `@earendil-works/pi-ai@0.81.1`，旧 coding-agent 名称由仅实现两个所需序列化函数的本地兼容层承接。
- 📝 兼容层输出已与官方 Pi `0.81.1` 的 `convertToLlm` 和 `serializeConversation` 对比，代表性消息逐字一致。
- 📝 真实受管安装后的 `npm audit --omit=dev` 为 0 个 info/low/moderate/high/critical。
- 📝 上游完整 Pi CLI 包含 `npm-shrinkwrap.json`，当前仍锁有一个 `protobufjs 7.6.4` 中危传递依赖；根项目 override 无法可靠覆盖。该残留影响 CI CLI 依赖树，不存在于受管 `pi-memory` 树，需等待上游 Pi 发布更新或使用明确的安装后修补流程。
- 📝 CI 同目录还固定了旧 Claude CLI `2.1.124`，当前审计另报一个 Claude 中危项；它不属于本次 Pi 功能改动，已在待办中单独记录。

## 📝 5. 测试过程中发现并修复的问题

1. 📝 Pi print/JSON 模式完成后被 inbox interval 持有，进程不退出。修复为保留轮询但 `unref()`，交互式 TUI 行为不变。
2. 📝 新版 Pi 只在扩展工具抛异常时标记 `isError`；直接返回 `{isError: true}` 会被改写为成功。桥接现在对 relay error 抛出可读异常，确保 fail-closed。
3. 📝 旧 pi-memory peer 自动带入未修复的旧 Pi；改为维护版 `pi-ai` alias 与最小兼容层。
4. 📝 npm 默认把精确 `0.4.0` 改写为 `^0.4.0`；受管目录现在固定 `save-exact=true`，真实重启后仍保持精确版本。
5. 📝 数据集删除测试重复创建已初始化的 `meta` 目录；测试准备改为幂等。
6. 📝 两项 Claude Native 测试受仓库 `cc-haha` 自动选择影响；测试现在固定被测命令为 `claude`，隔离环境差异，Native 大回归恢复 390/390。

## 📝 6. 产物与复现

- 📝 批量驱动：`omnigent/scripts/run_pi_global_agent_tests.py`。
- 📝 测试计划：`docs/pi_global_agent_memory_test_plan_20260723.md`。
- 📝 每次 Pi 运行保留 manifest、case JSONL、完整 Pi JSON 事件、stderr、relay 请求、指标和 Markdown/JSON 汇总。
- 📝 每次 LLM 运行保留完整请求/响应、流式分片、证据评分、工具轨迹、Provider/系统指标和 `analysis_bundle.zip`。
- 📝 所有输出位于 Git 忽略的 `output/`，不包含 API Key 或授权请求头。

## 📝 7. 发布判断

- 📝 功能、安全、隔离、证据和可持续并发 2 的长稳门禁全部通过。
- 📝 短突发并发 16 已通过；持续并发 8 会触发当前代理配额的稳定 429，不能作为默认批量配置。
- 📝 建议生产默认把模型持续并发设为 2；更高并发需要队列、429 指数退避或提升上游配额后再复测。
- 📝 Pi 与模型长稳不要在当前单一代理配额下同时跑满；批量调度器应使用共享并发预算。

## 📝 8. 2026-07-24 LongMemEval-S 能力基准

- 📝 新增官方 LongMemEval-S 分层 runner，并从六类题型各抽取 5 题；30 题在 memory 与空记忆 baseline 下各运行一次，共 60 次真实 Pi 调用。
- 📝 Memory 准确率为 36.7%（11/30），baseline 为 10.0%（3/30），提升 26.7 个百分点；27 道可回答题中分别为 33.3% 与 0%。
- 📝 答案会话命中率为 73.3%，但命中后答对率只有 45.5%；单会话用户事实为 80%，多会话聚合和隐含偏好均为 0%。
- 📝 Memory 平均消耗 2,635 token，较 baseline 增加 993（60.4%）；平均时延 16.99 秒，增加 6.66 秒（64.4%）。
- 📝 全部 60 次调用成功，无超时或非零退出；串行墙钟耗时 16.20 分钟。
- 📝 本次是固定样本 pilot，使用本地 `gpt-5.6-sol` 裁判且历史已预先物化，不等于官方 500 题 leaderboard，也不覆盖自主持续写入选择。
- 📝 详细方法、分类数字和问题分析见 `docs/pi_memory_longmemeval_pilot_20260724.md`。
