# Failure Explainer Step 4 Report - 2026-06-05

## Purpose

This step adds a first rule-based Failure Explainer on top of the unified Evidence Preview. The goal is not to make an LLM judge smarter yet. The goal is to produce stable, auditable failure reports that can support SkillOps evolution.

The explainer consumes:

- run row fields
- evidence preview JSON
- retrieval preview
- grep probe anchors
- skill trace fields
- optional key points when present

It outputs:

- `primary_failure_type`
- confidence
- structured failure signals
- suggested next action
- Markdown report for human review

## Implementation

New files:

- `configs/failure_taxonomy.yaml`
- `src/diagnosis/failure_taxonomy.py`
- `src/diagnosis/failure_explainer.py`

Supported failure types:

- `retrieval_miss`
- `wrong_source`
- `period_mismatch`
- `table_alignment_error`
- `metric_alias_error`
- `answer_coverage_failure`
- `source_conflict`
- `profile_boundary_error`

## Case Study 1: Success Control

Case:

- Company: Lotus Technology
- QID: `lotus_gen_01`
- Preview: `test/colm/retrieval/evidence_preview_step3_20260605/lotus_q1_success_preview.json`

Output:

- `test/colm/retrieval/failure_explainer_step4_20260605/lotus_q1_success_failure_report.json`
- `test/colm/retrieval/failure_explainer_step4_20260605/lotus_q1_success_failure_report.md`

Result:

- Primary failure type: `no_failure_detected`
- Confidence: 0.65
- Signals: 0

Interpretation:

The explainer acts as a control case: when retrieval evidence, grep anchors, and answer are aligned, it does not invent a failure.

## Case Study 2: Diagnosed Source Conflict

Case:

- Company: NVIDIA
- QID: `qa_kp_000015`
- Preview: `test/colm/retrieval/evidence_preview_step3_20260605/nvidia_q15_source_conflict_preview.json`

Output:

- `test/colm/retrieval/failure_explainer_step4_20260605/nvidia_q15_source_conflict_failure_report.json`
- `test/colm/retrieval/failure_explainer_step4_20260605/nvidia_q15_source_conflict_failure_report.md`

Result:

- Primary failure type: `source_conflict`
- Confidence: 0.95
- Signals: 6

Key signals:

- `source_conflict`: source conflict skill trace triggered
- `period_mismatch`: original answer contained later H20 / FY2026 / April 2025 leakage markers
- `wrong_source`: top retrieval preview contained later 10-Q sources for a FY2025-framed question
- `wrong_source`: retrieval preview also exposed cross-company table leakage from Lotus fallback tables

Suggested next action:

Keep or generalize period-aware source arbitration; verify that period-compatible evidence is present before repair.

## Paper Relevance

This completes the next vertical-slice link:

Evidence Preview -> Failure Diagnosis

The key paper claim is now more concrete: failures are not just judged as wrong; they are mapped to stable operational categories that can drive skill proposals and regression gates.

Next step: Skill Candidate Proposal. The NVIDIA report should generate a proposal such as `cross_company_source_guard` or `general_period_source_arbitration`, with observed failure, hypothesis, trigger, action, risk, required tests, and proposed status.

