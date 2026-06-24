# SkillOps Paper Skeleton

Date: 2026-06-10

## Working Title

**SkillOps for Reliable Financial Document QA: Human-Governed Skill Evolution with Grep-Style Evidence Probing**

Shorter alternative:

**From Static RAG to SkillOps for Reliable SEC Filing QA**

## Core Framing

This paper should not be framed as "we built a better RAG only." It should be framed as:

> We built a governance layer for evolving SEC QA systems: failures become evidence packets, evidence packets become typed diagnoses, diagnoses become candidate skills, and candidate skills are promoted only through explicit gates.

The RAG stack is the substrate. SkillOps is the paper novelty.

## Abstract Skeleton

Reliable QA over SEC filings requires systems to reason over tables, fiscal periods, filing sources, company profiles, and numeric units. Static RAG pipelines often fail because their errors are not converted into reusable, testable interventions. We introduce SkillOps, a human-governed skill evolution workflow for financial document QA. SkillOps augments a PageIndex Hybrid retrieval pipeline with grep-style evidence probing, evidence previews, failure diagnosis, skill candidate proposal, and promotion gates over protected and cross-company suites. In a protected cross-company validation set spanning Zeekr, Lotus Technology, and NVIDIA, the latest stack achieves 40/40 correct answers. A guardrail migration ablation shows that answer-level fallbacks can be replaced by scoped engineering skills while preserving correctness. Fair auto-promotion baselines show that naive auto-promotion causes false triggers and automatic self-review still misses subtle boundaries, motivating governed promotion rather than unrestricted self-modification. These results suggest that reliability in high-stakes financial QA benefits from auditable skill evolution rather than one-shot retrieval improvements alone.

## 1. Introduction

Problem:

- SEC QA is not just semantic retrieval.
- Common failures include period mismatch, table alignment, source conflict, profile boundary errors, and partial answer coverage.
- A static RAG system can be patched, but patches become hard to audit and can overfit one company.

Gap:

- Self-evolving agent work often emphasizes autonomous skill creation.
- Financial QA needs stronger governance because wrong numeric or filing-period answers are high-risk.
- Pure manual patching does not scale and is hard to present as a system.

Contribution:

1. A SkillOps workflow for SEC QA.
2. Grep-style evidence probing and evidence preview as inspectability tools.
3. A failure taxonomy and skill candidate proposal flow.
4. A promotion gate with protected, cross-company, failure-bank, and manual-review dimensions.
5. Empirical validation: 40/40 protected cross-company set, guardrail migration, and fair auto-promotion baselines.

Suggested intro ending:

> We do not claim fully autonomous self-modification. Instead, we argue that financial QA needs human-governed evolution: automatic discovery and proposal, explicit regression evidence, and controlled promotion.

## 2. Background and Motivation

Discuss:

- SEC filing QA difficulty: tables, periods, accounting scope, segment definitions, multiple filings.
- Why vanilla RAG is brittle: retrieved evidence may be correct but temporally incompatible; generated answer may mix rows; reranker may miss exact numeric anchors.
- Why answer-level patches are risky: can memorize final answers, overfit one company, and overwrite correct answers.

Use example categories:

- Zeekr net loss vs shareholder-attributable loss.
- NVIDIA FY2025 direct customer table vs quarterly/indirect snippets.
- Period leakage from later NVIDIA H20/export-control disclosures.

## 3. System Overview

Main figure:

```text
Question
  -> PageIndex Hybrid Retrieval
  -> Grep Evidence Probe
  -> Evidence Preview
  -> Answer Generation / Repair
  -> Failure Explainer
  -> Skill Candidate Proposal
  -> Promotion Gate
  -> Skill Registry
```

Subsections:

### 3.1 PageIndex Hybrid Retrieval

Keep concise. Say it provides page/section/table-aware retrieval context, but do not make it the only novelty.

### 3.2 Grep Evidence Probe

Define as lexical side-channel:

- exact phrase
- regex
- metric alias
- period phrase
- nearby number extraction

Claim: helps distinguish retrieval miss, period leakage, and answer coverage failure.

### 3.3 Evidence Preview

Define as a structured packet:

- retrieved snippets
- grep hits
- skill trace
- coverage/gap notes

Important: this is not the same as frontend "waiting screen"; it is an inspectable evidence packet.

### 3.4 Failure Explainer

Taxonomy:

- `period_mismatch`
- `source_conflict`
- `table_alignment_error`
- `profile_boundary_error`
- `answer_coverage_failure`
- `retrieval_miss`
- `wrong_source`
- `metric_alias_error`

### 3.5 Skill Candidate Proposal

Skill card fields:

- trigger
- scope
- evidence requirements
- repair/check action
- known risks
- required eval suites

### 3.6 Promotion Gate

Gate dimensions:

- targeted short
- core protected
- cross-company guard
- failure bank
- manual review

Careful wording:

> The current gate consumes evaluation summaries and produces staging decisions. It is a promotion protocol, not yet a full production orchestration platform.

## 4. Experiments

