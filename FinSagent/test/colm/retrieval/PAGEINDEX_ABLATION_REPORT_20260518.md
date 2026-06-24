# PageIndex Retrieval Ablation Report

## 1. 实验背景

本轮实验目标是验证 PageIndex 是否适合作为现有 RAG 检索链路的结构化增强模块。当前原始 RAG 主要包含 FAISS / BM25 / Title Summary / Table retrieval / reranker。PageIndex 不使用 embedding，不建立向量索引，而是先将 PDF 构造成结构树，再在检索阶段基于章节标题、摘要、页码范围等结构信息召回候选 chunk。

数据侧 PageIndex 已完成 75 个可读 PDF 的结构索引构建。剩余 1 个文件 `F1_20231024.pdf` 原始 PDF 损坏，缺少 `startxref` / `%%EOF`，PyPDF2 和 PyMuPDF 均无法解析有效页面；GT 中没有题目引用该文件，因此不影响本轮 Zeekr 检索评估结论。

## 2. 实验组定义

| 版本 | PageIndex 参数 | Reranker / 运行方式 | 目的 |
|---|---|---|---|
| 标准版 | top_k=10, node_top_k=10, max_chunks_per_node=3, page_window=0 | 原本地 reranker | 验证 PageIndex 轻量 hybrid 是否有效 |
| 激进版 | top_k=15, node_top_k=15, max_chunks_per_node=4, page_window=1 | 原本地 reranker | 扩大结构召回和相邻页窗口，观察是否提升召回 |
| 保守版 | top_k=15, node_top_k=15, max_chunks_per_node=3, page_window=0 | 原本地 reranker | 只扩大节点召回，不扩相邻页 |
| vLLM 版 | top_k=10, node_top_k=10, max_chunks_per_node=3, page_window=0 | vLLM reranker, CPU eval | 验证低显存评估链路是否可行 |

三种架构对比：

| 架构 | 含义 |
|---|---|
| Baseline | 原 RAG 检索链路，不启用 PageIndex |
| Replace BM25 | 用 PageIndex 替代 BM25，验证 PageIndex 是否能独立承担关键词召回 |
| Hybrid | 保留 BM25，同时加入 PageIndex，验证结构化检索是否能作为补强 |

## 3. 指标总表

### 3.1 标准版

| 架构 | Precision | Macro Recall | Micro Recall | Jaccard | Avg Retrieved | Retrieval Time |
|---|---:|---:|---:|---:|---:|---:|
| Baseline | 0.0805 | 0.3313 | 0.1841 | 0.0641 | 38.20 | 10.73s |
| Replace BM25 | 0.0833 | 0.3263 | 0.1807 | 0.0675 | 37.70 | 10.76s |
| Hybrid | 0.0922 | 0.3513 | 0.1938 | 0.0717 | 37.13 | 11.96s |

相对 Baseline：

| 架构 | Precision Δ | Macro Recall Δ | Micro Recall Δ | Jaccard Δ | Time Δ |
|---|---:|---:|---:|---:|---:|
| Replace BM25 | +0.0028 | -0.0050 | -0.0034 | +0.0034 | +0.03s |
| Hybrid | +0.0117 | +0.0200 | +0.0097 | +0.0076 | +1.23s |

结论：标准版是目前最稳定的主结果。Hybrid 相比 Baseline 在 Macro Recall 上提升 +0.0200，约 +6.0%，Precision 和 Jaccard 也同步提升，耗时只增加约 1.23s。Replace BM25 没有超过 Baseline，说明 PageIndex 不适合完全替代 BM25。

### 3.2 激进版

| 架构 | Precision | Macro Recall | Micro Recall | Jaccard | Avg Retrieved | Retrieval Time |
|---|---:|---:|---:|---:|---:|---:|
| Baseline | 0.0928 | 0.3427 | 0.1995 | 0.0730 | 36.44 | 21.11s |
| Replace BM25 | 0.0952 | 0.3330 | 0.1898 | 0.0736 | 36.22 | 24.74s |
| Hybrid | 0.0954 | 0.3462 | 0.1904 | 0.0779 | 36.43 | 30.82s |

相对 Baseline：

| 架构 | Precision Δ | Macro Recall Δ | Micro Recall Δ | Jaccard Δ | Time Δ |
|---|---:|---:|---:|---:|---:|
| Replace BM25 | +0.0024 | -0.0097 | -0.0097 | +0.0006 | +3.63s |
| Hybrid | +0.0026 | +0.0035 | -0.0091 | +0.0049 | +9.72s |

