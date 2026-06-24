# Human-Governed SkillOps for SEC Filing QA

## Executive Summary

This project upgrades the FinSagent SEC QA prototype from a static PageIndex + Hybrid RAG system with scattered engineering patches into a minimal human-governed SkillOps prototype.

The core result is a reproducible audit/evolution loop:

Question -> Retrieval -> Grep Evidence Probe -> Evidence Preview -> Failure Diagnosis -> Skill Candidate Proposal -> Staging/Promotion Gate

The goal is not to claim a fully autonomous production system. The contribution is a controlled framework for turning SEC QA failures into auditable, reviewable, regression-gated skill proposals.

## Current Accuracy Context

Cross-company benchmark v1.1:

- Companies: Zeekr, Lotus Technology, NVIDIA
- Evaluated QAs: 40
- Correct: 40
- Partial: 0
- Incorrect: 0
- Weighted correctness score: 5.0 / 5

Paper table:

| Company | Cases | Correct | Partial | Incorrect | Notes |
| --- | ---: | ---: | ---: | ---: | --- |
| Zeekr | 20 | 20 | 0 | 0 | Target-company sanity / benchmark subset |
| Lotus Technology | 10 | 10 | 0 | 0 | Cross-company generalization subset |
| NVIDIA | 10 | 10 | 0 | 0 | Cross-company generalization subset |
| Total | 40 | 40 | 0 | 0 | Weighted correctness score 5.0 / 5 |

Reference:

- `test/colm/retrieval/cross_company_benchmark_v1_1_20260605/cross_company_benchmark_v1_1_summary.json`

Interpretation:

The core SEC QA system has already passed the current target-company and cross-company sanity benchmark. The SkillOps work is therefore framed as reliability, auditability, diagnosis, and maintainability improvement rather than only raw accuracy improvement.

## Why Static RAG Was Not Enough

Vanilla RAG and even structure-aware retrieval can fail on SEC QA because the task is not only semantic matching. Common failure modes include:

- wrong filing or wrong source date
- fiscal/calendar period mismatch
- table row/column/unit alignment error
- metric alias mismatch
- answer coverage omission
- conflicting later disclosures
- company profile boundary over-inference

PageIndex and Hybrid retrieval improve evidence acquisition, but they do not by themselves govern how failures are diagnosed, how patches are reviewed, or how new skills are promoted safely.

## System Contributions

### 1. Skill Registry

Existing SEC-specific repairs are represented as governed skill cards under `configs/skill_cards/`.

The registry currently contains eight skill cards:

- `period_alignment`
- `source_conflict`
- `table_evidence_verifier`
- `answer_coverage`
- `company_profile_boundary`
- `exact_evidence_probe`
- `evidence_rescue_scorer`
- `quant_skill_hints`

Each card includes scope, failure types, trigger, inputs, outputs, risks, eval sets, status, owner, and implementation references.

### 2. Grep Evidence Probe

The grep probe is a lexical audit side-channel. It does not replace retrieval and does not answer questions directly.

It extracts structured anchors:

- exact phrase
- regex
- metric alias
- period phrase
- nearby number

This makes cheap evidence localization available for preview and diagnosis.

### 3. Evidence Preview

Evidence Preview merges:

- final answer
- retrieval chunks
- grep anchors
- skill traces
- audit notes

This gives a human reviewer one place to inspect what evidence was retrieved, which lexical anchors were found, and which skills fired.

### 4. Failure Explainer

The first Failure Explainer is rule-based and outputs structured FailureReports.

Supported taxonomy:

- `retrieval_miss`
- `wrong_source`
- `period_mismatch`
- `table_alignment_error`
- `metric_alias_error`
- `answer_coverage_failure`
- `source_conflict`
- `profile_boundary_error`

The purpose is stable operational classification, not free-form LLM judging.

### 5. Skill Candidate Proposal

FailureReports are converted into proposal-only skill candidates.

The generator does not write production Python code. It emits YAML/Markdown proposals with:

- candidate skill name
- observed failures
- failure type
- hypothesis
- proposed trigger
- proposed action
- risks
- required tests
- suggested status

### 6. Staging/Promotion Gate

Candidate proposals enter a conservative staging/promotion gate.

Decision states:

- `proposed`
- `rejected`
- `approved_for_implementation`
- `promoted`

The current gate consumes protected-set summaries and manual-review flags. It does not automatically rerun every protected benchmark by itself. Without manual review, candidates remain `proposed` even when protected-set summaries pass.

## Reproducible Runner

Two runner paths now execute the audit/evolution chain:

- single-case runner: `src/skillops/vertical_slice_runner.py`
- one-command demo suite runner: `src/skillops/demo_benchmark_runner.py`

They generate:

- grep probe JSON
- evidence preview JSON/Markdown
- failure report JSON/Markdown
- skill candidate YAML/Markdown
- gate eval summary
- gate decision YAML/Markdown
- case summary

This demonstrates that the SkillOps loop is reproducible, not hand-assembled. The clean rerun entry point is:

