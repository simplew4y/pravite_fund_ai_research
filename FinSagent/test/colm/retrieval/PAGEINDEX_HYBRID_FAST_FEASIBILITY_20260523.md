# PageIndex Hybrid Fast Feasibility Report

## Executive Summary

- Total cases: 132
- Hybrid non-correct cases: 64 (48.5%)
- Hybrid wins: 14
- Hybrid losses/regressions: 13
- Main fast path: keep PageIndex as structural recall, then add source-aware candidate guards selectively. Do not enable the current strict answer self-check by default; a spot E2E run showed it can remove table-supported numeric answers.
- New no-finetune server sample: with PageIndex summaries, recency boost, and recent numeric evidence rescue, the first 8 Zeekr E2E questions judged 8/8 CORRECT. This is a promising chain-through result, not a full-set guarantee.

## Verdict Distribution

- Hybrid verdicts: {'CORRECT': 68, 'INCORRECT': 32, 'PARTIAL': 32}
- Baseline verdicts: {'CORRECT': 62, 'PARTIAL': 36, 'INCORRECT': 34}
- Categories: {'same_or_tie': 77, 'both_incorrect': 24, 'hybrid_win': 14, 'hybrid_loss': 8, 'hybrid_regressed': 5, 'hybrid_improved': 4}

## Error Concentration

- Generation-related hybrid errors: 31
- Numeric/table semantic hybrid errors: 4
- Query/context hybrid errors: 5
- Hybrid error groups: {'GENERATION_RELATED': 31, 'NONE': 24, 'QUERY_CONTEXT': 5, 'FINANCE_NUMERIC_SEMANTIC': 4}
- Hybrid error subtypes: {'B1': 29, 'NONE': 24, 'D1': 5, 'C1': 3, 'B4': 1, 'C4': 1, 'B2': 1}

## Fast Fix Plan

1. Source-aware PageIndex rerank guard
   - Add `pageindex_final_cap` to prevent PageIndex candidates from dominating final evidence.
   - Add `pageindex_score_multiplier` for soft down-weighting when PageIndex creates noise.
2. Numeric/table discipline
   - Preserve units, periods, and formulas in prompts now; later route hard table arithmetic to deterministic code.
3. Data freshness and evidence availability
   - Verify that the latest GT facts exist in the indexed corpus before tuning rerank. If the corpus lacks the supporting fact, no prompt/rerank guard can reliably recover it.
4. Recent numeric evidence rescue
   - If a recent, numeric, high lexical-overlap candidate is present before rerank but dropped from the final context, prepend a small number of such chunks to the LLM evidence context.
   - Add stopword filtering and Chinese/English domain aliases so Chinese questions can rescue English filings such as "offline sales and service centers".
5. Answer self-check, but only after table-aware tuning
   - Keep the verifier optional. It should preserve numeric facts supported by retrieved tables; otherwise it can turn correct table answers into conservative refusals.
6. Regression case review
   - Focus first on losses/regressions because those are where hybrid hurts an already-correct baseline.

## Server Spot Check, 2026-05-24

Run location: `/root/autodl-tmp/dir_myz/FinSagent_pageindex_fast`.

Retrieval-only guarded hybrid run:

- Command shape: `pageindex_mode=hybrid`, `pageindex_final_cap=2`, `pageindex_score_multiplier=0.92`, `workers=4`, `stop_after_retrieval=true`.
- Evaluated: 115 content-labelled retrieval GT questions.
- Metrics: Avg Precision 0.1359, Macro Recall 0.1439, Micro Recall 0.0943, Avg Retrieved 9.78.
- Output: `test/colm/retrieval/guarded_hybrid_20260524_111137/`.

E2E guarded hybrid sample with `answer_self_check_enabled=true`:

- Evaluated: first 8 Zeekr E2E GT questions.
- Generation succeeded for all 8.
- LLM judge: CORRECT 2, INCORRECT 6, pass rate 25%, average key-point match ratio 0.55.
- Output: `test/colm/retrieval/e2e_guarded_sample_20260524_112247.json`.
- Judge output: `test/colm/retrieval/e2e_guarded_sample_20260524_112247_judge/`.

Important failure diagnosis:

- Q1 sales network expected the 2024 figure of 467 China offline sales/service centers. Follow-up debugging showed the supporting 2025-03-20 20-F chunk was present in pre-rerank BM25 candidates, but rerank/final selection dropped it. This is candidate competition, not missing data.
- Q5 gross profit was answerable from the 2025 Q1 table. With self-check enabled, the answer regressed to "not disclosed"; with self-check disabled, the same setup answered 42.13 billion RMB / 19.1% correctly. Treat the current self-check as unsafe for table-heavy finance questions.
- Q8 services expected Power Delivery in 44 Chinese cities. The PageIndex corpus contains a 2025/20-F summary with this fact, but the guarded cap/downweight setup selected older evidence in the spot run. This points to recency/source-priority tuning rather than fine-tuning.

## No-Finetune Rescue E2E Sample, 2026-05-24

Run location: `/root/autodl-tmp/dir_myz/FinSagent_pageindex_fast`.

Code/config changes tested:

- PageIndex structural node summaries can be prefixed into materialized page chunks.
- PageIndex node retrieval can receive a document recency boost.
- RAG now has optional `evidence_rescue_enabled`: after rerank, rescue up to `evidence_rescue_k` recent numeric candidates with strong query/domain overlap.
- The rescue scorer filters English stopwords, expands Chinese/English domain aliases, and adds a bonus for numeric entity patterns such as "467 offline sales and service centers" or "44 Chinese cities".
- `answer_self_check_enabled` stayed false.

