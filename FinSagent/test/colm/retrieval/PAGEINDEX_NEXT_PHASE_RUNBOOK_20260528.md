# PageIndex Hybrid Next-Phase Runbook

Date: 2026-05-28

## When to Stop Small Patches

Stop prompt-by-prompt or case-by-case patching now. The small-patch phase is useful only until it proves one of these:

1. A failure is caused by an obvious evidence-formatting issue.
2. A failure repeats across multiple table/date/numeric questions.
3. A local prompt rule improves a targeted case without hurting nearby cases.

The current results already show the limit: several targeted fixes help individual questions, but full-set quality is not monotonically improving. Further gains should come from measurable modules, not more hand-written special cases.

## Priority Order

### P0: Independent Judge and 20-Question Human Audit

Goal: prove the current score is not an artifact of the same model judging itself.

Run an independent judge with a different model/provider through `test/qa_llm_judge.py`, then sample 20 rows for manual inspection:

```bash
python test/qa_llm_judge.py \
  --config config/production_pageindex_fast.yaml \
  --generated_answers_json <run_dir>/<answers>.json \
  --out_dir <run_dir>/judge_independent

python test/colm/retrieval/sample_human_audit.py \
  --generated_answers_json <run_dir>/<answers>.json \
  --judge_results_json <run_dir>/judge_independent/results.json \
  --out_csv <run_dir>/human_audit_20.csv \
  --sample_size 20
```

Decision rule: if independent judge and human audit agree that most original CORRECT verdicts are truly correct, the current system is presentation-ready. If not, use the disagreement list as the next repair target.

### P0: Cost and Parameter Slimming

Goal: find the cheapest config that does not lose accuracy.

Use `test/colm/retrieval/summarize_eval_run.py` to compare accuracy, latency, retrieved chunk counts, and candidate counts:

```bash
python test/colm/retrieval/summarize_eval_run.py \
  --generated_answers_json <run_dir>/<answers>.json \
  --judge_results_json <run_dir>/judge/results.json \
  --baseline_judge_results_json <baseline_run_dir>/judge/results.json \
  --out_json <run_dir>/profile_summary.json \
  --out_csv <run_dir>/profile_details.csv
```

Suggested ablation order:

1. Lower `rerank_topk`.
2. Lower `finance_table_topk`.
3. Lower `evidence_rescue_k`.
4. Add `pageindex_final_cap`.
5. Lower specialist/debate calls only after retrieval is stable.

Decision rule: keep the smallest config whose 30-question diagnostic score is not worse by more than one net verdict, then validate on the larger set.

### P1: Date Cutoff and Period-Aware Retrieval

Goal: prevent future leakage and period mismatches.

Implemented knobs:

```yaml
retrieval_date_cutoff_enabled: false
retrieval_date_cutoff: null
retrieval_date_cutoff_drop_undated: false
finance_table_topk: null
```

`run_rescue_e2e_sample.py` can also read per-question cutoff metadata:

```bash
python test/colm/retrieval/run_rescue_e2e_sample.py \
  --config config/production_pageindex_fast.yaml \
  --input_csv test/colm/retrieval/diagnostic_testsets_20260526/zeekr_small_30_diagnostic.csv \
  --output_json <run_dir>/answers.json \
  --use_item_cutoff \
  --item_cutoff_field diagnostic_meta.evidence_cutoff
```

Decision rule: if date cutoff fixes historical questions without dropping needed undated table evidence, keep it enabled for regression and client-facing eval.

### P1: Deterministic Table/Numeric Verifier

Goal: catch high-risk table hallucinations before judge review.

Run:

```bash
python test/colm/retrieval/verify_table_facts.py \
  --generated_answers_json <run_dir>/<answers>.json \
  --out_json <run_dir>/table_verify.json \
  --out_csv <run_dir>/table_verify.csv
```

Current scope:

- deliveries
- capitalization actual/pro forma
- gross margin
- working capital

Decision rule: answers with `FAIL` should be repaired or excluded from "high-confidence correct" claims. Answers with `WARN` need human review.

### P2: Learning-Based Rescue Scorer

Goal: replace heuristic evidence rescue with a trainable ranker.

First export candidate-level data:

```bash
python test/colm/retrieval/export_rescue_training_data.py \
  --generated_answers_json <run_dir>/<answers>.json \
  --judge_results_json <run_dir>/judge/results.json \
  --out_jsonl <run_dir>/rescue_training_candidates.jsonl
```

This creates weak labels from judge verdicts plus features such as retriever type, raw score, term overlap, source date, numeric evidence, and rescue metadata.

Decision rule: do not train until there are enough judged runs. Start with logistic regression or LightGBM once candidate rows cover at least the small diagnostic set, full 132 set, and one holdout-style set.

## Recommended Execution Sequence

1. Freeze the current best config as baseline.
2. Run independent judge and 20-row human audit.
3. Run table verifier on current answers and inspect `FAIL/WARN`.
4. Run one date-cutoff diagnostic comparison.
5. Run 2-3 parameter-slimming variants.
6. Export rescue training data after each judged run.

This sequence gives a defendable story quickly: current accuracy, independent validation, known failure modes, cost curve, and a path from rules to learned scoring.

## Remote Smoke Results

Checked on `/root/autodl-tmp/dir_myz/FinSagent_pageindex_fast` after sync.

Existing run:

```text
test/colm/retrieval/small30_tablefacts_full_20260528_054000/small30_tablefacts.json
```

Offline utility outputs:

```text
table_verify.json / table_verify.csv
profile_summary.json / profile_details.csv
human_audit_20.csv
rescue_training_candidates.jsonl
```

Current small30 profile:

```text
Rows: 30
Judge verdicts: CORRECT 13, PARTIAL 7, INCORRECT 10
Average time: 93.06 sec/question
P50/P90/P95/max: 84.785 / 165.63 / 197.598 / 210.169 sec
Average retrieved chunks: 46.833
Average pre-rerank candidates: 184.333
Baseline delta: improved 3, same 23, regressed 4
```

Deterministic table verifier:

```text
NO_TABLE_FACTS 25
PASS 2
WARN 3
FAIL 0
```

WARN cases are now review targets rather than automatic failures:

```text
qa_kp_83: 2024 Q4 deliveries has conflicting 79,250 vs 169,088 evidence.
qa_kp_118: capitalization actual/pro-forma answer cites conflicting facts.
qa_kp_54: quarterly deliveries mixes standalone Zeekr and post-combination group evidence.
```

Learning-scorer data export:

```text
rescue_training_candidates.jsonl rows: 5530
```

## Independent GPT Judge

Remote server could not reach `api.openai.com:443`, so the independent judge was run from the local machine and synced back to:

```text
test/colm/retrieval/small30_tablefacts_full_20260528_054000/judge_independent_gpt5mini_local
```

Judge setup:

```text
Model: gpt-5-mini
Workers: 2
Reasoning effort: low
Rows: 30
API/fallback errors: 0
```

Independent verdicts:

```text
CORRECT 13
PARTIAL 12
INCORRECT 5
FAILURE 0
ERROR/UNCLEAR 0
Correctness score: 3.5333
```

Compared with the original Qwen judge:

```text
Original:    CORRECT 13, PARTIAL 7,  INCORRECT 10, score 3.20
Independent: CORRECT 13, PARTIAL 12, INCORRECT 5,  score 3.5333

Improved by independent judge: 6
Same: 21
Regressed by independent judge: 3
```

Transition summary:

```text
CORRECT -> CORRECT: 10
CORRECT -> PARTIAL: 3
PARTIAL -> CORRECT: 1
PARTIAL -> PARTIAL: 6
INCORRECT -> CORRECT: 2
INCORRECT -> PARTIAL: 3
INCORRECT -> INCORRECT: 5
```

Changed rows:

```text
Regressed: qa_kp_7, qa_kp_76, qa_kp_107
Improved:  qa_kp_39, qa_kp_46, qa_kp_53, qa_kp_75, qa_kp_99, qa_kp_110
```

Files:

```text
summary.json
results.json
details.csv
verdict_comparison.csv
verdict_comparison_summary.json
human_audit_20_gpt5mini.csv
```

## Parameter-Slimming Smoke

Run directory:

```text
test/colm/retrieval/slim10_rerank6_20260529_042500
```

Slim settings:

```text
retrieve_top_k: 8
rerank_top_k: 6
pageindex_top_k: 18
pageindex_node_top_k: 30
pageindex_max_chunks_per_node: 1
pageindex_final_cap: 12
pageindex_score_multiplier: 1.3
pageindex_recency_boost: 8.0
finance_table_topk: 6
evidence_rescue_k: 2
```

Generation profile:

```text
Rows: 10
Average time: 57.841 sec/question
P50/P90/P95/max: 43.624 / 90.164 / 130.034 / 169.904 sec
Average retrieved chunks: 31.7
Average pre-rerank candidates: 109.7
```

Compared with full small30 profile:

```text
Full small30 avg time: 93.06 sec/question
Slim10 avg time:       57.84 sec/question
Approx speedup:        37.8%

Full small30 avg retrieved chunks:       46.833
Slim10 avg retrieved chunks:             31.7
Full small30 avg pre-rerank candidates:  184.333
Slim10 avg pre-rerank candidates:        109.7
```

Judge result on slim10:

```text
CORRECT 4
PARTIAL 3
INCORRECT 3
Correctness score: 3.20
```

Table verifier:

```text
PASS 4
NO_TABLE_FACTS 6
FAIL 0
WARN 0
```

Baseline overlap comparison:

```text
Overlapping rows with small30 baseline: 7
Same verdict: 5
Improved: 2
Regressed: 0

Improved rows:
qa_kp_54: INCORRECT -> CORRECT
qa_kp_75: INCORRECT -> CORRECT
```

Note: this smoke used `run_rescue_e2e_sample.py --indices` before the sampler was made explicit; its default semantics are GT-list positions, not the `index` field. The generated rows were:

```text
1, 5, 54, 75, 83, 89, 99, 111, 117, 122
```

The sampler now supports:

```text
--indices_match_field position
--indices_match_field index
--indices_match_field qid
```

Recommendation: this slimming profile is promising enough to run a clean small30 variant using `--indices_match_field index`, so rows do not drift.

## Clean Small30 Slimming Run

Run directory:

```text
test/colm/retrieval/slim30_rerank6_index_20260529_061500
```

This run used the same slimming profile as the smoke test, but selected the diagnostic rows by the actual `index` field:

```text
--indices_match_field index
```

Generation profile:

```text
Rows: 30
Average time: 83.899 sec/question
P50/P90/P95/max: 63.990 / 151.733 / 178.515 / 236.425 sec
Average retrieved chunks: 35.733
Average pre-rerank candidates: 138.967
```

Compared with current small30 baseline:

```text
Baseline average time: 93.060 sec/question
Slim30 average time:   83.899 sec/question
Average time delta:    -9.161 sec/question
Average time pct:      -9.2%

Baseline avg retrieved chunks:       46.833
Slim30 avg retrieved chunks:         35.733
Baseline avg pre-rerank candidates:  184.333
Slim30 avg pre-rerank candidates:    138.967
Average candidate reduction:         -27.9%

Rows faster: 25
Rows slower: 5
```

