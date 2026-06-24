# Collaborator Task: Generalization and Slimming Audit

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

## Why This Task

The current system already has a strong target-company chain and has reached:

- Zeekr small30: 30/30
- Blind holdout20 after latest integration: 19/20, correctness score 4.8
- NVIDIA mini10 sanity: 9/10

The main risk is no longer "can the target set be fixed"; it is whether the skill layer is too long, too rigid, or too Zeekr-specific. This task asks for a horizontal audit rather than another local patch.

## Task

Audit the promoted/candidate skills and decide which should be:

1. Kept as deterministic production skills.
2. Converted to review-only hints.
3. Slimmed into a more general category-level skill.
4. Removed or left as experiment-only.

Focus on these files first:

- `test/colm/retrieval/SKILL_REGISTRY_20260603.md`
- `test/colm/retrieval/skill_registry_manifest_20260603.json`
- `src/utils/table_fact_verifier.py`
- `src/utils/table_answer_repair.py`
- `src/utils/profile_fact_repair.py`
- `src/utils/answer_coverage_repair.py`
- `src/utils/quant_skill_hints.py`
- `test/colm/retrieval/final_stack_validation_20260603/quant_skill_integration_v1/QUANT_SKILL_INTEGRATION_V1_REPORT_20260603.md`

## Specific Questions To Answer

1. Which skills are genuinely general SEC RAG skills?
2. Which skills are Zeekr-specific but still acceptable as source-policy/profile skills?
3. Which skills feel like benchmark-answer patching and should be downgraded?
4. Which trigger conditions are too broad and may cause skill conflicts?
5. Which skills can be merged into a smaller set of reusable categories?

## Suggested Output

Create a report under:

```bash
/root/autodl-tmp/dir_myz/review_generalization_slimming_<your_name>/
```

Recommended files:

- `GENERALIZATION_SLIMMING_REVIEW.md`
- `skill_decisions.csv`

Suggested CSV columns:

```csv
skill_id,current_status,decision,risk_level,reason,recommended_change
```

## Boundaries

- Do not tune answers against blind holdout cases.
- Do not add company-specific factbook entries.
- Do not modify the main retrieval architecture.
- Do not weaken table verification, date cutoff, or abstention behavior just to improve one case.
- If a skill only helps because it knows a specific gold answer, mark it as review-only or experiment-only.

## Optional Stretch

If time allows, propose how a future "skill evolution loop" should use:

- rotating diagnostics,
- cross-company sanity sets,
- exact-match preview/grep evidence,
- human review gates,
- and automatic skill-card approval rules.

The goal is to make future skills less manual, but still auditable and protected against overfitting.
