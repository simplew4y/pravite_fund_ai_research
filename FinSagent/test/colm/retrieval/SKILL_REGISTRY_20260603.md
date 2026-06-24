# Skill Registry

Registry version: `2026-06-03.v1`

Track reusable SEC RAG skills, validation evidence, risk level, and stopping boundaries so optimization does not devolve into local benchmark patching.

## Executive Summary

- Total skills tracked: 10
- Status counts: Backlog=1, Candidate promote=4, Frozen baseline=1, Offline candidate=1, Promoted guarded=3
- Risk counts: high=1, low=4, medium=5

## Boundary Policy

- Default iteration budget per skill: 2

Promotion requirements:
- Protected regression set must not regress.
- Cross-company sanity set must not regress.
- The skill must improve a named failure bucket or a documented target case.
- The fix must be explainable from retrieved evidence or deterministic table facts.
- Fresh rotating diagnostics are required before broad promotion when the skill was derived from old failures.
- Blind holdout remains untouched until final validation.

Stop conditions:
- Stop after two consecutive iterations without target improvement.
- Stop when the next fix requires company-specific fact registry entries rather than a general skill.
- Stop when the improvement only comes from judge-noisy cases without deterministic evidence.
- Stop when protected or cross-company gates regress.
- Stop when adding one skill creates a composition conflict with an existing promoted skill.
- Stop when the failure bucket is saturated and move to the next highest-risk bucket.

Auto approval policy:
- eligible: Low-risk deterministic verifier or renderer with no retrieval-side change and clean gates.
- review_required: Any retrieval-policy, date-cutoff, abstention, fact-registry, or cross-skill composition change.
- blocked: Any change that hard-codes benchmark answers, hides uncertainty, or weakens protected gates.

## Validation Sets

### protected_regression
- Name: Zeekr small30
- Path: `test/colm/retrieval/subquery_cap2_small30_20260530/small30_coverage_repaired_v1.json` (ok)
- Role: Protect the known-good target-company sanity set.

### development_diagnostic
- Name: Zeekr holdout20 diagnostic
- Path: `test/colm/retrieval/holdout20_cap2_20260531/holdout20_coverage_repaired_v1.json` (ok)
- Role: Expose remaining high-risk failure buckets; not a final blind leaderboard.

### cross_company_sanity
- Name: NVIDIA mini10
- Path: `test/colm/retrieval/nvidia_mini10_cap2_20260601/mini10.json` (ok)
- Role: Check that target-company skills do not become brittle Zeekr-only behavior.

### rotating_diagnostic_pool
- Name: Skill evolution rotating diagnostics
- Path: `test/colm/retrieval/skill_evolution_testsets_20260602/rotating_diagnostic_candidates.json` (ok)
- Role: Refresh failure discovery and reduce overfitting to old diagnostics.

### blind_holdout_pool
- Name: Skill evolution blind holdout candidates
- Path: `test/colm/retrieval/skill_evolution_testsets_20260602/blind_holdout_candidates.json` (ok)
- Role: Reserved final validation; do not use for skill generation.

## Skill Summary

| skill | status | risk | auto approval | type |
| --- | --- | --- | --- | --- |
| pageindex_hybrid_retrieval_v1 | Frozen baseline | medium | review_required | retrieval_architecture |
| parameter_slimming_cap2_v1 | Promoted guarded | low | eligible | engineering_cost_control |
| period_cutoff_backfill_v1 | Promoted guarded | medium | review_required | retrieval_policy |
| coverage_repair_v1 | Promoted guarded | medium | review_required | post_generation_repair |
| table_verification_v1 | Candidate promote | low | eligible | deterministic_verifier |
| source_conflict_v1 | Candidate promote | low | eligible | deterministic_verifier |
| component_mix_table_v1 | Candidate promote | low | eligible | deterministic_verifier |
| learning_rescue_scorer_v0 | Offline candidate | medium | review_required | learned_ranker |
| fact_registry_v0 | Backlog | high | review_required | company_specific_memory |
| skill_evolution_mvp_v1 | Candidate promote | medium | review_required | meta_workflow |

## Skill Details

### pageindex_hybrid_retrieval_v1

