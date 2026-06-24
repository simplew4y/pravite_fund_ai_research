# Cross-company benchmark v1 report (2026-06-04)

## Purpose

This benchmark consolidates the current target-company and non-target-company evidence into one cross-company view. It is designed to answer the question: after the Zeekr stage freeze, does the current PageIndex Hybrid + guarded skills stack still work outside the target company, and do the remaining failures look systematic and diagnosable?

This is a v1 benchmark. It uses existing, traceable judged runs rather than generating a large new but weakly validated 100-200 question set. The goal is a clean, defensible 40-question result that can be reported now, and a foundation for a larger rotating benchmark later.

## Benchmark composition

| Slice | Company | Role | Questions | Index condition |
| --- | --- | ---: | ---: | --- |
| Zeekr holdout20 | Zeekr | Target-company holdout | 20 | Full target-company DB with PageIndex; final guarded repaired output |
| Lotus mini10 | Lotus Technology | Non-target company PageIndex-path sanity | 10 | BM25/Chroma/Table plus PageIndex-compatible fallback structure, 8 PDFs, 1,958 runtime nodes |
| NVIDIA mini10 | NVIDIA | Non-target company external sanity | 10 | NVIDIA PageIndex available; Zeekr deterministic repairs disabled |

Machine-readable summary:

`test/colm/retrieval/cross_company_benchmark_v1_20260604/cross_company_benchmark_v1_summary.json`

CSV table:

`test/colm/retrieval/cross_company_benchmark_v1_20260604/cross_company_benchmark_v1_table.csv`

## Result

| Slice | Result | Correctness score | Avg time |
| --- | ---: | ---: | ---: |
| Zeekr holdout20 | 20 correct / 0 partial / 0 incorrect | 5.0 / 5 | 98.6s/q |
| Lotus mini10 with PageIndex-compatible fallback | 10 correct / 0 partial / 0 incorrect | 5.0 / 5 | 79.3s/q |
| NVIDIA mini10 | 9 correct / 0 partial / 1 incorrect | 4.6 / 5 | 62.6s/q |
| **Total** | **39 correct / 0 partial / 1 incorrect** | **4.9 / 5 weighted** | - |

Overall correct-only accuracy: 39/40 = 97.5%.

## Interpretation

This is now stronger than a single-company success claim. Zeekr remains fully correct on the holdout slice, Lotus remains fully correct after adding a runtime-loadable PageIndex-compatible structure index, and NVIDIA mostly passes without NVIDIA-specific profile/factbook repairs.

The one NVIDIA failure is useful rather than random: it is a period-boundary / future-leakage problem. The answer mixed later H20/export-control disclosures and later period impacts into a question asking for the FY2025 framing. This aligns with the known next optimization area: stricter fiscal-period and cutoff handling, especially for questions where later filings contain stronger but temporally incompatible evidence.

## What this proves

1. The system is not only memorizing or patching Zeekr answers. It passes two non-target company sanity slices: Lotus and NVIDIA.
2. Zeekr-specific deterministic profile repair is not required for the Lotus/NVIDIA runs, and the Lotus profile spillover check previously showed 0/10 profile repairs applied.
3. The current guarded skills stack transfers across common SEC QA types: numeric revenue/margin, filing definitions, transaction timeline, risk factors, segment/business profile, VIE/holding structure, listing/security facts, and export-control risk.
4. Remaining errors are diagnosable. The observed miss is a time-period/cutoff issue, not a collapse of retrieval or a need for broad company-specific factbooks.

## What this does not prove

1. It is not yet a broad 100-200 question benchmark.
2. Lotus uses a PageIndex-compatible manual PDF fallback structure, not a full LLM-generated PageIndex structure. It proves the runtime structure-index path is available and useful, but not that full PageIndex LLM indexing has been completed for Lotus.
3. NVIDIA mini10 is still small. It is a sanity slice, not a full NVIDIA benchmark.
4. The result does not remove the need for rotating holdouts. It should be treated as the current stage proof, not the final generalization proof.

## Recommended PPT wording

> We consolidated the current validation into a 40-question cross-company benchmark across Zeekr, Lotus, and NVIDIA. The system achieved 39/40 correct, 0 partial, and a weighted correctness score of 4.9/5. Zeekr holdout20 and Lotus mini10 both reached 10/10-style full correctness, while NVIDIA mini10 exposed one clear period/future-leakage failure. This supports the claim that the current improvements are not just single-company answer patching; the next priority is broader rotating benchmark coverage and stricter fiscal-period cutoff handling.

## Next benchmark expansion

The next step should be benchmark v2, not more Zeekr local tuning. Recommended size: 60-75 questions.

Suggested design:

- 3-5 companies total
- 12-15 questions per company
- Keep Zeekr as one target-company anchor
- Keep Lotus and NVIDIA as non-target anchors
- Add 1-2 Finder companies with clean annual-report data
- Cover common SEC QA categories: revenue/gross margin, balance sheet, cash flow, segment structure, risk factors, filing definitions, transaction timeline, share/listing facts, customer/supplier concentration, and period/cutoff-sensitive questions

Acceptance standard for stage proof:

- At least 90% correct-only accuracy on v2
- No company-specific skill spillover on non-target slices
- Failures must be explainable by taxonomy: retrieval miss, period mismatch, table numeric error, coverage omission, or generation hallucination
- Any new skill must pass target holdout plus at least one non-target slice before being accepted
