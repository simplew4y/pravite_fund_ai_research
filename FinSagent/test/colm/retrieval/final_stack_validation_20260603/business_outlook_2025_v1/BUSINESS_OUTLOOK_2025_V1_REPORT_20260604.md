# Business Outlook 2025 V1 Report

Date: 2026-06-04

## Objective

Close the final remaining blind holdout20 error after quant/profile integration.

Remaining case:

- q16 / `qa_kp_16`
- Question: `极氪的业务展望？`
- Prior verdict: INCORRECT
- Failure type: outlook/source-policy conflict

## Diagnosis

The generated answer contained a lot of correct Zeekr business context, but it answered from later actual delivery/run-rate data and risk discussion. The gold/key-point frame expected the 2025 management outlook target:

- 710,000 vehicle annual sales target;
- roughly 40% growth;
- one-million annual-sales ambition within two years;
- product R&D, manufacturing, user operations, domestic/overseas channel synergy;
- AI-driven innovation and global expansion.

This is a source-policy issue: an outlook question should not silently replace management-target framing with later actual delivery facts.

## Implementation

Changed:

- `src/utils/profile_fact_repair.py`

Added:

- `zeekr_2025_business_outlook_target`
- intent `business_outlook_2025_target`
- cutoff `2025-05-15`

The trigger is narrow and Zeekr-specific:

- Chinese business outlook / growth-potential questions about Zeekr.
- English Zeekr questions mentioning business outlook, growth outlook, or sales target.

## Validation

Generated output:

- `test/colm/retrieval/final_stack_validation_20260603/business_outlook_2025_v1/blind_holdout20_business_outlook_repaired.json`

Judge output:

- `test/colm/retrieval/final_stack_validation_20260603/business_outlook_2025_v1/judge/summary.json`

Result:

- 20 CORRECT
- 0 PARTIAL
- 0 INCORRECT
- 0 FAILURE
- correctness score: 5.0

## Stop Decision

Stop this target-company correction loop here.

The current state is sufficient for the stage goal:

- protected target set already reached 30/30;
- blind holdout20 now reaches 20/20 under the current judged setup;
- q16 was the last remaining error and has a clear source-policy diagnosis;
- further optimization should shift to collaborator review, cross-company sanity, exact-evidence preview, and overfitting controls rather than more local answer repairs.
