# SkillOps Demo Benchmark Manifest

- Run ID: `skillops_demo_benchmark_20260605`
- Suite ID: `skillops_demo_benchmark_20260605`
- Status: `pass`
- Case count: 5
- Expected-type mismatches: 0
- Suite report: `test/colm/retrieval/skillops_demo_benchmark_20260605/skillops_demo_suite_report.md`

## Cases

| Case | Label | QID | Expected | Actual | Proposals | Gate |
| --- | --- | --- | --- | --- | ---: | --- |
| `lotus_q1_success_runner` | Lotus success control | `lotus_gen_01` | `no_failure_detected` | `no_failure_detected` | 0 |  |
| `nvidia_q15_source_conflict_runner` | NVIDIA source conflict | `qa_kp_000015` | `source_conflict` | `source_conflict` | 2 | proposed, proposed |
| `zeekr_table_q100_runner` | Zeekr table alignment | `qa_kp_100` | `table_alignment_error` | `table_alignment_error` | 2 | proposed, proposed |
| `zeekr_profile_q48_runner` | Zeekr profile boundary | `qa_kp_48` | `profile_boundary_error` | `profile_boundary_error` | 1 | proposed |
| `zeekr_coverage_q62_runner` | Zeekr answer coverage | `qa_kp_62` | `answer_coverage_failure` | `answer_coverage_failure` | 1 | proposed |

## Interpretation

This benchmark is a reproducible demo suite for the SkillOps audit/evolution loop. It is not a statistical accuracy benchmark; the cross-company QA benchmark remains the accuracy evidence.
