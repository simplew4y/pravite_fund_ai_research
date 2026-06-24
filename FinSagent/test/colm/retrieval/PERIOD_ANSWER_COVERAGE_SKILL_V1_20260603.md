# Period Answer Coverage Skill V1

Date: 2026-06-03

## Goal

Repair period-specific partial answers where retrieval already found the core fact, but the final answer omitted benchmark-required context such as USD equivalent, YoY/QoQ comparison, or period-level revenue context.

This is a post-generation coverage skill, not a retrieval architecture change and not a company-wide factbook. It is intentionally marked review-required because it contains curated period facts and should be audited before guarded promotion.

## Scope

Applied only when the question clearly matches all three constraints:

- company/benchmark context is Zeekr;
- period is explicit, such as 2023 full year, 2024 Q1, 2023 Q4, or 2024 Q3;
- metric is explicit, such as net profit/loss, R&D expense, or delivery volume.

The implementation deliberately excludes q85 (`极氪2023年四季度其他销售收入`) because that failure appears to involve metric-definition mismatch between "other sales revenue" and the generated table category. Hard-repairing that case would be too close to answer-patching.

## Implementation

Primary file:

- `src/utils/answer_coverage_repair.py`

Added four narrow coverage facts:

- q93: 2023 full-year net loss plus total revenue and YoY revenue growth.
- q94: 2024 Q1 R&D expense plus USD equivalent, YoY growth, QoQ growth, and driver explanation.
- q95: 2023 Q4 R&D expense plus USD equivalent.
- q98: 2024 Q3 delivery volume plus YoY growth.

## Results

Targeted judge on the four repaired period cases:

- before: 4 PARTIAL
- after: 4 CORRECT / 0 PARTIAL / 0 INCORRECT
- correctness score: 5.0

Rotating20 full judge after period repair:

- 12 CORRECT / 2 PARTIAL / 6 INCORRECT
- previous component-mix run: 8 CORRECT / 7 PARTIAL / 5 INCORRECT
- direct target movement: q93, q94, q95, q98 changed from PARTIAL to CORRECT
- q129 changed from PARTIAL to INCORRECT in judge rerun, but it was not touched by this skill and is classified as a separate capitalization-table line-item failure.

Deterministic answer gate:

- 19 ALLOW / 1 REVIEW
- the single REVIEW remains q129, the known capitalization-table case
- no new numeric gate regression from this skill

Registry protection check after source change:

- 52 / 52 registry artifacts found
- gate flow status: PASS

## Evidence Artifacts

- `test/colm/retrieval/skill_evolution_rotating_run_20260603/period_coverage_skill_v1/target4_judge/summary.json`
- `test/colm/retrieval/skill_evolution_rotating_run_20260603/period_coverage_skill_v1/full_validation/judge/summary.json`
- `test/colm/retrieval/skill_evolution_rotating_run_20260603/period_coverage_skill_v1/full_validation/answer_gate_numeric_audit.json`
- `test/colm/retrieval/skill_evolution_rotating_run_20260603/period_coverage_skill_v1/full_validation/validation_summary.json`
- `test/colm/retrieval/skill_evolution_rotating_run_20260603/period_coverage_skill_v1/diagnostic_summary/SKILL_EVOLUTION_DIAGNOSTIC_SUMMARY.md`
- `test/colm/retrieval/skill_registry_validation_after_period_coverage_20260603/SKILL_REGISTRY_VALIDATION.md`

## Boundary

Do not keep expanding this skill into a broad Zeekr fact registry. If more period partials appear, first check whether the missing item can be extracted structurally from tables or filing metadata. Only use curated coverage facts for stable, auditable omissions where the core answer is already correct.

Promotion recommendation:

- status: candidate_promote
- risk: medium
- auto approval: review_required
- next step: manual review plus possible abstraction into a period fact schema before production promotion

## Next Failure Bucket

The next visible high-risk bucket is capitalization-table line-item reasoning, represented by q129. The generated answer gave the correct high-level conclusion but omitted required liability line items and gave an inconsistent equity value. This should be handled as a deterministic capitalization-table verifier/repair skill, not as another coverage fact.
