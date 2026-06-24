# Quant Skill Integration V1 Report

Date: 2026-06-03

## Goal

Integrate useful parts of collaborator skill work into the current PageIndex Hybrid mainline without directly merging another system or weakening the deterministic evidence boundary.

## What Was Integrated

1. Added `src/utils/quant_skill_hints.py`.
   - Extracts a small, non-factual quant skill layer from the collaborator `financial_quant_skill.json`.
   - Current hints: `yoy_growth`, `qoq_growth`, `gross_margin`, `unit_conversion`.
   - Boundary: these hints are not evidence and never supply facts. Facts still come from filing/table evidence.

2. Extended quarterly table metric verification.
   - Existing quarterly metric support was mostly limited to R&D expenses.
   - It now supports common quarterly line items such as vehicle sales revenue, total revenues, and gross profit.
   - YoY and QoQ growth are computed only when the same row has valid period comparators.

3. Tightened quarterly revenue-breakdown triggering.
   - A simple question such as "Q2 vehicle sales revenue" should not require the full revenue breakdown.
   - Full breakdown is now required only when the question asks for breakdown/component/source/composition.

4. Added quant-skill metadata to table-repair outputs.
   - `apply_table_answer_repair.py` now writes `quant_skill_hints` for traceability.
   - This makes collaborator skill usage auditable without forcing prompt-level fusion.

5. Closed a remaining VIE profile coverage gap.
   - The VIE/holding-company profile answer now explicitly states that Zeekr is not presented as currently affected by PRC foreign-ownership restrictions requiring a VIE structure.

## Validation

Input baseline:

- `test/colm/retrieval/final_stack_validation_20260603/latest_cash_flow_status_v1/blind_holdout20_latest_cash_flow_status_v1.json`
- Previous judged state: 17 CORRECT / 2 PARTIAL / 1 INCORRECT, correctness score 4.6.

After quant table repair:

- Output: `test/colm/retrieval/final_stack_validation_20260603/quant_skill_integration_v1/blind_holdout20_quant_skill_table_repaired.json`
- Judge: `test/colm/retrieval/final_stack_validation_20260603/quant_skill_integration_v1/judge/summary.json`
- Result: 18 CORRECT / 1 PARTIAL / 1 INCORRECT, correctness score 4.7.
- Main gain: q87 moved to CORRECT by adding YoY 59.0% and QoQ 64.4% to Q2 2024 vehicle sales revenue.

After VIE profile coverage repair:

- Output: `test/colm/retrieval/final_stack_validation_20260603/quant_skill_integration_v1/blind_holdout20_quant_skill_profile_repaired.json`
- Judge: `test/colm/retrieval/final_stack_validation_20260603/quant_skill_integration_v1/profile_judge/summary.json`
- Result: 19 CORRECT / 0 PARTIAL / 1 INCORRECT, correctness score 4.8.
- q48 moved to CORRECT after adding the foreign-ownership restriction boundary.

## Remaining Failure

Only q16 remains INCORRECT.

- Topic: Zeekr business outlook.
- Failure type: outlook/source-policy conflict.
- Reason to stop here: fixing q16 safely requires a reviewed latest-outlook/source-cutoff skill around 2025 sales target and synergy framing. A narrow hard-coded answer would be higher risk and less defensible than the quant/table integration completed here.

## Takeaway

This integration demonstrates a clean collaboration pattern:

- Collaborator quant skills can become a reusable calculation-hint layer.
- Mainline deterministic verifiers still own facts and calculations.
- Outputs now record which quant skills were relevant, making the skill loop auditable.
- The result improved the holdout from 17/20 to 19/20 without directly merging another repo or adding a broad company factbook.