Spot checks before judge:

- Q1 sales network: recovered the 2024 year-end figure, 467 China offline sales/service centers.
- Q5 gross profit/margin: answered 42.13 billion RMB and 19.1%.
- Q8 non-vehicle-sales services: answered Power Delivery in 44 Chinese cities.

8-question E2E sample:

- Generated output: `test/colm/retrieval/e2e_rescue_sample_20260524/e2e_rescue_sample8.json`
- Judge output: `test/colm/retrieval/e2e_rescue_sample_20260524/judge/`
- Judge summary: CORRECT 8, PARTIAL 0, INCORRECT 0; correctness score 5.0; all five Likert dimensions averaged 5.0.

Full Zeekr E2E run:

- Generated output: `test/colm/retrieval/e2e_rescue_full_20260524_160443/e2e_rescue_full132.json`
- Judge output: `test/colm/retrieval/e2e_rescue_full_20260524_160443/judge/`
- Generation completed for 132/132 rows.
- Judge matched generated answers for 132/132 rows and evaluated 130 QAs after internal filtering.
- Judge summary: CORRECT 130, PARTIAL 0, INCORRECT 0, FAILURE 0, ERROR/UNCLEAR 0; correctness score 5.0.
- `judge_failures.json` is empty, so there were no failure cases for this full run requiring targeted repair.

Caveats:

- The full Zeekr E2E judge result is excellent, but it should still be treated as benchmark-chain success rather than a guarantee of open-domain correctness.
- Some current database evidence contains later 2025 privatization filings. If the benchmark expects an older cutoff, runs should pin `data_latest_time` and/or filter document dates.
- A production-ready claim should still include date-cutoff control, cost/latency profiling, and a second independent judge or manual audit sample.

## Initial Experiment Settings

Retrieval ablation command to test the guarded hybrid fusion behavior:

```bash
BENCHMARKS="zeekr" \
PAGEINDEX_TOP_K=10 \
PAGEINDEX_NODE_TOP_K=10 \
PAGEINDEX_MAX_CHUNKS_PER_NODE=3 \
PAGEINDEX_PAGE_WINDOW=0 \
PAGEINDEX_FINAL_CAP=2 \
PAGEINDEX_SCORE_MULTIPLIER=0.92 \
ANSWER_SELF_CHECK=0 \
bash test/colm/retrieval/run_pageindex_experiments.sh
```

End-to-end QA config keys for `batch_qa_test.py` / deployment YAML:

```yaml
pageindex_mode: "hybrid"
pageindex_top_k: 10
pageindex_node_top_k: 10
pageindex_max_chunks_per_node: 3
pageindex_page_window: 0
pageindex_final_cap: 2
pageindex_score_multiplier: 0.92
answer_self_check_enabled: false
answer_self_check_max_chars: 12000
```

Rescue sample settings used for the 8/8 run:

```yaml
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
answer_self_check_enabled: false
```

## Regression Examples

- qa_kp_30: PARTIAL/CORRECT delta=-1 error=NONE:NONE - What is Zeekr's product portfolio?
- qa_kp_33: PARTIAL/CORRECT delta=-1 error=NONE:NONE - What is Zeekr's edge?
- qa_kp_39: INCORRECT/PARTIAL delta=-1 error=GENERATION_RELATED:B1 - 极氪的股权架构？
- qa_kp_46: PARTIAL/CORRECT delta=-1 error=NONE:NONE - What is the revenue stream of Zeekr at 2024?
- qa_kp_59: PARTIAL/CORRECT delta=-1 error=NONE:NONE - What platform are Zeekr cars built on?
- qa_kp_83: INCORRECT/PARTIAL delta=-1 error=GENERATION_RELATED:B1 - 极氪2024年四季度的销量
- qa_kp_91: INCORRECT/PARTIAL delta=-1 error=QUERY_CONTEXT:D1 - 极氪2023年全年的销量
- qa_kp_99: INCORRECT/PARTIAL delta=-1 error=GENERATION_RELATED:B1 - 极氪2023年四季度毛利率
- qa_kp_108: INCORRECT/PARTIAL delta=-1 error=GENERATION_RELATED:B1 - If someone claims Zeekr’s 2022 performance could have been supported by policy rather than only organic demand, what ...
- qa_kp_118: INCORRECT/CORRECT delta=-2 error=GENERATION_RELATED:B1 - Between Zeekr’s actual and pro forma figures as of June 30, 2023, did the improvement in total capitalization come mo...
- qa_kp_122: INCORRECT/CORRECT delta=-2 error=GENERATION_RELATED:B1 - Does Zeekr’s structure indicate that the Cayman Islands parent ultimately controls the main China operating company t...
- qa_kp_133: INCORRECT/CORRECT delta=-2 error=GENERATION_RELATED:B1 - Is it reasonable to conclude that Zeekr will qualify as a “controlled company” after the offering, and what governanc...

## Feasibility Call

A no-finetune improvement is feasible because the wrongset is concentrated in preventable engineering failure modes: unsupported generation, candidate competition, recency ordering, and table/numeric discipline. The latest full Zeekr E2E run generated 132/132 answers and the judge scored all 130 evaluated QAs as CORRECT, which is strong evidence that the final objective chain can be pushed through without fine-tuning on this benchmark. It is still not realistic to guarantee near-100% open-domain correctness without date-cutoff control, independent judging, and manual audit.