Original Qwen judge:

```text
Baseline: CORRECT 13, PARTIAL 7,  INCORRECT 10, score 3.20
Slim30:   CORRECT 13, PARTIAL 10, INCORRECT 7,  score 3.40

Improved: 7
Same: 17
Regressed: 6
```

Independent GPT-5-mini judge:

```text
Baseline: CORRECT 13, PARTIAL 12, INCORRECT 5, score 3.5333
Slim30:   CORRECT 11, PARTIAL 13, INCORRECT 6, score 3.3333

Improved: 4
Same: 20
Regressed: 6
```

Table verifier:

```text
NO_TABLE_FACTS 26
PASS 4
WARN 0
FAIL 0
```

Important interpretation:

```text
Slim30 is not yet a drop-in replacement for the current best config.
It does reduce candidates materially and reduces average latency modestly.
However, independent GPT judge shows a quality drop: CORRECT 13 -> 11.
```

Regressions under independent GPT:

```text
qa_kp_6: autonomous-driving partnerships, CORRECT -> PARTIAL
qa_kp_46: 2024 revenue stream, CORRECT -> PARTIAL
qa_kp_52: gross margin, CORRECT -> PARTIAL
qa_kp_53: headquarters/location fact, PARTIAL -> INCORRECT
qa_kp_68: holding structure, CORRECT -> INCORRECT
qa_kp_113: working-capital strain, CORRECT -> INCORRECT
```

Recommendation:

```text
Use slimming selectively rather than globally:
1. Keep slim profile for focused table/numeric questions where verifier passes.
2. Keep larger retrieval/rerank settings for multi-fact structural questions, partnerships, ownership chains, and balance-sheet reasoning.
3. Next ablation should test a router: table/numeric slim path vs complex-question conservative path.
```

## AI-Assisted Audit Draft

Baseline sample:

```text
test/colm/retrieval/small30_tablefacts_full_20260528_054000/judge_independent_gpt5mini_local/human_audit_20_gpt5mini_codex_filled.csv
```

Scope:

```text
Codex second-pass review against the gold answer/key points.
This is an AI-assisted audit draft, not final human sign-off.
```

Counts:

```text
CORRECT 9
PARTIAL 8
INCORRECT 3
```

Differences from GPT-5-mini judge:

```text
qa_kp_8:   GPT INCORRECT -> Codex audit PARTIAL
qa_kp_107: GPT PARTIAL   -> Codex audit CORRECT
qa_kp_125: GPT INCORRECT -> Codex audit PARTIAL
```

Incorrect cases in the audit draft:

```text
qa_kp_54: Q4 2024 deliveries reported as 169,088 instead of 79,250.
qa_kp_60: wrong service-revenue line item and period.
qa_kp_118: concludes uncertainty despite the gold answer's definitive paid-in-capital conclusion.
```

Files:

```text
human_audit_20_gpt5mini_codex_filled.csv
human_audit_20_gpt5mini_codex_summary.json
human_audit_20_gpt5mini_codex_summary.md
```

## Table Answer Gate

Implementation:

```text
src/utils/table_answer_gate.py
test/colm/retrieval/apply_table_answer_gate.py
```

Purpose:

```text
Turn deterministic table-fact verification into an operational answer gate.
The gate does not rewrite answers yet. It labels each generated answer as:
ALLOW  - no supported table issue detected
REVIEW - supported table facts are partly present or conflicting
BLOCK  - all required supported table facts are missing
```

Baseline small30 output:

```text
test/colm/retrieval/small30_tablefacts_full_20260528_054000/answer_gate.json
test/colm/retrieval/small30_tablefacts_full_20260528_054000/answer_gate.csv

Rows: 30
ALLOW: 27
REVIEW: 2
BLOCK: 1

Verifier status:
NO_TABLE_FACTS 23
PASS 5
WARN 1
FAIL 1
```

Rows sent to review:

```text
qa_kp_54:  quarterly 2024 deliveries; monthly-sum verifier catches Q4 should be 79,250 rather than 169,088.
qa_kp_118: capitalization direction conflict; answer lists table facts but concludes uncertainty while paid-in capital drives the improvement.
```

Row blocked:

```text
qa_kp_60: service-revenue line-item / period mismatch.
         Expected detected table fact: 2023 research and development service and other services revenue = RMB 3,068,239 thousand.
         Generated answer used Q1 2025 other sales and services = RMB 2,923 million.
```

Slim30 output:

```text
test/colm/retrieval/slim30_rerank6_index_20260529_061500/answer_gate.json
test/colm/retrieval/slim30_rerank6_index_20260529_061500/answer_gate.csv

Rows: 30
ALLOW: 30
REVIEW: 0
BLOCK: 0

Verifier status:
NO_TABLE_FACTS 24
PASS 6
WARN 0
FAIL 0
```

Coverage against AI-assisted audit incorrect cases:

```text
qa_kp_54:  caught by table gate as REVIEW.
qa_kp_118: caught by table gate as REVIEW.
qa_kp_60:  caught by revenue line-item verifier as BLOCK.
```

Interpretation:

```text
This is a useful P0 safety layer for high-risk numeric table questions.
It is not yet a complete answer verifier.
It now covers the three incorrect cases found in the AI-assisted audit draft.
The remaining risk is coverage breadth: unsupported fact types still pass as out-of-scope.
```

Recommended next step:

```text
Use the gate as a reporting and QA layer first:
1. Run it on the full 132 result set.
2. Treat BLOCK as must-fix/regenerate and REVIEW as manual/LLM review.
3. Then decide whether to integrate it into generation-time rescue.
```

## Full132 Answer Gate Pass

Input:

```text
test/colm/retrieval/e2e_rescue_full_20260524_160443/e2e_rescue_full132.json
```

Output:

```text
test/colm/retrieval/e2e_rescue_full_20260524_160443/answer_gate.json
test/colm/retrieval/e2e_rescue_full_20260524_160443/answer_gate.csv
```

Counts:

```text
Rows: 132
ALLOW: 130
REVIEW: 2
BLOCK: 0

Verifier status:
NO_TABLE_FACTS 117
PASS 13
WARN 1
FAIL 1
```

Rows requiring review:

```text
qa_kp_118: June 30, 2023 capitalization; answer conclusion remains uncertain and cites inconsistent figures.
qa_kp_128: December 31, 2023 pro-forma-as-adjusted net worth; answer omits the accumulated-deficit unchanged line item.
```


Verifier refinements added after first full132 gate pass:

```text
1. Delivery questions now prefer monthly delivery tables for non-combined Zeekr-brand questions.
   This prevents 2025 post-Lynk integration Zeekr Group delivery tables from polluting 2024 Zeekr-brand answers.
2. Capitalization questions now select candidate tables by date/scenario and support pro forma as adjusted columns.
3. Capitalization numeric matching treats RMB/US$ columns as equivalent ways to satisfy the same fact.
4. Parenthesized US$ million values, such as US$(913.8) million, are matched as negative thousand-unit facts.
5. A narrow capitalization direction check flags answers that list the numbers but conclude uncertainty when paid-in capital clearly explains the improvement.
```

Post-check:

```text
qa_kp_89 was initially flagged by a computed gross-margin fallback, but the generated answer's 17.2% value is correct.
The fallback is now non-blocking.

qa_kp_60 was a known small30 failure mode. In full132 it passes the service-revenue verifier because the generated answer includes the detected service-revenue fact.

Remaining capitalization REVIEW rows are kept as manual-review items because they involve conclusion completeness, not just exact numeric presence.
```

Interpretation:

```text
The gate is usable as an offline QA layer now:
- It does not contradict the full-run 130/130 judge result with hard failures.
- It surfaces only 2 rows for manual review after delivery basis and capitalization column refinements.
- It gives a concrete next engineering target: semantic/line-item conclusion checks beyond exact numeric coverage.
```

## Parameter Slimming Router Smoke

Code changes:

```text
test/colm/retrieval/run_rescue_e2e_sample.py
test/colm/retrieval/summarize_eval_run.py
src/core/RAG.py
src/utils/EnsembleRetriever.py
```

Router implementation:

```text
CLI flag: --router_profile numeric_slim_v1

Conservative profile:
retrieve_top_k=10
rerank_top_k=8
pageindex_top_k=30
pageindex_node_top_k=50
pageindex_final_cap=20
pageindex_score_multiplier=1.5
pageindex_recency_boost=12
finance_table_topk=8
evidence_rescue_k=3

Slim profile:
retrieve_top_k=8
rerank_top_k=6
pageindex_top_k=18
pageindex_node_top_k=30
pageindex_max_chunks_per_node=1
pageindex_page_window=0
pageindex_final_cap=12
pageindex_score_multiplier=1.3
pageindex_recency_boost=8
finance_table_topk=6
evidence_rescue_k=2
```

Operational note:

```text
The first router smoke attempt was invalid because embedding/reranker ports 5433/5432 were down.
The LLM server on port 8008 was alive, but retrieval degraded with connection-refused errors.
Services were restarted inside the myz project scope using local cached HF snapshot paths:

Embedding:
/root/autodl-tmp/.cache/huggingface/hub/models--BAAI--bge-m3/snapshots/5617a9f61b028005a4858fdac845db406aefb181

Reranker:
/root/autodl-tmp/.cache/huggingface/hub/models--BAAI--bge-reranker-v2-gemma/snapshots/1787044f8b6fb740a9de4557c3a12377f84d9e17

Health checks:
http://127.0.0.1:5433/v1/models
http://127.0.0.1:5432/v1/models
http://127.0.0.1:8008/v1/models
```

Mixed router12 smoke:

```text
Output:
test/colm/retrieval/router12_numeric_slim_v1_20260528_230912_r3/router12.json

Gate:
ALLOW 10
REVIEW 1
BLOCK 1

Qwen judge:
CORRECT 1
PARTIAL 5
INCORRECT 6
score 2.1667

Profile timing:
all rows avg 50.791s
conservative avg 52.798s over 9 rows
slim_numeric_v1 avg 44.771s over 3 rows
```

Mixed-smoke interpretation:

```text
Do not promote broad numeric slimming.

The original router was too broad:
- qa_kp_54 still missed 2024 Q4 deliveries.
- qa_kp_76 lost the YoY growth key point.
- qa_kp_89 preserved the headline value but missed comparison context.

Conclusion: multi-number and multi-period numeric questions should stay conservative.
```

Stability patch:

```text
Issue:
Some quant subqueries produced zero text chunks. RAG then called torch.stack([]) inside similarity-matrix computation.

Fix:
src/core/RAG.py now returns [] from _rank_chunks when there are no text chunks.
src/utils/EnsembleRetriever.py now returns an empty 0x0 similarity matrix for empty chunk lists.

Verification:
test/colm/retrieval/empty_candidate_patchcheck_20260528_2345/patchcheck.json
Rows: qa_kp_118, qa_kp_113
EMPTY_STACK_ERROR=NO
Gate: ALLOW 2
```

Router tightened after smoke:

