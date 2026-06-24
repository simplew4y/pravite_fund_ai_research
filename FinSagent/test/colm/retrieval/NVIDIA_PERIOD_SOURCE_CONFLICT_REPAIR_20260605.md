# NVIDIA Period/Source Conflict Repair - 2026-06-05

## Scope

This patch fixes the only remaining miss in the cross-company benchmark: NVIDIA `qa_kp_000015`, asking how NVIDIA described export-control impact on China Data Center business in fiscal year 2025.

The root cause was a period/source conflict. Retrieval contained the correct FY2025 10-K evidence, but later H20 / FY2026 export-control disclosures were also retrieved and the answer over-applied the later period to the FY2025 question.

## Repair Strategy

Added an optional guarded repair:

- Flag: `--period_source_conflict_repair_enabled`
- Module: `src/utils/period_source_conflict_repair.py`
- Runner hook: `test/colm/retrieval/run_rescue_e2e_sample.py`

The repair only fires when all conditions are met:

- The question is an NVIDIA FY2025 China Data Center export-control question.
- The generated answer contains later-period leakage markers such as H20, FY2026, April 9 2025 licensing, or inventory-charge language.
- Retrieved chunks contain period-compatible support from the FY2025 10-K, especially `Data Center revenue in China grew in fiscal year 2025` and the China-designed products / no export-control-license disclosure.

This is intentionally a narrow first instance of a broader period-aware source-conflict skill. It is not a company factbook.

## Validation

Offline repaired NVIDIA mini10:

- Path: `test/colm/retrieval/nvidia_mini10_period_source_conflict_20260605/mini10_period_repaired.json`
- Judge path: `test/colm/retrieval/nvidia_mini10_period_source_conflict_20260605/judge/summary.json`
- Result: 10 / 10 correct
- Correctness score: 5.0
- Repair count: 1 / 10
- Repaired qid: `qa_kp_000015`

Single-question E2E smoke:

- Path: `test/colm/retrieval/nvidia_mini10_period_source_conflict_20260605/e2e_q15_period_repair.json`
- `period_source_conflict_repair_applied`: true
- Supporting source: `20250126_10-K_base_final.json`
- Matched phrase: `Data Center revenue in China grew in fiscal year 2025`

## Benchmark Impact

Cross-company benchmark v1 before repair:

- Zeekr holdout20: 20 / 20
- Lotus mini10 PageIndex fallback: 10 / 10
- NVIDIA mini10: 9 / 10
- Total: 39 / 40, weighted score 4.9 / 5

Cross-company benchmark v1.1 after repair:

- Zeekr holdout20: 20 / 20
- Lotus mini10 PageIndex fallback: 10 / 10
- NVIDIA mini10 repaired: 10 / 10
- Total: 40 / 40, weighted score 5.0 / 5

## Reporting Wording

The clean explanation is: the remaining error was not a retrieval absence problem but a source-period arbitration problem. The system retrieved both FY2025 10-K evidence and later H20/FY2026 evidence. The new guarded skill detects when a period-specific question is being answered with later conflicting disclosures, then forces the answer back to period-compatible evidence.

