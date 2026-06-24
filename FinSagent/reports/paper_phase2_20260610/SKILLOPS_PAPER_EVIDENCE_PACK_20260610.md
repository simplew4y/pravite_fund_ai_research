# SkillOps Paper Evidence Pack

Date: 2026-06-10

## One-Sentence Thesis

FinSAgent was upgraded from a static SEC RAG pipeline into a human-governed SkillOps workflow: the system surfaces exact evidence, diagnoses failures, proposes auditable skills, and promotes them only through explicit regression gates and human review.

## Recommended Paper Claim

Use this precise claim:

> SkillOps improves reliability for SEC filing QA by turning observed failures into auditable, testable skill candidates. The key contribution is not full automation, but a governed evolution loop that combines automatic evidence probing, failure explanation, candidate generation, regression gates, and human-controlled promotion.

Avoid this overclaim:

> The system can fully autonomously evolve without human review.

The fair auto baseline now supports a more nuanced statement: stronger automatic gates can remove observed false triggers on a controlled suite, but human-governed promotion remains important for suite admission, accountability, and new failure-type handling.

## System Stage Table

| Stage | Added Capability | Main Reliability Role | Evidence |
|---|---|---|---|
| Vanilla SEC RAG | vector/BM25/table retrieval + LLM generation | baseline answer generation | original project stack |
| PageIndex Hybrid | structure-aware retrieval branch | improves table/section/page recall | PageIndex hybrid runs and 40-case protected result |
| Grep Evidence Probe | exact phrase, regex, metric, period, nearby-number probe | exposes whether exact evidence exists and whether later-period evidence leaked | `GREP_PROBE_STEP2_REPORT_20260605.md` |
| Evidence Preview | retrieval + grep + skill trace packet | makes agent behavior inspectable | `EVIDENCE_PREVIEW_STEP3_REPORT_20260605.md` |
| Failure Explainer | taxonomy diagnosis | converts wrong answers into typed failure modes | `FAILURE_EXPLAINER_STEP4_REPORT_20260605.md` |
| Skill Candidate Proposal | YAML/Markdown skill candidates | turns failures into reviewable interventions | `SKILL_CANDIDATE_STEP5_REPORT_20260605.md` |
| Staging/Promotion Gate | targeted, protected, cross-company, failure-bank, manual-review checks | prevents over-broad skill promotion | `REGRESSION_GATE_STEP6_REPORT_20260605.md`, `GATE_REPORT.md` |
| Guardrail Migration | answer-level repairs migrated into scoped engineering skills | reduces memorized answer fallback | `ANSWER_GUARDRAIL_MIGRATION_REPORT_20260609.md` |
| Fair Auto Baselines | naive / self-review / static-guarded auto-promotion comparisons | avoids strawman baseline and motivates governed promotion | `FAIR_AUTO_BASELINES_REPORT.md` |

## Headline Accuracy Result

Latest protected cross-company validation:

| Suite | Company | Cases | Correct | Partial | Incorrect | Avg s/q | Gate |
|---|---|---:|---:|---:|---:|---:|---|
| Lotus mini10 | Lotus Technology | 10 | 10 | 0 | 0 | 89.5 | ALLOW 10 |
| Zeekr holdout20 | Zeekr | 20 | 20 | 0 | 0 | 75.3 | ALLOW 19, REVIEW 1 |
| NVIDIA mini10 | NVIDIA | 10 | 10 | 0 | 0 | 90.7 | ALLOW 9, REVIEW 1 |
| Total | mixed | 40 | 40 | 0 | 0 | - | 2 conservative REVIEW |

Source:

- `test/colm/retrieval/latest_arch_validation_20260608/LATEST_ARCH_VALIDATION_REPORT_20260608.md`

Interpretation:

- The current architecture passes the 40-question protected cross-company set.
- The two REVIEW items are conservative numeric gate reviews, not judge failures.
- This result should be described as a protected set, not a broad public benchmark.

## SkillOps Demo Suite

Purpose: demonstrate the SkillOps loop and failure taxonomy, not statistical accuracy.