结论：激进版不划算。PageIndex 节点数、每节点 chunk 数和相邻页窗口同时扩大后，Hybrid 的 Precision / Jaccard 略升，但 Macro Recall 只小幅提升 +0.0035，Micro Recall 下降，Retrieval Time 增加约 46%。说明 PageIndex 结构扩展不是越多越好，过度扩展会引入噪声和延迟。

### 3.3 保守版

| 架构 | Precision | Macro Recall | Micro Recall | Jaccard | Avg Retrieved | Retrieval Time |
|---|---:|---:|---:|---:|---:|---:|
| Baseline | 0.0877 | 0.3050 | 0.1881 | 0.0715 | 37.23 | 21.59s |
| Replace BM25 | 0.0865 | 0.3331 | 0.2018 | 0.0719 | 38.31 | 26.84s |
| Hybrid | 0.0830 | 0.3209 | 0.1687 | 0.0673 | 35.83 | 27.98s |

相对 Baseline：

| 架构 | Precision Δ | Macro Recall Δ | Micro Recall Δ | Jaccard Δ | Time Δ |
|---|---:|---:|---:|---:|---:|
| Replace BM25 | -0.0012 | +0.0281 | +0.0137 | +0.0004 | +5.25s |
| Hybrid | -0.0047 | +0.0159 | -0.0194 | -0.0042 | +6.39s |

结论：保守版显示 PageIndex 本身能补到一部分结构证据，Replace BM25 的 Macro Recall 反而提升；但 Hybrid 的 Precision、Micro Recall 和 Jaccard 均下降，说明当前融合排序存在候选互相挤占的问题。下一步更应该优化融合策略，而不是继续简单增大 PageIndex 召回量。

### 3.4 vLLM 版

| 架构 | Precision | Macro Recall | Micro Recall | Jaccard | Avg Retrieved | Retrieval Time |
|---|---:|---:|---:|---:|---:|---:|
| Baseline | 0.0755 | 0.3003 | 0.1567 | 0.0608 | 36.30 | 64.28s |
| Replace BM25 | 0.0728 | 0.2520 | 0.1504 | 0.0572 | 35.83 | 63.93s |
| Hybrid | 0.0723 | 0.2651 | 0.1487 | 0.0551 | 34.43 | 79.27s |

相对 Baseline：

| 架构 | Precision Δ | Macro Recall Δ | Micro Recall Δ | Jaccard Δ | Time Δ |
|---|---:|---:|---:|---:|---:|
| Replace BM25 | -0.0027 | -0.0483 | -0.0063 | -0.0036 | -0.35s |
| Hybrid | -0.0032 | -0.0352 | -0.0080 | -0.0057 | +14.99s |

结论：vLLM 版证明低显存评估链路可行。eval Python 不再本地加载大 reranker，显存从约 23GB 降到几百 MB 级别。但该轮实验中出现腾讯 LLM API handshake timeout，影响 query rewrite / agent routing；同时 vLLM reranker 的排序行为和本地 reranker 不一致，导致 PageIndex 组没有复现标准版提升。因此 vLLM 版目前应作为工程可行性验证，不作为最终算法效果结论。

## 4. 横向结论

| 版本 | Hybrid 相对 Baseline 的 Macro Recall | Hybrid 相对 Baseline 的 Precision | Hybrid 相对 Baseline 的 Time | 判断 |
|---|---:|---:|---:|---|
| 标准版 | +0.0200 | +0.0117 | +1.23s | 最佳主方案 |
| 激进版 | +0.0035 | +0.0026 | +9.72s | 收益小、耗时高，不推荐 |
| 保守版 | +0.0159 | -0.0047 | +6.39s | 召回有提升但精度下降，融合不稳 |
| vLLM 版 | -0.0352 | -0.0032 | +14.99s | 低显存跑通，但受 reranker / LLM timeout 影响，不作算法结论 |

整体判断：

1. PageIndex 不适合直接替代 BM25。标准版和激进版中 Replace BM25 都没有稳定超过 Baseline。
2. PageIndex 更适合作为 Hybrid 结构化补强。标准版中 Hybrid 的 Macro Recall、Micro Recall、Precision、Jaccard 均提升，且耗时增加较小。
3. 单纯扩大 PageIndex 召回量不是稳定优化方向。激进版和保守版显示更大的 node_top_k / window / chunks 可能引入噪声和延迟。
4. 后续优化重点应从“调大 PageIndex 参数”转向“融合策略优化”，例如限制 PageIndex 候选占比、只补充 BM25/FAISS 没覆盖的结构页、按问题类型动态启用 PageIndex。
5. vLLM reranker 方向工程上可行，但需要先解决 reranker 校准和 LLM rewrite 稳定性问题，再用于最终效果对比。

