# PageIndex Hybrid 阶段性冻结与后续优化边界报告

日期：2026-06-01

## 结论摘要

当前 PageIndex Hybrid SEC QA pipeline 已经完成从初始普通 RAG 到可审计、可验证、成本可控系统的阶段性升级。基于现有实验结果，建议冻结当前主架构，不再继续做大规模架构改造；后续只保留错误驱动的小修补、验证器扩展、评测补强和必要的成本微调。这个决策不是停止优化，而是把优化方式从“继续叠架构”切换为“基于真实失败样本做小步、可回归、可解释的工程加固”。

当前主架构已经覆盖 SEC QA 的核心高风险环节：结构化文档检索、日期/期间控制、表格数值确定性校验、答案覆盖修补、成本路由、评测审计和失败归因。在 small30 诊断集上，当前方案达到 `30 correct / 0 partial / 0 incorrect`，deterministic gate 为 `ALLOW 30 / BLOCK 0`，人工抽检 `20/20 PASS`，同时平均耗时从 `91.8s/题` 降至 `57.5s/题`，约下降 `37%`。这说明当前系统已经达到阶段目标：相较初始 RAG，正确性、可解释性和成本都有明显改善。

但 holdout20 也证明了另一点：继续换新测试集不能保证全对，当前剩余错误主要来自长尾事实、公司事件时间线、产品/董事会/IPO/政策口径、复杂表格列选择等具体 failure mode。这类问题不适合通过继续增加大 agent、大检索链路或复杂 self-check 来解决，因为这些大改会显著增加成本、引入新不确定性，并带来针对当前测试集过拟合的风险。更合理的方式是冻结主架构，对真实出现的错误进行小范围、通用化修补。

## 当前系统相较初始 RAG 的优化

初始 RAG 的主要问题是普通 chunk 检索对 SEC 长文档不够稳定，容易漏召回跨页、跨章节、跨表格信息；历史题可能召回未来文件，产生 future leakage；表格数值题容易用错列、错期间、错单位；多 agent / 多 query 展开会推高延迟；评测链路也缺少稳定的 gate、人工抽检和 failure analysis。

当前系统已经针对这些问题完成了主线升级。检索侧引入 PageIndex Hybrid，利用页级、章节级结构增强 SEC 长文档召回；时间侧加入 date cutoff / period-aware retrieval，降低历史问题召回未来文件的风险；数值侧加入 deterministic numeric verifier，对 delivery、gross margin、cash balance、working capital、capitalization、cost structure 等高风险表格题进行硬校验；答案侧加入窄口径 coverage repair，修补模型常漏的必要上下文；成本侧加入 `agent_max_sub_queries=2`，限制每个 agent 的 query decomposition 宽度；评测侧形成了 deterministic gate、LLM judge、latency profiling、人工抽检、holdout failure analysis 的闭环。

此外，已经完成 learning-based rescue scorer 的可插拔雏形。该模块不学习 Zeekr 专属事实，只学习 query/candidate token overlap、数字/年份匹配、retriever 来源、chunk 长度、原始分数等通用证据选择特征。离线 holdout 候选级 AUC 达到 `0.8993`，说明学习型证据选择方向可行，但 E2E smoke 只把部分错误从 incorrect 改成 partial，尚不足以作为默认模块。

## 关键实验结果

### Small30 诊断集

当前最佳 small30 结果如下：

```text
Generated answers:
test/colm/retrieval/subquery_cap2_small30_20260530/small30_coverage_repaired_v1.json

Validation:
test/colm/retrieval/subquery_cap2_small30_20260530/standard_validation_coverage_v1_judge/validation_summary.json

Result:
- judge: CORRECT 30 / PARTIAL 0 / INCORRECT 0
- correctness_score: 5.0
- deterministic gate: ALLOW 30 / BLOCK 0
- average time: 57.497s/question
- p50 time: 54.215s
- p90 time: 90.318s
- p95 time: 100.285s
- max time: 126.642s
- avg retrieved chunks: 19.1
- avg pre-rerank candidates: 101.467
```

相比未做 query decomposition slimming 的版本：

```text
Before cap2:
- average time: 91.776s/question
- total time: 2753.282s

After cap2:
- average time: 57.497s/question
- total time: 1724.911s

Delta:
- average time reduced by about 37.4%
- total time reduced by about 37.3%
- correctness stayed at 30/30
```

### 人工抽检

```text
Audit file:
test/colm/retrieval/HUMAN_AUDIT_CAP2_SMALL30_20260531.md

Sample size:
20 / 30

Result:
- Manual PASS: 20
- Manual PARTIAL: 0
- Manual FAIL: 0
```

人工抽检覆盖了数值表格、销售网络、治理结构、控股/VIE、自动驾驶合作、私有化原因、working capital、controlled company 等问题类型。结论是 small30 上的 judge 结果有人工支持，可以作为阶段性展示集。

### Holdout20 泛化检查

```text
Output:
test/colm/retrieval/holdout20_cap2_20260531/holdout20_coverage_repaired_v1.json

Validation:
test/colm/retrieval/holdout20_cap2_20260531/standard_validation_coverage_v1_judge/validation_summary.json

Result:
- judge: CORRECT 6 / PARTIAL 4 / INCORRECT 10
- correctness_score: 2.6
- deterministic gate before cash verifier patch: ALLOW 20 / BLOCK 0
- average time: 63.534s/question
```