- Name: PageIndex Hybrid Retrieval
- Status: Frozen baseline
- Risk: medium
- Auto approval: review_required
- Goal: Use structural page/node evidence with hybrid retrieval and rescue so SEC answers receive enough source context.
- Boundary: Do not keep changing the main retrieval architecture unless protected plus rotating diagnostics show a repeated cross-bucket failure that cannot be handled by a narrower skill.

Trigger conditions:
- SEC filing QA
- long document evidence
- tables and adjacent narrative are both likely needed

Primary files:
- `test/colm/retrieval/run_rescue_e2e_sample.py`
- `config/production_pageindex_fast.yaml`

Evidence artifacts:
- `test/colm/retrieval/PAGEINDEX_STAGE_FREEZE_REPORT_20260601.md` (ok)
- `test/colm/retrieval/PAGEINDEX_HYBRID_FULLRUN_PPT_REPORT_20260525.md` (ok)

Promotion evidence:
- Target-company small30 reached 30/30 under the current fast chain.
- NVIDIA mini10 sanity reached 9/10 and exposed a period-boundary issue rather than total retrieval collapse.

### parameter_slimming_cap2_v1

- Name: Parameter Slimming / Cap2 Runtime Control
- Status: Promoted guarded
- Risk: low
- Auto approval: eligible
- Goal: Reduce latency/cost while preserving the target-company correctness envelope.
- Boundary: Stop slimming once protected correctness stays stable but additional reductions risk context loss; future work should profile before cutting more retrieval evidence.

Trigger conditions:
- default evaluation run
- cost-sensitive validation
- protected regression must remain stable

Primary files:
- `config/production_pageindex_fast.yaml`
- `test/colm/retrieval/run_rescue_e2e_sample.py`

Evidence artifacts:
- `test/colm/retrieval/subquery_cap2_small30_20260530/standard_validation_coverage_v1_judge/judge/summary.json` (ok)
- `test/colm/retrieval/HUMAN_AUDIT_CAP2_SMALL30_20260531.md` (ok)

Promotion evidence:
- small30 remained 30/30 after slimming.
- Runtime became reportable at roughly one minute per question on the protected set.

### period_cutoff_backfill_v1

- Name: Period-Aware Cutoff and Backfill
- Status: Promoted guarded
- Risk: medium
- Auto approval: review_required
- Goal: Prevent future leakage and recover period-correct evidence for historical SEC questions.
- Boundary: Do not make cutoff stricter globally; keep it trigger-based and require review when a question does not specify a time boundary.

Trigger conditions:
- question names a quarter/year
- retrieved later filing may override historical period
- company event timeline has newer documents than the asked period

Primary files:
- `test/colm/retrieval/run_rescue_e2e_sample.py`
- `config/production_pageindex_fast.yaml`

Evidence artifacts:
- `test/colm/retrieval/PAGEINDEX_NEXT_PHASE_RUNBOOK_20260528.md` (ok)
- `test/colm/retrieval/NVIDIA_MINI10_SANITY_REPORT_20260601.md` (ok)

Promotion evidence:
- Period-boundary failures were observed on Zeekr and NVIDIA.
- The mode is guarded because latest-information questions can legitimately need newer filings.

### coverage_repair_v1

- Name: Answer Coverage Repair
- Status: Promoted guarded
- Risk: medium
- Auto approval: review_required
- Goal: Repair recurring partial-answer omissions without changing evidence retrieval.
- Boundary: Do not expand into a broad company factbook until all general retrieval/table/period skills have been exercised.

Trigger conditions:
- answer is factually consistent but misses a known required key point
- repair fact can be sourced from existing evidence or a narrow deterministic rule

Primary files:
- `test/colm/retrieval/apply_answer_coverage_repair.py`
- `src/utils/answer_coverage_repair.py`

Evidence artifacts:
- `test/colm/retrieval/holdout20_cap2_20260531/standard_validation_coverage_v1_judge/judge/summary.json` (ok)
- `test/colm/retrieval/HOLDOUT20_CAP2_FAILURE_ANALYSIS_20260531.md` (ok)

