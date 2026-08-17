# RSI Production Evaluator v2.2 Audit

`period_source_full_agent_v2_2` is frozen outside the target repository from
local authorized FinSkillOps records. It contains 70 independent questions:

| Slice | Count |
| --- | ---: |
| Targeted period/source | 20 |
| Negative/no-op | 20 |
| Fresh internal | 30 |

Company coverage is Lotus 20, NVIDIA 20, and Zeekr 30. Every row has a ground
truth answer, atomic key points, retrieved evidence, pre-rerank evidence, source
record provenance, and content hashes. Normalized question overlap across the
three slices is zero.

The first generated snapshot (`v2`) was rejected because a raw year regex
mistook filing dates in filenames for temporal reasoning. `v2.1` corrected the
semantic-period rule but retained eight records with missing company metadata.
`v2.2` infers company only when Zeekr/极氪, Lotus/路特斯, or NVIDIA/英伟达 is
explicitly present in the question; otherwise the row remains unknown and cannot
silently enter a company-scoped gate.

The target runtime receives only `case_id` and `question`. Ground truth, key
points, evidence references, expected trigger behavior, and critical-error rules
remain evaluator-side. Only aggregate counts and SHA-256 snapshots are committed.

This suite is suitable for full-agent development A/B. The existing frozen
40-case protected suite remains a separate regression gate and is not relabeled
as fresh evidence.