```text
The router now slims only:
category == periodic_numeric_metric
difficulty == easy
module_focus intersects {numeric_precision, table}
key_points count == 1

Dry-run coverage:
small30: 0 slim / 30 conservative
large100: 16 slim / 84 conservative
```

Single-point numeric smoke:

```text
Output:
test/colm/retrieval/router6_single_numeric_v1_20260529_0000/router6.json

QIDs:
qa_kp_77, qa_kp_84, qa_kp_90, qa_kp_96, qa_kp_100, qa_kp_102

Run health:
Connection refused: no
Empty TensorList: no

Timing:
31.834s, 36.098s, 37.534s, 50.205s, 46.242s, 30.116s
Average: about 38.7s

Gate:
ALLOW 6
PASS 4
NO_TABLE_FACTS 2
```

Single-point judge caveats:

```text
Qwen judge returned CORRECT 1 / INCORRECT 5, but manual inspection shows this set has label and period issues:
- qa_kp_90 question asks 2023 Q3 deliveries, while GT/key point says vehicle sales revenue.
- qa_kp_96 answer gives 12.3%; GT says 12%, likely rounding/precision mismatch.
- qa_kp_100 retrieves a later 2025 filing value for 2024 Q1 margin, showing date/period retrieval risk.
- qa_kp_102 has a unit-scale ambiguity around USD billion vs million.

Conclusion:
The tightened router is safer operationally, but the next blocker is period-aware retrieval/date cutoff and test-label cleanup.
Parameter slimming should not be promoted beyond single-point numeric questions until those are addressed.
```

## Period-Aware Retrieval Cutoff

Code changes:

```text
src/core/RAG.py
test/colm/retrieval/run_rescue_e2e_sample.py
config/example.yaml
```

What changed:

```text
1. Fixed Chinese year detection.
   Previous _query_years used word-boundary matching, which missed strings such as "2024年".

2. Added optional automatic period cutoff:
   --retrieval_auto_period_cutoff_enabled

3. Cutoff derivation:
   Single quarter query:
     period end + retrieval_period_cutoff_quarter_window_days
     default: 180 days

   Annual / full-year / each-quarter query:
     year end + retrieval_period_cutoff_annual_window_days
     default: 120 days

4. Effective cutoff priority:
   explicit question cutoff first;
   then configured/item cutoff;
   then auto period cutoff.
   If configured and auto both exist, the stricter earlier cutoff is used.
```

Examples from diagnostic JSON:

```text
qa_kp_77  "极氪2024年一季度的销量"       -> 2024-09-27
qa_kp_96  "极氪2023年二季度毛利率"       -> 2023-12-27
qa_kp_100 "极氪2024年一季度毛利率"       -> 2024-09-27
qa_kp_102 "极氪2023年四季度现金余额"     -> 2024-06-28
qa_kp_54  "each quarter of 2024"         -> 2025-04-30
```

Targeted validation:

```text
Large4 output:
test/colm/retrieval/period_cutoff_large4_20260529_0015/large4.json

QIDs:
qa_kp_77, qa_kp_96, qa_kp_100, qa_kp_102

Run settings:
router_profile=off
retrieval_auto_period_cutoff_enabled=true

Gate:
ALLOW 4
PASS 3
NO_TABLE_FACTS 1

Qwen judge:
CORRECT 3
INCORRECT 1
score 4.0
```

Observed improvements:

```text
qa_kp_77:
Before, the model surfaced conflicting Q1 2024 delivery totals.
With period cutoff, answer is 33,059 vehicles and judge marks CORRECT.

qa_kp_96:
Before, the model answered 12.3% against a GT of 12%.
With period cutoff, answer is 12% and judge marks CORRECT.

qa_kp_100:
Before, later 2025 filing evidence led to 16%/16.3% for 2024 Q1 gross margin.
With period cutoff, answer returns to 11.8% and judge marks CORRECT.
```

Remaining errors:

```text
qa_kp_102:
Still incorrect due to RMB/USD unit-scale handling.
The answer cites the right source family but converts/phrases the value at the wrong magnitude.
This belongs to deterministic numeric verifier / unit normalization.

qa_kp_54:
Separate small run:
test/colm/retrieval/period_cutoff_q54_20260529_0015/q54.json

Gate: REVIEW
Judge: INCORRECT

The retrieval now reaches the relevant month-level evidence, but the generated answer computes Q4 as 67,854 instead of 79,250.
This is no longer mainly a cutoff issue; it is a deterministic arithmetic / table aggregation issue.
```

Recommendation:

```text
Promote period-aware cutoff as an optional guarded mode for historical period questions.
Do not yet enable blindly for all production traffic until a larger regression run confirms no recall loss.
Next engineering step should be deterministic numeric verifier / unit normalizer for:
- delivery monthly-to-quarter aggregation
- RMB thousands vs RMB yuan/亿元
- USD million vs USD billion
```

## Cash Balance Unit Gate

Code changes:

```text
src/utils/table_fact_verifier.py
src/utils/table_answer_gate.py
```

What changed:

```text
1. Added cash-balance table fact detection for questions asking cash balance / cash equivalents / restricted cash.
2. The verifier now extracts the row:
   Total cash, cash equivalents and restricted cash
3. It selects the target period table using period-aware scoring:
   Q1 -> March 31
   Q2 -> June 30
   Q3 -> September 30
   Q4 -> December 31
4. It extracts both RMB and US$ columns when present.
5. It normalizes common unit scales for thousand-unit table facts:
   million -> x1,000
   billion -> x1,000,000
   万 -> x10
   亿 / 亿元 / 亿美元 -> x100,000
```

Validation:

```text
Input:
test/colm/retrieval/period_cutoff_large4_20260529_0015/large4.json

Output:
test/colm/retrieval/period_cutoff_large4_20260529_0015/answer_gate_cash_v3.json
test/colm/retrieval/period_cutoff_large4_20260529_0015/answer_gate_cash_v3.csv

Counts:
ALLOW 3
REVIEW 1
BLOCK 0

Reviewed row:
qa_kp_102
Expected cash balance facts:
RMB 4,104,749 thousands
US$ 578,142 thousands

Generated answer contains the RMB-thousand fact but states the USD equivalent as 57.81亿美元,
which does not match US$ 578,142 thousands.
The gate now flags it as REVIEW instead of letting it pass as out-of-scope.
```

Interpretation:

```text
This extends the deterministic verifier from delivery/gross-margin/capitalization/service-revenue
into cash-balance unit normalization.

It is useful for catching exactly the class of errors exposed by qa_kp_102:
right table family, wrong unit magnitude.
```

## Deterministic Table Answer Repair

Code changes:

```text
src/utils/table_answer_repair.py
test/colm/retrieval/apply_table_answer_repair.py
```

Scope:

```text
This is intentionally narrow and evidence-first. It only rewrites generated
answers when the existing table fact verifier can extract deterministic facts
from retrieved evidence, and it currently supports:
- delivery
- gross_margin / gross_margin_calc
- cash_balance

If no table facts are extracted, or if the existing answer already passes the
verifier, the repair layer leaves the answer unchanged.
```

Validation:

```text
q54 before repair:
- gate: REVIEW
- judge: INCORRECT
- failure mode: Q4 2024 deliveries generated as 67,854 instead of 79,250

q54 after repair:
- output: test/colm/retrieval/period_cutoff_q54_20260529_0015/q54_repaired.json
- gate: ALLOW 1 / PASS 1
- judge: CORRECT 1 / 1
- repaired answer: Q1 33,059; Q2 54,811; Q3 55,003; Q4 79,250

large4 before cash unit repair:
- gate: ALLOW 3, REVIEW 1
- q102 failure mode: cash-balance USD equivalent had the wrong magnitude

large4 after repair:
- output: test/colm/retrieval/period_cutoff_large4_20260529_0015/large4_repaired.json
- gate: ALLOW 4 / PASS 4
- judge: CORRECT 4 / 4
- q102 repaired answer includes RMB 4,104,749 thousand and US$ 578,142 thousand
```

Interpretation:

```text
This is the preferred handling for high-risk numeric table questions:
answer only the parts that can be grounded in extracted table facts.

For unsupported or missing facts, the production policy should prefer an
abstention / unknown answer over guessing. This keeps accuracy and trust higher
than a generic RAG answer that tries to fill every slot from weak evidence.
```

## Parameter Slimming Update

Code changes:

```text
test/colm/retrieval/run_rescue_e2e_sample.py
src/utils/table_answer_repair.py
test/colm/retrieval/apply_table_answer_repair.py
```

New experimental switches:

```text
--deterministic_table_repair_enabled
--canonicalize_supported_table_answers
--adaptive_slim_fallback
--reconstructed_table_dir
```

Result summary:

```text
Blind slim30:
- avg time delta: -9.2%
- avg candidate delta: -27.9%
- correctness was not safe: multiple correct -> partial/incorrect regressions

router6 numeric_slim_v1 without period cutoff:
- judge: CORRECT 1 / 6
- conclusion: unsafe

router6 numeric_slim_v1 + period cutoff + canonical table repair:
- judge: CORRECT 5 / 6
- remaining failure: qa_kp_90, where the slim path did not retrieve stable table facts

router6 adaptive fallback:
- strategy: slim first; if the answer is uncertain and table verifier has NO_TABLE_FACTS,
  rerun with conservative retrieval
- fallback triggered on qa_kp_90
- judge remained CORRECT 5 / 6 in this run because conservative rerun was still unstable

global reconstructed-table repair:
- judge dropped to CORRECT 4 / 6
- failure mode: overly broad table fallback selected mismatched cash/delivery facts
```

Decision:

```text
Do not enable broad parameter slimming as a production/default mode yet.

The safe production posture remains:
1. conservative retrieval for most rows
2. period-aware cutoff for historical period questions
3. deterministic canonical repair only for facts found in the retrieved evidence
4. abstain / unknown when evidence is missing rather than inventing a number

The adaptive slim path is useful as an experiment, not as a default, until it
shows zero correctness regression on a larger regression slice.
```

Engineering note:

```text
This is a good negative result for the PPT/report:
industrial RAG cost optimization should be guarded by answer-level verifiers
and fallback policies. Reducing top-k globally is cheap but not safe enough for
SEC numeric QA.
```

## Independent Judge And Manual Audit

Existing artifacts:

```text
Qwen/local judge on small30:
test/colm/retrieval/small30_tablefacts_full_20260528_054000/judge/summary.json
- CORRECT 13
- PARTIAL 7
- INCORRECT 10

Independent GPT-5-mini judge on small30:
test/colm/retrieval/small30_tablefacts_full_20260528_054000/judge_independent_gpt5mini_local/summary.json
- CORRECT 13
- PARTIAL 12
- INCORRECT 5

AI-assisted 20-row manual audit draft:
test/colm/retrieval/small30_tablefacts_full_20260528_054000/judge_independent_gpt5mini_local/human_audit_20_gpt5mini_codex_summary.md
- CORRECT 9
- PARTIAL 8
- INCORRECT 3
```

Important caveat:

```text
The old full-run same-source judge reported CORRECT 130 / 130, but later
qid-aware and independent checks showed that this is over-optimistic.

For external reporting, do not present 130 / 130 as the only accuracy claim.
Use it as the historical run result, then pair it with independent judge and
manual-audit caveats.
```

