# Regression Gate Report

## Summary

- Decisions: {'proposed': 2}

| Candidate | Decision | Rationale | Regression Count | Protected Sets Passed | Followups |
| --- | --- | --- | ---: | --- | --- |
| `qa_kp_000015_general_period_source_arbitration` | `proposed` | Candidate remains proposed until protected-set and manual-review gates pass. | 0 | True | Complete protected-set evaluation and manual review. |
| `qa_kp_000015_cross_company_source_guard` | `proposed` | Candidate remains proposed until protected-set and manual-review gates pass. | 0 | True | Complete protected-set evaluation and manual review. |

## Candidate Details

### qa_kp_000015_general_period_source_arbitration

- Reviewer: myz
- Decision: `proposed`
- Rationale: Candidate remains proposed until protected-set and manual-review gates pass.
- Required followups: Complete protected-set evaluation and manual review.
- Eval summary:

```json
{
  "eval_summary_id": "nvidia_q15_skill_candidate_gate_eval_20260605",
  "protected_sets_passed": true,
  "regression_count": 0,
  "protected_sets": [
    {
      "name": "cross_company_benchmark_v1_1_20260605",
      "result": "40/40",
      "weighted_correctness_score": 5.0
    },
    {
      "name": "nvidia_mini10_period_source_conflict_20260605",
      "result": "10/10",
      "correctness_score": 5.0
    }
  ],
  "manual_review_status": "not_yet_reviewed",
  "notes": "This summary is used for proposal gating only. Candidate skills remain proposed until human review and implementation-specific regression tests are completed.",
  "diagnosis_support": "source_conflict + period_mismatch signals from NVIDIA q15"
}
```

### qa_kp_000015_cross_company_source_guard

- Reviewer: myz
- Decision: `proposed`
- Rationale: Candidate remains proposed until protected-set and manual-review gates pass.
- Required followups: Complete protected-set evaluation and manual review.
- Eval summary:

```json
{
  "eval_summary_id": "nvidia_q15_skill_candidate_gate_eval_20260605",
  "protected_sets_passed": true,
  "regression_count": 0,
  "protected_sets": [
    {
      "name": "cross_company_benchmark_v1_1_20260605",
      "result": "40/40",
      "weighted_correctness_score": 5.0
    },
    {
      "name": "nvidia_mini10_period_source_conflict_20260605",
      "result": "10/10",
      "correctness_score": 5.0
    }
  ],
  "manual_review_status": "not_yet_reviewed",
  "notes": "This summary is used for proposal gating only. Candidate skills remain proposed until human review and implementation-specific regression tests are completed.",
  "diagnosis_support": "wrong_source signal from Lotus fallback table leakage in NVIDIA preview"
}
```