holdout20 的结果说明当前方案不能直接宣称任意新测试集全对。失败主要集中在产品矩阵、Geely-Zeekr 关系、IPO 规模、董事会构成、制造地点、Zeekr Power、全球可得性、政策文件、volume breakdown 和 cash balance 等长尾事实或复杂表格口径问题。这个结果支持阶段性冻结主架构：当前主要瓶颈已经不是检索参数再扩大或架构再复杂，而是具体 failure mode 的系统化治理。

### Deterministic Verifier 新增通用修补

holdout20 中 q84 暴露了现金余额表格解析问题。原 verifier 只识别单行 `total cash, cash equivalents and restricted cash`，但目标表格把 `cash and cash equivalents` 与 `restricted cash` 分成两行。已补充通用逻辑：当 total row 不存在时，按目标季度列自动相加两行。

```text
After patch:
test/colm/retrieval/holdout20_cap2_20260531/standard_validation_after_cash_verifier_gate_only/validation_summary.json

Result:
- gate: ALLOW 19 / BLOCK 1
- blocked row: qa_kp_84
- expected RMB fact: 8,048,100 thousand
- expected US$ fact: 1,107,455 thousand

Small30 regression:
test/colm/retrieval/subquery_cap2_small30_20260530/standard_validation_after_cash_verifier_gate_only/validation_summary.json

Result:
- gate: ALLOW 30 / BLOCK 0
```

这个修补符合当前边界：它不是 Zeekr factbook，而是通用表格解析能力增强。

## 为什么不建议继续做大架构优化

第一，当前主架构已经覆盖主要系统性问题。PageIndex Hybrid、date cutoff、deterministic verifier、coverage repair、cost slimming、evaluation audit 都已经落地，并在 small30 上证明有效。继续增加大规模 agent、多轮 self-check、复杂 reranker 或更宽检索链路，短期内不一定解决 holdout20 暴露的问题。

第二，剩余错误的性质不支持继续堆大架构。holdout20 失败显示，错误主要来自长尾事实、公司事件时间线、产品/董事会/IPO/政策口径、具体表格期间和列选择。这些更适合通过小范围 verifier、日期规则、表格解析、证据选择来修补，而不是通过更复杂的全局架构改造解决。

第三，继续大改会提高过拟合风险。当前 small30 已经打满，如果继续围绕同一批题优化架构，很容易把系统调成“对这批题特别好”，但换 holdout 后仍然暴露问题。更合理的做法是冻结主架构，用新的 holdout/new set 暴露真实 failure mode，再把单点错误抽象成通用小模块。

第四，继续大改会推高成本和不稳定性。当前 `agent_max_sub_queries=2` 已经在保持 small30 正确率的同时降本约 `37%`。如果继续扩大 agent、检索或多轮推理，很可能把延迟重新拉高，同时增加不可解释错误。现阶段继续瘦身或继续堆复杂架构的收益都不如提升泛化验证质量。

第五，独立 GPT judge 当前受服务器网络限制。key 已验证正确，但服务器无法直连 OpenAI API，`api.openai.com` 连接超时。因此独立 judge 暂时不是架构问题，而是外部网络条件问题。当前阶段可以用 deterministic gate、internal judge、人工抽检和 holdout failure analysis 支撑汇报，后续在网络条件允许时补独立 judge。

## 后续优化边界

建议冻结当前主配置，将后续优化限制在以下范围内：

```text
允许继续做：
- 针对真实错误扩展 deterministic numeric/table verifier
- 修正 date cutoff / period-aware retrieval 的具体边界
- 小范围调整 evidence rescue scorer，但默认保持关闭，直到 E2E 验证通过
- 增加 holdout/new test set 和人工抽检
- 修复明显 bug、日志、评测脚本、profiling 脚本
- 对独立 judge 做网络恢复或换环境补跑
```

```text
暂不建议做：
- 继续增加新 agent 或更复杂多 agent 架构
- 继续扩大 query decomposition 或检索宽度
- 上大规模 self-check / self-reflection 链路
- 为当前主线加入 Zeekr 专属 factbook
- 围绕 small30 继续做答案模板式修补
- 在没有新 holdout 验证前继续瘦身参数
```

公司级 fact registry / factbook 可以作为最后的独立增强模块或 ablation，而不是当前主线。未来如果需要换公司，可以考虑做一个自动读取 filing 并生成公司定制 fact registry 的功能，但这应作为单独模块评估，而不是混入当前主架构。

## 建议给老板的表述

当前系统已经完成阶段性主架构优化：从普通 RAG 升级为结构化检索、日期控制、确定性数值校验、成本控制和评测审计一体化的 SEC QA pipeline。在 small30 诊断集上达到 `30/30 correct`，人工抽检 `20/20 pass`，并将平均耗时降低约 `37%`。这证明当前主架构已经达到阶段目标。

下一阶段不建议继续做大架构改造，因为 holdout20 暴露的剩余问题主要是长尾事实和具体表格/时间口径问题，不是继续增加 agent 或扩大检索就能稳定解决。继续大改会增加成本、复杂度和过拟合风险。更合理的工程策略是冻结当前主架构，进入错误驱动的小修补阶段：对新测试集暴露的问题做归因，把可泛化的错误沉淀为 verifier、date rule、table parser 或 evidence rescue 的小模块，并通过回归集和 holdout 集验证不退化。

## 最终决策建议

建议将当前版本标记为 `stage-freeze candidate`。主架构不再继续大改；后续只做小修补、验证补强和外部 judge 补跑。是否进入下一轮大优化，应以新的 holdout/new set 结果为触发条件，而不是基于 small30 继续调参。如果新错误能够通过小修补解决，则不启动大架构改造；只有当多个新测试集反复证明当前主架构在某类问题上系统性失败，才考虑下一轮架构级优化。
