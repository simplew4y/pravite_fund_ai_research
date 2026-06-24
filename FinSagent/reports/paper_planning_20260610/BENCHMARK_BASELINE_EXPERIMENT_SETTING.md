# Benchmark, Baseline, and Experiment Setting Plan

Date: 2026-06-10

## Principle

Separate three things clearly:

1. **Accuracy benchmark**: measures answer correctness.
2. **SkillOps demo suite**: demonstrates diagnosis, proposal, and gate workflow.
3. **Promotion-safety baselines**: evaluates whether automatic skill promotion over-triggers.

Do not mix them in one table.

## Benchmark Summary

### B1. Core Protected Cross-Company Set

Use as headline correctness evidence.

| Slice | Company | Cases | Role | Latest Result |
|---|---|---:|---|---|
| Zeekr holdout20 | Zeekr | 20 | target-company protected | 20/20 correct |
| Lotus mini10 | Lotus Technology | 10 | non-target sanity / cross-company guard | 10/10 correct |
| NVIDIA mini10 | NVIDIA | 10 | non-target sanity / period-sensitive guard | 10/10 correct |
| Total | mixed | 40 | protected validation | 40/40 correct |

Recommended wording:

> We evaluate the latest stack on a protected 40-question cross-company validation set. This is a stage-proof protected set rather than a broad public benchmark.

Do not call it:

- a large-scale benchmark
- complete generalization proof
- production evaluation

### B2. SkillOps Demo Suite

Use as workflow evidence, not accuracy evidence.

| Case Type | Purpose |
|---|---|
| success control | verify the system does not propose a skill when no failure is detected |
| source conflict | show evidence/source arbitration |
| period mismatch | show cutoff and period leakage diagnosis |
| table alignment error | show table-specific failure handling |
| profile boundary error | show company/profile boundary diagnosis |
| answer coverage failure | show partial-answer coverage diagnosis |

Recommended wording:

> The demo suite is designed to exercise the SkillOps lifecycle and failure taxonomy; it is not used to estimate answer accuracy.

### B3. Targeted Regression Suites

Use as promotion gate evidence.

| Suite | Current Role |
|---|---|
| `profile_precedence_short_v1` | tests Zeekr net-loss and NVIDIA direct-customer precedence skills |
| `period_alignment_short_v1` | tests period leakage / period-aware retrieval |
| `cross_company_guard_v1` | tests company spillover |
| `failure_bank_v1` | preserves confirmed failures |
| `core_protected_v1_40` | protects headline behavior |

## Baselines

### Accuracy Baselines

Current strongest available accuracy comparison should be framed cautiously because older runs may use different configs.

Recommended baseline table:

| Baseline | Description | Use |
|---|---|---|
| Vanilla / initial RAG | vector/BM25/rerank -> LLM without SkillOps governance | motivation / historical baseline |
| PageIndex Hybrid | adds structure-aware retrieval | retrieval improvement stage |
| Latest guarded stack | PageIndex Hybrid + SkillOps skills + gate discipline | main system |

Needed caution:

- If older baseline parameters differ, say "historical development baseline" rather than perfectly controlled ablation.
- If a strict ablation is required, rerun a small frozen subset with toggles.

### Promotion-Safety Baselines

Use the fair auto baseline as the main baseline story.

| Baseline | Rule | Result |
|---|---|---:|
| `naive` | target pass -> auto promote | 12 false triggers |
| `self_review_proxy` | automatic card-level company/year/period/evidence review | 3 false triggers |
| `static_guarded` | fixed target/noop/scope/cross-company regression | 0 false triggers |
| governed SkillOps | automatic proposal + tests + human promotion | 0 / PASS |

Recommended conclusion:

> The goal is not to prove that every automatic gate fails. Static guarded promotion blocks the observed false triggers. The human-governed layer is needed for deciding suite admission, reviewing new failure types, and preventing silent benchmark overfitting.

## Experiment Setting

### Main Research Questions

RQ1. Can the latest stack answer the protected cross-company SEC QA set correctly?

- Metric: correct / partial / incorrect; average latency; gate ALLOW/REVIEW.
- Evidence: 40/40 latest architecture validation.

RQ2. Can SkillOps turn failures into auditable diagnosis and candidate skills?

- Metric: demo case expected taxonomy match; proposal generated; gate status.
- Evidence: 6-case SkillOps demo suite.

RQ3. Can answer-level patches be migrated into scoped engineering skills?

- Metric: active answer overrides after migration; fallback-off accuracy; targeted regression pass.
- Evidence: 0 active overrides, fallback-off 40/40, profile precedence 6/6.

RQ4. Is the auto-promotion baseline fair, and what does it show?

- Metric: false triggers under naive, self-review proxy, static guarded, governed SkillOps.
- Evidence: 25,000 simulated candidate cycles.

## Proposed Tables

### Table 1: Challenge-to-Skill Mapping

| Challenge | Failure Type | SkillOps Mechanism |
|---|---|---|
| wrong fiscal period | `period_mismatch` | period-aware retrieval / cutoff / grep period probe |
| wrong source | `source_conflict` | source arbitration skill |
| wrong table row | `table_alignment_error` | table verifier / deterministic gate |
| wrong accounting scope | `profile_boundary_error` or scope mismatch | profile precedence skill |
| incomplete answer | `answer_coverage_failure` | coverage repair |

### Table 2: Core Protected Accuracy

Use 40/40 table.

### Table 3: SkillOps Demo Cases

Use 6-case taxonomy table.

### Table 4: Guardrail Migration Ablation

| Check | Result |
|---|---|
| profile reapply on latest 40/40 | 0 active overrides |
| legacy fallback disabled | 40/40 correct |
| precedence short regression | 6/6 PASS |

### Table 5: Fair Auto-Promotion Baselines

Use four-row baseline table.

## Experiment Setting Adjustments After Related Work

Based on related work, the paper should adjust as follows:

### Adjustment 1: Add a "promotion safety" experiment, not only answer accuracy.

Self-evolving skill papers usually evaluate task success and reuse. Our differentiator is high-stakes promotion safety. Keep the fair auto baseline as a first-class experiment.

### Adjustment 2: Be honest that static guarded baseline is strong.

If static guarded reaches 0 false triggers, do not hide it. Use it to say SkillOps can be partially automated, but human governance is needed for test suite admission and new failure types.

### Adjustment 3: Position grep probe against evidence-grounded QA and RAG reliability work.

Grep is not claimed as better retrieval. It is a low-cost exact-evidence side channel for diagnosing whether the right period, metric, and number were present.

### Adjustment 4: Keep benchmark language conservative.

FinanceBench / SECQUE are larger and public. Our 40-case set is a protected internal cross-company validation set. The contribution is the SkillOps workflow, not benchmark scale.

## Optional Extra Experiment If Time Allows

Only if time is available:

Run a strict mini ablation on the same 10-15 frozen questions:

| Variant | Description |
|---|---|
| Retrieval-only / vanilla RAG | no SkillOps repairs |
| PageIndex Hybrid | retrieval enhancement only |
| PageIndex + Grep Preview | evidence side channel, no repair |
| Full SkillOps guarded stack | current system |

This would strengthen the paper, but it is not required before writing the planning docs.