Promotion evidence:
- Useful for partial omissions, but it is more judge-sensitive than deterministic table facts.

### table_verification_v1

- Name: Deterministic Table Verification and Repair
- Status: Candidate promote
- Risk: low
- Auto approval: eligible
- Goal: Verify and repair high-risk table-derived answers using parsed SEC table facts.
- Boundary: Only add new table fact types when they are structurally detectable across filings. Do not hard-code isolated answer text.

Trigger conditions:
- cash balance
- quarterly R&D expenses
- quarterly revenue breakdown
- revenue contribution
- delivery volume breakdown

Primary files:
- `src/utils/table_fact_verifier.py`
- `src/utils/table_answer_gate.py`
- `src/utils/table_answer_repair.py`

Evidence artifacts:
- `test/colm/retrieval/TABLE_VERIFICATION_SKILL_V1_20260603.md` (ok)
- `test/colm/retrieval/skill_evolution_mvp_20260602/table_skill_v1/holdout20_table_repaired_v1_judge/judge/summary.json` (ok)
- `test/colm/retrieval/skill_evolution_mvp_20260602/table_skill_v1/small30_table_gate_v1.json` (ok)
- `test/colm/retrieval/skill_evolution_mvp_20260602/table_skill_v1/nvidia_mini10_table_gate_v1.json` (ok)

Promotion evidence:
- holdout20 moved from about 5C/4P/11I to 9C/3P/8I in one judge rerun.
- Repaired q57, q78, and q84 to table-gate PASS.
- small30 gate remained 30/30 ALLOW.
- NVIDIA mini10 gate remained 10/10 ALLOW.

### source_conflict_v1

- Name: Source Conflict / Discrepancy Reporting
- Status: Candidate promote
- Risk: low
- Auto approval: eligible
- Goal: Detect incompatible filing bases and answer with explicit discrepancy reporting instead of forcing one reconciled number.
- Boundary: Keep this skill discrepancy-focused. Do not use it to choose benchmark-preferred numbers unless both conflicting sources are shown.

Trigger conditions:
- delivery volume breakdown
- monthly table and separate quarterly table disagree
- same-looking metric appears under different reporting bases

Primary files:
- `src/utils/table_fact_verifier.py`
- `src/utils/table_answer_gate.py`
- `src/utils/table_answer_repair.py`

Evidence artifacts:
- `test/colm/retrieval/SOURCE_CONFLICT_SKILL_V1_20260603.md` (ok)
- `test/colm/retrieval/skill_evolution_mvp_20260602/source_conflict_skill_v1/q51_v2_judge/judge/summary.json` (ok)
- `test/colm/retrieval/skill_evolution_mvp_20260602/source_conflict_skill_v1/small30_gate_v2.json` (ok)
- `test/colm/retrieval/skill_evolution_mvp_20260602/source_conflict_skill_v1/nvidia_mini10_gate_v2.json` (ok)

Promotion evidence:
- q51 target judge moved to CORRECT after v2 wording.
- small30 gate remained 30/30 ALLOW.
- NVIDIA mini10 gate remained 10/10 ALLOW.
- The repair states the filing mismatch instead of hiding it.

### component_mix_table_v1

- Name: Component Mix Table Verification and Repair
- Status: Candidate promote
- Risk: low
- Auto approval: eligible
- Goal: Verify and repair annual cost-of-revenues and R&D expense component-mix answers using parsed SEC table rows.
- Boundary: Only use annual component-mix tables with structurally detectable RMB and percentage columns. Exclude interim tables and do not broaden into a company fact registry.

Trigger conditions:
- cost of revenues mix across years
- vehicle sales cost as a driver of total cost growth
- R&D outsourcing versus employee compensation mix
- annual component table with RMB values and percentage columns

Primary files:
- `src/utils/table_fact_verifier.py`
- `src/utils/table_answer_repair.py`

