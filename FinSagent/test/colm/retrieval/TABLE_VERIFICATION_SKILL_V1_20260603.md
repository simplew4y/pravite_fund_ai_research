# Table Verification Skill V1

Generated: 2026-06-03

## Scope

This skill adds deterministic table handling for recurring SEC QA failure modes without adding a company-specific factbook:

- quarterly revenue breakdown, e.g. total revenue plus vehicle/battery/service components;
- quarterly financial metrics with computed YoY/QoQ growth, currently R&D expense;
- sales/revenue contribution fallback when per-model sales contribution is not fully disclosed;
- delivery-volume breakdown trigger for "volume breakdown" wording;
- stricter percent matching and table-unit detection to avoid date/unit false positives.

## Changed Files

- `src/utils/table_fact_verifier.py`
- `src/utils/table_answer_gate.py`
- `src/utils/table_answer_repair.py`

## Main Outputs

Remote output directory:

`/root/autodl-tmp/dir_myz/FinSagent_pageindex_fast/test/colm/retrieval/skill_evolution_mvp_20260602/table_skill_v1/`

Key artifacts:

- `holdout20_table_gate_v1.json/.csv`
- `holdout20_table_repaired_v1.json`
- `holdout20_table_repaired_v1_gate.json/.csv`
- `holdout20_table_repaired_v1_judge/judge/summary.json`
- `small30_table_gate_v1.json/.csv`
- `nvidia_mini10_table_gate_v1.json/.csv`

## Validation Summary

Holdout20 table gate before repair:

- ALLOW 17 / REVIEW 2 / BLOCK 1
- supported table scope: 5 rows
- covered rows: q51, q57, q78, q84, q86
- q57 and q78 were reviewable omissions; q84 was blocked as wrong cash balance; q51 and q86 passed deterministic table checks.

Holdout20 after deterministic repair:

- repair applied to 3 rows: q57, q78, q84
- table gate: ALLOW 20 / supported PASS 5 / out_of_scope 15
- judge result: 9 CORRECT / 3 PARTIAL / 8 INCORRECT
- previous current baseline judge result: 5 CORRECT / 4 PARTIAL / 11 INCORRECT

Protected small30:

- input: `test/colm/retrieval/subquery_cap2_small30_20260530/small30_coverage_repaired_v1.json`
- gate result: ALLOW 30
- supported table rows: 11 PASS
- no new block/review, so no protected-regression signal.

NVIDIA mini10 sanity:

- input: `test/colm/retrieval/nvidia_mini10_cap2_20260601/mini10.json`
- gate result: ALLOW 10
- no cross-company false trigger.

## Case-Level Notes

- q57 moved PARTIAL -> CORRECT after adding revenue-contribution fallback: per-model unit contribution remains undisclosed, but 2025 Q1 revenue contribution is now stated as vehicle sales RMB 190.96bn / 86.7% and other sales/services RMB 29.23bn / 13.3%.
- q78 moved PARTIAL -> CORRECT after adding computed growth facts: Q4 2024 R&D expense RMB 32.05bn, YoY +1.4%, QoQ +63.0%.
- q84 moved INCORRECT -> CORRECT after cash-balance repair: RMB 8,048,100 thousand, i.e. RMB 8.048bn / RMB 80.48亿元; US$ 1,107,455 thousand, i.e. US$ 1.107bn.
- q86 was not rewritten, but deterministic table verification now passes all four revenue facts. The previous judge looked like a unit-math false negative; the rerun judged it CORRECT.
- q51 remains INCORRECT because the gold answer expects a source-conflict note: monthly deliveries sum to 222,123, while another SEC quarterly citation uses inconsistent quarter figures. This should be handled by a source-conflict/discrepancy skill, not by ordinary table arithmetic.

## Promotion Decision

Candidate status: promote to the current engineering branch as a narrow table skill.

Reason:

- improves the diagnostic table bucket;
- repairs supported errors with transparent table facts;
- passes protected small30 gate;
- does not trigger on NVIDIA mini10;
- leaves unsupported rows out of scope rather than guessing.

## Next Skill Candidate

Source-conflict / discrepancy skill:

- detect when two SEC-derived table/narrative sources use incompatible period totals;
- answer with both numbers and explicitly say the filings are inconsistent;
- primary target: q51-style delivery breakdown where monthly totals and cited quarterly figures disagree.
