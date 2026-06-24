# Profile Descriptor And Numeric Cleanup Skill V1

Date: 2026-06-03

## Purpose

This skill fixes small but recurring answer-quality failures where the retrieved evidence is broadly correct, but the final answer misses required descriptors or includes unnecessary numeric details that can conflict with the authoritative table.

It covers three narrow cases:

- COVID impact: include production/supply-chain disruption, sales/marketing delays, R&D efficiency impact, mitigation, and remaining uncertainty.
- SEA platform: explicitly describe SEA as open-source, pure electric, and modularized, owned by Geely Holding, and broad enough for multiple vehicle types.
- H1 2023 operating leverage: remove distracting non-H1 SG&A/R&D growth numbers and use the H1 table figures.

## Implementation

Changed files:

- `src/utils/profile_fact_repair.py`
- `src/utils/answer_coverage_repair.py`

Added profile facts:

- `zeekr_covid_business_impact`
- `zeekr_sea_platform_descriptor`

Added coverage cleanup fact:

- `zeekr_h1_2023_operating_leverage`

Trigger boundaries:

- COVID repair only triggers when the question explicitly asks Zeekr/COVID impact.
- SEA repair only triggers direct platform-built-on / platform-developed-on questions.
- Operating leverage cleanup only triggers first-half 2023 operating-leverage questions.

## Validation

Target judge:

- q45 COVID impact: CORRECT
- q56 Chinese SEA platform: CORRECT
- q59 English SEA platform: CORRECT
- q111 H1 2023 operating leverage cleanup: CORRECT

Target4 summary:

- 4 evaluated
- 4 CORRECT
- correctness score: 5.0
- average factual consistency: 5.0

Rotating20 regression, compared with `latest_snapshot_skill_v1` baseline:

| run | CORRECT | PARTIAL | INCORRECT | score |
| --- | ---: | ---: | ---: | ---: |
| latest snapshot baseline | 16 | 2 | 2 | 4.4 |
| descriptor + cleanup v1 | 18 | 0 | 2 | 4.6 |

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

After this skill, rotating20 has two incorrect rows:

- q65: product-roadmap/latest-disclosure question. This needs a separate product-roadmap skill because it involves 2025 hybrid/SUV planning and could easily overfit if handled casually.
- q85: "other sales revenue" metric-definition conflict. Do not hard-fix until the intended definition is clarified.

## Promotion Decision

Recommended status: `candidate_promote`.

Risk: `medium`.

Auto approval: `review_required`.

Reason: the scope is narrow and validation is clean, but it still edits answer content for narrative profile questions and one numeric cleanup case. It should remain manually reviewed before promotion.

## Next Step

The next possible skill is q65 product roadmap / hybrid-plan handling. Treat it as higher risk than q45/q59 because it depends on latest disclosures and product naming. q85 should remain in the clarification bucket.
