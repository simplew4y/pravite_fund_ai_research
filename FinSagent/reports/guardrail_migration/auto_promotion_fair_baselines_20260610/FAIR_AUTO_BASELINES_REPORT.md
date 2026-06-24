# Fair Auto-Promotion Baselines Report

Date: 2026-06-10

## Purpose

This branch extends the earlier auto-promotion risk baseline so the paper does not rely on a deliberately weak strawman. The experiment now compares increasingly stronger automatic promotion policies against governed SkillOps.

## Baselines

| Baseline | Promotion rule | Human review |
|---|---|---|
| `naive` | Promote any candidate that fixes its targeted positive case. | No |
| `self_review_proxy` | Promote only when an automatic card-level reviewer sees company, year, period, and evidence guards. | No |
| `static_guarded` | Promote only when the candidate passes a fixed target/noop/scope/cross-company regression suite. | No |
| governed SkillOps | Use the real engineered profile repair with legacy fallback disabled; production promotion remains human-controlled. | Yes |

## Long-Cycle Result

Run setup: 5 seeds, 5,000 cycles per seed, 25,000 simulated candidate cycles total.

| Seed | Naive false triggers | Self-review false triggers | Static-guarded false triggers | Governed status |
|---:|---:|---:|---:|---|
| 7 | 12 | 3 | 0 | PASS |
| 13 | 12 | 3 | 0 | PASS |
| 19 | 12 | 3 | 0 | PASS |
| 23 | 12 | 3 | 0 | PASS |
| 29 | 12 | 3 | 0 | PASS |

Average final false triggers:

| Baseline | Avg. false triggers | Interpretation |
|---|---:|---|
| `naive` | 12.0 | Local target pass alone is too broad. |
| `self_review_proxy` | 3.0 | Automatic review helps but still misses subtle protected noops and accounting-scope boundaries. |
| `static_guarded` | 0.0 | Fixed regression guards can block the observed false triggers in this suite. |
| governed SkillOps | 0.0 | Same protected behavior, with human-controlled promotion for accountability and future suite updates. |

## Key Finding

The fairer comparison changes the paper claim:

It is not "all automation is bad." A stronger automatic gate can remove the observed false triggers on this controlled suite. The remaining value of governed SkillOps is that promotion is auditable, protected by explicit suites, and accountable when new failure types appear. The human step is a governance layer over automatic discovery, explanation, proposal, and testing.

## Representative Self-Review Misses

The `self_review_proxy` baseline still promotes some candidates that pass company/year/period/evidence checks but are too aggressive:

| Case | Risk type | Why static/guided gate matters |
|---|---|---|
| `zeekr_correct_with_evidence_noop` | Already-correct answer overwritten | A card-level reviewer sees evidence but does not test "do not rewrite a correct answer." |
| `zeekr_full_year_attributable_scope_negative` | Accounting-scope mismatch | The question is full-year and evidence exists, but the scope is shareholder-attributable loss rather than consolidated net loss. |
| `nvidia_correct_with_evidence_noop` | Already-correct answer overwritten | Evidence sufficiency alone does not imply repair is needed. |

## Paper Framing

Use the result as a layered baseline:

1. `naive` shows why local-target auto-promotion is unsafe.
2. `self_review_proxy` shows that automatic self-review improves safety but can still miss subtle QA boundaries.
3. `static_guarded` shows that fixed regression gates are a strong non-human baseline.
4. governed SkillOps should be positioned as the deployable workflow: automatic skill proposal plus explicit suites and human-controlled promotion, not as a claim that humans are needed for every low-level check.

## Artifact Paths

Server root:

```text
/root/autodl-tmp/dir_myz/FinSagent_pageindex_fast/test/colm/retrieval/auto_promotion_fair_baselines_20260610_long
```

The raw per-seed outputs are intentionally not committed because each seed directory contains large cycle traces. The lightweight reproducible runner is:

```text
test/colm/retrieval/run_auto_promotion_risk_baseline.py
```