## 5. 为什么不继续盲调参数

当前已经覆盖了三类代表性参数设置：

| 参数方向 | 对应版本 | 观察 |
|---|---|---|
| 轻量融合 | 标准版 | Hybrid 稳定提升，收益/耗时平衡最好 |
| 扩大结构召回和页窗口 | 激进版 | Precision / Jaccard 略升，但耗时大幅增加，召回收益有限 |
| 只扩大节点召回 | 保守版 | Replace BM25 有提升，但 Hybrid 融合不稳，Precision / Micro Recall 下降 |

这说明 PageIndex 的收益主要来自“结构化补召回”，而不是简单扩大候选规模。继续把 `top_k` 或 `node_top_k` 调到更大，大概率会增加噪声和耗时，未必带来稳定收益。

因此当前建议停止盲目参数扫描，固定标准版作为 PageIndex Hybrid baseline：

```text
PAGEINDEX_TOP_K=10
PAGEINDEX_NODE_TOP_K=10
PAGEINDEX_MAX_CHUNKS_PER_NODE=3
PAGEINDEX_PAGE_WINDOW=0
```

下一步应转向可解释分析和融合策略设计。

## 6. Case Study 分析方向

Case Study 的目标是解释 PageIndex 为什么有效、什么时候无效，以及为什么 Hybrid 优于 Replace BM25。

### 6.1 PageIndex 帮助的场景

关注问题：

```text
Hybrid 命中，Baseline 未命中或命中更少
```

典型观察：

| 问题类型 | PageIndex 命中节点 | 解释 |
|---|---|---|
| 资本结构 / pro forma 变化 | `Capitalization` | 该类证据常集中在 F-1 的固定章节，PageIndex 能按章节定位跨页证据 |
| 收入规模 / 财务亮点 | `Financial Highlights` | 结构标题能补强关键词召回，尤其适合 SEC 报告的摘要型章节 |
| 销售网络 / 全球布局 | `Recent Developments` / sales network 相关章节 | PageIndex 能通过章节上下文补充 BM25 未覆盖的文档页 |

可汇报表述：

> PageIndex 的优势在于先定位文档结构节点，再映射回原 RAG chunk；因此对于章节型、跨页型、多跳型问题，能补充 BM25/FAISS 不容易直接召回的证据页。

### 6.2 PageIndex 拖后腿的场景

关注问题：

```text
Baseline 命中，Hybrid 未命中或命中更少
```

典型观察：

| 问题类型 | 可能原因 | 解释 |
|---|---|---|
| tariffs impact | 关键词很强 | BM25 对 tariff 等显式词面非常敏感，PageIndex 结构候选可能引入弱相关章节 |
| gross margin | 指标词明确 | 原始 BM25 / FAISS 已能覆盖，PageIndex 候选进入后可能挤占有效候选 |
| net profit / business outlook | 单点指标或强语义关键词 | 结构节点不一定比直接关键词匹配更精确 |

可汇报表述：

> PageIndex 不应无条件替代或大量扩展。对于强关键词、单指标型问题，BM25/FAISS 已经较强，过多 PageIndex 候选可能造成候选挤占。

### 6.3 Hybrid 强于 Replace BM25 的原因

Replace BM25 的目的不是最终方案，而是消融实验。结果显示 PageIndex 不能稳定替代 BM25，原因是：

1. BM25 擅长精确关键词命中。
2. PageIndex 擅长章节结构定位。
3. 两者覆盖的问题类型不同。
4. Hybrid 保留了 BM25 的关键词召回，同时补充 PageIndex 的结构召回，因此标准版表现最好。

## 7. 融合策略分析方向

当前 Hybrid 方式可以概括为：

```text
FAISS + BM25 + Table + Title Summary + PageIndex
-> 候选合并 / 去重
-> reranker 选择最终 evidence
```

问题在于 PageIndex 候选加入后，有时会挤掉 BM25 / FAISS / Table 的有效候选。后续更有价值的优化不是继续调大 PageIndex 参数，而是优化候选融合策略。

建议分析指标：

