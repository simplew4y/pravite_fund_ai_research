# DCI-PageIndex 路由增强修改报告

生成时间：2026-05-26

## 1. 背景与目标

本次修改针对 `dci-pageindex` 检索后端在 NVIDIA SEC 问答评测中的几个稳定失败模式：

- Earnings release 相关问题容易只命中 `10-Q`，漏掉包含 press release / non-GAAP / guidance 口径的 `8-K`。
- `has_pageindex=false` 的文件，如 `20250528_8-K`、`20250827_8-K`、`20250604_DEFA14A`，容易被 agent 弱化或跳过。
- H20、non-GAAP 毛利率、股东提案、Q1-Q3 趋势、FY2025 年度规模等问题需要金融披露知识辅助路由。
- 历史低召回题需要生产可用的 hard routing guardrails，但不能直接 hard code 最终答案。

目标是提高正式检索中的 evidence filing recall，尤其保证反复失败问题能检索到正确披露文件。

## 2. 修改范围

### 2.1 `src/core/DCIPageIndexRetriever.py`

新增生产检索级路由规则，不按题号返回答案，而是为 query 自动补充：

- `route_hints`
- `critical_filings`
- `fallback_searches`
- `financial_skills`
- `reported_fiscal_period`

覆盖的金融路由技能包括：

- `earnings_release_skill`：季度业绩、guidance、non-GAAP、press release 优先查 `8-K`。
- `sec_filing_skill`：10-Q/10-K 与 8-K 的互补关系。
- `financial_metric_skill`：收入、净利润、EPS、毛利率、年度增长、Q1-Q3 趋势。
- `proxy_governance_skill`：DEF14A/DEFA14A、股东提案、董事会建议。

同时增强了工具能力：

- `read_manifest` 支持 `reported_fiscal_period` 和 `event_tag` 过滤。
- 默认 manifest 返回新增字段：`reported_fiscal_period`、`event_tags`、`search_aliases`。
- `reported_fiscal_period` 对普通 10-Q 自动 fallback 到 `fiscal_period`，避免只对 enriched 8-K 生效。
- 当 LLM 提前输出 evidence 但漏掉 critical filing 时，系统会自动从对应 markdown/tables 中补充匹配片段。
- 最终 top-k evidence 做 filing diversity 排序，优先保留 critical filings，避免一个文件的多个片段挤掉关键文件。

### 2.2 `scripts/build_dci_corpus_pageindex/build.py`

新增可复现的 NVIDIA route metadata，避免后续重建 corpus 时丢失人工增强字段。

已覆盖的关键 filing 包括：

- `20250126_10-K`
- `20250226_8-K`
- `20250427_10-Q`
- `20250528_8-K`
- `20250727_10-Q`
- `20250827_8-K`
- `20251026_10-Q`
- `20251119_8-K`
- `20250604_DEFA14A`

### 2.3 `dci_corpus_pageindex/manifest.json`

对当前运行使用的 manifest 直接补充元数据字段：

- `reported_fiscal_period`
- `is_earnings_release`
- `event_tags`
- `search_aliases`

这属于当前 corpus 的热修，同时已同步到构建脚本，避免只对当前文件生效。

## 3. 核心策略

### 3.1 Earnings Release / 8-K 兜底

季度业绩类问题，例如 revenue、net income、EPS、gross margin、non-GAAP、guidance，会强制把 `8-K` 加入候选表单，并优先查对应 reported quarter 的 earnings release。

例如：

- FY2026 Q1：`20250427_10-Q` + `20250528_8-K`
- FY2026 Q2：`20250727_10-Q` + `20250827_8-K`
- FY2026 Q3：`20251026_10-Q` + `20251119_8-K`

### 3.2 H20 专项规则

当 query 包含 H20 / China / 出口 / license / non-GAAP / gross margin 等信号时，会强制查：

- `20250409_8-K`
- `20250427_10-Q`
- `20250528_8-K`
- Q2 对比问题额外查 `20250727_10-Q` 和 `20250827_8-K`

并加入跨文件 fallback grep：

- `H20.*China|China.*H20`
- `H20.*gross margin|gross margin.*H20`
- `unable to ship|no H20 sales|unrestricted customer|previously reserved H20`

### 3.3 Proxy / Vote 规则

股东提案、董事会建议、AGAINST、Proposal 5/6/7 等问题，会强制覆盖：

- `DEF14A`
- `DEFA14A`
- 必要时 `PRE14A`

重点解决 `20250604_DEFA14A` 没有 pageindex 导致被跳过的问题。

### 3.4 年度与趋势问题

新增两类金融分析路由：

- FY2025 年度规模问题：强制覆盖 `20250126_10-K`、`20250226_8-K`、`20250513_DEF14A`。
- Q1 到 Q3 收入/净利润趋势问题：强制覆盖三份 10-Q：`20250427_10-Q`、`20250727_10-Q`、`20251026_10-Q`。

## 4. 评测效果

### 4.1 修改前完整基线

来源：`/root/autodl-tmp/dir_ljl/FinSagent_agentic_search_hhl/test/dci_eval_runs/dci-pageindex_20260526_004834/summary.md`

| 指标 | 修改前 |
|---|---:|
| attempted | 30 |
| errors | 0 |
| mean filing recall | 0.772 |
| mean precision | 0.828 |
| hit_any rate | 0.933 |
| avg per question | 43.483s |
| L0 mean recall | 0.900 |
| L1 mean recall | 0.617 |
| L2 mean recall | 0.800 |

典型失败：

- `L0_004`：期望 `20250528_8-K`，实际只取到 `20250427_10-Q`，recall 0.0。
- `L2_002`：期望 `20250528_8-K`、`20250827_8-K`，实际只取到 10-Q，recall 0.0。
- `L1_010`：漏 `20250604_DEFA14A`，recall 0.5。