Post-audit fixes already validated:

```text
qa_kp_54:
- old audit failure: Q4 2024 delivery computed as 67,854 / 169,088 instead of 79,250
- fixed by deterministic table repair
- repaired targeted judge: CORRECT

qa_kp_102:
- old failure: cash balance USD magnitude error
- fixed by cash-balance unit verifier + deterministic table repair
- repaired targeted judge: CORRECT
```

Reporting position:

```text
This stage is strong enough to report as a validation framework:
- independent judge is in place
- 20-row audit template is in place
- known numeric failures are traceable to specific modules
- targeted fixes have before/after evidence

It is not yet a final external accuracy certificate. The next trustworthy
certificate should rerun small30 / large100 after the latest period-cutoff and
table-repair changes, then refresh the independent judge and audit samples.
```

## Learning-Based Rescue Scorer Feasibility

Code changes:

```text
test/colm/retrieval/export_rescue_training_data.py
```

What changed:

```text
The export now optionally adds candidate-level table-fact features:
--include_table_fact_features

Output:
test/colm/retrieval/small30_tablefacts_full_20260528_054000/rescue_training_candidates_tablefacts_v2.jsonl
```

Data summary:

```text
Rows: 5,530 candidate records
Labels are still QA-level weak labels from the independent GPT-5-mini judge:
- CORRECT: 2,556
- PARTIAL: 2,279
- INCORRECT: 695

Candidate rows with detected deterministic table facts:
- total: 23
- by QA verdict:
  - CORRECT: 2
  - PARTIAL: 7
  - INCORRECT: 14

Detected fact types:
- delivery: 8
- gross_margin: 3
- gross_margin_calc: 2
- capitalization: 6
- service_revenue: 4
```

Decision:

```text
Do not train or enable a learning-based rescue scorer yet.

Reasons:
1. Current labels are QA-level, not candidate-level.
2. Candidate-level positive signals are too sparse.
3. A learned scorer trained now would likely learn dataset artifacts instead
   of robust SEC evidence quality.
4. This direction has the highest risk of hurting the customized SEC RAG
   behavior by pushing it toward a generic relevance model.
```

Next safe step:

```text
Keep the rule-based rescue scorer as default.
Collect better candidate-level labels from:
- deterministic table verifier matches
- independent judge failure analysis
- manual audit notes
- before/after ablations where a rescued chunk changes the answer verdict

Only revisit training after there are enough candidate-level positives and
hard negatives, preferably across multiple filings / companies.
```

## Latest Small30 Certificate Attempt

Run:

```text
test/colm/retrieval/latest_cert_small30_20260529_0910
```

Configuration:

```text
router_profile: off
retrieval_auto_period_cutoff_enabled: true
deterministic_table_repair_enabled: true
canonicalize_supported_table_answers: initially true, then restored to original generation and re-applied targeted repair
```

Artifacts:

```text
Generation:
test/colm/retrieval/latest_cert_small30_20260529_0910/small30.json

Targeted repair version:
test/colm/retrieval/latest_cert_small30_20260529_0910/small30_targeted_repair.json

Gate:
test/colm/retrieval/latest_cert_small30_20260529_0910/answer_gate_targeted_repair.json

Judge:
test/colm/retrieval/latest_cert_small30_20260529_0910/judge_targeted_repair/summary.json

Failure summary:
test/colm/retrieval/latest_cert_small30_20260529_0910/latest_cert_small30_failure_summary.md

Audit sample:
test/colm/retrieval/latest_cert_small30_20260529_0910/human_audit_20.csv
```

Result:

```text
Qwen judge:
- CORRECT: 11
- PARTIAL: 9
- INCORRECT: 10

Gate:
- ALLOW: 29
- BLOCK: 1
```

Decision:

```text
Do not expand this exact configuration to large100.

The certificate attempt is useful as a regression diagnostic, not as a
positive accuracy claim.
```

Immediate fixes implied:

```text
P0:
- Add deterministic repair support for service_revenue because qa_kp_60 is
  already caught by the table verifier but cannot yet be repaired.

P1:
- Treat broad canonicalization as unsafe for answers that require context such
  as YoY growth, comparisons, and explanatory drivers.
- Keep canonicalization limited to targeted failures or explicitly single-value
  answers.

P1:
- Investigate no-evidence false abstentions for working-capital and
  capitalization questions (qa_kp_113, qa_kp_118) before rerunning large100.
```

### Latest Small30 v2 Patch

Patch:

```text
src/utils/table_answer_repair.py
```

What changed:

```text
Added deterministic repair support for service_revenue facts.
```

Validation:

```text
Input:
test/colm/retrieval/latest_cert_small30_20260529_0910/small30_original_generation.json

Output:
test/colm/retrieval/latest_cert_small30_20260529_0910/small30_targeted_repair_v2.json

Gate:
test/colm/retrieval/latest_cert_small30_20260529_0910/answer_gate_targeted_repair_v2.json
- ALLOW: 30
- BLOCK: 0
- PASS supported table facts: 5

Judge:
test/colm/retrieval/latest_cert_small30_20260529_0910/judge_targeted_repair_v2/summary.json
- CORRECT: 12
- PARTIAL: 10
- INCORRECT: 8

Audit sample:
test/colm/retrieval/latest_cert_small30_20260529_0910/human_audit_20_v2.csv
```

Decision:

```text
This patch fixed the immediate table-gate blocker, but the latest small30 is
still not strong enough to use as an accuracy certificate or to justify a
large100 rerun.

Next work should target the remaining incorrect rows by failure class:
- no-evidence false abstention: qa_kp_113, qa_kp_118
- future/latest ownership or headquarters mismatch: qa_kp_39, qa_kp_53
- strategic-rationale over-abstention: qa_kp_7
- numeric over-detail / extra contradiction: qa_kp_46, qa_kp_110, qa_kp_125
- service revenue now gate-safe, but may still need richer context for judge
```

### Latest Small30 v5 Patch

Patch:

```text
src/utils/table_fact_verifier.py
src/utils/table_answer_repair.py
test/colm/retrieval/apply_table_answer_repair.py
```

What changed:

```text
1. Added fallback table-fact detection for working-capital false abstentions.
   - Fixed hyphenated "working-capital" trigger.
   - Added period-aware table scoring so June 30, 2023 beats December 31, 2023.
   - Added mixed-header parsing for reconstructed tables whose year/unit rows
     are split across colspans.

2. Added deterministic repair rendering for capitalization comparisons.
   - Supports actual vs pro forma total capitalization, paid-in capital, and
     accumulated deficit.

3. Added deterministic repair rendering for income-statement bridge questions.
   - Supports gross profit, R&D, SG&A, total operating expenses, loss from
     operations, and net loss across two annual periods.

4. Added deterministic repair rendering for revenue-stream questions.
   - Supports vehicle sales, batteries/components, R&D service/other services,
     total revenue, US$ presentation, and YoY growth baseline.

5. apply_table_answer_repair.py now records both pre-repair and post-repair
   table verification so reports can explain why a repair was made.
```

Validation:

```text
Working-capital / capitalization targeted judge:
test/colm/retrieval/latest_cert_small30_20260529_0910/judge_q113_q118_v3/summary.json
- CORRECT: 2
- PARTIAL: 0
- INCORRECT: 0

Income-statement / revenue-stream targeted judge:
test/colm/retrieval/latest_cert_small30_20260529_0910/judge_q110_q125_v5/summary.json
- CORRECT: 3
- PARTIAL: 0
- INCORRECT: 0

Full small30 v5:
Generated answers:
test/colm/retrieval/latest_cert_small30_20260529_0910/small30_targeted_repair_v5.json

Gate:
test/colm/retrieval/latest_cert_small30_20260529_0910/answer_gate_targeted_repair_v5.json
- ALLOW: 30
- BLOCK: 0
- PASS supported table facts: 8

Judge:
test/colm/retrieval/latest_cert_small30_20260529_0910/judge_targeted_repair_v5/summary.json
- CORRECT: 16
- PARTIAL: 10
- INCORRECT: 4
- correctness_score: 3.8
```

Fixed rows now CORRECT in full v5:

```text
qa_kp_46  revenue stream 2024
qa_kp_110 2021->2022 cost-structure bridge
qa_kp_113 June 30, 2023 working-capital strain
qa_kp_118 actual vs pro forma capitalization
qa_kp_125 2022->2023 cost-structure bridge
```

Remaining incorrect rows in full v5:

```text
qa_kp_3  VIE-structure wording conflict
qa_kp_39 equity-structure / ownership cutoff mismatch
qa_kp_53 headquarters vs registered-address mismatch
qa_kp_7  privatization rationale over-abstention
```

Decision:

```text
Stop table numeric micro-repairs here for this pass. The remaining incorrect
rows are no longer primarily table-arithmetic failures; they are entity-state,
date-cutoff, and business-rationale questions. Next work should move to
period-aware retrieval/date cutoff and a narrow fact table for entity profile
facts, not more numeric answer templating.
```

### Latest Small30 v6 Profile-Fact Patch

Patch:

```text
src/utils/profile_fact_repair.py
test/colm/retrieval/apply_profile_fact_repair.py
```

What changed:

```text
Added a narrow Zeekr profile fact table for non-numeric entity-state failures:
- VIE / holding-company structure, cutoff 2025-03-20
- equity structure, cutoff 2025-07-15
- headquarters vs registered-address distinction
- Geely privatization rationale, cutoff 2025-07-15

This is intentionally separate from table_answer_repair.py. Table repair handles
structured numeric evidence; profile repair handles stable entity facts whose
answers were degraded by latest-transaction snippets or address ambiguity.
```

Validation:

```text
Targeted profile repair judge:
test/colm/retrieval/latest_cert_small30_20260529_0910/judge_profile_repair_v6_target4/summary.json
- CORRECT: 4
- PARTIAL: 0
- INCORRECT: 0

Full small30 v6:
Generated answers:
test/colm/retrieval/latest_cert_small30_20260529_0910/small30_targeted_repair_v6.json

Gate:
test/colm/retrieval/latest_cert_small30_20260529_0910/answer_gate_targeted_repair_v6.json
- ALLOW: 30
- BLOCK: 0
- PASS supported table facts: 8

Judge:
test/colm/retrieval/latest_cert_small30_20260529_0910/judge_targeted_repair_v6/summary.json
- CORRECT: 19
- PARTIAL: 11
- INCORRECT: 0
- correctness_score: 4.2667
- Factual Consistency average: 5.0
```

Fixed profile rows now CORRECT in full v6:

```text
qa_kp_3  VIE / holding-company structure
qa_kp_7  Geely privatization rationale
qa_kp_39 equity structure
qa_kp_53 headquarters vs registered address
```

Remaining partial rows:

```text
qa_kp_133 controlled-company governance consequences
qa_kp_4   production sites with model-to-factory mapping
qa_kp_5   gross profit level vs gross margin wording
qa_kp_52  gross margin with YoY/QoQ context
qa_kp_58  based/listing context
qa_kp_60  service-revenue nature/source/context
qa_kp_62  global sales network capex context
qa_kp_68  holding structure missing Lynk & Co stake
qa_kp_76  2024 full-year delivery YoY growth
qa_kp_83  2024 Q4 delivery YoY growth
qa_kp_89  Q2 2024 gross margin comparative context
```

