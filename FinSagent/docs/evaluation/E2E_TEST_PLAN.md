# FinSagent Skills Combo 真实端到端测试方案

适用分支：`RAG`
依赖规范：`OUTPUT_QUALITY_METRICS.md`、`REAL_FINANCIAL_E2E_EVALUATION_SPEC.md`、`SKILL_COMBO_CATALOG.md`

## 1. 目标

验证FinSagent在真实金融问答和研报生成场景中的：

1. 36项金融硬指标准确率。
2. DCI、纯RAG和Evidence Fusion的独立效果及融合净增益。
3. 18组Skill Combo在对应任务族上的质量增益和副作用。
4. 引用正确性、公司/doc_id边界、拒答与抗编造能力。
5. 串行及并发1/2/4/8的用户等待时间和系统稳定性。
6. 所有模型第一手回答和完整研报可审计、可展示。

## 2. 数据与隔离

### 2.1 真实数据

- `ygdy_data`：阳光电源3份内部资料。
- `test_real_data`：NVIDIA、Hermès、F1、Horizon、Porsche共5份模型。

### 2.2 合成压力数据

- `ygdy_report_skill_lab`：只使用已授权的隔离合成文件。
- 新增数据如有需要，只进入独立测试数据集，不修改`ygdy_data`和`test_real_data`。
- 所有Case标注`real`或`synthetic_holdout`，两者分别报告准确率。

## 3. Case规模

### 3.1 结构化金融指标：72题

每个36项硬指标至少2题：

| 分组 | 指标数 | 每项题数 | 合计 |
| --- | ---: | ---: | ---: |
| IS1–IS7 | 7 | 2 | 14 |
| BS1–BS7 | 7 | 2 | 14 |
| CF1–CF3 | 3 | 2 | 6 |
| D1–D7 | 7 | 2 | 14 |
| V1–V7 | 7 | 2 | 14 |
| R1–R5 | 5 | 2 | 10 |
| 合计 | 36 |  | 72 |

72题中必须嵌入：

- 至少4题带修饰词指标。
- 至少6题年度/季度/TTM/预测混合。
- 至少4题实际值与预测值同名冲突。
- 至少4题需要跨字段计算。
- 至少2题负值基数或正负转换。

### 3.2 安全与公司事实：18题

- CEO、董事长、管理层变更：3题。
- 股权、实控人、股东结构：3题。
- 明确无答案：6题。
- 跨公司污染：6题。

正式QA集共90题。旧60题可复用，但必须重做指标标签、原子事实、允许doc_id和期间口径；不能原样视为合格题集。

### 3.3 完整研报：8题

1. 阳光电源财务快评。
2. 阳光电源季度业绩点评。
3. 阳光电源年度财务深度分析。
4. 阳光电源多文档盈利预测与情景分析。
5. 阳光电源可比公司与估值分析。
6. 公司管理层/股权事件影响分析。
7. 企业信用尽调报告。
8. 储能行业景气、竞争格局和公司投资价值综合报告。

## 4. Case字段

每题必须包含：

```yaml
case_id: IS1_REAL_001
question: ...
task_family: financial_metric
metric_ids: [IS1]
company: 阳光电源
ticker: 300274.CH
period: 2024A
actual_or_estimate: actual
answer_atoms: []
formula: null
tolerance_rule: extract
allowed_doc_ids: []
forbidden_doc_ids: []
source_locations: []
expected_skills: []
must_refuse: false
data_class: real
```

## 5. 实验阶段

### Phase 0：配置与链路门禁

- 校验18个Combo的所有Skill ID均可发现。
- 保存代码commit、模型ID、配置哈希、数据集版本和Skill package hash。
- C0确认Skill运行时关闭；其他组合确认仅allowlist内Skills启用。
- 实现并验证评测专用`rag_only`路径；生产配置不修改。

### Phase 1：检索消融

对90题关闭Skills，分别运行：

- R0：DCI only。
- R1：RAG only。
- R2：Evidence Fusion。

共270次请求。报告答案准确率、引用正确率、doc_id越界率和延迟，并计算：

- Fusion相对DCI净增益。
- Fusion相对RAG净增益。
- `Fusion - max(DCI, RAG)`协同值。
- 救回题和退化题的完整原始输出。

### Phase 2：核心财务Skills消融

- C0/C1/C2：运行72道硬指标题。
- C3：运行全部无答案、修饰词、期间冲突题。
- C4：运行全部跨公司和主体边界题。

C0结果复用，不重复调用。重点判断C1→C2的增量，以及C3/C4是否以牺牲覆盖率换取安全性。