| Case | Type | Main Signal | Candidate / Gate Role |
|---|---|---|---|
| Lotus success control | `no_failure_detected` | revenue / nine-month anchors | verifies no spurious proposal |
| NVIDIA source conflict | `source_conflict` | export-control / Data Center / fiscal-year anchors | period/source arbitration proposal |
| NVIDIA period mismatch | `period_mismatch` | FY2025 question with FY2026/H20/April 2025 leakage | period-aware arbitration proposal |
| Zeekr Q1 gross margin | `table_alignment_error` | gross-margin / Q1 table anchors | table alignment guard |
| Zeekr VIE profile boundary | `profile_boundary_error` | VIE / holding-company structure anchors | profile boundary guard |
| Zeekr sales network | `answer_coverage_failure` | sales-network / outlet-count anchors | answer coverage guard |

Clean rerun target:

```bash
PYTHONPATH=src python -m skillops.demo_benchmark_runner \
  --case_manifest configs/skillops_demo_cases.json \
  --out_dir test/colm/retrieval/skillops_demo_benchmark_rerun
```

Expected: 6 cases, 0 mismatches, status pass.

## Evaluation Suite Protocol

| Suite | Type | Frozen | Purpose |
|---|---|---|---|
| `core_protected_v1_40` | fixed protected | true | headline regression and comparability |
| `skillops_demo_v1` | demo/taxonomy | true | evidence preview, diagnosis, proposal, gate examples |
| `failure_bank_v1` | evolving | false | preserve confirmed failures and prevent recurrence |
| `period_alignment_short_v1` | targeted short | false | period leakage and over-triggering checks |
| `cross_company_guard_v1` | guardrail | false | prevent single-company overfitting |
| `profile_precedence_short_v1` | targeted short | false | Zeekr net-loss and NVIDIA direct-customer precedence boundaries |

Config files:

- `configs/eval_suites/core_protected_v1.yaml`
- `configs/eval_suites/skillops_demo_v1.yaml`
- `configs/eval_suites/failure_bank_v1.yaml`
- `configs/eval_suites/period_alignment_short_v1.yaml`
- `configs/eval_suites/cross_company_guard_v1.yaml`
- `configs/eval_suites/profile_precedence_short_v1.yaml`

## Guardrail Migration Evidence

Question addressed: is the system just storing final answers?

Answer: the latest migration reduces answer-level fallback by converting the remaining profile fixes into scoped engineering skills.

| Evidence | Result |
|---|---|
| Reapply profile layer to latest 40/40 outputs | 0 active answer overrides |
| Legacy answer fallback disabled | 40/40 still correct |
| New deterministic precedence regression | 6/6 PASS |
| Migrated engineering skills | `annual_net_loss_statement_precedence`, `annual_direct_customer_table_precedence`, `unit_scale_normalizer` |

Source:

- `test/colm/retrieval/guardrail_migration_20260609/ANSWER_GUARDRAIL_MIGRATION_REPORT_20260609.md`
- `test/colm/retrieval/profile_precedence_regression_20260609_v2/PROFILE_PRECEDENCE_REGRESSION_REPORT.md`

## Fair Auto-Promotion Baselines

Question addressed: is human governance needed only because the auto baseline is unrealistically weak?

The baseline was upgraded into a three-level automatic comparison:

| Baseline | Promotion Rule | Human Review | Final false triggers |
|---|---|---|---:|
| `naive` | local target pass only | no | 12 |
| `self_review_proxy` | automatic card-level company/year/period/evidence guard review | no | 3 |
| `static_guarded` | fixed target/noop/scope/cross-company regression suite | no | 0 |
| governed SkillOps | automatic proposal/testing plus human promotion | yes | 0 / PASS |

Run setup: 5 seeds, 5,000 cycles per seed, 25,000 simulated candidate cycles.

Source:

- `reports/guardrail_migration/auto_promotion_fair_baselines_20260610/FAIR_AUTO_BASELINES_REPORT.md`
- raw server output: `/root/autodl-tmp/dir_myz/FinSagent_pageindex_fast/test/colm/retrieval/auto_promotion_fair_baselines_20260610_long`

Interpretation:

- Naive auto-promotion is unsafe.
- Self-review reduces risk but still misses already-correct overwrite and subtle accounting-scope boundaries.
- Static regression gates can block the observed false triggers on this controlled suite.
- The paper should position human governance as accountability and suite-admission control, not as a claim that every low-level check must be manual.

