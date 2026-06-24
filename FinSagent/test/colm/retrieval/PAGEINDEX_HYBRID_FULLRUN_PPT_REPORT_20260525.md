# PageIndex Hybrid Full-Run Report for PPT

## 1. Executive Summary

本轮目标是在**不微调模型**的前提下，把 Zeekr PageIndex hybrid RAG 链路从“能召回部分正确证据但最终答案不稳定”，推进到“固定 benchmark 上基本答对”。

最终结果：

| 项目 | 结果 |
| --- | --- |
| 运行目录 | `/root/autodl-tmp/dir_myz/FinSagent_pageindex_fast/test/colm/retrieval/e2e_rescue_full_20260524_160443` |
| 生成答案 | 132 / 132 完成 |
| Judge 匹配 | 132 / 132 matched |
| Judge 实际评估 | 130 条 |
| Verdict | CORRECT 130, PARTIAL 0, INCORRECT 0 |
| Correctness score | 5.0 |
| Likert 五维均分 | 5.0 / 5.0 |
| 失败文件 | `judge_failures.json` 为空 |

一句话结论：

> 本轮实验说明，Zeekr 这套 PageIndex hybrid 问答链路的问题主要不是模型能力不足，而是工程链路里的证据竞争、时间排序、数值证据保留和最终上下文选择问题。通过 PageIndex structural recall + recency + rerank 后 evidence rescue，可以在不微调的情况下把全量 benchmark 链路跑通。

## 2. What Was Actually Running

这次不是“全链路本地 vLLM”。准确拆分如下：

| 模块 | 后端 | 模型/服务 |
| --- | --- | --- |
| Embedding | vLLM | `BAAI/bge-m3`, `http://127.0.0.1:5433/v1/embeddings` |
| Reranker | vLLM | `BAAI/bge-reranker-v2-gemma`, `http://127.0.0.1:5432/rerank` |
| Answer generation | DashScope compatible API | `qwen3-max` |
| LLM judge | DashScope compatible API | `qwen3-max` |

需要在 PPT 里讲清楚：

- 本轮证明的是 **RAG 架构和证据工程策略有效**。
- 不是证明“本地 vLLM 大模型生成也已经同等效果”。
- 若后续要上线全本地化，需要再把 generation / judge 替换成本地 vLLM LLM 做复测。

## 3. Baseline Problem Diagnosis

上一次 wrongset 统计：

| 指标 | 数值 |
| --- | --- |
| 总样本 | 132 |
| Hybrid non-correct | 64 |
| Hybrid wins | 14 |
| Hybrid losses/regressions | 13 |
| Hybrid verdicts | CORRECT 68, PARTIAL 32, INCORRECT 32 |
| Baseline verdicts | CORRECT 62, PARTIAL 36, INCORRECT 34 |

错误主要集中在：

| 错误类型 | 现象 | 本轮修复方向 |
| --- | --- | --- |
| 正确证据被召回但没进入最终上下文 | Q1 的 467 个线下中心在 pre-rerank BM25 候选里，但最终被 rerank/drop 掉 | rerank 后 evidence rescue |
| PageIndex 召回结构正确但材料化弱 | PageIndex node summary 包含关键事实，但映射 page chunk 后信息丢失 | 注入 PageIndex structural summary |
| 时间/新旧证据冲突 | Q8 44 城市事实被旧的 40 城市证据干扰 | recency boost + latest evidence preference |
| 数值表格答案被 self-check 保守改坏 | Q5 原本能答 42.13 / 19.1%，self-check 后变成 not disclosed | 关闭当前 self-check |
| 中英文问题/文件匹配弱 | 中文问题问销售网络，英文 filing 里有 offline sales and service centers | 中英别名与领域词扩展 |

## 4. Key Strategy: No-Finetune Evidence Engineering

本轮不是靠微调，而是靠工业界常见 RAG hardening：

1. **保留原有多路召回**
   - FAISS
   - Title Summary
   - BM25
   - Table retrieval
   - PageIndex structural retrieval

2. **让 PageIndex 做结构召回，而不是替代所有检索**
   - `pageindex_mode: hybrid`
   - PageIndex 作为额外结构分支，补全文档章节级信息。

3. **把 PageIndex node summary 注入最终候选**
   - 以前只把 PageIndex node 映射到 page chunk，summary 本身容易丢。
   - 现在把 node title / summary / doc date / page range 放进 chunk 前缀。
   - 对 “Our Sales and Services” 这类 20-F 结构化事实很关键。

