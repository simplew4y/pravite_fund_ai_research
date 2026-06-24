# PageIndex Table-Facts Optimization Notes - 2026-05-28

## Scope

All remote runs were executed under:

`/root/autodl-tmp/dir_myz/FinSagent_pageindex_fast`

Diagnostic set:

`test/colm/retrieval/diagnostic_testsets_20260526/zeekr_small_30_diagnostic.json`

## Changes Tested

- Added qid-safe judge matching and generated-answer priority in `test/qa_llm_judge.py`.
- Added lightweight table row/column extraction notes for:
  - capitalization actual vs pro forma rows;
  - gross margin derived from gross profit / total revenue;
  - delivery volume, including quarter totals from monthly values.
- Added table relevance ordering and filtered the 2025-05-15 post-integration delivery table for brand-level delivery questions.
- Added guarded prompts for table evidence, delivery questions, gross-margin rounding, and revenue-stream context.
- Evaluation script now supports `disable_external_tools` to keep filing QA focused on local evidence.

## Key Runs

### Baseline Small30

Path:

`test/colm/retrieval/small30_current_20260528_035403`

Result:

- CORRECT: 14
- PARTIAL: 6
- INCORRECT: 10
- Correctness score: 3.2667

### Full Small30 After First Table-Facts Patch

Path:

`test/colm/retrieval/small30_tablefacts_full_20260528_054000`

Result:

- CORRECT: 13
- PARTIAL: 7
- INCORRECT: 10
- Correctness score: 3.2000

Conclusion: table facts improved several hard numeric cases but introduced regressions, so this exact config is not a merge-ready global improvement.

### Targeted Recheck After Narrowing Rules

Path:

`test/colm/retrieval/small30_targeted_tablefacts3_20260528_064500`

Important outcomes:

- `qa_kp_75`: CORRECT
- `qa_kp_113`: CORRECT
- `qa_kp_118`: CORRECT
- `qa_kp_83`: PARTIAL, because system correctly avoided unsupported YoY growth and answered 79,250 only.

### Prompt-Tight Targeted Recheck

Path:

`test/colm/retrieval/small30_targeted_prompttight_20260528_070500`

Important outcomes:

- `qa_kp_54`: CORRECT after quarterly delivery summing and group-table filtering.
- `qa_kp_83`: PARTIAL; no contradiction, missing gold's 9.8% YoY.
- `qa_kp_99`: still INCORRECT under judge because answer gives 14.2% while gold expects 14%.
- `qa_kp_46`: still incomplete; needs total revenue growth of 46.9% and growth drivers.

## What Worked

- Capitalization table extraction fixed `qa_kp_118` in targeted runs.
- Working-capital table extraction kept `qa_kp_113` correct.
- Delivery group-table filtering plus monthly-to-quarter summing fixed `qa_kp_54`.
- Caveat suppression fixed `qa_kp_75` in targeted runs.

## What Did Not Work Yet

- Full small30 did not improve globally; one run regressed from 14/6/10 to 13/7/10.
- `qa_kp_99` is blocked by strict judge/gold rounding: evidence supports 14.2%, gold expects 14%.
- `qa_kp_46` still omits total YoY growth and disclosed growth drivers.
- `qa_kp_8` regressed due date mismatch on Power Delivery city coverage.
- Some answers remain nondeterministic across targeted vs full runs even at temperature 0, likely due multi-subquery evidence ordering and synthesis.

## Recommended Next Step

Do not run a broad ablation yet. First create a small deterministic evidence normalizer for:

- delivery tables by period/scope;
- gross margin headline rounding;
- annual revenue stream tables with YoY growth and drivers;
- headquarters/based address distinction.

Then rerun small30 and only proceed to large100/full132 if small30 beats the baseline.