| 分析项 | 目的 |
|---|---|
| 最终 evidence source distribution | 看 PageIndex 在最终证据里贡献多少 |
| pre-rerank source distribution | 看 PageIndex 是否在候选阶段过量进入 |
| win/loss case 的 PageIndex 占比 | 判断 PageIndex 是补强还是挤占 |
| 按问题类型统计收益 | 找到适合开启 PageIndex 的 query 类型 |

可尝试的融合策略：

| 策略 | 说明 |
|---|---|
| PageIndex contribution cap | 限制 PageIndex 最多贡献 N 个最终 chunk，避免挤占 BM25/FAISS |
| Complement-only PageIndex | PageIndex 只补充 BM25/FAISS 没覆盖到的文档页或章节 |
| Source-aware weighting | 对 PageIndex 候选加权，但不与 BM25 高置信候选完全同权竞争 |
| Query-type routing | 章节型 / 跨页型问题开启 PageIndex，强关键词问题降低 PageIndex 权重 |
| Structural expansion only | PageIndex 只用于扩展已命中文档的相邻结构页，而不是直接进入全局排序 |

建议优先级：

1. 先做 win/loss case study，明确 PageIndex 帮助和伤害的题型。
2. 再做 PageIndex contribution cap，成本低、风险小。
3. 最后考虑 query-type routing 或更复杂的动态融合。

## 8. vLLM 版问题说明

vLLM 版不是 PageIndex 算法失败，而是评估链路发生了变化。

已确认：

```text
本地 reranker 标准版模型名: BAAI/bge-reranker-v2-gemma
vLLM reranker 模型名:      BAAI/bge-reranker-v2-gemma
```

模型名相同，但 backend 不同：

| 版本 | Reranker backend |
|---|---|
| 本地标准版 | 本地 FlagLLMReranker / FlagEmbedding 路径 |
| vLLM 版 | HTTP 请求 `http://127.0.0.1:5432/rerank` |

小样本 sanity check 显示两者大方向一致，但分数尺度不同：

| 样本 | 本地 score | vLLM logit score | 观察 |
|---|---:|---:|---|
| revenue 相关文本 | 8.98 | 5.87 | 两者都认为相关 |
| revenue 非相关法律文本 | -7.41 | 1.86 | 本地强烈压低，vLLM 分数仍为正 |
| gross margin 相关文本 | 2.71 | 5.87 | 两者都排前 |
| gross margin 非相关治理文本 | -5.37 | 1.72 | 本地强烈压低，vLLM 分数仍为正 |

这说明：

1. vLLM 服务不是完全错误，top 相关项排序方向基本一致。
2. vLLM relevance_score 转换后的分数分布更“挤”，负样本压制不如本地明显。
3. 在真实候选很多的情况下，分数尺度和截断策略差异可能影响最终 top-k evidence selection。

同时，vLLM 这轮日志中还出现外部 LLM API timeout：

```text
httpx.ConnectTimeout
SessionManager.py call_llm
https://api.lkeap.cloud.tencent.com/v1/chat/completions
```

该外部 LLM 是 `deepseek-v3.2` via 腾讯 LKEAP API，负责 query rewrite / agent routing，不是 vLLM reranker，也不是 PageIndex。前几轮实验也走该 API，但当时请求基本返回 200 OK；vLLM 版由于 CPU eval 更慢，运行时间更长，更容易暴露外部 API 网络波动。

因此 vLLM 版结论应表述为：

> vLLM 低显存链路已跑通，eval Python 不再额外占用 20GB+ 显存；但当前 vLLM reranker backend 与本地 reranker 的打分尺度不完全一致，且本轮混入外部 LLM timeout，因此暂不作为最终算法效果结论。

## 9. 建议下一步

短期汇报采用标准版作为主结果：

> PageIndex 作为结构化增强模块，在标准 Hybrid 配置下相对原 RAG Baseline 带来最稳定收益：Macro Recall +0.0200，约 +6.0%，Precision +0.0117，Jaccard +0.0076，Retrieval Time 仅增加约 1.23s。

下一步研发建议：

1. 固定标准版参数作为当前 PageIndex baseline。
2. 做 case study，解释 PageIndex 在 Capitalization、Financial Highlights、Sales Network 等结构化问题上补强 BM25 的能力。
3. 优化 Hybrid 融合策略，而不是继续增大 PageIndex 召回量。
4. vLLM 路线先做 reranker sanity check 和 timeout 稳定性验证，再复跑标准版。
5. 替换损坏的 `F1_20231024.pdf` 后补建 PageIndex，完成 76/76 数据闭环。
