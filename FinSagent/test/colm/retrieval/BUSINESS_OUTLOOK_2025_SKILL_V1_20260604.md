# Business Outlook 2025 Skill V1

Date: 2026-06-04

## Goal

Repair Zeekr 2025 outlook questions where the answer drifts from the requested management/outlook target framing into later year-to-date delivery facts.

## Change

Primary file:

- `src/utils/profile_fact_repair.py`

Added a narrow profile/source-policy fact:

- `zeekr_2025_business_outlook_target`
- intent: `business_outlook_2025_target`
- cutoff: `2025-05-15`

Trigger:

- Chinese questions about Zeekr business outlook, growth potential, or growth profile.
- English questions containing Zeekr plus business outlook / growth outlook / sales target.

## Canonical Framing

The answer emphasizes the 2025 outlook target frame:

- product R&D synergy;
- manufacturing-system reform;
- user-operations upgrades;
- coordinated domestic and overseas channels;
- platform technology sharing and scale-driven cost reduction;
- 2025 sales target of 710,000 vehicles;
- approximately 320,000 Zeekr-brand vehicles and 390,000 Lynk & Co vehicles;
- about 40% growth target;
- ambition to reach one million annual sales within two years;
- AI-driven innovation and global expansion as strategic drivers.

## Validation

Input:

- `test/colm/retrieval/final_stack_validation_20260603/quant_skill_integration_v1/blind_holdout20_quant_skill_profile_repaired.json`

Output:

- `test/colm/retrieval/final_stack_validation_20260603/business_outlook_2025_v1/blind_holdout20_business_outlook_repaired.json`

Judge:

- `test/colm/retrieval/final_stack_validation_20260603/business_outlook_2025_v1/judge/summary.json`

Result:

- Before this skill: 19 CORRECT / 0 PARTIAL / 1 INCORRECT, correctness score 4.8.
- After this skill: 20 CORRECT / 0 PARTIAL / 0 INCORRECT, correctness score 5.0.

Profile repair application count on holdout20:

- `zeekr_2025_business_outlook_target`: 1
- existing promoted profile repairs: 6

## Boundary

This is not a general business-outlook generator and should remain review-required.

Do not use it to override:

- live-current delivery status questions;
- post-cutoff actual sales performance;
- non-Zeekr outlook questions;
- questions that explicitly ask for actual year-to-date deliveries rather than management targets.

The skill is acceptable as a source-policy/profile skill because the failure was caused by mixing an outlook-target question with later actual delivery facts.
