# Skill Registry Runner

Generated: 2026-06-03

## Purpose

`run_skill_registry_validation.py` is the first CLI wrapper for the future skill-evolution frontend. It reads the registry manifest, checks evidence paths, optionally runs lightweight deterministic gates, and writes a promotion-oriented validation report.

It intentionally does not run full generation or full LLM judge by default.

## Commands

Dry run:

```bash
/root/autodl-tmp/miniconda3/bin/python test/colm/retrieval/run_skill_registry_validation.py \
  --out_dir test/colm/retrieval/skill_registry_validation_dryrun_20260603
```

Lightweight gate flow:

```bash
/root/autodl-tmp/miniconda3/bin/python test/colm/retrieval/run_skill_registry_validation.py \
  --run_gates \
  --out_dir test/colm/retrieval/skill_registry_validation_gates_20260603
```

## Latest Run

Output directory:

`test/colm/retrieval/skill_registry_validation_gates_20260603/`

Summary:

- Artifact checks: 45 ok / 0 missing
- Development diagnostic gate: PASS, 20/20 ALLOW
- Protected small30 gate: PASS, 30/30 ALLOW
- NVIDIA mini10 cross-company gate: PASS, 10/10 ALLOW

Promotion recommendations:

- `table_verification_v1`: eligible for guarded promotion
- `source_conflict_v1`: eligible for guarded promotion
- `learning_rescue_scorer_v0`: keep offline
- `fact_registry_v0`: keep backlog
- `skill_evolution_mvp_v1`: candidate review, not fully automatic yet

## Boundary

The runner should remain a validation/orchestration tool. It can recommend promotion, but it should not silently rewrite production config or merge a high-risk skill.

Allowed to auto-promote later:

- low-risk deterministic verifier/renderer;
- no retrieval-policy change;
- no missing artifacts;
- protected and cross-company gates both pass.

Requires review:

- retrieval strategy changes;
- period cutoff changes;
- abstention behavior;
- learned scorer;
- company fact registry;
- any change that improves only noisy judge cases.
