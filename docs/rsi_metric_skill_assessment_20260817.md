# FinSagent RSI：Metric 与 Skill 现状评估

## 结论

现有系统已经具备可复用的 Skill 执行层和单次失败诊断链，但尚未形成可证明“能力真的提升”的 RSI。当前最大缺口不是再增加一个 repair，而是补齐独立评估、成对实验、触发精度、证据/范围指标、统计门禁、不可变归档和人工晋级。

本次实现把两层职责分开：`skillops` 继续描述和记录单个 Skill；`rsi` 消费确认失败，提出多个候选并在隔离评测中比较 baseline/candidate。RSI 不读取 hidden answer，不修改 evaluator，也不自动晋级。

## 现有 Skill 盘点

| Skill Card | 状态 | 主要失败类型 | RSI 评价 |
| --- | --- | --- | --- |
| `answer_coverage` | promoted | answer coverage | 有生产 repair；需要补“错误补写”和无证据触发负例 |
| `company_profile_boundary` | promoted | profile boundary | 有公司边界保护；需要跨公司噪声与泛化 holdout |
| `period_alignment` | promoted | period mismatch | 与 source conflict 高度耦合，适合作为首个 RSI pilot |
| `source_conflict` | promoted | wrong source/source conflict | 当前实现存在窄场景逻辑，需要公司无关的证据仲裁实验 |
| `table_evidence_verifier` | promoted | table alignment | 有确定性 verifier；缺单位、累计/单季和邻行负例指标 |
| `evidence_rescue_scorer` | experimental | retrieval miss | 可作为检索召回候选，但必须监控成本与错误救援 |
| `exact_evidence_probe` | experimental | evidence retrieval | 可作为诊断探针；不应直接等同答案正确 |
| `quant_skill_hints` | experimental | metric/table calculation | 目前偏 trace/hint；缺计算原子和公式重算门禁 |

## 现有 Metric 的不足

现有 gate 主要依赖 `correct/partial/incorrect`、failure count 和 protected set 是否通过。这足以做 smoke regression，但不足以支持 RSI 晋级：

- `core_protected_v1` 为 40/40 饱和集，适合防回归，不适合证明增益。
- `skillops_demo_v1` 只有 6 个稳定演示案例，证明链路可重放，不代表统计能力。
- 缺少 baseline/candidate 同题同 seed 的成对差值和置信区间。
- 缺少 citation support、scope control、refusal precision/recall、trigger false-positive、critical error、延迟和成本的统一向量。
- 缺少 targeted、fresh internal、protected 三类数据切片的同时门禁。
- 缺少 mechanism attribution，无法区分候选机制生效与随机波动/评估器漂移。

## RSI v1 Metric 向量

每次 target run 由独立 judge 生成：

- `success`：任务是否通过核心原子门禁。
- `atomic_correctness`：独立事实/计算原子的得分，不与文风混合。
- `citation_support`：引用是否可解析且支持结论。
- `scope_control`：公司、期间、来源、实际/预测和单季/累计边界。
- `refusal_quality`：该答时不误拒、该拒时不编造。
- `critical_error_count`：公司/期间/口径/单位/禁止来源/编造等严重错误，必须为零。
- `trigger_true_positive` / `trigger_false_positive`：Skill 在正例、负例和 no-op 例上的触发质量。
- `latency_ms` / `cost_units`：成功质量之外的资源代价。
- `mechanism_attributed`：改进是否能由预期 Skill trace 和证据变化解释。

晋级默认要求 fresh/targeted 增益至少 3pp 且 bootstrap 95% CI 下界不低于 0；protected 下降不超过 1pp；引用和范围不回退；p95 延迟和成本分别不超过 15%/20%；机制归因至少 80%；严重错误和错误触发为零。自动门禁只产生 `eligible_for_human_review`。

## 首轮 RSI Pilot

首轮只做 `period_alignment + source_conflict`：

1. L0 候选：改变期间/来源兼容阈值，不改业务逻辑。
2. L2 候选：把当前窄场景 repair 泛化为“证据范围 + 报告期 + 来源日期”的公司无关仲裁。
3. 正例：指定期间被后续披露污染、同指标多版本冲突。
4. 负例/no-op：非时间题、来源一致题、只有后续来源且应拒答的题。
5. 回归：`core_protected_v1`、`cross_company_guard_v1`。

在 fresh internal 未建立前，不应宣称 RSI 已提升能力；当前模块只建立了可运行、可审计的实验和晋级协议。
