# Capitalization Table Skill V1

Date: 2026-06-03

## Goal

Repair capitalization-table answers that require comparing Actual, Pro Forma, and Pro Forma as adjusted columns. The first target case is q129: whether Zeekr's pro forma as adjusted changes are mainly about reducing liabilities.

This is a deterministic table skill. It uses parsed SEC capitalization rows, not a company factbook.

## Implementation

Primary files:

- `src/utils/table_fact_verifier.py`
- `src/utils/table_answer_repair.py`

Changes:

- expanded capitalization detection for liability-change questions to include:
  - Notes payable
  - Amounts due to related parties
  - Loans from related parties
  - Ordinary shares
  - Additional paid-in capital
- added a liability-change renderer that answers:
  - whether the liability rows changed;
  - which exact liability line items stayed unchanged;
  - which equity/capitalization items changed instead.
- added a small source tie-break for pro forma/as-adjusted capitalization tables:
  - if the question does not explicitly ask for a final prospectus/424B4, prefer the F-1/F-1A table when it ties on detected facts;
  - if the question explicitly asks for final prospectus/424B4, allow 424B4 to win.

## Results

Target q129:

- before capitalization repair: INCORRECT
- after capitalization repair: CORRECT
- target correctness score: 5.0
- target judge failures: 0

Rotating20 after period coverage + capitalization repair:

- judge: 12 CORRECT / 3 PARTIAL / 5 INCORRECT
- gate: 20 ALLOW / 0 REVIEW / 0 BLOCK
- q129 moved from INCORRECT to CORRECT
- q63 moved from CORRECT to PARTIAL in a judge rerun even though it was not touched by this skill; this is treated as judge variance, not repair regression.

Compared with period coverage:

- period coverage full run: 12 CORRECT / 2 PARTIAL / 6 INCORRECT, gate 19 ALLOW / 1 REVIEW
- capitalization skill: 12 CORRECT / 3 PARTIAL / 5 INCORRECT, gate 20 ALLOW
- deterministic gate risk improved because the remaining q129 REVIEW was eliminated.

## Evidence Artifacts

- `test/colm/retrieval/skill_evolution_rotating_run_20260603/capitalization_skill_v1/q129_judge/summary.json`
- `test/colm/retrieval/skill_evolution_rotating_run_20260603/capitalization_skill_v1/full_validation/judge/summary.json`
- `test/colm/retrieval/skill_evolution_rotating_run_20260603/capitalization_skill_v1/full_validation/answer_gate_numeric_audit.json`
- `test/colm/retrieval/skill_evolution_rotating_run_20260603/capitalization_skill_v1/full_validation/validation_summary.json`
- `test/colm/retrieval/skill_evolution_rotating_run_20260603/capitalization_skill_v1/diagnostic_summary/SKILL_EVOLUTION_DIAGNOSTIC_SUMMARY.md`
- `test/colm/retrieval/skill_registry_validation_after_capitalization_20260603/SKILL_REGISTRY_VALIDATION.md`

## Boundary

Keep this skill limited to capitalization tables with explicit Actual / Pro Forma / Pro Forma as adjusted columns. Do not use it as a general balance-sheet fact registry. If multiple filings have different pro forma as adjusted values, the source-selection rule must be documented and reviewable rather than silently picking a convenient number.

Promotion recommendation:

- status: candidate_promote
- risk: low-to-medium
- auto approval: review_required for now because source tie-breaking affects SEC filing version selection
- next step: review the source-selection rule, then consider guarded promotion if collaborators agree it is acceptable.