## Key Figures To Draw

1. Pipeline figure:

```text
Question -> Retrieval/PageIndex -> Grep Probe -> Evidence Preview -> Answer
                                      |
                                      v
                            Failure Explainer
                                      |
                                      v
                        Skill Candidate Proposal
                                      |
                                      v
      Targeted Short + Core Protected + Cross-company + Failure Bank + Human Review
                                      |
                                      v
                              Skill Registry
```

2. Skill lifecycle figure:

```text
Observed Failure -> Evidence Packet -> Failure Type -> Candidate Skill Card
      -> Staging Gate -> Proposed / Rejected / Approved -> Regression Tracking
```

3. Baseline comparison figure:

```text
Naive auto: 12 false triggers
Self-review auto: 3 false triggers
Static-guarded auto: 0 false triggers
Governed SkillOps: 0 false triggers + human promotion accountability
```

## Suggested Experiment Tables

Table 1: Cross-company protected accuracy.

Use the 40/40 table above.

Table 2: SkillOps case suite.

Use the six demo cases with failure type, grep signal, proposal, and gate result.

Table 3: Fair auto-promotion baselines.

Use the four-baseline comparison.

Table 4: Guardrail migration ablation.

Use 0 active overrides, fallback-off 40/40, and 6/6 precedence regression.

## What The Paper Can Claim

- The system provides an auditable SkillOps workflow for SEC QA.
- Grep-style evidence probing makes exact evidence and period leakage visible.
- Failure explanations can be converted into typed, reviewable skill candidates.
- Cross-company protected validation currently reaches 40/40 on Zeekr/Lotus/NVIDIA.
- Guardrail migration reduces memorized-answer fallback and keeps protected accuracy.
- Fair auto-promotion baselines show why governance should be framed as controlled promotion, not just automatic local repair.

## What The Paper Should Not Claim Yet

- Not a production-grade fully autonomous evolving agent.
- Not a broad 100-200 question public benchmark.
- Not proof that static regression gates will cover all future failures.
- Not a full precision/recall evaluation of the failure explainer.
- Not a claim that PageIndex alone solves SEC QA; the result is the full guarded stack.

## Remaining Paper Gaps

| Gap | Severity | Suggested Handling |
|---|---|---|
| Failure explainer precision/recall not evaluated | medium | present as system component + case evidence; list quantitative eval as future work |
| Benchmark size is 40 protected questions | medium | call it protected cross-company validation; propose rotating benchmark expansion |
| Static-guarded baseline also reaches 0 false triggers | low/medium | frame governed SkillOps as accountability/suite admission, not raw false-trigger superiority |
| Runtime latency is high | medium | report latency honestly; position optimization as engineering follow-up |
| Some reports are generated artifacts, not clean public release | low | provide reproducible scripts and artifact hygiene note |

## Recommended Abstract Draft

Reliable question answering over SEC filings requires more than retrieving relevant passages: systems must handle table alignment, fiscal-period boundaries, source conflicts, company-specific profile boundaries, and answer coverage. We present SkillOps, a human-governed skill evolution workflow for financial document QA. SkillOps augments a PageIndex Hybrid RAG pipeline with grep-style evidence probing, evidence previews, failure taxonomy, skill candidate proposals, and promotion gates over protected and cross-company evaluation suites. On a 40-question protected set spanning Zeekr, Lotus Technology, and NVIDIA, the latest stack achieves 40/40 correct answers. A guardrail migration ablation shows that answer-level fallbacks can be reduced into scoped engineering skills while preserving 40/40 correctness. Finally, fair auto-promotion baselines show that naive auto-promotion causes 12 false triggers and automatic self-review still leaves 3, while static regression and governed SkillOps block the observed false triggers. These results motivate controlled, auditable skill promotion rather than unrestricted self-modification for high-stakes financial QA.

## Immediate Next Step

Start writing the paper with this structure:

1. Introduction: why static RAG fails for SEC QA.
2. System: PageIndex Hybrid + SkillOps loop.
3. Skill Components: grep probe, preview, explainer, proposals, gate.
4. Experiments: 40/40 protected set, demo suite, guardrail migration, fair auto baselines.
5. Limitations and future work: rotating benchmark, explainer metrics, latency, broader company coverage.
