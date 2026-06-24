# Skill Candidate Proposals

## table_alignment_guard

- Candidate ID: `qa_kp_100_table_alignment_guard`
- Suggested status: `proposed`
- Human review required: True
- Failure types: table_alignment_error

### Observed Failures

- table_alignment_error (medium): Table verifier or repair trace triggered. Evidence: {'skill_id': 'table_evidence_verifier', 'triggered': True, 'trigger_reason': 'deterministic source-precedence gross-margin repair for 2024 Q1', 'output_decision': 'repair_ap...

### Hypothesis

Numeric failures often come from using the wrong table row, column, unit, or subtotal.

### Proposed Trigger

Numeric SEC question with table evidence and verifier conflict or unsupported answer number.

### Proposed Action

Run deterministic row/column/unit verification before final answer acceptance.

### Risks

- May leave complex derived calculations unresolved.
- Requires robust table extraction quality.

### Required Tests

- No regression on protected numeric set.
- Manual review of verifier traces for at least 10 table questions.

## metric_alias_profile

- Candidate ID: `qa_kp_100_metric_alias_profile`
- Suggested status: `proposed`
- Human review required: True
- Failure types: metric_alias_error

### Observed Failures

- metric_alias_error (low): Question appears metric-bearing but grep probe did not identify a metric alias family. Evidence: metric_aliases={}

### Hypothesis

Company filings use metric aliases that are not captured by generic question terms.

### Proposed Trigger

Metric-bearing question with missing or weak metric alias anchors.

### Proposed Action

Generate or update company profile metric aliases from filing headings and table labels.

### Risks

- Could over-expand aliases and retrieve semantically nearby but wrong metrics.

### Required Tests

- Alias additions improve retrieval on diagnostic examples without reducing precision on holdout metrics.
