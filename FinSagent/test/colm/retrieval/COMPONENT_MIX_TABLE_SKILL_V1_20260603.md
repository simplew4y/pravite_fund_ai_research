# Component Mix Table Skill V1

Generated: 2026-06-03

## Scope

Add deterministic table verification and repair for annual component-mix tables:

- cost of revenues mix across years
- research and development expense mix across years

This skill is limited to parsed SEC tables with annual year columns, RMB values,
and percentage columns. It does not use a company factbook and does not encode
benchmark answer text.

## Implementation

Primary files:

- `src/utils/table_fact_verifier.py`
- `src/utils/table_answer_repair.py`

New fact types:

- `cost_revenue_mix`
- `rd_expense_mix`

Important guardrails:

- interim tables with `three/six/nine months ended` are excluded for annual
  component-mix questions;
- when multiple structurally equivalent tables exist, newer filing source dates
  are preferred;
- the repair renderer only uses parsed table rows and emits all required
  component values and percentages.

## Target Fixes

The rotating diagnostic run exposed two structurally table-based failures:

- `qa_kp_134`: cost-of-revenues mix incorrectly claimed full-year 2023 vehicle
  sales cost was unavailable.
- `qa_kp_135`: R&D expense mix hallucinated employee-compensation amounts and
  concluded the shift was not definitive.

After this skill:

- q134 gate: ALLOW / PASS
- q135 gate: ALLOW / PASS
- targeted judge q134/q135: 2 CORRECT / 0 PARTIAL / 0 INCORRECT

## Rotating20 Result

Before this skill:

- judge: 6 CORRECT / 7 PARTIAL / 7 INCORRECT
- gate: 18 ALLOW / 2 REVIEW / 0 BLOCK

After this skill:

- judge: 8 CORRECT / 7 PARTIAL / 5 INCORRECT
- gate: 19 ALLOW / 1 REVIEW / 0 BLOCK
- repaired rows: 2

The remaining gate REVIEW is `qa_kp_129`, a capitalization-liability detail
coverage issue that should be handled separately.

## Regression

Protected and cross-company lightweight gates remain PASS after the change:

- artifact paths: 45 ok / 0 missing
- development diagnostic gate: PASS
- protected small30 gate: PASS
- NVIDIA mini10 gate: PASS

## Boundary

Promote only as a guarded deterministic table skill. Do not broaden this into a
company fact registry. Add future component-mix table types only when the rows
are structurally detectable across filings and can pass protected/cross-company
gates.

## Artifacts

- `test/colm/retrieval/skill_evolution_rotating_run_20260603/component_mix_skill_v1e/target_judge/summary.json`
- `test/colm/retrieval/skill_evolution_rotating_run_20260603/component_mix_skill_v1e/full_validation/judge/summary.json`
- `test/colm/retrieval/skill_evolution_rotating_run_20260603/component_mix_skill_v1e/full_validation/answer_gate_numeric_audit.json`
- `test/colm/retrieval/skill_registry_validation_after_component_mix_20260603/SKILL_REGISTRY_VALIDATION.md`