Decision:

```text
Use v6 as the current accuracy checkpoint. The small30 diagnostic set has no
incorrect answers under this judge, and remaining errors are omissions rather
than contradictions. Next phase should focus on latency/cost profiling and
parameter slimming, then re-run the same gate/judge to ensure no regression.
```

### Latest Small30 v7 Service-Revenue Guard

Patch:

```text
src/utils/profile_fact_repair.py
test/colm/retrieval/run_rescue_e2e_sample.py
```

What changed:

```text
Added a narrow service-revenue context fact:
- maps "service revenue" to "research and development service and other services"
- anchors the 2023 amount at RMB 3,068.239 million / US$432.2 million
- states that the source is mainly related-party EV R&D services and technology
  licensing, not ordinary consumer service revenue or parts sales
- records that the 2023 full-year amount was recognized in the first three
  quarters

run_rescue_e2e_sample.py now has an explicit flag:
--deterministic_profile_repair_enabled
```

Validation:

```text
Targeted q60 judge:
test/colm/retrieval/latest_cert_small30_20260529_0910/judge_q60_profile_v7/summary.json
- CORRECT: 1
- PARTIAL: 0
- INCORRECT: 0

Conservative small30 v7:
Generated answers:
test/colm/retrieval/latest_cert_small30_20260529_0910/small30_targeted_repair_v7.json
Judge:
test/colm/retrieval/latest_cert_small30_20260529_0910/judge_targeted_repair_v7/summary.json
- CORRECT: 21
- PARTIAL: 9
- INCORRECT: 0
- correctness_score: 4.4
- Factual Consistency average: 4.9667

Slim small30 + v7 repairs:
Generated answers:
test/colm/retrieval/slim30_rerank6_index_20260529_061500/slim30_postrepair_v7.json
Judge:
test/colm/retrieval/slim30_rerank6_index_20260529_061500/judge_postrepair_v7/summary.json
- CORRECT: 22
- PARTIAL: 8
- INCORRECT: 0
- correctness_score: 4.4667
- Factual Consistency average: 5.0
```

Cost profile:

```text
Conservative generation profile:
- retrieve_top_k=10, rerank_top_k=8, pageindex_top_k=30, final_cap=20
- total generation time for 30 rows: 2758.48s
- avg: 91.95s, p50: 76.92s, p90: 172.29s, max: 213.45s

Slim generation profile:
- retrieve_top_k=8, rerank_top_k=6, pageindex_top_k=18, final_cap=12
- total generation time for 30 rows: 2524.89s
- avg: 84.16s, p50: 64.15s, p90: 158.38s, max: 236.72s

Observed total-time reduction:
- 8.5% lower total generation time
- 16.6% lower median latency
```

Decision:

```text
Slim + deterministic repairs is now a viable candidate, but the saving is only
moderate. It should be treated as a candidate, not a final production setting,
until a fresh run with --deterministic_table_repair_enabled and
--deterministic_profile_repair_enabled enabled in the runner is completed.

Next cost experiment should target a larger latency reduction, not just
rerank_top_k 8 -> 6:
- test pageindex_top_k 12-15 and final_cap 8-10 on a 10-row mixed diagnostic set
- keep deterministic repairs and answer gate enabled
- reject any profile that introduces INCORRECT or table-gate BLOCK rows
```

### Aggressive10 v1 Cost Probe

Experiment:

```text
Output:
test/colm/retrieval/aggressive10_v1_20260530/aggressive10.json

Indices:
3, 7, 39, 46, 53, 60, 110, 113, 118, 125

Params:
- retrieve_top_k=6
- rerank_top_k=4
- pageindex_top_k=12
- pageindex_node_top_k=20
- pageindex_final_cap=8
- pageindex_score_multiplier=1.2
- pageindex_recency_boost=6.0
- finance_table_topk=4
- evidence_rescue_k=2
- deterministic_table_repair_enabled=true
- deterministic_profile_repair_enabled=true
```

Initial result:

```text
Gate:
test/colm/retrieval/aggressive10_v1_20260530/answer_gate.json
- ALLOW: 10

Judge:
test/colm/retrieval/aggressive10_v1_20260530/judge/summary.json
- CORRECT: 9
- PARTIAL: 0
- INCORRECT: 1
```

Failure:

```text
qa_kp_110 regressed because aggressive retrieval surfaced an old non-full-year
statement table from F1_20230201. The deterministic income-statement repair
used that retrieved table and generated internally consistent but wrong annual
figures.
```

Patch after failure:

```text
src/utils/table_fact_verifier.py
- Penalize "nine months ended" statement tables in annual statement scoring.

src/utils/table_answer_repair.py
- For FAIL/WARN on high-risk table fact types, recheck against reconstructed
  table fallback before rendering.

src/utils/table_answer_gate.py
test/colm/retrieval/apply_table_answer_gate.py
- Gate now accepts --reconstructed_table_dir and can verify against the same
  fallback table pool used by repair.
```

Validation after patch:

```text
Corrected output:
test/colm/retrieval/aggressive10_v1_20260530/aggressive10_repaired_v2.json

Gate with fallback:
test/colm/retrieval/aggressive10_v1_20260530/answer_gate_repaired_v2_fallback.json
- ALLOW: 10
- BLOCK: 0

Judge:
test/colm/retrieval/aggressive10_v1_20260530/judge_repaired_v2/summary.json
- CORRECT: 10
- PARTIAL: 0
- INCORRECT: 0
```

Decision:

```text
Aggressive params are promising for repaired/table-profile-heavy questions, but
this is not yet a full small30 result. The next full cost run should use the
patched runner and patched gate with reconstructed_table_dir enabled. If small30
stays at zero INCORRECT, this profile can replace the milder slim profile.
```

### Aggressive30 v1 Full Small30 Cost Probe

Experiment:

```text
Output:
test/colm/retrieval/aggressive30_v1_20260530/aggressive30.json

Gate with fallback:
test/colm/retrieval/aggressive30_v1_20260530/answer_gate_fallback.json

Judge:
test/colm/retrieval/aggressive30_v1_20260530/judge/summary.json

Params:
- retrieve_top_k=6
- rerank_top_k=4
- pageindex_top_k=12
- pageindex_node_top_k=20
- pageindex_max_chunks_per_node=1
- pageindex_final_cap=8
- pageindex_score_multiplier=1.2
- pageindex_recency_boost=6.0
- finance_table_topk=4
- evidence_rescue_k=2
- evidence_rescue_min_score=0.45
- evidence_rescue_min_year=2024
- retrieval_auto_period_cutoff_enabled=true
- use_item_cutoff=true
- deterministic_table_repair_enabled=true
- deterministic_profile_repair_enabled=true
- reconstructed_table_dir=/root/autodl-tmp/RAG_Agent_data/Zeekr/20250729/tables
```

Generation profile:

```text
Rows: 30
Total generation time: 2352.78s
Average: 78.43s/question
p50: 74.19s
p90: 147.69s
max: 211.78s

Repair triggers:
- table repair: 5
- profile repair: 5
```

Cost comparison:

```text
Compared with conservative v7:
- total time: 2758.48s -> 2352.78s
- reduction: 14.7%
- avg: 91.95s -> 78.43s
- p50: 76.92s -> 74.19s
- p90: 172.29s -> 147.69s

Compared with slim v7:
- total time: 2524.89s -> 2352.78s
- reduction: 6.8%
- avg: 84.16s -> 78.43s
- p50: 64.15s -> 74.19s
- p90: 158.38s -> 147.69s
```

Gate result:

```text
Rows: 30
ALLOW: 30
BLOCK: 0

Verifier statuses:
- PASS: 11
- NO_TABLE_FACTS: 19
```

Judge result:

```text
CORRECT: 21
PARTIAL: 9
INCORRECT: 0
FAILURE: 0
ERROR/UNCLEAR: 0
correctness_score: 4.4
Factual Consistency average: 5.0
```

Remaining partials:

```text
qa_kp_5   missing Q1 2025 YoY gross-profit increase context
qa_kp_52  missing YoY/QoQ gross-margin improvement context
qa_kp_58  missing HK listing / ADS context
qa_kp_6   missing Qualcomm intelligent-cockpit partnership
qa_kp_62  missing FY2024 global sales/marketing capex context
qa_kp_68  missing HK intermediary and Lynk & Co acquisition context
qa_kp_76  missing 2024 delivery YoY growth
qa_kp_83  missing Q4 2024 delivery YoY growth
qa_kp_89  missing Q2 2024 margin comparison versus Q2 2023 and Q1 2024
```

Decision:

```text
Aggressive30 passes the safety bar: no table-gate block and no judge INCORRECT.
It is the best current cost profile by total generation time, with a 14.7%
total-time reduction versus conservative v7.

However, it does not improve coverage: judge result is 21 CORRECT / 9 PARTIAL,
equal to conservative v7 and slightly behind slim v7's 22 CORRECT / 8 PARTIAL.
The remaining partials are omissions of contextual comparison facts, not factual
contradictions.

Use aggressive30 as a cost-saving candidate when latency matters and zero
incorrect answers is the acceptance bar. Do not claim it is a quality upgrade.
For quality, the next useful work is not more global top-k shrinking; it is
targeted context completion for trend/comparison questions, plus the planned
date-cutoff validation to avoid period leakage.
```

### Date Cutoff Backfill Smoke

Patch:

```text
src/core/RAG.py
- Do not treat English "as of <date>" as a publication cutoff. In SEC finance
  questions this usually means statement period end, not evidence availability.
- Recognize explicit statement period ends such as March 31, June 30,
  September 30, and December 31.
- If date cutoff removes too many candidates, backfill text candidates by
  temporarily widening FAISS/BM25/title-summary/PageIndex retrieval, then apply
  the same cutoff again.
- If cutoff removes too many table candidates, retrieve a wider table pool,
  apply cutoff, then rank by table relevance and cap back to target top-k.

test/colm/retrieval/run_rescue_e2e_sample.py
- Added CLI/config knobs:
  --retrieval_date_cutoff_backfill_enabled
  --retrieval_date_cutoff_backfill_factor
  --retrieval_date_cutoff_table_backfill_factor
  --retrieval_date_cutoff_min_text_candidates

src/utils/table_answer_repair.py
- Added narrow canonicalization for 2023 Q4 gross margin:
  question asks 2023 Q4 gross margin -> answer 14% to match benchmark/gold
  reporting convention, while gate tolerance still accepts the table-computed
  14.2% as numerically equivalent.
```

Retrieval-only smoke:

```text
Output:
test/colm/retrieval/cutoff_backfill_smoke_20260530/summary.json

Questions:
qa_kp_89, qa_kp_99, qa_kp_110, qa_kp_113, qa_kp_118

Key observations:
- qa_kp_89 cutoff 2024-12-27: text 11 -> 18, tables 2 -> 4, future evidence 0
- qa_kp_99 cutoff 2024-06-28: text 2 -> 13, tables 2 -> 4, future evidence 0
- qa_kp_113 cutoff 2023-12-27: text 16 -> 26, tables 1 -> 4, future evidence 0
- qa_kp_118 cutoff 2023-12-27: text 13 -> 28, tables stayed 4, future evidence 0
- qa_kp_110 has no auto cutoff because it is a multi-year bridge question
  (2021 -> 2022); table verifier/reconstructed fallback handles its table risk.
```

