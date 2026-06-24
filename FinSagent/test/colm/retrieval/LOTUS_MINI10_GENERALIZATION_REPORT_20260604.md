# Lotus mini10 cross-company generalization check (2026-06-04)

## Purpose

After freezing the Zeekr local repair loop, we created a new non-Zeekr mini set on Lotus Technology to check whether the current PageIndex Hybrid skill stack still works outside the target company and whether Zeekr-specific profile skills leak into another company.

This set is intended as a cross-company sanity proof, not as a final broad benchmark. It contains 10 manually grounded SEC-style questions covering numeric tables, filing definitions, transaction timeline, product/risk language, balance-sheet snapshots, VIE/holding structure, and listed securities.

## Dataset and run artifacts

- Test set: 	est/colm/retrieval/lotus_mini10_generalization_20260604/lotus_mini10.json
- Generated answers: 	est/colm/retrieval/lotus_mini10_generalization_20260604/lotus_mini10_run.json
- Judge output: 	est/colm/retrieval/lotus_mini10_generalization_20260604/judge_v2/summary.json
- Profile spillover check: 	est/colm/retrieval/lotus_mini10_generalization_20260604/lotus_profile_repair_check.json

## Result

| Set | Company | Size | Result | Correctness score | Notes |
| --- | --- | ---: | --- | ---: | --- |
| Lotus mini10 | Lotus Technology | 10 | 10 correct / 0 partial / 0 incorrect | 5.0 / 5 | New non-Zeekr cross-company sanity set |

Likert averages from judge v2:

- Information Coverage: 5.0 / 5
- Factual Consistency: 5.0 / 5
- Clarity of Expression: 4.9 / 5
- Reasoning Chain: 4.2 / 5
- Analytical Depth: 4.3 / 5

Latency: total 854.7s for 10 questions, average 85.5s/question, min 31.4s, max 158.6s/question.

## Important caveat

The Lotus data directory currently has BM25 / Chroma / table indexes, but no PageIndex structural index:

/root/autodl-tmp/RAG_Agent_data/lotus/20250701/database_lotus/pageindex does not exist.

Therefore this run proves cross-company retrieval and skill-boundary behavior under the current hybrid stack, but it does not yet prove full PageIndex structural-index generalization on Lotus. A stronger next experiment is to build the Lotus PageIndex directory and rerun the same mini10 without changing the questions.

## What this proves

1. The current system is not only a Zeekr answer memorization path. On a fresh company set, with deterministic Zeekr profile/table repairs disabled during generation, it can still answer 10/10 SEC-style questions correctly.
2. The key generic skills transfer: period-aware numeric retrieval, table retrieval, filing-definition handling, business-combination timeline lookup, risk-factor evidence selection, and holding-structure/VIE reasoning.
3. Zeekr-specific profile repair is now company-guarded. Offline spillover check on Lotus mini10 produced 0/10 profile repairs applied, all out_of_scope.
4. The test-set QA process matters. An earlier draft had shell-escaped dollar values and over-broad keypoints; after grounding keypoints strictly to the question text and source facts, the same generated answers judged 10/10 correct.

## What this does not prove

1. It does not prove universal generalization across all SEC filers.
2. It does not prove the full PageIndex index is available for every company, because Lotus currently lacks the PageIndex directory.
3. It does not prove the system is cheap enough for production; latency is still high without a Lotus PageIndex index and with conservative retrieval settings.
4. It does not replace a rotating holdout suite. This should become one slice in a broader cross-company benchmark.

## PPT wording

A concise slide statement can be:

> After freezing Zeekr-specific repairs, we created a new Lotus Technology mini10 cross-company sanity set. The system achieved 10/10 correct with no Zeekr profile-skill spillover, showing that the current improvements are not purely single-company answer patching. The limitation is that Lotus currently lacks a PageIndex structural index, so the next stronger proof is to build the Lotus PageIndex index and rerun the same set unchanged.

## Recommended next step

Freeze this Lotus mini10 as a small cross-company sanity set. Do not keep tuning it. Next, build a rotating cross-company set with 3-5 companies and 10-20 questions each, then only accept new skills if they pass: target-company set, existing holdout, and at least one non-target company slice.
