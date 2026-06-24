# Cross-Company Benchmark v1.1 After Period Repair - 2026-06-05

## Result

After fixing the only NVIDIA miss with a guarded period/source conflict repair, the benchmark is clean:

| Set | Company | Result | Score | Note |
| --- | --- | ---: | ---: | --- |
| Zeekr holdout20 | Zeekr | 20 / 20 | 5.0 | Target-company holdout |
| Lotus mini10 PageIndex fallback | Lotus Technology | 10 / 10 | 5.0 | Cross-company sanity with PageIndex-compatible fallback |
| NVIDIA mini10 repaired | NVIDIA | 10 / 10 | 5.0 | Cross-company sanity after period/source conflict repair |
| Total | 3 companies | 40 / 40 | 5.0 | No partial / incorrect remaining |

## What Changed

The previous v1 result was 39 / 40. The only miss was NVIDIA `qa_kp_000015`: the answer mixed later H20 / FY2026 export-control disclosures into a FY2025 question.

The new repair checks for this source-period conflict and only rewrites the answer when FY2025-compatible 10-K evidence is present in retrieved chunks. In the E2E smoke, the repair used `20250126_10-K_base_final.json` and matched `Data Center revenue in China grew in fiscal year 2025`.

## Interpretation

This is a useful final-state result for the current phase: the system is not just memorizing Zeekr-specific facts, because the clean pass covers target-company holdout plus two non-target companies. The one observed cross-company failure was explainable and repairable as a general class: period-aware source arbitration.

The next architecture direction should not be another broad retrieval stack rewrite. A better next cycle is to generalize this guarded period/source-conflict logic across fiscal-year questions, while keeping it gated and auditable.

