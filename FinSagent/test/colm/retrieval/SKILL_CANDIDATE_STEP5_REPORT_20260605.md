# Skill Candidate Proposal Step 5 Report - 2026-06-05

## Purpose

This step adds the proposal-only part of SkillOps evolution. The system does not generate or promote production Python code. It converts a structured FailureReport into human-reviewed skill candidate proposals.

This is the key governance boundary:

FailureReport -> SkillCandidateProposal -> human review -> regression gate -> implementation decision

## Implementation

New file:

- `src/diagnosis/skill_candidate_generator.py`

Main CLI:

```bash
PYTHONPATH=src python -m diagnosis.skill_candidate_generator \
  --failure_report_json <failure_report.json> \
  --out_yaml <skill_candidates.yaml> \
  --out_md <skill_candidates.md>
```

Each proposal contains:

- candidate skill name
- observed failures
- failure types
- hypothesis
- proposed trigger
- proposed action
- risks
- required tests
- suggested status
- human review requirement

## Case Study 1: NVIDIA Failure -> Two Candidate Skills

Input:

- `test/colm/retrieval/failure_explainer_step4_20260605/nvidia_q15_source_conflict_failure_report.json`

Outputs:

- `test/colm/retrieval/skill_candidate_step5_20260605/nvidia_q15_skill_candidates.yaml`
- `test/colm/retrieval/skill_candidate_step5_20260605/nvidia_q15_skill_candidates.md`

Generated proposals:

1. `general_period_source_arbitration`
   - Failure types: `source_conflict`, `period_mismatch`, `wrong_source`
   - Hypothesis: period-specific SEC questions fail when later filings or later event disclosures dominate period-compatible evidence.
   - Action: gate evidence by period compatibility, require period-compatible supporting spans, preserve later evidence as later-period context.

2. `cross_company_source_guard`
   - Failure type: `wrong_source`
   - Hypothesis: fallback/table retrieval can leak evidence from another company corpus.
   - Action: flag or filter chunks whose source company conflicts with the question company unless the question is explicitly cross-company.

Both are marked `proposed` and require human review.

## Case Study 2: Success Control -> No Proposal

Input:

- `test/colm/retrieval/failure_explainer_step4_20260605/lotus_q1_success_failure_report.json`

Outputs:

- `test/colm/retrieval/skill_candidate_step5_20260605/lotus_q1_success_skill_candidates.yaml`
- `test/colm/retrieval/skill_candidate_step5_20260605/lotus_q1_success_skill_candidates.md`

Result:

- Proposals generated: 0

Interpretation:

The proposal generator does not create skills for success/control cases. This is important for overfitting control.

## Paper Relevance

This completes the research loop up to candidate generation:

Question -> Retrieval -> Grep Probe -> Evidence Preview -> Failure Diagnosis -> Skill Candidate Proposal

The system can now explain a failure and produce a bounded, reviewable proposal instead of silently accumulating ad hoc patches. This is the core "human-governed SkillOps" contribution.

Next step: Regression Gate. It should consume candidate proposals and evaluation summaries, then mark a candidate as `proposed`, `rejected`, `approved_for_implementation`, or `promoted`.