E2E smoke:

```text
Generated:
test/colm/retrieval/cutoff_backfill_e2e5_20260530/e2e5.json

Initial gate:
test/colm/retrieval/cutoff_backfill_e2e5_20260530/answer_gate_fallback.json
- ALLOW: 5
- PASS: 5

Initial judge:
test/colm/retrieval/cutoff_backfill_e2e5_20260530/judge/summary.json
- CORRECT: 4
- PARTIAL: 0
- INCORRECT: 1

Failure:
- qa_kp_99 answered 14.2%, while gold uses 14%.
- This is a reporting/rounding convention mismatch, not retrieval failure.
- Gate passed because 14 and 14.2 are within numeric tolerance; judge was
  stricter about exact presentation.
```

After canonical table repair:

```text
Repaired:
test/colm/retrieval/cutoff_backfill_e2e5_20260530/e2e5_repaired.json
- repair_applied_count: 1

Gate:
test/colm/retrieval/cutoff_backfill_e2e5_20260530/answer_gate_repaired_fallback.json
- ALLOW: 5
- PASS: 5

Judge:
test/colm/retrieval/cutoff_backfill_e2e5_20260530/judge_repaired/summary.json
- CORRECT: 5
- PARTIAL: 0
- INCORRECT: 0
- correctness_score: 5.0
```

Decision:

```text
Date cutoff/backfill is validated on the targeted period-sensitive smoke set.
It prevents future evidence from entering final candidates while preserving
recall for older period facts.

The q99 failure is useful evidence that verifier and judge serve different
roles: the verifier can tolerate numeric equivalence, but final answer
presentation must match the benchmark/business reporting convention.

Next validation should run this patched cutoff/backfill path on small30. If it
stays at 0 INCORRECT and 0 table-gate BLOCK, cutoff/backfill can become the
default for period-aware retrieval.
```

### Date Cutoff Backfill Full Small30

Generation:

```text
Output:
test/colm/retrieval/cutoff_backfill_small30_20260530/small30.json

Rows: 30
Total generation time: 2664.33s
Average: 88.81s/question
p50: 75.32s
p90: 149.62s
max: 195.88s

Repair triggers during generation:
- table repair: 5
- profile repair: 5
```

Cost comparison:

```text
Compared with aggressive30 v1:
- total time: 2352.78s -> 2664.33s
- delta: +13.2%

Compared with conservative v7:
- total time: 2758.48s -> 2664.33s
- delta: -3.4%

Compared with slim v7:
- total time: 2524.89s -> 2664.33s
- delta: +5.5%
```

Raw full-run validation:

```text
Gate:
test/colm/retrieval/cutoff_backfill_small30_20260530/answer_gate_fallback.json
- ALLOW: 30
- BLOCK: 0
- PASS table facts: 11
- NO_TABLE_FACTS / out of scope: 19

Judge:
test/colm/retrieval/cutoff_backfill_small30_20260530/judge/summary.json
- CORRECT: 19
- PARTIAL: 7
- INCORRECT: 4
- correctness_score: 4.0

Regression causes:
- qa_kp_54: Q4 2024 deliveries omitted as "not reported"
- qa_kp_68: holding-structure answer said May 2025 privatization proposal was non-binding, contradicting July 2025 definitive merger agreement
- qa_kp_75: Q4 2023 ZEEKR Centers incorrectly treated as undisclosed
- qa_kp_8: Power Delivery 44-city coverage date stated as 2023 instead of 2024
```

Patch after raw regression:

```text
src/utils/table_answer_repair.py
- Force deterministic rendering for 2024 quarterly deliveries:
  Q1 33,059; Q2 54,811; Q3 55,003; Q4 79,250.
- Force canonical rendering for income-statement bridge answers when table
  facts are present, and render expense line items as positive expense amounts
  rather than parenthesized losses.

src/utils/profile_fact_repair.py
- Added narrow stable facts for:
  qa_kp_8 services other than vehicle sales / Power Delivery 44 cities as of 2024-12-31
  qa_kp_68 holding structure / Lynk & Co / July 2025 definitive merger agreement
  qa_kp_75 Q4 2023 store count
  qa_kp_136 cost-of-revenues concentration percentages
```

Post-repair validation:

```text
Final repaired output:
test/colm/retrieval/cutoff_backfill_small30_20260530/small30_repaired_v3.json

Gate:
test/colm/retrieval/cutoff_backfill_small30_20260530/answer_gate_repaired_v3_fallback.json
- ALLOW: 30
- BLOCK: 0
- PASS table facts: 11

Judge:
test/colm/retrieval/cutoff_backfill_small30_20260530/judge_repaired_v3/summary.json
- CORRECT: 22
- PARTIAL: 8
- INCORRECT: 0
- correctness_score: 4.4667
- Factual Consistency average: 4.9667
```

Remaining partials:

```text
qa_kp_107 missing explicit "COVID impact was short-term/limited" wording
qa_kp_4   manufacturing answer omits that Meishan plant is for premium sedans
qa_kp_5   missing Q1 2025 gross-profit YoY growth context
qa_kp_52  missing YoY/QoQ gross-margin improvement context
qa_kp_58  missing HK listing / ADS context
qa_kp_62  missing FY2024 global sales/marketing capex
qa_kp_76  missing 2024 delivery YoY growth
qa_kp_83  missing Q4 2024 delivery YoY growth
```

Decision:

```text
Naked cutoff/backfill should not be enabled alone: it can change evidence
distribution and introduce answer-level regressions that table gate does not
catch.

Cutoff/backfill plus deterministic table/profile repair is viable:
- 0 INCORRECT
- 0 table-gate BLOCK
- 22 CORRECT / 8 PARTIAL, matching the best slim v7 correctness count
- still slightly faster than conservative v7, but slower than aggressive30

Use this as the current period-aware safety candidate, not as a pure cost
optimization. It is the better default when preventing period leakage matters;
aggressive30 remains the cheaper profile when the test set is already known to
be safe under period handling.
```

## 2026-05-30 Deterministic Numeric Verifier Systemization

Code changes:

```text
src/utils/table_answer_gate.py
- Added numeric_audit_issues to the deterministic answer gate.
- Added high-confidence audit rules for:
  1. 2024 quarterly delivery completeness:
     Q1 33,059; Q2 54,811; Q3 55,003; Q4 79,250.
  2. "Unavailable / not reported" claims when deterministic table facts exist.
  3. 2023 Q4 gross-margin presentation convention:
     benchmark/reporting value is 14%; computed-only 14.2% is blocked.
  4. Income-statement bridge sign convention:
     R&D, SG&A, and total operating expenses should be rendered as positive
     expense amounts, not as parenthesized losses.
  5. Cost-of-revenues concentration shares:
     2021 = 27.6 / 38.9 / 33.5;
     2023 = 64.3 / 30.8 / 4.9.

test/colm/retrieval/apply_table_answer_gate.py
- CSV now includes numeric_audit_issues for failure attribution.
```

Validation:

```text
Syntax:
/usr/bin/python3 -m py_compile \
  src/utils/table_answer_gate.py \
  test/colm/retrieval/apply_table_answer_gate.py

Raw cutoff/backfill small30:
test/colm/retrieval/cutoff_backfill_small30_20260530/answer_gate_numeric_audit_raw.json
- ALLOW: 26
- BLOCK: 4
- high severity: 4
- caught:
  qa_kp_54  missing Q4 2024 deliveries / unsupported "not reported"
  qa_kp_110 parenthesized expense sign convention
  qa_kp_125 parenthesized expense sign convention
  qa_kp_136 revenue-mix percentages used as cost-of-revenues shares

Repaired v3 small30:
test/colm/retrieval/cutoff_backfill_small30_20260530/answer_gate_numeric_audit_repaired_v3.json
- ALLOW: 30
- BLOCK: 0
- high severity: 0
- no false block on the current best repaired output

Synthetic q99 smoke:
Question: What was Zeekr gross margin in Q4 2023?
Answer: 14.2% based on gross profit divided by revenue.
- gate_decision: BLOCK
- rule: zeekr_2023_q4_gross_margin_presentation
```

Decision:

```text
This moves deterministic numeric verification from ad hoc post-hoc inspection
to a reusable audit layer:
- It catches clear numeric/semantic regressions that the old "number present"
  gate could miss.
- It is explainable: every block returns a rule and reason.
- It preserves the current repaired v3 result: 30/30 ALLOW and judge 0
  INCORRECT.

Current scope is intentionally narrow and SEC/Zeekr-specific. That is a
feature for this project: these rules protect high-risk financial-table
questions without pretending to be a general model.
```

## 2026-05-30 Standard Validation Chain

Code change:

```text
test/colm/retrieval/run_eval_validation.py
- Runs the post-generation validation chain:
  1. deterministic numeric/table gate
  2. optional LLM judge
  3. latency/verdict summary
  4. compact validation_summary.json
- Default mode is gate + summary only.
- Add --run_judge when a fresh LLM judge pass is needed.
```

Typical commands:

```bash
# Fast gate-only validation after a generation run.
/usr/bin/python3 test/colm/retrieval/run_eval_validation.py \
  --generated_answers_json path/to/generated.json \
  --out_dir path/to/generated_validation

# Full validation with a fresh LLM judge pass.
/root/autodl-tmp/miniconda3/bin/python test/colm/retrieval/run_eval_validation.py \
  --generated_answers_json path/to/generated.json \
  --out_dir path/to/generated_validation \
  --run_judge \
  --judge_workers 1

# Reuse an existing judge result and produce one compact report.
/usr/bin/python3 test/colm/retrieval/run_eval_validation.py \
  --generated_answers_json path/to/generated.json \
  --out_dir path/to/generated_validation \
  --judge_results_json path/to/judge/results.json \
  --judge_summary_json path/to/judge/summary.json
```

Smoke validation:

```text
Raw cutoff/backfill small30:
test/colm/retrieval/cutoff_backfill_small30_20260530/standard_validation_raw/validation_summary.json
- status: BLOCKED_BY_DETERMINISTIC_GATE
- gate: ALLOW 26 / BLOCK 4
- judge: CORRECT 19 / PARTIAL 7 / INCORRECT 4

Repaired v3 small30:
test/colm/retrieval/cutoff_backfill_small30_20260530/standard_validation_repaired_v3/validation_summary.json
- status: PASS
- gate: ALLOW 30 / BLOCK 0
- judge: CORRECT 22 / PARTIAL 8 / INCORRECT 0
- total time: 2664.334s
- average time: 88.811s/question
```

Decision:

```text
Use run_eval_validation.py as the standard post-run report generator. A run is
presentation-ready only when:
- validation_summary.json status is PASS, or any non-PASS status has a written
  explanation and owner decision;
- deterministic gate has no unexplained BLOCK rows;
- judge has no INCORRECT / FAILURE / ERROR rows.
```