### 4.1 Protected Cross-Company Accuracy

Table:

| Company | Cases | Correct | Partial | Incorrect | Avg s/q | Gate |
|---|---:|---:|---:|---:|---:|---|
| Zeekr | 20 | 20 | 0 | 0 | 75.3 | ALLOW 19, REVIEW 1 |
| Lotus | 10 | 10 | 0 | 0 | 89.5 | ALLOW 10 |
| NVIDIA | 10 | 10 | 0 | 0 | 90.7 | ALLOW 9, REVIEW 1 |
| Total | 40 | 40 | 0 | 0 | - | 2 REVIEW |

Text:

- Emphasize protected validation, not public benchmark.
- Explain REVIEW: conservative numeric gate, not judge failure.

### 4.2 SkillOps Demo Suite

Table:

| Case | Failure Type | Evidence Signal | Proposal |
|---|---|---|---|
| Lotus control | no failure | revenue/period anchors | none |
| NVIDIA source conflict | source conflict | export-control/Data Center/FY anchors | source arbitration |
| NVIDIA period mismatch | period mismatch | FY2026/H20 leakage | period-aware arbitration |
| Zeekr Q1 gross margin | table alignment | Q1/gross-margin anchors | table guard |
| Zeekr VIE | profile boundary | VIE/holding structure | profile guard |
| Zeekr sales network | coverage failure | outlet-count anchors | coverage guard |

### 4.3 Guardrail Migration

Show the anti-overfitting story:

| Check | Result |
|---|---|
| Profile reapply on latest 40/40 | 0 answer overrides |
| Legacy fallback disabled | 40/40 still correct |
| Precedence regression | 6/6 PASS |

Explain that final-answer fallback becomes emergency safety switch, not normal path.

### 4.4 Fair Auto-Promotion Baselines

Table:

| Baseline | Human Review | False Triggers |
|---|---|---:|
| naive | no | 12 |
| self-review proxy | no | 3 |
| static guarded | no | 0 |
| governed SkillOps | yes | 0 / PASS |

Nuanced conclusion:

- Do not claim static guarded is bad.
- Say static guarded is strong on known suites.
- Governed SkillOps adds human accountability for new skill admission, suite updates, and promotion decisions.

## 5. Discussion

Main points:

- Skills are not just hand-written hacks if they are scoped, auditable, and regression tested.
- Grep does not replace retrieval; it makes evidence inspection cheaper and more deterministic.
- Static gates are useful but depend on coverage. The human role is not every check; it is approving the boundary of what counts as sufficient evidence.
- This design is compatible with future semi-automatic skill evolution dashboards.

## 6. Limitations

Must include:

- 40 protected questions is not a broad benchmark.
- Failure explainer precision/recall is not measured yet.
- Latency remains high.
- Static guarded baseline reaches 0 false triggers on the current controlled suite.
- Human-governed workflow is less autonomous than fully self-evolving agents.
- Artifact release needs cleanup for paths, generated outputs, and environment assumptions.

## 7. Future Work

Best future directions:

1. Larger rotating benchmark with 3-5 companies and 60-100+ questions.
2. Failure explainer precision/recall annotation.
3. Automated suite-refresh proposal with human admission.
4. UI for evidence preview, skill candidate review, and promotion gate.
5. Latency reduction: TTFT, preview-first response, retrieval/generation parallelization.
6. Optional company-local fact registry as a final specialized layer, separated from general SkillOps.

## Figures and Tables Checklist

Figures:

- Figure 1: SkillOps workflow.
- Figure 2: Evidence preview / grep probe packet.
- Figure 3: Skill lifecycle and promotion gate.

Tables:

- Table 1: system stages.
- Table 2: 40-question cross-company validation.
- Table 3: SkillOps demo suite.
- Table 4: guardrail migration ablation.
- Table 5: fair auto-promotion baselines.

## Reviewer Risks and Responses

### "Is this just hand-coded rules?"

Response:

The paper should distinguish unstructured answer patches from governed skills. A governed skill has a trigger, scope, evidence requirements, failure type, regression suite, and promotion gate. The guardrail migration explicitly reduces answer overwrite behavior.

### "Why not fully automatic?"

Response:

Fair auto baselines show a spectrum. Naive auto is unsafe; self-review improves but misses subtle boundaries; static guarded works on observed suites. The proposed governance layer is about accountability and suite admission under distribution shift, not claiming humans are needed for all checks.

### "Is 40 questions enough?"

Response:

It is a protected cross-company validation set, not a final broad benchmark. The contribution is the SkillOps workflow and evidence protocol; larger rotating benchmarks are future work.

### "What is the novelty beyond RAG?"

Response:

Novelty is the failure-to-skill lifecycle: grep evidence probe, evidence preview, typed failure explainer, candidate skill cards, and gated promotion for SEC QA.

## Writing Order

Recommended:

1. Write Introduction and System Overview first.
2. Insert the four main experiment tables.
3. Write Discussion around fair auto baselines.
4. Add Limitations honestly.
5. Only then refine related work.
