# Paper Planning Flow

Date: 2026-06-10

## Why This Folder Exists

The current goal is not to write a full draft immediately. The goal is to prevent the draft from becoming a pile of engineering reports.

The planning order is:

1. Challenge
2. Motivation
3. Contribution
4. Benchmark summary
5. Baselines
6. Experiment setting
7. Related work
8. Adjust experiment setting
9. Then write the first draft

## Files

| File | Role |
|---|---|
| `PAPER_STRATEGY_CHALLENGE_MOTIVATION_CONTRIBUTION.md` | Defines the paper's core story and what not to overclaim. |
| `BENCHMARK_BASELINE_EXPERIMENT_SETTING.md` | Separates accuracy benchmark, SkillOps demo suite, targeted regression, and promotion-safety baselines. |
| `RELATED_WORK_SCOPING_20260610.md` | Maps related work buckets and explains how they should adjust the experiment setting. |

## Current Story After Planning

The strongest paper story is:

> FinSAgent SkillOps is not a fully autonomous self-evolving agent. It is a human-governed skill evolution workflow for reliable SEC filing QA. It uses evidence probes, failure taxonomy, skill candidates, and promotion gates to make RAG improvements auditable and safer to evolve.

## Experiment Setting After Related Work

Keep these experiments:

1. Protected cross-company validation: 40/40.
2. SkillOps demo suite: 6-case taxonomy workflow.
3. Guardrail migration: fallback-off 40/40 and profile precedence 6/6.
4. Fair auto-promotion baselines: naive, self-review proxy, static guarded, governed SkillOps.

Optional if time allows:

5. Strict mini ablation on one frozen subset:
   - vanilla / initial RAG
   - PageIndex Hybrid only
   - PageIndex + grep preview
   - full SkillOps guarded stack

This optional ablation would make the experiment section stronger, but the paper can be planned without it.

## What Not To Do Next

- Do not write the full paper draft immediately.
- Do not add a new large benchmark unless there is time to validate it carefully.
- Do not claim broad SOTA over FinanceBench or SECQUE.
- Do not frame static guarded auto as bad; it is a strong baseline.
- Do not make the paper depend on company-specific factbook customization.

## Recommended Next Action

Do a small related-work pass with BibTeX-quality citations, then decide whether to run the optional strict mini ablation. After that, write the first draft.
