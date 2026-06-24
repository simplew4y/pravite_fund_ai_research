# Failure Diagnosis Report

- QID: `qa_kp_48`
- Primary failure type: `profile_boundary_error`
- Confidence: 0.69

## Question

极氪是否采用VIE架构？

## Suggested Next Action

Move stable profile assumptions into reviewed company profile metadata with explicit scope.

## Signals

| Type | Severity | Evidence | Rationale |
| --- | --- | --- | --- |
| `profile_boundary_error` | medium | {'skill_id': 'company_profile_boundary', 'triggered': True, 'trigger_reason': 'profile fact repair for vie_structure', 'output_decision': 'repair_applied', 'supporting_source':... | Profile boundary repair trace triggered. |

## Audit Notes

- rule_based_explainer
- signals=1
