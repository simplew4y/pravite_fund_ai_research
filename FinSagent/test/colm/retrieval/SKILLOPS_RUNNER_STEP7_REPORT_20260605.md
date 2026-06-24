# SkillOps Vertical Slice Runner Step 7 Report - 2026-06-05

## Purpose

This step turns the SkillOps vertical slice from a collection of reports into a reproducible single-case runner. The runner starts from an existing QA run row and filing roots, then executes the audit loop:

Grep Probe -> Evidence Preview -> Failure Diagnosis -> Skill Candidate Proposal -> Regression Gate -> Case Summary

It still does not rerun the core RAG pipeline. It is an audit/evolution runner over existing outputs.

## Implementation

New file:

- `src/skillops/vertical_slice_runner.py`

Main CLI:

```bash
PYTHONPATH=src python -m skillops.vertical_slice_runner \
  --row_json <existing_run_output.json> \
  --row_index <n> \
  --grep_root <filing_root_or_file> \
  --out_dir <case_output_dir> \
  --case_id <case_id> \
  --eval_summary <optional_eval_summary.json>
```

Generated artifacts per case:

- grep probe JSON
- evidence preview JSON/Markdown
- failure report JSON/Markdown
- skill candidate YAML/Markdown
- gate eval summary JSON
- gate decisions YAML/Markdown
- case summary JSON/Markdown

## Case 1: Lotus Success Runner

Command input:

- Run row: `test/colm/retrieval/lotus_mini10_generalization_20260604/lotus_mini10_pageindex_fallback_run.json`
- Row index: 0
- Grep root: `/root/autodl-tmp/RAG_Agent_data/lotus/20250701/final_meta`

Output directory:

- `test/colm/retrieval/skillops_runner_step7_20260605/lotus_q1_success/`

Result:

- QID: `lotus_gen_01`
- Primary failure type: `no_failure_detected`
- Proposal count: 0
- Gate decisions: 0

## Case 2: NVIDIA Source-Conflict Runner

Command input:

- Run row: `test/colm/retrieval/nvidia_mini10_period_source_conflict_20260605/e2e_q15_period_repair.json`
- Row index: 0
- Grep roots:
  - `/root/autodl-tmp/RAG_Agent_data/nvidia/20260425/2_final_pdf_v2/20250126_10-K/base_final.json`
  - `/root/autodl-tmp/RAG_Agent_data/nvidia/20260425/2_final_pdf_v2/20250427_10-Q/base_final.json`
  - `/root/autodl-tmp/RAG_Agent_data/nvidia/20260425/2_final_pdf_v2/20251026_10-Q/base_final.json`
- Eval summary: `test/colm/retrieval/skill_candidate_step6_20260605/nvidia_q15_gate_eval_summary.json`

Output directory:

- `test/colm/retrieval/skillops_runner_step7_20260605/nvidia_q15_source_conflict/`

Result:

- QID: `qa_kp_000015`
- Primary failure type: `source_conflict`
- Failure confidence: 0.95
- Proposal count: 2
- Gate decisions: `proposed`, `proposed`

## Interpretation

The runner demonstrates that the Step 1-6 loop is reproducible from one command for both a clean success case and a diagnosed repair case. This is stronger than a hand-assembled report and is suitable for an EMNLP Industry demo pipeline.

Next step: add more case studies for table alignment, metric alias, answer coverage, and retrieval miss; then generate an ablation-style paper report over the case suite.