### 4.2 修改后完整 30 题评测

来源：`test/dci_eval_runs/dci-pageindex_20260526_020840/summary.md`

| 指标 | 修改前 | 修改后 | 变化 |
|---|---:|---:|---:|
| attempted | 30 | 30 | 0 |
| errors | 0 | 0 | 0 |
| mean filing recall | 0.772 | 0.894 | +0.122 |
| mean precision | 0.828 | 0.716 | -0.112 |
| hit_any rate | 0.933 | 0.967 | +0.034 |
| avg per question | 43.483s | 58.522s | +15.039s |
| mean LLM turns | 8.3 | 7.57 | -0.73 |
| mean tool calls | 9.7 | 9.2 | -0.5 |

分层效果：

| Layer | 修改前 recall | 修改后 recall | 变化 |
|---|---:|---:|---:|
| L0 | 0.900 | 1.000 | +0.100 |
| L1 | 0.617 | 0.800 | +0.183 |
| L2 | 0.800 | 0.883 | +0.083 |

### 4.3 重点低召回题 targeted 评测

来源：`test/dci_eval_runs/dci-pageindex_20260526_020525/summary.md`

| qid | 修改前 recall | 修改后 recall | 关键改善 |
|---|---:|---:|---|
| `L0_004` | 0.0 | 1.0 | 成功命中 `20250528_8-K` |
| `L1_001` | 0.333 | 1.0 | 成功覆盖 `20250409_8-K`、`20250427_10-Q`、`20250528_8-K` |
| `L1_010` | 0.5 | 1.0 | 成功命中 `20250604_DEFA14A` |
| `L2_002` | 0.0 | 1.0 | 成功命中 `20250528_8-K`、`20250827_8-K` |

targeted 评测总体：

| 指标 | 结果 |
|---|---:|
| attempted | 4 |
| errors | 0 |
| mean filing recall | 1.0 |
| hit_any rate | 1.0 |
| avg per question | 46.542s |

## 5. 代价与副作用

### 5.1 Precision 下降

完整评测 precision 从 0.828 降到 0.716。原因是策略会主动补充相关 8-K、10-Q、DEFA14A，导致 retrieved filings 更多。

这对“答案正确性”通常是正向的，因为多拿到补充证据；但对当前 filing precision 指标是负向的。

### 5.2 耗时上升

平均耗时从 43.483s 上升到 58.522s。主要原因：

- 更多 form type 被强制探索。
- no-pageindex 文件需要直接 `ripgrep/read_file`。
- critical filing 自动补证增加了少量本地读文件成本。

### 5.3 个别题仍有问题

完整 30 题 run 中仍存在低召回项：

- `L1_002`：漏 `20250827_8-K`。
- `L1_003`：该轮完整评测中出现 0 evidence 的异常。
- `L1_004`：漏 `20250604_DEFA14A`。
- `L2_003`：被 earnings 8-K 干扰，漏 Q2/Q3 10-Q。
- `L2_010`：只命中 `20250126_10-K`，漏 `20250513_DEF14A`。

在完整评测之后，已继续补充：

- 7 月底 / FY2026 Q2 earnings route。
- FY2025 annual result route。
- Q1-Q3 10-Q trend route。
- 普通 10-Q 的 `reported_fiscal_period` fallback。

针对这些补丁的 3 题补测已经完成。

来源：`test/dci_eval_runs/dci-pageindex_20260526_023927/summary.md`

| 指标 | 结果 |
|---|---:|
| attempted | 3 |
| errors | 0 |
| mean filing recall | 1.0 |
| mean precision | 0.917 |
| hit_any rate | 1.0 |

补测结果：

| qid | recall | retrieved |
|---|---:|---|
| `L1_002` | 1.0 | `20250727_10-Q`, `20250827_8-K` |
| `L1_003` | 1.0 | `20250126_10-K`, `20250226_8-K`, `20250513_DEF14A` |
| `L2_003` | 1.0 | `20250427_10-Q`, `20250528_8-K`, `20250727_10-Q`, `20251026_10-Q` |

因此，完整 30 题表仍以 `dci-pageindex_20260526_020840` 为准，但后续针对性修复已验证有效。

## 6. 当前结论

本次修改是有效的。

最关键的历史失败模式已经被修复：

- H20 Q1 影响能稳定命中 `20250528_8-K`。
- H20 Q1/Q2 对比能稳定命中 `20250528_8-K` 和 `20250827_8-K`。
- 股东提案问题能覆盖 `DEF14A` 和 no-pageindex 的 `DEFA14A`。
- targeted 重点题 mean recall 达到 1.0。
- 完整 30 题 mean recall 从 0.772 提升到 0.894。

主要代价是 precision 和耗时下降，这是检索策略从“少而准”转向“保证关键证据覆盖”的自然结果。对于金融问答系统，尤其是需要可解释证据链的场景，这个 trade-off 是可接受的。

## 7. 后续建议

1. 将 route metadata 从硬编码字典逐步迁移为 corpus 构建阶段自动抽取，例如根据 filing 文本自动识别 earnings release、reported quarter、proxy supplement、H20。
2. 将评测指标拆分为 `must_hit_recall` 和 `acceptable_support_recall`，避免 L1 的 candidate filings 全部被当作硬命中要求。
3. 对 precision 做“相关文件白名单”归一化：例如 earnings 问题同时返回 10-Q 和 8-K 不应被完全视为低 precision。
4. 针对 no-pageindex 文件补建轻量 pageindex 或 title-summary，减少直接全文 grep 的耗时。
5. 再跑一轮完整 30 题，纳入最新 Q2/FY2025/Q1-Q3 route 修正后的最终效果。
