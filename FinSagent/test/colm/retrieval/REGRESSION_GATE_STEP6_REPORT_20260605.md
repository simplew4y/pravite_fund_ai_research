# Regression Gate Step 6 Report - 2026-06-05

## Purpose

This step closes the minimal SkillOps loop with a conservative regression gate. The gate consumes skill candidate proposals and evaluation summaries, then emits reviewable decisions.

The gate does not implement or promote skills automatically. A candidate can only move beyond `proposed` when protected-set checks and human review are complete.

## Implementation

New file:

- `src/skillops/gate_runner.py`

Main CLI:

```bash
PYTHONPATH=src python -m skillops.gate_runner \
  --proposals_yaml <skill_candidates.yaml> \
  --eval_summary <eval_summary.json> \
  --out_yaml <gate_decisions.yaml> \
  --out_md <gate_decisions.md>
```

Decision states:

- `proposed`
- `rejected`
- `approved_for_implementation`
- `promoted`

## Case Study 1: NVIDIA Candidate Gate

Inputs:

- Proposals: `test/colm/retrieval/skill_candidate_step5_20260605/nvidia_q15_skill_candidates.yaml`
- Eval summary: `test/colm/retrieval/skill_candidate_step6_20260605/nvidia_q15_gate_eval_summary.json`

Outputs:

- `test/colm/retrieval/skill_candidate_step6_20260605/nvidia_q15_gate_decisions.yaml`
- `test/colm/retrieval/skill_candidate_step6_20260605/nvidia_q15_gate_decisions.md`

Result:

- `general_period_source_arbitration`: `proposed`
- `cross_company_source_guard`: `proposed`

Reason:

- Protected sets passed
- Regression count is 0
- Human review has not yet been completed

This is the intended conservative behavior. The system can propose useful candidates but cannot silently promote them.

## Case Study 2: Lotus Success Control

Inputs:

- Proposals: `test/colm/retrieval/skill_candidate_step5_20260605/lotus_q1_success_skill_candidates.yaml`
- Eval summary: `test/colm/retrieval/skill_candidate_step6_20260605/lotus_q1_success_gate_eval_summary.json`

Outputs:

- `test/colm/retrieval/skill_candidate_step6_20260605/lotus_q1_success_gate_decisions.yaml`
- `test/colm/retrieval/skill_candidate_step6_20260605/lotus_q1_success_gate_decisions.md`

Result:

- Decisions: 0

Interpretation:

No proposal enters the gate for a success/control case.

## Minimal SkillOps Loop Status

The vertical slice is now complete:

Question -> Retrieval -> Grep Probe -> Evidence Preview -> Failure Diagnosis -> Skill Candidate Proposal -> Regression Gate

This is sufficient for an EMNLP Industry-style system demo. The next engineering step is to connect these components into a single runner/report command so the entire loop can be executed from one entry point.

