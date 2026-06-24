# Lotus PageIndex-compatible rerun report (2026-06-04)

## Why this run was added

The first Lotus mini10 run proved cross-company retrieval and skill-boundary behavior, but Lotus did not yet have a PageIndex directory. To make the cross-company proof stronger, we added a PageIndex-compatible structure index for the Lotus filings used by the mini10 set and reran the same questions unchanged.

## Index build

Real PageIndex LLM indexing was attempted first on the Lotus core filing subset, but it was too slow for the current reporting window and produced no completed structure files before being stopped. We then used the existing uild_pageindex_index.py manual PDF fallback path, which creates runtime-compatible *_structure.json files from PDF page text and detected headings.

This is not the full LLM-summarized PageIndex build. It is a PageIndex-compatible structural fallback that exercises the runtime index-loading and page/node retrieval path.

Index location:

/root/autodl-tmp/RAG_Agent_data/lotus/20250701/database_lotus/pageindex

Index manifest:

	est/colm/retrieval/lotus_mini10_generalization_20260604/pageindex_fallback_manifest.json

Built files:

- 8 core Lotus PDFs indexed
- 1,958 runtime-loadable PageIndex nodes
- runtime check: vailable=True

Core indexed PDFs:

- Lotus 20-F 20240422
- Lotus 20-F 20250430
- Lotus 424B3 20240112
- Lotus 424B3 20241121
- Lotus 6-K 20240222
- Lotus 6-K 20240223
- Lotus 6-K 20240408
- Lotus 6-K 20250530

## Rerun result

Same test set, same questions, same GT:

	est/colm/retrieval/lotus_mini10_generalization_20260604/lotus_mini10.json

Generated answers:

	est/colm/retrieval/lotus_mini10_generalization_20260604/lotus_mini10_pageindex_fallback_run.json

Judge summary:

	est/colm/retrieval/lotus_mini10_generalization_20260604/pageindex_fallback_judge/summary.json

Result:

| Set | Index condition | Result | Correctness score |
| --- | --- | --- | ---: |
| Lotus mini10 | PageIndex-compatible fallback structure present | 10 correct / 0 partial / 0 incorrect | 5.0 / 5 |

Likert averages:

- Information Coverage: 4.9 / 5
- Factual Consistency: 5.0 / 5
- Reasoning Chain: 4.4 / 5
- Clarity of Expression: 4.9 / 5
- Analytical Depth: 4.5 / 5

Latency:

- Total: 793.1s for 10 questions
- Average: 79.3s/question
- Previous no-PageIndex Lotus run: about 854.7s total, 85.5s/question average

## Interpretation

This improves the earlier Lotus proof because Lotus now has a runtime-loadable PageIndex-compatible structure directory, and the same mini10 remains 10/10 without changing the questions. It also confirms the index path is no longer missing: the runtime retriever can load 1,958 nodes from the Lotus PageIndex directory.

However, this should be described precisely: the current Lotus index is a manual PDF fallback structure, not a full LLM-generated PageIndex structure. For the strongest possible claim, the next step is still to complete a real PageIndex LLM build for Lotus or for a smaller subset of the same filings, then rerun the unchanged mini10 again.

## PPT wording

> We addressed the main caveat in the first Lotus sanity check by adding a runtime-loadable PageIndex-compatible structure index for 8 core Lotus filings. The same Lotus mini10 was rerun unchanged and remained 10/10 correct, with the runtime loading 1,958 structure nodes. This strengthens the cross-company proof, while we still distinguish it from a full LLM-generated PageIndex build, which is slower and can be completed later for an even stronger benchmark.

## Recommendation

Use this as the current-stage cross-company PageIndex-path sanity result. Do not overclaim it as a full PageIndex LLM-index generalization benchmark. The next most valuable work is a rotating 60-75 question cross-company benchmark, plus a queued full PageIndex LLM build for one non-Zeekr company when time/API budget allows.
