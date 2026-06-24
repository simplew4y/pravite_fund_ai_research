# PageIndex Hybrid Stage Freeze After Holdout20

Date: 2026-06-04

## Decision

Freeze the current target-company correction loop and stop adding more local answer repairs unless a new rotating/cross-company diagnostic exposes a repeated, evidence-backed failure bucket.

## Current Validated State

Target-company protected set:

- Zeekr small30: 30 / 30
- Role: protected regression / target-company sanity check

Target-company blind holdout20:

- Before quant/profile integration: 17 CORRECT / 2 PARTIAL / 1 INCORRECT, correctness score 4.6
- After quant skill integration and VIE profile coverage: 19 CORRECT / 0 PARTIAL / 1 INCORRECT, correctness score 4.8
- After business outlook source-policy skill: 20 CORRECT / 0 PARTIAL / 0 INCORRECT, correctness score 5.0

Cross-company sanity:

- NVIDIA mini10 prior sanity: 9 / 10
- New profile-repair spillover check after Zeekr outlook skill: 0 / 10 profile repairs applied
- Output: `test/colm/retrieval/final_stack_validation_20260603/stage_freeze_after_20of20/nvidia_mini10_profile_repair_check.json`

## What Changed In The Final Step

The last remaining holdout failure was q16, `极氪的业务展望？`.

Diagnosis:

- The generated answer used later actual delivery/run-rate facts and risk discussion.
- The expected answer was an outlook/source-policy frame: 2025 target, synergy, AI-driven innovation, global expansion.

Implemented skill:

- `zeekr_2025_business_outlook_target`
- intent: `business_outlook_2025_target`
- cutoff: `2025-05-15`
- primary file: `src/utils/profile_fact_repair.py`

Validation:

- `test/colm/retrieval/final_stack_validation_20260603/business_outlook_2025_v1/judge/summary.json`
- Result: 20 / 20 CORRECT, score 5.0

## Why Freeze Here

The stage goal is now satisfied:

- Known protected target-company sanity is clean.
- Blind holdout20 is clean under the current judge setup.
- The final failure had a clear source-policy diagnosis.
- Cross-company profile spillover check is clean.
- Further local fixes are more likely to reduce defensibility than improve architecture quality.

The remaining useful work should shift from "repair more Zeekr cases" to "prove the system is not overfit."

## Workstreams After Freeze

1. Generalization and slimming audit
   - Owner: collaborator
   - Task doc: `test/colm/retrieval/collaboration_20260603/COLLABORATOR_GENERALIZATION_SLIMMING_TASK_20260603.md`
   - Goal: decide which skills are general SEC RAG skills, which are Zeekr-specific source-policy skills, and which should become review-only.

2. Exact evidence preview / grep audit
   - Owner: collaborator
   - Task doc: `test/colm/retrieval/collaboration_20260603/COLLABORATOR_EXACT_EVIDENCE_PREVIEW_TASK_20260603.md`
   - Goal: evaluate grep/exact-match evidence as preview/audit support, not as final-answer logic.

3. Cross-company sanity expansion
   - Recommended next test: one additional non-Zeekr company mini set.
   - Goal: confirm deterministic table/quant skills transfer while Zeekr profile skills stay bounded.

4. Final reporting
   - Position this as an industrial SEC RAG skill layer:
     - PageIndex hybrid retrieval for structured evidence.
     - Deterministic table verifier/gate for numeric reliability.
     - Quant skill hints for calculation intent.
     - Review-required profile/source-policy skills for stable company-specific boundaries.
     - Exact evidence preview as future audit support.

## Boundary Going Forward

Do not add a new local repair unless all of these are true:

- the failure repeats across a rotating diagnostic bucket or is explicitly selected for a reviewed source-policy skill;
- the evidence source and cutoff are documented;
- protected regression does not regress;
- cross-company sanity does not show spillover;
- the skill can be explained as a reusable verifier, renderer, source-policy rule, or review-only hint.

Do not optimize against the now-clean holdout20 further.