Evidence artifacts:
- `test/colm/retrieval/COMPONENT_MIX_TABLE_SKILL_V1_20260603.md` (ok)
- `test/colm/retrieval/skill_evolution_rotating_run_20260603/component_mix_skill_v1e/target_judge/summary.json` (ok)
- `test/colm/retrieval/skill_evolution_rotating_run_20260603/component_mix_skill_v1e/full_validation/judge/summary.json` (ok)
- `test/colm/retrieval/skill_evolution_rotating_run_20260603/component_mix_skill_v1e/full_validation/answer_gate_numeric_audit.json` (ok)
- `test/colm/retrieval/skill_registry_validation_after_component_mix_20260603/SKILL_REGISTRY_VALIDATION.md` (ok)

Promotion evidence:
- q134 and q135 targeted judge reached 2/2 CORRECT after deterministic repair.
- rotating20 improved from 6C/7P/7I to 8C/7P/5I.
- rotating20 gate improved from 18 ALLOW / 2 REVIEW to 19 ALLOW / 1 REVIEW.
- protected small30, development diagnostic, and NVIDIA mini10 lightweight gates remained PASS.

### learning_rescue_scorer_v0

- Name: Learning-Based Rescue Scorer
- Status: Offline candidate
- Risk: medium
- Auto approval: review_required
- Goal: Replace hand-written rescue scoring with a trained candidate scorer after enough labeled failures exist.
- Boundary: Do not put a learned scorer into the main chain only because it improves one diagnostic bucket. Require separate train/dev split and cross-company validation.

Trigger conditions:
- retrieval candidates include both correct and distracting evidence
- rule-based rescue cannot reliably rank evidence

Primary files:
- `test/colm/retrieval/export_rescue_training_data.py`
- `test/colm/retrieval/train_rescue_scorer.py`

Evidence artifacts:
- `test/colm/retrieval/skill_evolution_mvp_20260602/skill_proposals.md` (ok)

Promotion evidence:
- Offline scorer exists as a candidate; it should not be promoted until rotating diagnostics and cross-company validation are run.

### fact_registry_v0

- Name: Company Fact Registry
- Status: Backlog
- Risk: high
- Auto approval: review_required
- Goal: Store narrow high-value company facts only after general skills stop yielding meaningful gains.
- Boundary: Use only after current general skills are frozen and only as a separately measurable optional layer.

Trigger conditions:
- profile facts repeatedly fail despite correct evidence retrieval
- facts are stable and client-relevant
- manual or audited extraction is available

Primary files:
- None

Evidence artifacts:
- `test/colm/retrieval/HOLDOUT20_CAP2_FAILURE_ANALYSIS_20260531.md` (ok)

Promotion evidence:
- Not promoted. This is intentionally delayed to avoid turning the system into a Zeekr-only factbook too early.

### skill_evolution_mvp_v1

- Name: Skill Evolution MVP
- Status: Candidate promote
- Risk: medium
- Auto approval: review_required
- Goal: Analyze failures, propose skill candidates, refresh testsets, and run promotion gates.
- Boundary: The meta-workflow should propose and validate skills; it should not auto-edit production code without a promotion decision.

Trigger conditions:
- new judge results are available
- a candidate skill is proposed
- a validation report is needed

Primary files:
- `test/colm/retrieval/skill_evolution_analyzer.py`
- `test/colm/retrieval/skill_evolution_gate.py`
- `test/colm/retrieval/build_skill_evolution_testsets.py`

Evidence artifacts:
- `test/colm/retrieval/SKILL_EVOLUTION_MVP_20260602.md` (ok)
- `test/colm/retrieval/skill_evolution_mvp_20260602/promotion_gate/promotion_gate.md` (ok)
- `test/colm/retrieval/skill_evolution_testsets_20260602/testset_refresh_report.md` (ok)

Promotion evidence:
- Existing analyzer, gate, and testset refresh create the basis for a future frontend.

## Next Recommended Steps

- P0: Generate a single registry report from this manifest. Exit: A reviewer can see which skills are active, guarded, candidate, or backlog in one page.
- P0: Wire the registry into promotion gate output. Exit: Every candidate skill has a status, risk level, evidence artifacts, and a stop rule.
- P1: Add a small CLI runner for skill evolution. Exit: One command can analyze failures, update candidate cards, and render a report without changing production code.
- P2: Build a minimal frontend over the manifest. Exit: User can approve, reject, or pause skill candidates with validation evidence visible.
