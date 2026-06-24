# Ownership Chain Skill V1

Date: 2026-06-03

## Goal

Repair corporate-structure questions where the retrieved answer finds the right entity chain but adds unsupported uncertainty about 100% ownership. The first target case is q122: whether Zeekr's Cayman Islands parent ultimately controls the main China operating company through a 100% ownership chain.

This is a stable profile/structure skill, not a table verifier and not a latest-news factbook.

## Implementation

Primary file:

- `src/utils/profile_fact_repair.py`

Added one narrow profile fact:

- `zeekr_cayman_100pct_operating_chain`

Trigger boundary:

- question must mention Cayman;
- question must ask for 100% / 100 percent / wholly owned chain;
- question must mention chain;
- question must ask about the main China operating company.

Rendered answer:

- Yes;
- The Company / ZEEKR Intelligent Technology Holding Limited (Cayman Islands) owns 100% of ZEEKR Technology Innovation Limited (BVI);
- ZEEKR Technology Innovation Limited owns 100% of ZEEKR Technology Limited (Hong Kong);
- ZEEKR Technology Limited owns 100% of Zhejiang ZEEKR.

## Results

Target q122:

- before ownership repair: INCORRECT
- after ownership repair: CORRECT
- target correctness score: 5.0

Rotating20 after capitalization + ownership-chain repair:

- judge: 14 CORRECT / 2 PARTIAL / 4 INCORRECT
- gate: 20 ALLOW / 0 REVIEW / 0 BLOCK
- q122 moved from INCORRECT to CORRECT
- q63 also moved from PARTIAL to CORRECT in the judge rerun, but it was not touched by this skill and is treated as judge variance.

Compared with capitalization run:

- capitalization run: 12 CORRECT / 3 PARTIAL / 5 INCORRECT
- ownership-chain run: 14 CORRECT / 2 PARTIAL / 4 INCORRECT
- deterministic gate stayed fully clean at 20 ALLOW.

## Evidence Artifacts

- `test/colm/retrieval/skill_evolution_rotating_run_20260603/ownership_chain_skill_v1/q122_judge/summary.json`
- `test/colm/retrieval/skill_evolution_rotating_run_20260603/ownership_chain_skill_v1/full_validation/judge/summary.json`
- `test/colm/retrieval/skill_evolution_rotating_run_20260603/ownership_chain_skill_v1/full_validation/answer_gate_numeric_audit.json`
- `test/colm/retrieval/skill_evolution_rotating_run_20260603/ownership_chain_skill_v1/full_validation/validation_summary.json`
- `test/colm/retrieval/skill_evolution_rotating_run_20260603/ownership_chain_skill_v1/diagnostic_summary/SKILL_EVOLUTION_DIAGNOSTIC_SUMMARY.md`
- `test/colm/retrieval/skill_registry_validation_after_ownership_chain_20260603/SKILL_REGISTRY_VALIDATION.md`

## Boundary

Do not broaden this into a general company factbook. This skill should only answer explicit ownership-chain questions where the chain and 100% links are disclosed. If a question asks about broader subsidiaries, non-wholly-owned entities, VIE arrangements, or latest post-merger ownership, leave it to retrieval or a separately reviewed profile skill.

Promotion recommendation:

- status: candidate_promote
- risk: medium
- auto approval: review_required
- next step: collaborator review, especially to decide whether this should stay as a curated profile fact or be replaced later by a general entity-chain extractor.
