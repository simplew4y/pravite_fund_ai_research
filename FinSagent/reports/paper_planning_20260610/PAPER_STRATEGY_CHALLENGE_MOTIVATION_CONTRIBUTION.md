# Paper Strategy: Challenge, Motivation, Contribution

Date: 2026-06-10

## Current Recommendation

Do not write the full paper draft yet. First freeze the narrative and experiment protocol:

1. Challenge
2. Motivation
3. Contribution
4. Benchmark
5. Baselines
6. Experiment setting
7. Related work
8. Adjust experiment setting after related work
9. Then write the first draft

## Challenge

### C1. SEC QA is structurally harder than ordinary RAG QA.

SEC filings contain long documents, repeated fiscal periods, multiple filing types, dense tables, accounting-scope variants, and cross-company terminology differences. A retrieved passage can be semantically relevant but still wrong for the question because it comes from the wrong period, wrong source, wrong table row, or wrong accounting scope.

Examples from the current system:

- Zeekr 2024 consolidated net loss vs shareholder-attributable loss.
- NVIDIA FY2025 direct-customer annual table vs quarterly or indirect-customer snippets.
- NVIDIA period leakage from later export-control / H20 disclosures.
- Zeekr table alignment failures around Q1 gross margin.

### C2. Static RAG improvements do not naturally become reusable reliability mechanisms.

PageIndex Hybrid, rerank, rescue, and prompt fixes can improve answer quality, but failure handling can remain scattered. Without a lifecycle, fixes become hard to audit and can accidentally overwrite correct answers or overfit to one company.

### C3. Fully automatic skill evolution is risky in financial QA.

In high-stakes QA, the problem is not only whether a skill fixes one failure. The key question is whether it changes answers outside its intended scope. Auto-promotion needs negative scope tests, cross-company guards, and accountability.

## Motivation

### M1. Industrial SEC QA needs reliability workflows, not only retrieval accuracy.

For a user or client, a system that answers 40 questions correctly is not enough if the correction logic cannot be audited. The system needs to show why an answer changed, what evidence triggered the change, and what tests prevent the change from spilling into other cases.

### M2. Skills are a natural abstraction, but only if they are governed.

The project already contains skill-like interventions:

- period cutoff / period-aware retrieval
- table numeric verification
- answer coverage repair
- profile boundary checks
- direct-customer table precedence
- net-loss accounting-scope precedence
- grep evidence probing

The paper should argue that these are not ad hoc hacks when they are represented as skill cards with scope, triggers, evidence requirements, risk notes, and promotion gates.

### M3. Human governance is a strength, not a weakness.

The paper should not apologize for not being fully autonomous. In financial QA, human review is a governance layer:

- deciding whether a new failure type is real
- admitting cases into protected/failure-bank suites
- approving promotion after automatic tests pass
- preventing over-optimization to one benchmark

## Contribution

### Contribution 1: SkillOps workflow for SEC filing QA.

We introduce a failure-to-skill lifecycle:

```text
Observed Failure
  -> Grep Evidence Probe
  -> Evidence Preview
  -> Failure Explainer
  -> Skill Candidate Proposal
  -> Regression Gate
  -> Skill Registry / Human-Governed Promotion
```

### Contribution 2: Evidence-grounded failure diagnosis.

The system uses grep-style exact evidence probes and evidence previews to expose whether failures are due to:

- missing evidence
- wrong period
- wrong source
- table alignment
- metric alias mismatch
- answer coverage
- profile boundary

### Contribution 3: Skill cards and promotion gates.

Skill candidates are not merged directly. They must specify:

- trigger condition
- intended scope
- evidence requirements
- repair/check behavior
- risk of over-triggering
- required evaluation suites

Promotion gate dimensions:

- targeted short
- core protected
- cross-company guard
- failure bank
- manual review

### Contribution 4: Empirical evidence in SEC QA.

Current evidence:

- Latest protected cross-company validation: 40/40 correct across Zeekr, Lotus, NVIDIA.
- SkillOps demo suite: 6 cases covering success, source conflict, period mismatch, table alignment, profile boundary, answer coverage.
- Guardrail migration: answer-level fallbacks converted into scoped engineering skills while preserving 40/40.
- Fair auto-promotion baselines: naive auto has 12 false triggers; self-review proxy has 3; static-guarded and governed SkillOps block observed false triggers.

### Contribution 5: Nuanced position on automation.

We do not claim that humans must check every rule, or that all automatic skill evolution is unsafe. Instead:

- naive auto-promotion is unsafe;
- automatic self-review reduces but does not eliminate subtle risk;
- static guarded promotion can block known-suite false triggers;
- human-governed SkillOps remains necessary for suite admission, accountability, and new failure-type promotion.

## One-Paragraph Paper Pitch

Static RAG pipelines can answer SEC questions when retrieval succeeds, but their failures often recur because fixes are scattered across prompts, rerankers, and answer-level patches. We present SkillOps, a human-governed workflow that converts SEC QA failures into auditable, testable skills. SkillOps combines PageIndex Hybrid retrieval, grep-style evidence probing, evidence previews, failure taxonomy, skill candidate proposal, and promotion gates over targeted, protected, cross-company, and failure-bank suites. On a protected cross-company set across Zeekr, Lotus, and NVIDIA, the latest stack reaches 40/40 correct answers. More importantly, guardrail migration and fair auto-promotion baselines show how skills can be promoted without relying on memorized final answers or naive self-modification.

## What To Avoid

- Do not frame the paper as "we beat all financial QA benchmarks."
- Do not claim fully autonomous self-evolution.
- Do not present 6 demo cases as a statistical benchmark.
- Do not hide that static-guarded auto reaches 0 false triggers on the current controlled suite.
- Do not imply PageIndex alone caused 40/40; the result is the full guarded stack.
