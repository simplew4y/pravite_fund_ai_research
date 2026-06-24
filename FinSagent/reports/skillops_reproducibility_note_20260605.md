# SkillOps Reproducibility Note

## Clean Rerun Command

From a clean clone, run:

```bash
PYTHONPATH=src python -m skillops.demo_benchmark_runner \
  --case_manifest configs/skillops_demo_cases.json \
  --out_dir test/colm/retrieval/skillops_demo_benchmark_rerun
```

Expected result:

- Case count: 6
- Expected-type mismatches: 0
- Status: `pass`

## Evaluation Roles

The project keeps two evaluation roles separate:

| Role | Suite | Purpose | Current Result |
| --- | --- | --- | --- |
| Accuracy benchmark | `cross_company_benchmark_v1_1` | Measures QA answer correctness across companies | 40 / 40 correct across Zeekr, Lotus Technology, and NVIDIA |
| SkillOps demo suite | `skillops_demo_benchmark_20260605` | Demonstrates evidence preview, failure diagnosis, skill proposal, and staging gate behavior | 6 / 6 expected taxonomy labels reproduced |

The 6-case SkillOps suite is not a statistical accuracy benchmark. It is a reproducible taxonomy and workflow demo.

## Demo Case Evidence Table

| Case | Failure Type | Grep Signal | Skill Trace | Proposal | Gate |
| --- | --- | --- | --- | --- | --- |
| Lotus success control | `no_failure_detected` | Stable lexical anchors in demo input | none | none | none |
| NVIDIA export-control source conflict | `source_conflict` | Export-control / Data Center / fiscal-year anchors | `period_source_conflict_repair_applied` | source arbitration skill proposal | proposed |
| NVIDIA period mismatch | `period_mismatch` | FY2025 question with FY2026 / H20 / April 2025 leakage markers | none | period-aware arbitration skill proposal | proposed |
| Zeekr Q1 2024 gross margin | `table_alignment_error` | Gross-margin / Q1 / table-alignment anchors | `table_repair_applied` | table verifier skill proposal | proposed |
| Zeekr VIE profile boundary | `profile_boundary_error` | VIE / holding-company structure anchors | `profile_repair_applied` | profile boundary skill proposal | proposed |
| Zeekr global sales network | `answer_coverage_failure` | sales-network / outlet-count anchors | `coverage_repair_applied` | coverage repair skill proposal | proposed |

## Gate Wording

The current gate is best described as a staging or promotion gate, not a fully autonomous regression rerunner.

It consumes protected-set summaries and manual-review flags, then blocks automatic approval unless regression evidence and human review are present. In the current demo, candidate skills are marked `proposed`, not automatically promoted.

## Artifact Hygiene

The demo manifest points only to stable demo inputs under:

`test/colm/retrieval/skillops_demo_inputs/`

Runtime environment files should not be tracked. Use:

`deploy/tool_filter/.env.example`

as the template and keep `deploy/tool_filter/.env` local.
