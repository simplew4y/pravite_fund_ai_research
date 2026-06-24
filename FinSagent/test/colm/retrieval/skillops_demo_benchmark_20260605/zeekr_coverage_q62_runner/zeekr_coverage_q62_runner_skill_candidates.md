# Skill Candidate Proposals

## answer_coverage_guard

- Candidate ID: `qa_kp_62_answer_coverage_guard`
- Suggested status: `proposed`
- Human review required: True
- Failure types: answer_coverage_failure

### Observed Failures

- answer_coverage_failure (medium): Answer coverage repair trace triggered. Evidence: {'skill_id': 'answer_coverage', 'triggered': True, 'trigger_reason': 'coverage repair for global_sales_network', 'output_decision': 'repair_applied', 'supporting_source': No...
- answer_coverage_failure (medium): Coverage repair was applied, indicating the original answer missed a required key point. Evidence: {'fact_id': 'zeekr_global_sales_network', 'intent': 'global_sales_network', 'answer_zh': '截至2024年12月31日，极氪全球共有538家线下销售和服务网点，...

### Hypothesis

Answers can include the core fact but omit required comparison or boundary key points.

### Proposed Trigger

Judge/key-point diff indicates missing key points while answer contains core entity/metric.

### Proposed Action

Require a coverage checklist before finalization and propose guarded coverage repair only with supporting evidence.

### Risks

- Can become answer-memorization if key points are copied into global rules.

### Required Tests

- Human review confirms added coverage is evidence-backed.
- No regression on concise-answer questions.
