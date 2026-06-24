# NVIDIA Mini10 Cross-Company Sanity Report

## Purpose

本次实验用于检查冻结后的 PageIndex hybrid 主链路是否只是在 Zeekr 测试集上过拟合。实验换用 NVIDIA 2025 SEC QA 数据，保持现有主链路参数，不加入 NVIDIA 专属 factbook / fact registry，也不启用 Zeekr profile/table deterministic repair。

## Data And Run

- GT: `/root/autodl-tmp/RAG_Agent_data/nvidia/gt/nvidia_sec_questions_30_2025_with_key_pts.json`
- Vector DB: `/root/autodl-tmp/RAG_Agent_data/nvidia/20260425/5_database_nvidia`
- PageIndex: `/root/autodl-tmp/RAG_Agent_data/nvidia/20260425/database_nvidia/pageindex`
- Output: `test/colm/retrieval/nvidia_mini10_cap2_20260601/mini10.json`
- Judge: `test/colm/retrieval/nvidia_mini10_cap2_20260601/judge/summary.json`

Selected 10 questions cover company profile, segment structure, data-center workloads, policy/export-control risk, customer concentration, revenue growth drivers, and numeric revenue facts.

## Frozen Parameters

- `retrieve_top_k=6`
- `rerank_top_k=4`
- `pageindex_top_k=12`
- `pageindex_node_top_k=20`
- `pageindex_final_cap=8`
- `pageindex_score_multiplier=1.2`
- `pageindex_recency_boost=6.0`
- `finance_table_topk=4`
- `evidence_rescue_k=2`
- `agent_max_sub_queries=2`
- `retrieval_auto_period_cutoff_enabled=true`
- `retrieval_date_cutoff_backfill_enabled=true`
- deterministic Zeekr repairs disabled

## Result

- Evaluated: 10 / 10
- CORRECT: 9
- PARTIAL: 0
- INCORRECT: 1
- Judge errors/fallback: 0
- Average time: 62.63s/question
- Min/max time: 26.95s / 125.15s
- Total generation time: 626.27s
- Average key-point match ratio: 0.925
- Average Likert correctness score: 4.6 / 5

## Failure

The only incorrect case is `qa_kp_000015`: "NVIDIA在2025年如何描述出口管制对中国Data Center业务的影响？"

Judge diagnosis: the generated answer mixed later H20/export-control disclosures and 2026 fiscal-period impacts into a 2025 fiscal-year question. It claimed substantial exclusion from China's data-center market and cited later revenue decline/impairment effects, while the GT expects the 2025-fiscal-year framing: NVIDIA expanded compliant China Data Center products, China Data Center revenue grew in FY2025, but its share remained below the pre-October-2023 export-control level.

## Interpretation

This is a useful cross-company signal. The system did not collapse on NVIDIA: 9/10 passed without company-specific final-layer facts. The failure is not a random retrieval failure or a need for a NVIDIA-specific factbook; it is a period-boundary / future-leakage issue. That matches the previously identified priority: improve date cutoff and period-aware retrieval before adding bespoke company registries.

## Recommendation

Use this result in the phase-freeze argument as a small external sanity check: the current architecture generalizes reasonably to another SEC issuer, and the remaining failure mode is well-scoped. The next small optimization should be period-aware retrieval for questions that mention a fiscal year or explicit reporting period, especially when later 8-K/10-Q disclosures contain stronger but temporally incompatible facts.