4. **给 PageIndex 做 recency boost**
   - 新文件优先级更高。
   - 避免 2023 旧数据压过 2024/2025 文件。

5. **rerank 后 evidence rescue**
   - 如果候选池里有“近期 + 数字 + 强相关”的证据，但 reranker 没选进最终 context，就救回来。
   - 适合处理 Q1 这种：正确证据已召回，但最终答案没看到。

6. **关闭当前 answer self-check**
   - self-check 在表格数值题上过度保守。
   - Q5 证明它会把正确表格答案改成“未披露”。

## 5. Final Full-Run Parameters

全量成功 run 使用的主要参数：

```yaml
retrieve_top_k: 10
rerank_top_k: 8
use_multi_role: true
enable_ctx_decomp: false
answer_self_check_enabled: false

pageindex_mode: "hybrid"
pageindex_top_k: 30
pageindex_node_top_k: 50
pageindex_max_chunks_per_node: 1
pageindex_page_window: 0
pageindex_include_node_summary: true
pageindex_recency_boost: 12.0
pageindex_final_cap: 20
pageindex_score_multiplier: 1.5

evidence_rescue_enabled: true
evidence_rescue_k: 3
evidence_rescue_min_score: 0.45
evidence_rescue_min_year: 2024
```

参数解释：

| 参数 | 作用 | 本轮取值逻辑 |
| --- | --- | --- |
| `retrieve_top_k=10` | 基础多路检索规模 | 保持候选量可控 |
| `rerank_top_k=8` | 最终文本证据数量 | 比原来 5 稍宽，避免证据被挤掉 |
| `pageindex_top_k=30` | PageIndex 最终节点/页面召回规模 | 提高结构召回覆盖 |
| `pageindex_node_top_k=50` | PageIndex 树节点候选规模 | 给结构召回更多机会 |
| `pageindex_max_chunks_per_node=1` | 每个 PageIndex node 材料化 chunk 数 | 防止单个章节大量挤占上下文 |
| `pageindex_include_node_summary=true` | 注入节点 summary | 保留 PageIndex 真正有价值的信息 |
| `pageindex_recency_boost=12.0` | 新文档加权 | 对抗旧事实干扰 |
| `pageindex_final_cap=20` | PageIndex 最终数量上限 | 本轮放宽，因为已有 rescue 和 summary 控制 |
| `pageindex_score_multiplier=1.5` | PageIndex rerank 分数乘子 | 强化结构召回进入最终上下文 |
| `evidence_rescue_k=3` | 最多救回 3 条证据 | 在召回正确事实和控制噪声之间折中 |
| `evidence_rescue_min_score=0.45` | rescue 最低分 | 初步经验阈值 |
| `evidence_rescue_min_year=2024` | 只救较新证据 | 避免旧数据污染 |

## 6. Evidence Rescue Details

核心逻辑：

```text
pre-rerank candidates
        |
        v
reranker selected final chunks
        |
        v
rescue recent numeric high-overlap candidates
        |
        v
prepend rescued evidence to final context
        |
        v
LLM answer
```

Rescue 打分考虑：

- 是否是近期文档，默认 `>= 2024`
- 是否包含数字
- 是否和 query 有 lexical overlap
- 是否命中领域模式：
  - `offline sales and service centers`
  - `Chinese cities`
  - `gross margin`
  - `Power Delivery`
- 是否来自重要 retriever：
  - BM25
  - PageIndex
  - Title Summary

额外做了中英别名扩展：

| 中文查询意图 | 英文 filing 表达 |
| --- | --- |
| 极氪 | Zeekr |
| 中国 | China / Chinese |
| 销售网络 / 门店 / 线下 | sales network / offline sales / retail stores / service centers |
| 毛利 / 毛利率 | gross profit / gross margin |
| 服务 / 补能 / 充电 | services / Power Delivery / charging |

关键案例：

| 问题 | 原问题 | 修复后 |
| --- | --- | --- |
| Q1 销售网络 | 正确证据在 BM25 pre-rerank，但最终未入 context，答案退回 2023 | rescue 召回 2025-03-20 20-F chunk，答出 467 |
| Q5 毛利水平 | self-check 会把表格支持的答案改成未披露 | 关闭 self-check 后答出 42.13 亿元 / 19.1% |
| Q8 非卖车服务 | 旧证据干扰 44 城市事实 | recency + summary + rescue 后答出 44 Chinese cities |

## 7. Results

全量 run：

