# FinSagent C2「财务证据闭环」Skill Combo 正式评测

## 1. Combo 定义

C2 使用 `evidence_fusion`，运行模式为 `active`，组合包含：

- `period_alignment`
- `finskillops_financial_numeric_synthesis`
- `financial_formula_verifier`
- `table_evidence_verifier`
- `source_conflict`
- `answer_coverage`

其核心相互作用是：DCI 提供结构化指标与模型单元格，RAG 提供文档/表格证据，Numeric Synthesis 约束期间、单位和来源，Formula Verifier 在最终答案阶段用同期间操作数进行确定性重算。

## 2. 正式 72 题结果

| 组别 | 机器 answer-atom 分 | P50 | P95 | 最大延迟 | doc_id 越界 |
|---|---:|---:|---:|---:|---:|
| C0 无 Skills 融合 | 70/72（97.2%） | 19.06s | 37.31s | 146.62s | 0/72 |
| C2 Active 财务证据闭环 | 71/72（98.6%） | 19.36s | 42.43s | 80.63s | 0/72 |

C2 相对 C0 修正 `FORMAL_CF3_034`、`FORMAL_V2_061`，回退 `FORMAL_IS2_004`，机器净增益 +1 题（+1.4pp）。

注意：C0 的 `FORMAL_CF3_033` 主结论实际错误，但正文包含标准答案数字，answer-atom scorer 将其判为通过。因此 70/72 是宽松机器分，不是严格的主结论正确率。人工主结论审计下，C0 至少应再减 1 题；C2 的该题由 Formula Verifier 输出唯一正式口径。

## 3. 甲方可直接展示的原话对比

### CF3 2024：主结论从错误模型 FCF 切换为正式两项口径

标准答案：`12,068.33 - 2,785.95 = 9,282.37 CNYm`。

**C0 原话（主答案错误，但机器误判通过）：**

> 阳光电源2024年自由现金流（正式口径）为7,773.85百万元人民币（CNYm）……此外，还需包含第三个操作数FCF调整项……若仅使用经营现金流和资本支出两个操作数计算，结果为9,282.37 CNYm，与正式口径不符。

**C2 原话：**

> 按正式评测口径，自由现金流 = 经营活动现金流 - 资本开支绝对值。2024经营活动现金流为12,068.33 CNYm，资本开支绝对值为2,785.95 CNYm，因此自由现金流为9,282.37 CNYm。

### CF3 2026E：修复模型调整项混入口径

标准答案：`16,561.24 - 2,931.41 = 13,629.83 CNYm`。

**C0 原话（失败）：**

> 按正式口径计算，阳光电源2026E年自由现金流为12,304.47 CNYm……模型中还包含一个调整项（FCF_ADJ）为-1,325.35 CNYm。

**C2 原话（通过）：**

> 按正式评测口径，自由现金流 = 经营活动现金流 - 资本开支绝对值。2026E经营活动现金流为16,561.24 CNYm，资本开支绝对值为2,931.41 CNYm，因此自由现金流为13,629.83 CNYm。

### V2 2020：修复裸模型算术错误

标准答案：`110.94 / 0.9609008955 = 115.45x`。

**C0 原话（失败）：**

> 根据Control panel当前价110.94元及2020年每股收益（EPS）0.9609元计算，阳光电源2020年的Trailing PE为25.8倍。具体计算过程为：110.94 / 0.9609008954577172 ≈ 25.803。

**C2 原话（通过）：**

> Trailing PE = 当前价 / EPS = 110.94 / 0.9609008955 = 115.45倍。

### IS2 2026E：发现并修复 Combo 回退

标准答案：营业成本按指标展示口径取绝对额 `67,704.36 CNYm`，同时可披露模型原始负号。

**首次 C2 原话（失败）：**

> 阳光电源2026E年营业成本预测值为-67,704.36百万元人民币（CNYm），该数值为预测值，直接提取自模型单元格Upload Sheet!T43。

**修复后目标复测原话（通过）：**

> 2026E营业成本为67,704.36 CNYm（百万元人民币）。按指标展示口径取成本绝对额；模型单元格原始列示值为-67,704.36 CNYm。

## 4. Skill 触发与可归因性

首次 72 题中 `financial_formula_verifier` 对 CF3/V2/V3/V7 共 8 个目标 case：8/8 触发、0 误触发、8 次均覆盖最终答案。加入营业成本符号规范后，独立目标复测覆盖 IS2/CF3/V2/V3/V7 共 10 题：

- 答案：10/10 通过；
- Formula Verifier：10/10 触发，precision=100%，recall=100%；
- Numeric Synthesis：10/10 触发；
- P50=20.49s，最大值=80.67s（FCF 检索仍是尾延迟来源）。

目标复测目录：

`/root/autodl-tmp/dir_lzx/finsagent_e2e_eval_outputs/runs/formal_postfix_c2_active_postsign_20260811`

## 5. Table Evidence Verifier 的真实状态

formal_90 构造器将 `table_evidence_verifier` 硬编码为 72 题全部期望触发，但首次 C2 运行实际 0 次应用。排查表明：

- final SkillContext 并未丢失表格证据；代表题 retrieved chunks 含 5 个 table chunks，pre-rerank 含 35 个；
- verifier 当前只实现交付量、服务收入、资本化、营运资本、现金余额等旧 benchmark 的专用解析器；
- 它不支持通用 IS/BS/CF Excel 行，因此返回 `NO_TABLE_FACTS`；
- 结论是能力范围与 formal_90 标签错配，而不是 RAG 索引再次失效。

在修复标签或扩展通用 Excel 行解析前，不能把 C2 的总体 micro trigger recall 当作产品结论；应分别披露 Formula Verifier 的 100% 目标触发和 Table Verifier 的当前不适用状态。

## 6. 原始产物路径

- C0 融合：`/root/autodl-tmp/dir_lzx/finsagent_e2e_eval_outputs/runs/formal_postfix_c0_fusion_20260810`
- C2 首次全量：`/root/autodl-tmp/dir_lzx/finsagent_e2e_eval_outputs/runs/formal_postfix_c2_active_full72_20260811`
- C2 符号修复后 10 题复测：`/root/autodl-tmp/dir_lzx/finsagent_e2e_eval_outputs/runs/formal_postfix_c2_active_postsign_20260811`

每个目录均含 `raw_outputs/`、`answer_markdown/`、`evidence/`、`scorecards/`、`progress.jsonl` 和运行 manifest。

## 7. 当前可下结论与不可下结论

可以下结论：C2 的确定性公式 Skill 对已支持的 10 个目标题具有可重复、可追踪的正向作用，并能修复 FCF 口径、PE 算术、市值单位和成本符号问题。

暂不可下结论：修复后全 72 题已经重新取得 72/72；目前只完成唯一失败项及所有 Formula 目标题的独立复测。也不能声称 Table Verifier 在这套通用财务题上有效。
