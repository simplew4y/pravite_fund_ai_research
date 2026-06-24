# Rotating20 Skill Evolution Report

Generated: 2026-06-03

## Goal

Use a fresh rotating diagnostic set to check whether the current auto-guarded
skill chain generalizes beyond the old small30/holdout20 loop. This run is not
the final blind holdout. Its purpose is failure discovery and skill routing.

## Run Setup

- Test set: `test/colm/retrieval/skill_evolution_testsets_20260602/rotating_diagnostic_candidates.json`
- Rows: 20
- Risk mix: coverage 5, fact_registry 2, general 3, period_control 5, table_verification 5
- Generation output: `test/colm/retrieval/skill_evolution_rotating_run_20260603/rotating20_generated_boundary_fixed.json`
- Validation: deterministic table gate plus LLM judge
- Protected regression after fix: PASS

## Main Results

- Judge verdicts: 6 CORRECT / 7 PARTIAL / 7 INCORRECT
- Deterministic gate: 18 ALLOW / 2 REVIEW / 0 BLOCK
- Runtime: avg 57.4s/question, p50 49.0s, p90 87.1s, max 152.4s
- Table repair applied: 2 rows after boundary fix
- Answer abstention: 0 rows

This confirms the rotating set is substantially harder than the protected
small30 sanity set. It is useful for skill discovery, but should not be used as
a repeated leaderboard.

## Boundary Fix Applied

The run exposed a harmful skill interaction on `qa_kp_134`: the table repair
treated a cost-of-revenues mix question as a revenue-contribution question and
overwrote the original answer with a 2025 Q1 revenue mix answer.

Fix:
- `revenue_contribution` detection now excludes cost-of-revenues mix/driver
  questions.
- Direct check on `qa_kp_134` now returns `repair_applied=false`.
- Protected and cross-company gates still pass after the change.

This is a skill-boundary tightening, not a hard-coded answer patch.

## Failure Buckets

| bucket | count | examples | interpretation |
| --- | ---: | --- | --- |
| coverage_failure | 3 | qa_kp_21, qa_kp_65, qa_kp_122 | Missing or contradicting key points in broader narrative/company-structure questions. |
| period_control_partial | 3 | qa_kp_93, qa_kp_95, qa_kp_98 | Core numeric value often present, but missing USD equivalent, YoY growth, or contextual key point. |
| deterministic_table_gate | 2 | qa_kp_129, qa_kp_134 | Gate flagged missing table details; needs human check before new deterministic rule. |
| table_verification_failure | 1 | qa_kp_135 | R&D component mix is not covered by current table fact types. |
| table_verification_partial | 1 | qa_kp_94 | R&D amount and YoY present, but USD/context missing. |
| general_failure/partial | 2 | qa_kp_59, qa_kp_72 | Likely key-point coverage or GT/unit issue; inspect before engineering. |

## Recommended Next Skill Work

1. Cost/R&D component table skill candidate
   - Scope: cost-of-revenues mix and R&D component mix across years.
   - Why: q134 and q135 are structurally table-based and currently uncovered.
   - Boundary: only use parsed table rows; do not encode benchmark answer text.

2. Period answer coverage repair candidate
   - Scope: when a period numeric answer is correct but missing USD equivalent,
     YoY growth, or stated driver from adjacent narrative.
   - Why: q93/q95/q98/q94 are mostly partial, not complete retrieval collapse.
   - Boundary: do not globally add extra facts unless the asked metric and period
     are clear.

3. Corporate structure / ownership-chain verifier candidate
   - Scope: ownership chain questions where diagram/table evidence gives 100%
     links but the answer over-abstains.
   - Why: q122 contradicted the gold answer by saying the 100% chain was not
     definitive.
   - Boundary: defer broad fact registry until generic structure extraction is
     tested.

## What Not To Do Yet

- Do not tune the main PageIndex retrieval architecture from this run alone.
- Do not touch the blind holdout until a candidate skill passes rotating,
  protected small30, and NVIDIA gates.
- Do not promote fact registry as the main solution yet; use it later as a
  custom-company enhancement or comparison.
- Do not optimize the same bucket for more than two iterations without protected
  and cross-company evidence.

## Artifacts

- Judged diagnostic report: `test/colm/retrieval/skill_evolution_rotating_run_20260603/diagnostic_summary_judged_boundary_fixed/SKILL_EVOLUTION_DIAGNOSTIC_SUMMARY.md`
- Judge summary: `test/colm/retrieval/skill_evolution_rotating_run_20260603/judge_validation_boundary_fixed/judge/summary.json`
- Gate summary: `test/colm/retrieval/skill_evolution_rotating_run_20260603/judge_validation_boundary_fixed/answer_gate_numeric_audit.json`
- Regression after fix: `test/colm/retrieval/skill_registry_validation_after_boundary_fix_20260603/SKILL_REGISTRY_VALIDATION.md`