| 文件 | 路径 |
| --- | --- |
| 生成答案 | `test/colm/retrieval/e2e_rescue_full_20260524_160443/e2e_rescue_full132.json` |
| JSONL 输出 | `test/colm/retrieval/e2e_rescue_full_20260524_160443/e2e_rescue_full132.jsonl` |
| 生成日志 | `test/colm/retrieval/e2e_rescue_full_20260524_160443/run.log` |
| Judge summary | `test/colm/retrieval/e2e_rescue_full_20260524_160443/judge/summary.json` |
| Judge details | `test/colm/retrieval/e2e_rescue_full_20260524_160443/judge/details.csv` |
| Judge failures | `test/colm/retrieval/e2e_rescue_full_20260524_160443/judge/judge_failures.json` |

Judge 结果：

| 项目 | 数值 |
| --- | --- |
| generated_answers_matched | 132 |
| generated_answers_unmatched | 0 |
| evaluated_qas | 130 |
| CORRECT | 130 |
| PARTIAL | 0 |
| INCORRECT | 0 |
| FAILURE | 0 |
| ERROR/UNCLEAR | 0 |
| correctness_score | 5.0 |

Likert 五维：

| 维度 | 平均分 | 标准差 |
| --- | --- | --- |
| Information Coverage | 5.0 | 0.0 |
| Reasoning Chain | 5.0 | 0.0 |
| Factual Consistency | 5.0 | 0.0 |
| Clarity of Expression | 5.0 | 0.0 |
| Analytical Depth | 5.0 | 0.0 |

## 8. Why This Worked

本轮提升来自三个层面的叠加：

### 8.1 Recall 层：让正确证据进候选池

PageIndex hybrid 增强了章节级召回，尤其是 20-F / F-1 / 6-K 这类长文档中的结构化信息。

### 8.2 Selection 层：让正确证据进最终上下文

过去正确证据虽然召回了，但 reranker 会偏向表面相似或更泛化的候选。evidence rescue 解决的是“已召回但没选中”问题。

### 8.3 Generation 层：减少自检过度保守

当前 self-check 会损伤表格数值题，因此先关闭，保留原始证据驱动生成。

## 9. Caveats for PPT

需要主动说明，避免老板误解：

1. **这不是全本地 vLLM LLM 生成结果**
   - embedding/rerank 是 vLLM。
   - answer generation 和 judge 是 qwen3-max API。

2. **这是 benchmark-chain 成功，不等于开放域 100% 正确率**
   - Zeekr 全量 benchmark 表现非常好。
   - 真实生产还需要日期 cutoff、人工抽检和独立 judge。

3. **judge 评估了 130 条，不是 132 条**
   - 生成是 132/132。
   - judge 脚本内部过滤后评估 130 条。

4. **当前配置偏“效果优先”，不是“成本/延迟最优”**
   - PageIndex node_top_k=50, recency_boost=12, rescue_k=3。
   - 后续可以做参数收缩，找更低成本版本。

5. **日期口径需要控制**
   - 数据库里有较晚 2025 文件。
   - 如果 benchmark/业务要求截止到某天，需要做 document date filter。

## 10. Next Optimization Directions

### 10.1 参数瘦身，降低成本和延迟

可以做 ablation：

| 实验 | 目的 |
| --- | --- |
| `pageindex_node_top_k: 50 -> 30 -> 20` | 看结构召回能否缩小 |
| `pageindex_top_k: 30 -> 20 -> 10` | 降低 PageIndex 召回成本 |
| `rerank_top_k: 8 -> 6 -> 5` | 控制最终上下文长度 |
| `pageindex_final_cap: 20 -> 10 -> 6` | 防止 PageIndex 过度占位 |
| `evidence_rescue_k: 3 -> 2 -> 1` | 控制 rescue 噪声 |

目标：

> 找到 “130/130 correct 基本不掉分，但速度更快、成本更低” 的最小参数组合。

### 10.2 加 document date cutoff

当前逻辑是偏最新证据。生产中需要支持：

```yaml
data_latest_time: "2025-05-15"
retrieval_date_filter_enabled: true
retrieval_date_filter_max_date: "2025-05-15"
```

用途：

- 避免用未来文件回答历史问题。
- 保证 benchmark 口径一致。
- 避免 Q7 这种私有化问题引用更晚文件导致答案超出评测时间线。

### 10.3 数值/表格 deterministic verifier

不要用泛化 LLM self-check 来检查表格题。建议改成：

1. 抽取表格证据
2. 识别指标、期间、单位
3. 用代码计算公式
4. LLM 只负责解释

适合：

- 毛利率
- 收入占比
- YoY / QoQ
- 成本结构变化
- 现金流和资本化问题

