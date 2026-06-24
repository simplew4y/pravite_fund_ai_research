# Evidence Preview Step 3 Report - 2026-06-05

## Purpose

This step turns the SkillOps prototype from separate artifacts into a unified audit view. The preview combines:

- retrieval chunks from PageIndex / Hybrid / rescue retrieval
- structured grep anchors from the new grep probe
- skill trace fields from guarded repair skills
- final answer and audit notes

This layer is still read-only. It does not change retrieval or generation behavior.

## Implementation

New module:

- `src/preview/evidence_preview.py`

Main API:

```python
build_evidence_preview(row, grep_probe_result) -> EvidencePreview
```

CLI:

```bash
PYTHONPATH=src python -m preview.evidence_preview \
  --row_json <run_output.json> \
  --grep_json <probe.json> \
  --out_json <preview.json> \
  --out_md <preview.md>
```

## Case Study 1: Successful Answer Preview

Case:

- Company: Lotus Technology
- QID: `lotus_gen_01`
- Question: revenue for the nine months ended September 30, 2024 vs. 2023

Outputs:

- `test/colm/retrieval/evidence_preview_step3_20260605/lotus_q1_success_preview.json`
- `test/colm/retrieval/evidence_preview_step3_20260605/lotus_q1_success_preview.md`

The preview shows:

- top retrieval chunk with the exact answer evidence: `$652,823,000` vs. `$317,941,000`
- grep anchors for period / revenue / nearby numeric evidence
- no skill trace, because this is a normal successful answer case

## Case Study 2: Skill Repair Preview

Case:

- Company: NVIDIA
- QID: `qa_kp_000015`
- Question: FY2025 export controls and China Data Center business

Outputs:

- `test/colm/retrieval/evidence_preview_step3_20260605/nvidia_q15_source_conflict_preview.json`
- `test/colm/retrieval/evidence_preview_step3_20260605/nvidia_q15_source_conflict_preview.md`

The preview shows:

- retrieval contained both FY2025 10-K evidence and later H20 / FY2026 evidence
- grep anchors expose export-control / China / Data Center lexical evidence
- `source_conflict` skill trace was triggered
- supporting source: `20250126_10-K_base_final.json`
- matched support phrase: `Data Center revenue in China grew in fiscal year 2025`
- original period-conflicted answer was preserved for audit

## Paper Relevance

This is the first complete visualizable loop for the EMNLP Industry story:

Question -> Retrieval -> Grep Probe -> Skill Trace -> Evidence Preview

The preview makes the system inspectable without claiming that grep alone is sufficient. It gives human reviewers and future failure explainers a shared artifact for checking source period, table/numeric evidence, skill decisions, and answer coverage.

Next step: build the Failure Explainer on top of this preview, using rule-based checks first and optional LLM summarization later.

