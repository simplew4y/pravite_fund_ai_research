# Source Conflict Skill V1

Generated: 2026-06-03

## Scope

This skill handles SEC QA cases where two retrieved filing sources expose different numeric bases for the same-looking metric. It does not choose a hidden winner. It detects the inconsistency, keeps the safe parts of the original answer, and rewrites the risky conclusion so the answer explicitly presents both bases.

Current implemented pattern:

- delivery volume breakdown;
- monthly delivery table vs later quarterly delivery table;
- mixed citation where Q1/Q2 come from monthly sums while Q3/Q4 come from a separate SEC quarterly table.

## Changed Files

- `src/utils/table_fact_verifier.py`
- `src/utils/table_answer_gate.py`
- `src/utils/table_answer_repair.py`

## Key Case

Target case:

- q51: `What is the volume breakdown of Zeekr in 2024?`

Detected facts:

- Monthly table confirms full-year 2024 deliveries: 222,123 vehicles.
- Monthly table gives early-quarter figures: Q1 33,059 and Q2 54,811.
- Separate SEC quarterly delivery table uses a different delivery basis and reports: Q3 124,606 and Q4 169,088.
- Mixed citation Q1 33,059 / Q2 54,811 / Q3 124,606 / Q4 169,088 sums to 381,564, which does not reconcile to the full-year total of 222,123.
- The filing evidence does not explain the inconsistency.

## Validation

Output directory:

`/root/autodl-tmp/dir_myz/FinSagent_pageindex_fast/test/colm/retrieval/skill_evolution_mvp_20260602/source_conflict_skill_v1/`

Key artifacts:

- `holdout20_table_source_repaired_v2.json`
- `holdout20_source_repaired_gate_v2.json/.csv`
- `q51_v2_judge/judge/summary.json`
- `small30_gate_v2.json/.csv`
- `nvidia_mini10_gate_v2.json/.csv`

Gate results:

- holdout20 repaired v2: ALLOW 20; supported rows PASS 5; out-of-scope 15.
- protected small30: ALLOW 30; supported rows PASS 11.
- NVIDIA mini10 sanity: ALLOW 10; no source-conflict false trigger.

Target judge result:

- q51 repaired v2: CORRECT, correctness_score 5.0.

## Notes

The full 20-question judge rerun for an earlier v1 source-conflict attempt was noisy: q86 flipped back to incorrect due the same unit-math judge issue previously observed. Therefore, the promotion evidence for this source-conflict skill should use:

- deterministic table gate PASS;
- q51 target judge CORRECT;
- protected small30 no-regression;
- NVIDIA mini10 no-regression.

Do not over-read one noisy full diagnostic aggregate as a stable leaderboard.

## Promotion Status

Candidate status: promote as a narrow source-conflict skill if the product goal accepts explicit discrepancy reporting.

Recommended behavior:

- When sources conflict, do not force a single reconciled answer.
- Present the stable full-year/monthly basis.
- Present the conflicting quarterly basis with source wording.
- State that the filings do not explain the mismatch.

This is safer than ordinary table arithmetic and better aligned with SEC RAG behavior.
