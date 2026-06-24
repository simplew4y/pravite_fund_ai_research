# Holdout20 Cap2 Failure Analysis

Run:

```text
Output:
test/colm/retrieval/holdout20_cap2_20260531/holdout20_coverage_repaired_v1.json

Validation:
test/colm/retrieval/holdout20_cap2_20260531/standard_validation_coverage_v1_judge/validation_summary.json

Latency profile:
test/colm/retrieval/holdout20_cap2_20260531/latency_profile_coverage_v1.json
test/colm/retrieval/holdout20_cap2_20260531/latency_profile_coverage_v1.md
```

Summary:

```text
Rows: 20
Coverage repair applied: 0
Gate: ALLOW 20 / BLOCK 0
Judge: CORRECT 6 / PARTIAL 4 / INCORRECT 10
Correctness score: 2.6

Latency:
- total: 1270.679s
- avg: 63.534s/question
- p50: 63.218s
- p90: 83.930s
- p95: 87.092s
- max: 140.966s
- avg retrieved chunks: 20.6
- avg pre-rerank candidates: 76.0
```

Interpretation:

```text
The cap2 cost setting generalizes from a latency perspective, but the current
answer quality does not generalize to this holdout. This is a useful negative
result: the small30 success should be reported as a validated diagnostic slice,
not as proof of broad full-dataset correctness.
```

Failure groups:

| group | rows | examples | likely fix |
| --- | ---: | --- | --- |
| Stable company-profile facts missing or contradicted | 5 | product matrix, board composition, manufacturing location, Zeekr Power, global availability | narrow company fact registry with source/date |
| Corporate event/date timeline drift | 2 | Geely-Zeekr relationship, IPO ADS count/listing detail | date-aware fact registry and event timeline |
| Period/policy-specific retrieval miss | 1 | 2022 policy support for BEV demand | period-aware retrieval + policy fact anchors |
| Numeric/table verifier gap | 2 | 2024 Q2 cash balance, 2024 volume breakdown discrepancy | add deterministic verifier/fact rows for recurring financial metrics |
| Broad risk/pipeline answers under-cover key points | 2 | major risks, product pipeline | structured risk/product fact tables |

Representative failures:

```text
qa_kp_2 product matrix:
- answer says product matrix is unavailable
- GT expects ZEEKR 001, 001 FR, 009, X, and first sedan details

qa_kp_24 board:
- answer says 8 directors / 4 independents
- GT expects 7 directors / 3 independents

qa_kp_38 manufacturing:
- answer says 001/009 are manufactured at three Geely-owned facilities
- GT expects both at ZEEKR Factory in Ningbo

qa_kp_41 Zeekr Power:
- answer says Zeekr Power is not clearly defined
- GT treats it as in-house electrification/intelligentization capability

qa_kp_84 cash balance:
- answer gives US$1,227.741 million / about US$1.23B
- GT expects US$1.107B
```

Decision:

```text
Stop treating retrieval-parameter tuning as the main bottleneck for this phase.

Next best work:
1. add deterministic verifier coverage for the observed numeric/table misses;
2. design a narrow company fact registry for stable Zeekr profile/event/product
   facts, with source dates and cutoff rules;
3. rerun holdout20 before expanding to a larger holdout.

Do not repair these holdout failures as isolated one-off answer templates unless
the same fact is stable, sourced, and expected to recur across questions.
```
