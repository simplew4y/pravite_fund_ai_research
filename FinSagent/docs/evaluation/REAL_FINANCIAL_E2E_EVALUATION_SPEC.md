# FinSagent 真实金融端到端评测规范

状态：正式验收规范
适用分支：`RAG`
固定输出目录：`/root/autodl-tmp/dir_lzx/finsagent_e2e_eval_outputs`

## 1. 验收目标

代码测试通过不等于产品验收通过。正式结论必须来自真实金融问题的端到端运行，并保存模型第一手输出、检索证据、引用、doc_id、Skill轨迹和延迟。

之前基于31项自定义事实的首轮表仅作为探索性结果，不得作为正式结论。正式硬指标采用 `OUTPUT_QUALITY_METRICS.md` 中的36项：IS1–IS7、BS1–BS7、CF1–CF3、D1–D7、V1–V7、R1–R5。

## 2. 必须覆盖的任务

1. 精确指标：收入、归母净利润、毛利率、经营现金流、资本开支等。
2. 带修饰词指标，例如“剔除阶段性影响后的实际毛利率”；修饰词属于答案主键。
3. 年度、季度、累计、TTM、FY1/FY2/NTM预测值混合及实际/预测冲突。
4. 完整研报生成和多文档综合。
5. CEO、董事长、实控人、股权、管理层任免及生效日期。
6. 明确无答案问题，验证能否拒答并说明缺失证据。
7. 跨公司污染反例及同名指标、相同期间诱饵。

## 3. 检索链路消融

Skills关闭且模型、题目、提示词和采样参数固定：

- R0：DCI only。
- R1：RAG only。
- R2：DCI + RAG / Evidence Fusion。

必须报告：

- `Gain_vs_DCI = Accuracy(R2) - Accuracy(R0)`。
- `Gain_vs_RAG = Accuracy(R2) - Accuracy(R1)`。
- `Synergy = Accuracy(R2) - max(Accuracy(R0), Accuracy(R1))`。
- 融合救回、融合退化的题号、原始答案和证据变化。

## 4. Skill组合消融

固定R2融合检索与同一模型，使用 `SKILL_COMBO_MATRIX.yaml` 中C0–C5。Skill重叠不扣分；通过最终答案、引用、污染、研报和延迟判断组合价值。

组合必须记录：候选Skills、实际触发Skills、触发原因、执行状态、执行阶段、耗时及输出修改摘要。Skill触发Precision/Recall/F1根据Case中的`expected_skills`计算。

## 5. 正式指标

### 5.1 答案

- 原子事实正确率：多值答案拆为原子事实计算micro accuracy。
- 整题正确率：所有必要原子事实、公司、期间、口径、币种均正确才通过。
- IS/BS/CF/D/V/R分组通过率和36项逐项通过率。
- 无答案正确拒答率与编造率。

### 5.2 引用与边界

- 引用正确率：被引用证据确实支持对应结论。
- 引用完整率：核心结论具有有效证据的比例。
- 检索doc_id越界率、引用doc_id越界率、答案公司污染率分别报告。
- 同时报告发生过越界的Case比例，避免大量正常chunk稀释严重事故。

### 5.3 检索及Skills增益

- DCI、RAG、融合准确率和净增益。
- Skill相对C0的答案增益、引用增益、污染变化和延迟成本。
- Skill触发Precision、Recall、F1，以及应触发未触发、错误触发、触发无效明细。

### 5.4 性能

- 冷启动和热态分开。
- 并发1/2/4/8分别测试。
- P50/P95/P99、吞吐量、超时率、HTTP错误率、模型错误率。
- 保存每次请求的开始时间、首token时间、完成时间和失败原因。

## 6. 研报验收

每个Combo的完整报告必须原样保存，禁止只保存摘要。至少覆盖财务快评、季度点评、年度深度、多文档盈利预测、估值情景分析和公司治理事件影响。

事实指标与主观研报质量分开报告。主观维度包括多文档覆盖、投资逻辑、催化剂、风险、结构和可读性；存在严重事实错误时，不得用主观综合分宣称整体质量提升。

## 7. 输出目录

```text
cases/                         题集、标准答案、允许doc_id、期望Skills
shared_ground_truth/           标准值和来源位置
tools/                         固化运行与评分脚本
runs/<run_id>/manifest.json    commit、模型、配置、数据集和Skills快照
runs/<run_id>/raw_outputs/     每次调用完整原始JSON/SSE
runs/<run_id>/answer_markdown/ 所有逐题完整答案
runs/<run_id>/reports/         所有完整研报
runs/<run_id>/evidence/        chunks、引用映射和边界审计
runs/<run_id>/scorecards/      逐事实、逐题、36项及汇总跑分
runs/<run_id>/performance/     并发与分位延迟
runs/<run_id>/logs/            服务和运行日志
runs/<run_id>/showcase/        从全量输出生成的甲方对比索引
latest                         最近一次完整运行
```

## 8. 完成门禁

一次运行仅在以下条件全部满足时标为`complete`：

1. 36项指标全部有有效Case和逐项结果。
2. 所有要求的任务类型齐全。
3. DCI、RAG、融合及适用Skill Combo原始输出齐全。
4. 每条结果均保存回答、引用、检索doc_id、Skill轨迹和耗时。
5. 全部研报可直接打开阅读。
6. 并发1/2/4/8性能结果齐全。
7. 失败样例可从汇总分数反向定位到模型原始答案与证据。