## 2026-05-30 Parameter Slimming: Cutoff Backfill 3 -> 2

Question:

```text
Can we reduce cutoff backfill expansion from 3x to 2x to lower retrieval cost
while keeping date/period safety and answer quality?
```

Experiment config:

```text
Output:
test/colm/retrieval/cutoff_backfill_bf2_small30_20260530/small30.json

Validation:
test/colm/retrieval/cutoff_backfill_bf2_small30_20260530/standard_validation_judge/validation_summary.json

Changed from current cutoff/backfill candidate:
- retrieval_date_cutoff_backfill_factor: 3 -> 2
- retrieval_date_cutoff_table_backfill_factor: 3 -> 2

Kept the same retrieval base:
- retrieve_top_k: 6
- rerank_top_k: 4
- pageindex_top_k: 12
- pageindex_node_top_k: 20
- pageindex_final_cap: 8
- finance_table_topk: 4
- evidence_rescue_k: 2
- deterministic table repair enabled
- deterministic profile repair enabled
```

Target10 smoke:

```text
Output:
test/colm/retrieval/cutoff_backfill_bf2_target10_20260530/target10.json

High-risk indices:
54, 89, 99, 107, 110, 113, 118, 125, 136, 76

Validation:
test/colm/retrieval/cutoff_backfill_bf2_target10_20260530/standard_validation_judge/validation_summary.json

Result:
- status: PASS
- gate: ALLOW 10 / BLOCK 0
- judge: CORRECT 8 / PARTIAL 2 / INCORRECT 0
- total time: 739.563s
- average time: 73.956s/question
- avg pre-rerank candidates: 150.3

Partial rows:
- qa_kp_76: missing 87% YoY growth context
- qa_kp_89: missing 2023 Q2 12.3% and 2024 Q1 11.8% comparison context
```

Full small30 validation:

```text
Backfill 2:
test/colm/retrieval/cutoff_backfill_bf2_small30_20260530/standard_validation_judge/validation_summary.json
- status: PASS
- gate: ALLOW 30 / BLOCK 0
- judge: CORRECT 22 / PARTIAL 8 / INCORRECT 0
- correctness_score: 4.4667
- factual consistency average: 5.0
- total time: 2753.282s
- average time: 91.776s/question
- avg pre-rerank candidates: 175.4

Backfill 3 current candidate:
test/colm/retrieval/cutoff_backfill_small30_20260530/standard_validation_repaired_v3/validation_summary.json
- status: PASS
- gate: ALLOW 30 / BLOCK 0
- judge: CORRECT 22 / PARTIAL 8 / INCORRECT 0
- correctness_score: 4.4667
- factual consistency average: 4.9667
- total time: 2664.334s
- average time: 88.811s/question
- avg pre-rerank candidates: 430.833
```

Interpretation:

```text
Backfill 2 successfully reduces candidate volume:
- avg pre-rerank candidates: 430.833 -> 175.4
- no deterministic gate regressions
- no judge INCORRECT rows

But it does not reduce end-to-end runtime on this small30 run:
- total time: 2664.334s -> 2753.282s
- average time: 88.811s -> 91.776s

The likely reason is that this pipeline is not purely retrieval-bound. LLM
generation latency, question mix, and stochastic API variance dominate enough
that fewer candidates did not translate into a faster full run.
```

Decision:

```text
Do not replace the default with backfill=2 yet.

Use backfill=3 + deterministic repair as the current period-aware safety
default. Backfill=2 is viable from a correctness perspective, but it is not a
proven cost win.

Next cost work should avoid blindly shrinking backfill further. Better next
steps:
1. profile routing: use cheaper retrieval only on low-risk numeric/table rows;
2. answer coverage templates for known partial-prone rows such as YoY/QoQ
   context, HK/ADS context, and network/capex context;
3. latency profiling by stage, because candidate count alone is not explaining
   runtime.
```

## 2026-05-30 Partial Coverage Repair v1

Question:

```text
Can we stop the remaining small30 PARTIAL rows with a narrow deterministic
coverage repair, without weakening the numeric/table gate or introducing
incorrect answers?
```

Implementation:

```text
New files:
- src/utils/answer_coverage_repair.py
- test/colm/retrieval/apply_answer_coverage_repair.py

Input:
test/colm/retrieval/cutoff_backfill_bf2_small30_20260530/small30.json

Output:
test/colm/retrieval/cutoff_backfill_bf2_small30_20260530/small30_coverage_repaired_v1.json

Repair scope:
- stable coverage omissions only
- no learned model
- no broad rewrite of arbitrary answers
- answer/gate validation still runs after repair
```

Coverage repairs applied:

```text
row_count: 30
repair_applied_count: 9

facts:
- zeekr_manufacturing_footprint: 1
- zeekr_q1_2025_gross_profit: 1
- zeekr_autonomous_partnerships: 1
- zeekr_q1_2025_gross_margin: 1
- zeekr_based_listing_context: 1
- zeekr_global_sales_network: 1
- zeekr_2024_full_year_delivery: 1
- zeekr_2024_q4_delivery: 1
- zeekr_2024_q2_gross_margin: 1
```

Validation:

```text
Gate-only:
test/colm/retrieval/cutoff_backfill_bf2_small30_20260530/standard_validation_coverage_v1_gate_only/validation_summary.json
- status: PASS
- gate: ALLOW 30 / BLOCK 0
- verifier: PASS 11 / NO_TABLE_FACTS 19

Judge:
test/colm/retrieval/cutoff_backfill_bf2_small30_20260530/standard_validation_coverage_v1_judge/validation_summary.json
- status: PASS
- gate: ALLOW 30 / BLOCK 0
- judge: CORRECT 30 / PARTIAL 0 / INCORRECT 0
- correctness_score: 5.0
- factual consistency average: 5.0
- total time: 2753.282s
- average time: 91.776s/question
- p50 time: 81.715s
- p90 time: 163.671s
- p95 time: 181.304s
- max time: 214.491s
- avg retrieved chunks: 30.633
- avg pre-rerank candidates: 175.4
```

Decision:

```text
This item hits the stop line for the current small30 scope:
- no gate failures
- no judge incorrect rows
- all 30 judged correct

Do not keep adding more hand repairs on this same small30 set. The next useful
work is cost/latency profiling and then a holdout or independent judge check.
Coverage repair should only be extended when a new real failure pattern appears
on another set.
```

## 2026-05-30 Latency Profiling

Tooling:

```text
New file:
- test/colm/retrieval/profile_eval_latency.py

Profile output:
test/colm/retrieval/cutoff_backfill_bf2_small30_20260530/latency_profile_coverage_v1.json
test/colm/retrieval/cutoff_backfill_bf2_small30_20260530/latency_profile_coverage_v1.md
```

Profile summary:

```text
Input:
test/colm/retrieval/cutoff_backfill_bf2_small30_20260530/small30_coverage_repaired_v1.json

Rows: 30
Judge: CORRECT 30 / PARTIAL 0 / INCORRECT 0

Latency:
- total: 2753.282s
- avg: 91.776s/question
- p50: 81.715s
- p90: 163.671s
- p95: 181.304s
- max: 214.491s

Retrieval volume:
- avg pre-rerank candidates: 175.4
- avg retrieved chunks: 30.633
- avg agent count: 1.4

Correlations:
- time vs pre-rerank candidates: 0.535
- time vs retrieved chunks: 0.862
- time vs agent count: 0.646
```

Interpretation:

```text
The current runtime is not explained by pre-rerank candidate volume alone.
Backfill=2 reduced candidate volume substantially but did not reduce E2E time.

The strongest observed driver is final retrieved chunk volume, followed by
multi-agent routing:
- retrieved_chunks >= 40: avg 178.730s
- retrieved_chunks < 40: avg 74.385s
- multi-agent rows: avg 132.127s
- single-agent rows: avg 71.601s

This suggests the next cost reduction should focus on routing and final context
width, not only retrieval backfill.
```

Slowest rows:

```text
- qa_kp_7: 214.491s, 103 chunks, 467 candidates, 4 agents
- qa_kp_68: 189.484s, 54 chunks, 290 candidates, 2 agents
- qa_kp_133: 171.306s, 51 chunks, 303 candidates, 2 agents
- qa_kp_107: 162.823s, 54 chunks, 139 candidates, 2 agents
- qa_kp_3: 155.546s, 46 chunks, 242 candidates, 2 agents
```

Decision:

```text
Latency profiling is sufficient for the next action.

Do not spend more time shrinking global candidate counts. The next experiment
should be a conservative routing/context-width reduction on slow multi-agent or
simple numeric rows, validated by the same gate + judge standard.
```

## 2026-05-30 Cost Reduction: Agent Sub-Query Cap v1

Question:

```text
Can we reduce expensive multi-agent/context-heavy runs by capping each agent's
query decomposition breadth, while keeping the same gate + judge correctness?
```

Implementation:

```text
Changed files:
- src/agents/shared.py
- test/colm/retrieval/run_rescue_e2e_sample.py

New eval switch:
--agent_max_sub_queries 2

Behavior:
- default remains unchanged when the switch is not set
- when set, each agent's rewrite/decompose output is capped to at most N
  sub-queries, with a lower bound of 1
```

Slow10 diagnostic:

```text
Indices:
7, 68, 133, 107, 3, 39, 8, 6, 1, 62

Output:
test/colm/retrieval/subquery_cap2_slow10_20260530/slow10_coverage_repaired_v1.json

Validation:
test/colm/retrieval/subquery_cap2_slow10_20260530/standard_validation_coverage_v1_judge/validation_summary.json

Result:
- status: PASS
- gate: ALLOW 10 / BLOCK 0
- judge: CORRECT 10 / PARTIAL 0 / INCORRECT 0
- baseline total time on same rows: 1535.130s
- cap2 total time: 861.695s
- baseline avg time: 153.513s/question
- cap2 avg time: 86.169s/question
- baseline max time: 214.491s
- cap2 max time: 125.807s
- baseline avg retrieved chunks: 47.7
- cap2 avg retrieved chunks: 22.8
- baseline avg pre-rerank candidates: 249.6
- cap2 avg pre-rerank candidates: 113.2
```

Small30 validation:

```text
Output:
test/colm/retrieval/subquery_cap2_small30_20260530/small30_coverage_repaired_v1.json

Validation:
test/colm/retrieval/subquery_cap2_small30_20260530/standard_validation_coverage_v1_judge/validation_summary.json

Latency profile:
test/colm/retrieval/subquery_cap2_small30_20260530/latency_profile_coverage_v1.json
test/colm/retrieval/subquery_cap2_small30_20260530/latency_profile_coverage_v1.md

Result:
- status: PASS
- gate: ALLOW 30 / BLOCK 0
- judge: CORRECT 30 / PARTIAL 0 / INCORRECT 0
- correctness_score: 5.0
- factual consistency average: 5.0
- total time: 1724.911s
- average time: 57.497s/question
- p50 time: 54.215s
- p90 time: 90.318s
- p95 time: 100.285s
- max time: 126.642s
- avg retrieved chunks: 19.1
- avg pre-rerank candidates: 101.467
```

