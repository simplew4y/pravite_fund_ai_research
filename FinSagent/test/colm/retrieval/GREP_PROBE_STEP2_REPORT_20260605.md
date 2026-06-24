# Grep Evidence Probe Step 2 Report - 2026-06-05

## Purpose

This step adds the first formal grep probe for the SkillOps direction. It does not replace PageIndex or Hybrid retrieval and does not answer questions directly. Its role is to produce cheap, structured, auditable lexical anchors for evidence preview and later failure diagnosis.

## Implementation

New module:

- `src/grep/grep_probe.py`
- `src/grep/probe_report.py`

Main API:

```python
grep_probe(question, roots, metadata) -> EvidenceProbeResult
```

The result contains:

- `query_terms`: concrete terms extracted from the question
- `metric_aliases`: recognized metric families such as revenue, gross margin, delivery, cash
- `period_terms`: years, quarters, and period phrases
- `anchors`: structured evidence anchors with type, source path, span, snippet, confidence hint, and metadata
- `files_scanned`: audit count

Supported anchor types in this version:

- `exact_phrase`
- `regex`
- `metric_alias`
- `period_phrase`
- `nearby_number`

## Smoke Case

Question:

> What was Lotus Technology revenue for the nine months ended September 30, 2024, and how did it compare with the same period in 2023?

Input root:

`/root/autodl-tmp/RAG_Agent_data/lotus/20250701/final_meta`

Output:

- JSON: `test/colm/retrieval/grep_probe_step2_20260605/lotus_q1_probe.json`
- Markdown: `test/colm/retrieval/grep_probe_step2_20260605/lotus_q1_probe_report.md`

Observed result:

- Files scanned: 54
- Query terms: Lotus, revenue, nine, months, September, 30, 2024, 2023
- Period terms: nine months ended September 30, 2024, 2023
- Metric alias family: revenue
- Anchor mix: period phrase, metric alias, nearby number, exact phrase

## Interpretation

The smoke run shows the intended behavior: grep finds relevant lexical evidence anchors and exposes source snippets, but it does not decide which anchor is the final answer. Some nearby-number anchors are relevant context but not answer facts, such as delivery counts or first-half revenue. This is acceptable and important for the paper framing: grep is an auditable evidence probe, not a replacement for retrieval, reranking, table verification, or answer generation.

The next step is Evidence Preview: merge retrieval chunks, grep anchors, and SkillTrace records into one human-readable preview so a reviewer can see why an answer was supported or why a failure diagnosis was triggered.