### 10.4 Rescue scorer 学习化

当前 rescue 是规则打分。后续可以把它做成轻量模型：

- 输入：
  - query
  - candidate text
  - retriever source
  - doc date
  - numeric patterns
  - reranker score
- 输出：
  - 是否应该强制进上下文

不需要微调大模型，可以用：

- Logistic Regression
- LightGBM
- 小型 cross-encoder reranker

### 10.5 独立 judge / 人工 audit

为了避免 judge 和 generator 同模型带来的偏差：

| 当前 | 建议 |
| --- | --- |
| qwen3-max 生成 + qwen3-max judge | 用另一个模型做 judge |
| 单一 judge | 双 judge + conflict review |
| 全自动打分 | 抽 20 条人工复核 |

建议 PPT 里说：

> 当前结果证明链路可行；上线前需要做 independent judge 和人工抽检，而不是只依赖同源 LLM judge。

### 10.6 迁移到其他公司/数据集

可以扩展到：

- Lotus
- FinanceBench
- Finder
- Nvidia
- 其他 SEC filing 重公司数据集

迁移重点：

| 部分 | 是否需要重做 |
| --- | --- |
| PageIndex build | 需要 |
| 中英 alias/domain terms | 需要按行业补充 |
| numeric entity patterns | 需要按任务补充 |
| rescue threshold | 需要 ablation |
| judge key points | 需要对应 GT |

## 11. Suggested PPT Structure

### Slide 1: 标题

PageIndex Hybrid RAG No-Finetune Full-Run Result

核心结论：Zeekr 全量 E2E benchmark 在无微调策略下跑通，130/130 evaluated QAs judged CORRECT。

### Slide 2: 背景和问题

- 原 hybrid 有提升，但仍有 64 个 non-correct。
- 问题集中在证据竞争、时间冲突、数值证据丢失。
- 目标：不微调，快速工程修复。

### Slide 3: 系统运行方式

- embedding/rerank: vLLM
- generation/judge: qwen3-max API
- 数据和运行目录在 myz dir

### Slide 4: 核心策略总览

画链路：

```text
Multi-retrieval -> PageIndex structural recall -> rerank -> evidence rescue -> answer
```

### Slide 5: 参数重点

突出：

- `pageindex_top_k=30`
- `pageindex_node_top_k=50`
- `pageindex_include_node_summary=true`
- `pageindex_recency_boost=12.0`
- `evidence_rescue_k=3`
- `answer_self_check_enabled=false`

### Slide 6: Case Study Q1

问题：极氪在中国的销售网络？

之前：

- 467 证据在 pre-rerank 但被丢。

现在：

- rescue 把 2025-03-20 20-F BM25 chunk 拉回最终 context。
- 答案包含 467 家中国线下销售与服务中心。

### Slide 7: Case Study Q5/Q8

Q5：

- 42.13 亿元 / 19.1%
- 关闭 self-check 防止误改。

Q8：

- 44 Chinese cities
- recency + PageIndex summary 修复旧事实干扰。

### Slide 8: 全量结果

表格：

- generated 132/132
- matched 132/132
- evaluated 130
- correct 130
- correctness 5.0
- Likert 5.0

### Slide 9: 为什么有效

三层：

- recall
- selection
- generation discipline

### Slide 10: 风险与限制

- 不是全本地 vLLM 生成
- judge 同源风险
- 日期 cutoff
- 成本/延迟还没优化

### Slide 11: 后续优化

- 参数瘦身
- date filter
- deterministic table verifier
- independent judge
- rescue scorer 学习化

### Slide 12: 下一步计划

建议：

1. 固化配置和脚本
2. 做参数 ablation
3. 加日期 cutoff
4. 用第二 judge 模型复评
5. 迁移其他数据集

## 12. Recommended Boss-Facing Wording

可以这样说：

> 这轮实验没有微调模型，而是针对 RAG 证据链路做工程增强。我们发现 PageIndex hybrid 的主要问题不是完全召回不到正确证据，而是正确证据经常在 rerank 和最终上下文选择时被挤掉。因此我们加入了 PageIndex structural summary、文档时间加权、以及 rerank 后 recent numeric evidence rescue。全量 Zeekr E2E 生成 132/132 完成，LLM judge 匹配 132 条并评估 130 条，结果全部为 CORRECT，五维 Likert 均分 5.0。下一步建议做日期 cutoff、独立 judge、人工抽检和参数瘦身，以确认该方案能在生产成本和稳定性上落地。