### Phase 3：专业场景组合

每个组合选择8道目标Case，包含6道正触发和2道相似但不应触发的负例：

- C5：财报深读。
- C6：季度业绩点评。
- C7：公司一页纸。
- C8：公司深度研报。
- C10/C11：估值和行情。
- C12：行业景气。
- C13/C14：治理与股权。
- C15：公告事件。
- C16：机构调研准备。
- C17/C18：信用尽调与债务排雷。

负例用于计算Skill触发Precision，防止所有长问题都触发深度Skills。

### Phase 4：完整研报横向比较

8道研报不要求18组全部运行，使用对应组合：

| 研报任务 | 对比组合 |
| --- | --- |
| 财务快评 | C0、C2、C5、C7、C9 |
| 季度点评 | C0、C2、C6、C9 |
| 年度深度 | C0、C5、C8、C9 |
| 盈利预测与情景 | C0、C2、C8、C9 |
| 估值与可比公司 | C0、C2、C10、C11、C9 |
| 治理事件影响 | C0、C4、C13、C14、C9 |
| 信用尽调 | C0、C5、C14、C17 |
| 行业综合 | C0、C8、C12、C9 |

每篇研报保存完整Markdown及原始JSON，不得只保存摘要。

### Phase 5：并发与稳定性

选择5类请求：精确指标、复杂计算、多文档问答、一页纸、完整深度研报。

- 并发：1、2、4、8。
- 每档至少3轮。
- 冷启动单独运行，不计入热态分位数。
- 记录P50/P95/P99、吞吐、首响应时间、超时和错误率。
- 同时记录8008 vLLM状态、GPU显存、排队长度和服务错误。

## 6. 自动判分

### 6.1 数值指标

- 纯提取：±1最小显示单位。
- 计算值：相对误差≤0.5%。
- 单位可等价转换，币种必须正确。
- 公司、期间、累计/单季、实际/预测、修饰词任一错误则该原子事实失败。
- 多值题同时报告原子事实micro accuracy和整题exact match。

### 6.2 引用和边界

- 每条核心结论建立claim→citation映射。
- 引用正确率和引用完整率分开。
- 检索doc_id越界、引用doc_id越界和答案公司污染分开。
- 同时报告发生过任何越界的Case比例。

### 6.3 拒答

- 材料无答案且明确说明缺失：通过。
- 给出无法由材料支持的具体事实或数值：编造失败。
- 仅说“不知道”但材料实际存在答案：错误拒答。

### 6.4 Skill触发

- 对照`expected_skills`计算Precision/Recall/F1。
- 记录应触发未触发、错误触发、触发无效和触发后退化。

### 6.5 研报

事实硬门禁与主观质量分开：

- 财务事实和计算准确性。
- 期间及实际/预测一致性。
- 引用支持和冲突处理。
- 多文档覆盖与关键遗漏。
- 投资逻辑、催化剂和风险。
- 结构和可读性。

存在严重事实错误、公司污染或编造时，不得用主观总分宣称整体提升。

## 7. 产物

固定根目录：

```text
/root/autodl-tmp/dir_lzx/finsagent_e2e_eval_outputs/
```

每次运行保存：

```text
runs/<run_id>/
  manifest.json
  raw_outputs/<retrieval>/<combo>/<case_id>.json
  answer_markdown/<retrieval>/<combo>/<case_id>.md
  reports/<combo>/<report_id>.md
  evidence/<retrieval>/<combo>/<case_id>.json
  scorecards/atomic_facts.csv
  scorecards/question_scores.csv
  scorecards/metric_36_scores.csv
  scorecards/combo_scores.csv
  scorecards/retrieval_ablation.csv
  performance/request_log.jsonl
  performance/concurrency_summary.csv
  showcase/index.md
  logs/
```

## 8. 规模与耗时预估

- 检索消融：270次。
- 核心Skills和专业场景：约160–210次，复用C0。
- 完整研报：约35–40次。
- 并发与稳定性：至少60次。
- 总量约525–580次端到端调用。

按历史单请求约200秒估算，串行约29–32小时；并发4理想下限约7–8小时，实际需考虑GPU排队、超时和冷启动，建议预留10–14小时。

## 9. 执行门禁

开始全量运行前先完成12题Smoke Test：

- 4题精确指标。
- 2题修饰词/期间冲突。
- 2题无答案。
- 2题跨公司污染。
- 1题公司治理。
- 1题完整研报。

Smoke Test必须确认原始输出、引用、doc_id和Skill轨迹均能落盘；否则不得开始数百次全量调用。