`PYTHONPATH=src python -m skillops.demo_benchmark_runner --case_manifest configs/skillops_demo_cases.json --out_dir test/colm/retrieval/skillops_demo_benchmark_rerun`

## Case Suite

Current runner suite:

| Case | Company | Primary Type | Grep Signal | Skill Trace | Proposal | Gate Result |
| --- | --- | --- | --- | --- | --- | --- |
| Lotus revenue question | Lotus | `no_failure_detected` | revenue / nine-month period anchors | none | none | none |
| NVIDIA FY2025 export-control question | NVIDIA | `source_conflict` | export-control / Data Center / fiscal-year anchors | `period_source_conflict_repair_applied` | period/source arbitration | proposed |
| NVIDIA period mismatch demo | NVIDIA | `period_mismatch` | FY2025 question with FY2026 / H20 / April 2025 leakage markers | none | period-aware arbitration | proposed |
| Zeekr Q1 2024 gross margin | Zeekr | `table_alignment_error` | gross-margin / Q1 / table-alignment anchors | `table_repair_applied` | table alignment guard | proposed |
| Zeekr VIE structure | Zeekr | `profile_boundary_error` | VIE / holding-company structure anchors | `profile_repair_applied` | profile boundary guard | proposed |
| Zeekr global sales network | Zeekr | `answer_coverage_failure` | sales-network / outlet-count anchors | `coverage_repair_applied` | answer coverage guard | proposed |

Coverage:

- success control: 1
- actionable failure categories covered: 5
- total cases: 6

Reference:

- `test/colm/retrieval/skillops_demo_benchmark_20260605/skillops_demo_benchmark_manifest.md`
- `reports/skillops_reproducibility_note_20260605.md`

## Ablation Framing

The current evidence supports the following paper-style comparison:

| System Stage | What It Adds | Expected Benefit |
| --- | --- | --- |
| Vanilla RAG | basic semantic retrieval and generation | baseline, unstable on SEC-specific errors |
| PageIndex + Hybrid | structure-aware and hybrid retrieval | better table/section/source recall |
| Static SEC Skills | deterministic repair and guarded verification | higher correctness on known SEC failure modes |
| Grep Probe + Evidence Preview | lexical anchors and auditable evidence view | cheaper source inspection and failure localization |
| Failure Diagnosis + Proposal + Staging Gate | governed SkillOps loop | maintainable, reviewable, regression-aware evolution |

Compact paper table:

| Stage | Retrieval / Evidence | Control Layer | Output |
| --- | --- | --- | --- |
| Vanilla RAG | vector / BM25 / rerank | none | direct LLM answer |
| PageIndex + Hybrid | page/node-aware hybrid retrieval | source and table-aware retrieval heuristics | stronger evidence recall |
| SEC Skills | PageIndex + deterministic repairs | numeric/table/profile/coverage guards | corrected or abstained answer |
| Grep Probe | lexical anchors over candidate evidence | exact phrase, period, metric, and number probes | auditable evidence preview |
| SkillOps | grep + preview + failure taxonomy | proposal-only skill evolution and staging gate | reviewed skill candidate, not automatic promotion |

Important nuance:

SkillOps is not only an accuracy booster. Its main value is operational: it makes failure types, skill triggers, evidence, proposals, and promotion decisions inspectable.

## Grep Positioning

The grep component should be described as:

> a lexical evidence probe for auditable SEC QA failure diagnosis

It should not be described as a replacement for RAG.

Intuition:

Dense retrieval is good at semantic similarity, but SEC failures often hinge on exact terms, dates, table labels, product names, and numbers. Grep-style anchors provide a cheap second view of the corpus that helps humans and diagnosis rules see whether the right evidence exists, whether a metric alias is missing, and whether a later disclosure is contaminating the answer.

## Human Governance Boundary

The system intentionally avoids full auto-modification.

Current boundary:

- automatic: probe, preview, diagnose, propose, stage
- human-governed: review proposal, approve implementation, promote skill
- blocked by design: automatic arbitrary Python code generation and promotion

This is important for industrial credibility because uncontrolled auto-evolution can overfit, create skill conflicts, or silently regress protected cases.

## Remaining Gaps

The current prototype is strong enough for a demo and paper narrative, but not yet a full production platform.

Remaining work:

- add primary-case coverage for `retrieval_miss`, `wrong_source`, and `metric_alias_error`
- evaluate Failure Explainer precision/recall on a labeled failure set
- connect company profiles to grep alias expansion systematically
- run larger protected regression sets for candidate promotion
- expand the one-command runner to cover additional primary failure types and protected-set summaries
- add optional LLM summarization after rule-based diagnosis, without letting LLM override structured signals

## Paper Claim

The paper claim should be scoped as:

> We present a human-governed SkillOps framework for SEC filing QA that complements structure-aware RAG with lexical evidence probing, auditable evidence previews, rule-based failure diagnosis, proposal-only skill evolution, and regression-aware staged promotion.

This is a credible EMNLP Industry-style contribution because it targets an industrial reliability problem: not just getting answers right once, but making the path from failures to system improvements inspectable and controlled.
