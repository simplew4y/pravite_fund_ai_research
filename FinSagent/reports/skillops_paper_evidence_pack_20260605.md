# SkillOps Paper Evidence Pack

## 1. System Overview

FinSagent has been upgraded from a static SEC RAG pipeline into a human-governed SkillOps prototype:

`Question -> Retrieval -> Grep Evidence Probe -> Evidence Preview -> Failure Diagnosis -> Skill Candidate Proposal -> Staging/Promotion Gate`

The contribution is not full autonomy. The contribution is a controlled path from observed SEC QA failures to auditable evidence, typed diagnosis, reviewable skill candidates, and gated promotion.

## 2. Accuracy Benchmark Table

This table is the headline answer-correctness evidence.

| Suite | Company | Cases | Correct | Partial | Incorrect | Use |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| `core_protected_v1_40` | Zeekr | 20 | 20 | 0 | 0 | target-company protected set |
| `core_protected_v1_40` | Lotus Technology | 10 | 10 | 0 | 0 | cross-company guard |
| `core_protected_v1_40` | NVIDIA | 10 | 10 | 0 | 0 | cross-company guard |
| `core_protected_v1_40` | Total | 40 | 40 | 0 | 0 | paper accuracy table / promotion gate |

Reference:

- `configs/eval_suites/core_protected_v1.yaml`
- `test/colm/retrieval/cross_company_benchmark_v1_1_20260605/cross_company_benchmark_v1_1_summary.json`

## 3. SkillOps Demo Case Table

This table is the workflow/taxonomy evidence. It is not a statistical accuracy benchmark.

| Case | Failure Type | Grep Signal | Skill Trace | Proposal | Gate |
| --- | --- | --- | --- | --- | --- |
| Lotus success control | `no_failure_detected` | revenue / nine-month period anchors | none | none | none |
| NVIDIA source conflict | `source_conflict` | export-control / Data Center / fiscal-year anchors | `period_source_conflict_repair_applied` | period/source arbitration | proposed |
| NVIDIA period mismatch | `period_mismatch` | FY2025 question with FY2026 / H20 / April 2025 leakage markers | none | period-aware arbitration | proposed |
| Zeekr Q1 gross margin | `table_alignment_error` | gross-margin / Q1 / table-alignment anchors | `table_repair_applied` | table alignment guard | proposed |
| Zeekr VIE profile boundary | `profile_boundary_error` | VIE / holding-company structure anchors | `profile_repair_applied` | profile boundary guard | proposed |
| Zeekr global sales network | `answer_coverage_failure` | sales-network / outlet-count anchors | `coverage_repair_applied` | answer coverage guard | proposed |

Clean rerun:

```bash
PYTHONPATH=src python -m skillops.demo_benchmark_runner \
  --case_manifest configs/skillops_demo_cases.json \
  --out_dir test/colm/retrieval/skillops_demo_benchmark_rerun
```

Expected result: `6 cases / 0 mismatch / status=pass`.

## 4. Evaluation Suite Design

| Suite | Type | Frozen | Purpose | Used For |
| --- | --- | --- | --- | --- |
| `core_protected_v1_40` | fixed protected | true | regression and comparability | promotion gate, paper accuracy table |
| `skillops_demo_v1_6` | reproducible demo | true | demonstrate diagnosis/proposal/gate workflow | paper case table, clean rerun |
| `failure_bank_v1_seed` | evolving failure bank | false | preserve confirmed failures | failure regression, skill evidence |
| `period_alignment_short_v1` | targeted short | false | test period leakage and over-triggering | targeted short gate |
| `cross_company_guard_v1` | guardrail | false | prevent single-company overfitting | promotion gate, generalization check |

Suite definitions live under `configs/eval_suites/`.

## 5. Failure Taxonomy

Current structured labels:

- `retrieval_miss`
- `wrong_source`
- `period_mismatch`
- `table_alignment_error`
- `metric_alias_error`
- `answer_coverage_failure`
- `source_conflict`
- `profile_boundary_error`

The demo suite currently covers one success control and five actionable failure categories. Remaining primary-case coverage gaps are `retrieval_miss`, `wrong_source`, and `metric_alias_error`.

## 6. Skill Registry Summary

Governed skill cards live under `configs/skill_cards/`.

Current card families:

- period and source alignment
- table evidence verification
- answer coverage repair
- company profile boundary control
- exact/grep evidence probing
- evidence rescue scoring
- quantitative hinting

Skill cards make scope, risks, triggers, outputs, and eval expectations auditable.

## 7. Grep Evidence Probe Examples

The grep probe is a lexical evidence side-channel, not a replacement for RAG.

Examples:

- Period leakage: FY2025 question paired with FY2026 / H20 / April 2025 markers.
- Table alignment: gross-margin and Q1 anchors around numeric evidence.
- Coverage: global sales network and outlet-count anchors.
- Source conflict: export-control and Data Center anchors with period/source trace.

The probe helps answer: did the right exact evidence exist, did retrieval miss it, and did later-period evidence contaminate the answer?

## 8. Gate Decision Examples

The current gate is a staging/promotion gate. It consumes summaries rather than automatically rerunning every protected set itself.

Gate report dimensions:

| Dimension | Meaning |
| --- | --- |
| `targeted_short` | targeted skill-specific short set status |
| `core_protected` | fixed 40-case protected status |
| `cross_company_guard` | cross-company overfitting guard status |
| `failure_bank` | known failure recurrence status |
| `manual_review` | human review status |

Current demo candidates remain `proposed` because manual review and protected-set promotion evidence are not marked complete inside the demo runner.

## 9. Limitations

- Demo rows are stable and reproducible, but some are audit-trace demos rather than full raw end-to-end QA runs.
- The staging gate currently consumes eval summaries; it is not yet a full orchestration layer that reruns every benchmark.
- Failure explainer precision/recall has not yet been measured on a labeled failure set.
- The failure bank is seeded, not yet populated from a long-running production loop.
- Public artifact hygiene still requires normal external-release review for secrets, paths, and large generated outputs.

## Paper Starting Point

Working title:

`From Static RAG to SkillOps: Human-Governed Skill Evolution for Reliable SEC Filing QA`

Alternative title:

`SkillOps for Reliable Financial Document QA with Grep-Style Evidence Probing`