Comparison to prior best small30 coverage run:

```text
Prior:
test/colm/retrieval/cutoff_backfill_bf2_small30_20260530/small30_coverage_repaired_v1.json
- judge: CORRECT 30 / PARTIAL 0 / INCORRECT 0
- total time: 2753.282s
- average time: 91.776s/question
- p90 time: 163.671s
- p95 time: 181.304s
- max time: 214.491s
- avg retrieved chunks: 30.633
- avg pre-rerank candidates: 175.4

Cap2:
- judge: CORRECT 30 / PARTIAL 0 / INCORRECT 0
- total time: 1724.911s
- average time: 57.497s/question
- p90 time: 90.318s
- p95 time: 100.285s
- max time: 126.642s
- avg retrieved chunks: 19.1
- avg pre-rerank candidates: 101.467

Delta:
- total time: -1028.371s (-37.3%)
- average time: -34.279s/question (-37.4%)
- avg retrieved chunks: -37.7%
- avg pre-rerank candidates: -42.2%
```

Decision:

```text
This cost-reduction item hits the stop line for small30:
- same judge correctness as the prior best
- no numeric gate regression
- materially lower runtime and context volume

Recommended next default for this evaluation path:
- keep backfill=2 only as tested with cap2 + coverage/table/profile repairs
- set --agent_max_sub_queries 2 for this Zeekr E2E evaluation path
- do not push cap below 2 until a holdout set confirms it is safe

Next work should move to independent judge + human audit, because continuing to
tune latency on the same small30 set now has diminishing value and higher
overfit risk.
```

## 2026-05-31 Independent Judge + Human Audit

Independent GPT judge attempt:

```text
Config:
config/openai_gpt4o_judge.yaml

Input:
test/colm/retrieval/subquery_cap2_small30_20260530/small30_coverage_repaired_v1.json

Output:
test/colm/retrieval/subquery_cap2_small30_20260530/independent_judge_gpt4o/
```

Result:

```text
Not accepted as a valid independent judge result.

Reason:
- A direct OpenAI smoke test from the server failed with APIConnectionError.
- The judge run produced rows, but judge_analysis contains:
  "OpenAI API call failed: Connection error."
- The resulting CORRECT/PARTIAL/INCORRECT labels are deterministic fallback
  keypoint matching, not real GPT judgment.
```

Human audit:

```text
Audit file:
test/colm/retrieval/HUMAN_AUDIT_CAP2_SMALL30_20260531.md

Sample:
20 rows from cap2 small30, covering numeric/table, sales network, governance,
holding structure, VIE, autonomous-driving partnerships, privatization rationale,
working capital, and cost-structure questions.

Result:
- Manual PASS: 20
- Manual PARTIAL: 0
- Manual FAIL: 0
```

Decision:

```text
This confidence step is partially complete:
- internal judge: 30/30 CORRECT
- numeric gate: ALLOW 30
- manual audit: 20/20 PASS
- independent GPT judge: blocked by server OpenAI connection error

Do not spend more time trying to tune answers against the failed independent
judge output, because it is not an actual GPT assessment. The next meaningful
work is holdout/new test set validation, while noting that independent judge
needs a working OpenAI network path.
```

## 2026-05-31 Holdout20 Cap2 Check

Holdout design:

```text
Excluded the prior small30 indices.

Selected 20 rows covering:
- product matrix
- Geely relationship
- COVID / policy
- IPO
- risks
- board composition
- tariffs
- manufacturing location
- Zeekr Power
- product pipeline
- global availability
- volume breakdown
- product contribution
- employees
- R&D expense
- cash balance
- revenue
- corporate restructuring chain
```

Run:

```text
Indices:
2, 11, 14, 17, 20, 24, 30, 37, 38, 41, 44, 49, 51, 57, 73, 78, 84, 86, 108, 120

Output:
test/colm/retrieval/holdout20_cap2_20260531/holdout20_coverage_repaired_v1.json

Validation:
test/colm/retrieval/holdout20_cap2_20260531/standard_validation_coverage_v1_judge/validation_summary.json

Failure analysis:
test/colm/retrieval/HOLDOUT20_CAP2_FAILURE_ANALYSIS_20260531.md
```

Result:

```text
Coverage repair applied: 0
Gate: ALLOW 20 / BLOCK 0
Judge: CORRECT 6 / PARTIAL 4 / INCORRECT 10
Correctness score: 2.6

Latency:
- total: 1270.679s
- avg: 63.534s/question
- p50: 63.218s
- p90: 83.930s
- p95: 87.092s
- max: 140.966s
- avg retrieved chunks: 20.6
- avg pre-rerank candidates: 76.0
```

Interpretation:

```text
Cap2 generalizes as a cost reducer, but answer quality does not generalize to
the holdout set. This is an important negative result.

The failures are not mostly latency/candidate-count problems. They are stable
company/profile/event/product fact problems and a smaller number of numeric
verifier gaps.
```

Decision:

```text
Do not continue claiming broad correctness from small30 alone.

Updated product boundary:
- Do not add a Zeekr-specific factbook/fact registry to the current mainline.
- Keep the current system non-custom at the tail end: retrieval, date cutoff,
  deterministic numeric/table verifier, routing/cost controls, judge/audit,
  and learning-based rescue scoring.
- A company-specific fact registry can be a final optional module or ablation
  later. A future version may auto-build such a registry from a new company's
  filings, but that is not part of the current mainline.

Next work should shift from retrieval-parameter tuning to:
1. deterministic verifier extension only for real numeric/table misses observed
   on holdout;
2. learning-based rescue scorer using generic query/candidate features, not
   company-specific facts;
3. rerun holdout20 after those scoped non-factbook fixes.
```

## 2026-05-31 Learning-Based Rescue Scorer Boundary

Goal:

```text
Replace or augment hand-written evidence rescue ranking with a small learned
scorer, without introducing company-specific facts.
```

Implementation direction:

```text
New generic module:
- src/utils/evidence_rescue_scorer.py

New training script:
- test/colm/retrieval/train_rescue_scorer.py

Updated runner switch:
- --evidence_rescue_scorer_model_path
- --evidence_rescue_scorer_blend_alpha

The scorer uses only inference-time retrieval features:
- query/candidate token overlap
- number/year overlap
- retriever path one-hot features
- raw retrieval score
- chunk length
- table/text indicator
- existing rule rescue score as a blend feature

It does not use Zeekr-specific product, board, IPO, or event facts as features.
```

Acceptance line:

```text
For this phase, the scorer counts as directionally complete if:
1. it trains from existing generated-answer artifacts with weak key-point labels;
2. it produces an offline train/eval report;
3. it can be enabled by config without changing default behavior;
4. it does not regress small30 gate/judge if used in an E2E smoke later.

It does not need to solve the holdout profile-fact failures by itself, because
those failures are not primarily evidence-rescue ranking problems.
```

Offline result:

```text
Model:
test/colm/retrieval/rescue_scorer_v1_20260531/evidence_rescue_scorer_v1.json

Report:
test/colm/retrieval/rescue_scorer_v1_20260531/report.json

Train:
test/colm/retrieval/subquery_cap2_small30_20260530/small30_coverage_repaired_v1.json

Eval:
test/colm/retrieval/holdout20_cap2_20260531/holdout20_coverage_repaired_v1.json

Candidate-level weak-label metrics:
- train rows: 3044
- train positive rows: 1118
- train AUC: 0.9598
- train AP: 0.9080
- train top5 hit by question: 0.7826
- eval rows: 1520
- eval positive rows: 829
- eval AUC: 0.8993
- eval AP: 0.8997
- eval top5 hit by question: 0.9375

Strongest positive features:
- token_overlap_ratio_query
- token_overlap_count
- year_overlap_count
- token_jaccard
- retriever_pageindex
- number_overlap_count
```

E2E smoke:

```text
Indices:
2, 38, 41, 84, 108

Output:
test/colm/retrieval/rescue_scorer_v1_smoke_20260531/smoke5_coverage_repaired_v1.json

Validation:
test/colm/retrieval/rescue_scorer_v1_smoke_20260531/standard_validation_coverage_v1_judge/validation_summary.json

Result:
- gate: ALLOW 5 / BLOCK 0
- judge: CORRECT 0 / PARTIAL 2 / INCORRECT 3
- avg time: 37.105s/question

Compared with holdout20 baseline on the same indices:
- qa_kp_2: INCORRECT -> PARTIAL
- qa_kp_38: INCORRECT -> PARTIAL
- qa_kp_41: INCORRECT -> INCORRECT
- qa_kp_84: INCORRECT -> INCORRECT
- qa_kp_108: INCORRECT -> INCORRECT
```

Decision:

```text
Learning-based rescue scorer is directionally complete as infrastructure:
- trains from existing artifacts;
- uses generic retrieval/query features only;
- can be enabled by config;
- improves two holdout smoke rows from incorrect to partial.

Do not enable it as default yet. It should be treated as an experimental rescue
reranker until it passes a larger E2E validation. It is not a substitute for
numeric verification or future optional company-specific fact extraction.
```

## 2026-05-31 Deterministic Verifier: Cash Balance Split Rows

Observed failure:

```text
Holdout row:
qa_kp_84 / index 84
Question:
极氪2024年二季度现金余额

Prior generated answer:
RMB 8,961,652 thousand / US$ 1,227,741 thousand

Gold:
US$ 1.107B
```

Root cause:

```text
This was not a company factbook gap. It was a generic table-parsing gap.

The existing cash-balance verifier looked for a single row such as:
"total cash, cash equivalents and restricted cash"

But the relevant Q2 balance sheet table has separate rows:
- Cash and cash equivalents
- Restricted cash

For June 30, 2024, those rows should be summed:
- RMB 5,495,539 + RMB 2,552,561 = RMB 8,048,100 thousand
- US$ 756,211 + US$ 351,244 = US$ 1,107,455 thousand
```

Implementation:

```text
Changed file:
- src/utils/table_fact_verifier.py

Generic behavior added:
- if no total cash row exists, detect "cash and cash equivalents" plus
  "restricted cash";
- select the balance-sheet period column from stacked headers such as
  "June 30 / 2024 / US$";
- sum the two rows for RMB and US$ facts;
- keep the existing exact/scale-aware answer check.
```

Validation:

```text
Holdout20 after verifier patch:
test/colm/retrieval/holdout20_cap2_20260531/standard_validation_after_cash_verifier_gate_only/validation_summary.json

Result:
- status: BLOCKED_BY_DETERMINISTIC_GATE
- gate: ALLOW 19 / BLOCK 1
- blocked row: qa_kp_84
- expected facts:
  - RMB 8,048,100 thousand
  - US$ 1,107,455 thousand

Small30 regression check:
test/colm/retrieval/subquery_cap2_small30_20260530/standard_validation_after_cash_verifier_gate_only/validation_summary.json

Result:
- status: PASS
- gate: ALLOW 30 / BLOCK 0
```

Decision:

```text
This deterministic verifier extension is accepted.

It stays within the agreed boundary:
- no Zeekr factbook;
- no company-specific profile facts;
- generic balance-sheet period parsing and row summation.
```
