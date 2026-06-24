# Failure Diagnosis Report

- QID: `qa_kp_100`
- Primary failure type: `table_alignment_error`
- Confidence: 0.77

## Question

极氪2024年一季度毛利率

## Suggested Next Action

Run deterministic table verifier and inspect row/column/unit alignment.

## Signals

| Type | Severity | Evidence | Rationale |
| --- | --- | --- | --- |
| `table_alignment_error` | medium | {'skill_id': 'table_evidence_verifier', 'triggered': True, 'trigger_reason': 'deterministic source-precedence gross-margin repair for 2024 Q1', 'output_decision': 'repair_applie... | Table verifier or repair trace triggered. |
| `metric_alias_error` | low | metric_aliases={} | Question appears metric-bearing but grep probe did not identify a metric alias family. |

## Audit Notes

- rule_based_explainer
- signals=2
