# Collaborator Task: Exact Evidence Preview / Grep Skill Audit

Owner directory: `/root/autodl-tmp/dir_myz/FinSagent_pageindex_fast`

## Server Access

SSH config:

```sshconfig
Host rag_autodl_PRO_6000
  HostName connect.westd.seetacloud.com
  Port 18504
  User root
  IdentityFile ~/.ssh/id_ed25519
  ForwardAgent yes
```

After login:

```bash
cd /root/autodl-tmp/dir_myz/FinSagent_pageindex_fast
```

Please only work under `/root/autodl-tmp/dir_myz/`.

## Background

The current PageIndex Hybrid mainline already has:

- PageIndex hybrid retrieval as the main evidence retriever.
- Deterministic table verifier / answer gate.
- Profile and coverage repair for narrow, reviewed failure buckets.
- Quant skill hints for YoY/QoQ/gross-margin/unit-conversion style calculations.

Recent holdout result:

- Blind holdout20 after quant/profile integration: 19 CORRECT / 0 PARTIAL / 1 INCORRECT, correctness score 4.8.

The open question is whether a Claude/MCP-style `grep` skill should be added to the system preview. This task is to evaluate and design that addition without replacing the main RAG chain.

## Task

Design a lightweight `Exact Evidence Preview` layer based on grep / exact-match search.

It should be treated as:

- preview evidence,
- audit support,
- low-confidence rescue support,
- and failure diagnosis tooling.

It should not be treated as:

- the main retrieval architecture,
- a final answer source,
- or an automatic answer repair layer.

## Files To Inspect First

Current mainline:

- `src/core/RAG.py`
- `src/core/RAGManager.py`
- `src/utils/pageindexRetriever.py`
- `src/utils/table_fact_verifier.py`
- `src/utils/table_answer_gate.py`
- `src/utils/table_answer_repair.py`
- `src/utils/quant_skill_hints.py`
- `test/colm/retrieval/run_rescue_e2e_sample.py`

Reports / context:

- `test/colm/retrieval/PAGEINDEX_STAGE_FREEZE_REPORT_20260601.md`
- `test/colm/retrieval/final_stack_validation_20260603/quant_skill_integration_v1/QUANT_SKILL_INTEGRATION_V1_REPORT_20260603.md`
- `test/colm/retrieval/collaboration_20260603/STAGE_GOAL_AND_COLLAB_PLAN.md`

External reference from collaborator package, if available:

- `.claude/skills/finance-rag-core/scripts/cache_pdf_text.sh`
- `.claude/skills/finance-rag-core/scripts/search_pdf_text.sh`
- `.claude/skills/finance-rag-core/SKILL.md`

## Questions To Answer

1. Where should exact-match evidence appear in preview output?
2. What query terms should be searched?
   - entity aliases,
   - metric names,
   - years/quarters,
   - exact numbers from question or draft answer,
   - key-point phrases.
3. When should grep be triggered?
   - always for preview,
   - only on low-confidence retrieval,
   - only when answer gate is REVIEW/BLOCK,
   - only during judge/audit.
4. How should grep hits be displayed?
   - filename,
   - page or page index when available,
   - short quote,
   - matched terms,
   - confidence / warning label.
5. What should grep not be allowed to do?
   - no automatic answer overwrite,
   - no period substitution,
   - no table arithmetic without table verifier,
   - no source choice override without source-policy review.

## Suggested Output

Create a report under:

```bash
/root/autodl-tmp/dir_myz/review_exact_evidence_preview_<your_name>/
```

Recommended files:

- `EXACT_EVIDENCE_PREVIEW_DESIGN.md`
- `grep_preview_cases.csv`

Suggested CSV columns:

```csv
case_id,question,trigger_mode,grep_terms,hit_count,useful_hits,false_positive_risk,recommended_preview_text
```

## Minimal Experiment

Pick 10 questions:

- 3 table/numeric questions,
- 3 profile/entity questions,
- 2 latest/date-cutoff questions,
- 2 known failure or partial cases.

For each question, run a simple exact-match search over local extracted text or table content and classify whether the hits are useful.

Useful means:

- hit contains the requested entity + metric + period together,
- or helps locate the right filing/table,
- or explains why the answer/gold is unsupported.

Not useful means:

- generic keyword hit,
- wrong period,
- wrong entity,
- number appears without row/column/unit context,
- hit would mislead answer generation.

## Proposed Integration Boundary

If the experiment is positive, propose a `preview_only` module such as:

```text
src/utils/exact_evidence_preview.py
```

Expected behavior:

1. Input: question, optional draft answer, retrieved chunks.
2. Extract search terms.
3. Search local cached text/table content.
4. Return top compact hits.
5. Attach hits to preview/debug output only.

Do not wire it into final answer generation without a separate review.

## Deliverable Standard

The report should end with one of three recommendations:

1. `adopt_preview_only`: useful enough to add as a preview/audit feature.
2. `adopt_audit_only`: useful for debugging, but too noisy for normal preview.
3. `do_not_adopt`: not enough benefit over current PageIndex evidence and table verifier.

The best possible outcome is not necessarily "add grep everywhere"; the best outcome is a clear boundary that makes the system more auditable without making answer generation noisier.
