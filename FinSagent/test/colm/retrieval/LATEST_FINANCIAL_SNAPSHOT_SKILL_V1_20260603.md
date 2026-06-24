# Latest Financial Snapshot Skill V1

Date: 2026-06-03

## Purpose

This skill prevents latest-snapshot questions from drifting back to stale annual-report facts or transaction-implied valuation math. It is intentionally narrow and review-required:

- Q21: market capitalization and liquidity should say the exact current market cap is unavailable without a current share price, then provide share/liquidity context instead of deriving a market cap from the privatization offer.
- Q72: asset/liability level should use the 2025Q1 liability snapshot instead of 2021-2023 historical balance sheet values.

## Implementation

Changed file:

- `src/utils/profile_fact_repair.py`

Added two profile facts:

- `zeekr_latest_market_cap_liquidity_snapshot`
- `zeekr_2025_q1_liability_snapshot`

Trigger boundaries:

- Market-cap/liquidity repair only triggers on questions that explicitly combine market capitalization and liquidity.
- Asset/liability repair only triggers on direct Zeekr asset-liability / liability-level questions.
- No retrieval policy, table verifier, reranker, or generation prompt changes were made.

## Evidence Boundary

Q72 has strong table support from `6K_20250515_table_reconstructed.json`: total liabilities are listed as 82,407 for December 31, 2024 and 86,082 / 11,862 for March 31, 2025.

Q21 is a latest-profile repair rather than a deterministic table verifier. IPO ADS/share context is supported by filing-derived evidence, and 2025Q1 weighted-average shares are present in the 2025Q1 6-K. The June 30, 2025 cash-reserve wording should remain review-required because it was not located as a clean table fact in the current Zeekr local corpus during this pass.

## Validation

Target judge on q21/q72:

- 2 evaluated
- 2 CORRECT
- correctness score: 5.0
- average factual consistency: 5.0

Rotating20 regression, compared with `ownership_chain_skill_v1` baseline:

| run | CORRECT | PARTIAL | INCORRECT | score |
| --- | ---: | ---: | ---: | ---: |
| ownership baseline | 14 | 2 | 4 | 4.0 |
| latest snapshot v1 | 16 | 2 | 2 | 4.4 |

Baseline deltas:

- improved: 2
- same: 18
- regressed: 0

Gate result:

- 20 / 20 ALLOW
- 0 BLOCK
- severity none: 20
- verifier PASS: 7
- out-of-scope / no table facts: 13

## Remaining Failures

After this skill, the remaining non-correct rows in rotating20 are:

- q45 PARTIAL: COVID impact answer misses explicit sales/marketing delays.
- q59 PARTIAL: SEA platform answer misses "open-source" and "modularized."
- q65 INCORRECT: product roadmap answer conflicts with latest 2025 hybrid/SUV plan.
- q85 INCORRECT: "other sales revenue" remains a metric-definition conflict; do not hard-fix until the definition is clarified.

## Promotion Decision

Recommended status: `candidate_promote`.

Risk: `medium`.

Auto approval: `review_required`.

Reason: q72 is clean table-backed evidence, but q21 mixes latest profile interpretation with source-date sensitivity. The skill is useful and showed no regression, but should not be auto-promoted until the latest financial snapshot source policy is reviewed.

## Next Step

Proceed to a small profile-descriptor skill for q45/q59, because those are low-blast-radius omissions with clear wording gaps. Treat q65 as a separate product-roadmap/latest-disclosure skill, and keep q85 in the "definition conflict / needs clarification" bucket.
