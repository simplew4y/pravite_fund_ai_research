# Failure Diagnosis Report

- QID: `qa_kp_62`
- Primary failure type: `answer_coverage_failure`
- Confidence: 0.83

## Question

极氪在全球的销售网络？

## Suggested Next Action

Compare answer against key points and consider a guarded coverage skill proposal.

## Signals

| Type | Severity | Evidence | Rationale |
| --- | --- | --- | --- |
| `answer_coverage_failure` | medium | {'skill_id': 'answer_coverage', 'triggered': True, 'trigger_reason': 'coverage repair for global_sales_network', 'output_decision': 'repair_applied', 'supporting_source': None,... | Answer coverage repair trace triggered. |
| `answer_coverage_failure` | medium | {'fact_id': 'zeekr_global_sales_network', 'intent': 'global_sales_network', 'answer_en': 'As of December 31, 2024, Zeekr had 538 offline sales and service outlets globally, incl... | Coverage repair was applied, indicating the original answer missed a required key point. |

## Audit Notes

- rule_based_explainer
- signals=2
