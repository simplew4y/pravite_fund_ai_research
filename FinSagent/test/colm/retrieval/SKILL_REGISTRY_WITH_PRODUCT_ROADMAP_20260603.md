# Skill Registry

Registry version: `2026-06-03.v1`

Track reusable SEC RAG skills, validation evidence, risk level, and stopping boundaries so optimization does not devolve into local benchmark patching.

## Executive Summary

- Total skills tracked: 16
- Status counts: Backlog=1, Candidate promote=7, Frozen baseline=1, Offline candidate=1, Promoted guarded=6
- Risk counts: high=2, low=4, medium=10

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
| period_answer_coverage_v1 | Candidate promote | medium | review_required | post_generation_repair |
| table_verification_v1 | Promoted guarded | low | eligible | deterministic_verifier |
| capitalization_table_v1 | Candidate promote | medium | review_required | deterministic_verifier |
| ownership_chain_v1 | Candidate promote | medium | review_required | company_profile_structure |
| latest_financial_snapshot_v1 | Candidate promote | medium | review_required | company_profile_snapshot |
| profile_descriptor_numeric_cleanup_v1 | Candidate promote | medium | review_required | answer_quality_repair |
| source_conflict_v1 | Promoted guarded | low | eligible | deterministic_verifier |
| component_mix_table_v1 | Promoted guarded | low | eligible | deterministic_verifier |
| learning_rescue_scorer_v0 | Offline candidate | medium | review_required | learned_ranker |
| fact_registry_v0 | Backlog | high | review_required | company_specific_memory |
| skill_evolution_mvp_v1 | Candidate promote | medium | review_required | meta_workflow |
| product_roadmap_latest_v1 | Candidate promote | high | review_required | latest_product_profile |

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

### period_answer_coverage_v1

- Name: Period Answer Coverage Repair
- Status: Candidate promote
- Risk: medium
- Auto approval: review_required
- Goal: Repair period-specific partial answers where the core fact is correct but required USD, YoY/QoQ, or period context is omitted.
- Boundary: Do not broaden into a Zeekr factbook. Exclude disputed metric definitions such as q85, and prefer structural table/filing extraction before adding more curated coverage facts.

Trigger conditions:
- question names an explicit year or quarter
- question names a supported metric such as net profit/loss, R&D expense, or delivery volume
- the missing item is a stable auditable period fact rather than a disputed metric definition

Primary files:
- `src/utils/answer_coverage_repair.py`
- `test/colm/retrieval/apply_answer_coverage_repair.py`

Evidence artifacts:
- `test/colm/retrieval/PERIOD_ANSWER_COVERAGE_SKILL_V1_20260603.md` (ok)
- `test/colm/retrieval/skill_evolution_rotating_run_20260603/period_coverage_skill_v1/target4_judge/summary.json` (ok)
- `test/colm/retrieval/skill_evolution_rotating_run_20260603/period_coverage_skill_v1/full_validation/judge/summary.json` (ok)
- `test/colm/retrieval/skill_evolution_rotating_run_20260603/period_coverage_skill_v1/full_validation/answer_gate_numeric_audit.json` (ok)
- `test/colm/retrieval/skill_registry_validation_after_period_coverage_20260603/SKILL_REGISTRY_VALIDATION.md` (ok)

Promotion evidence:
- Targeted period cases q93, q94, q95, and q98 moved from 4 PARTIAL to 4 CORRECT.
- Rotating20 moved from 8C/7P/5I after component mix to 12C/2P/6I after period coverage.
- The only added incorrect in the judge rerun was q129, which was untouched by this skill and belongs to capitalization-table line-item reasoning.
- Numeric gate remained 19 ALLOW / 1 REVIEW; the single review remains the known q129 capitalization case.
- Registry protection validation after the source change found 52/52 artifacts and gate flow PASS.

### table_verification_v1

- Name: Deterministic Table Verification and Repair
- Status: Promoted guarded
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

### capitalization_table_v1

- Name: Capitalization Table Line-Item Repair
- Status: Candidate promote
- Risk: medium
- Auto approval: review_required
- Goal: Answer Actual / Pro Forma / Pro Forma as adjusted capitalization questions by comparing exact liability and equity line items from parsed SEC tables.
- Boundary: Keep this skill limited to parsed capitalization tables. Source tie-breaking for multiple pro forma as adjusted filings must remain explicit and reviewable.

Trigger conditions:
- capitalization table with Actual, Pro Forma, and Pro Forma as adjusted columns
- question asks whether changes are mainly liability reductions
- line-item values are structurally detectable from parsed SEC table rows

Primary files:
- `src/utils/table_fact_verifier.py`
- `src/utils/table_answer_repair.py`

Evidence artifacts:
- `test/colm/retrieval/CAPITALIZATION_TABLE_SKILL_V1_20260603.md` (ok)
- `test/colm/retrieval/skill_evolution_rotating_run_20260603/capitalization_skill_v1/q129_judge/summary.json` (ok)
- `test/colm/retrieval/skill_evolution_rotating_run_20260603/capitalization_skill_v1/full_validation/judge/summary.json` (ok)
- `test/colm/retrieval/skill_evolution_rotating_run_20260603/capitalization_skill_v1/full_validation/answer_gate_numeric_audit.json` (ok)
- `test/colm/retrieval/skill_registry_validation_after_capitalization_20260603/SKILL_REGISTRY_VALIDATION.md` (ok)

Promotion evidence:
- Target q129 moved from INCORRECT to CORRECT with correctness score 5.0.
- Rotating20 deterministic gate improved to 20 ALLOW / 0 REVIEW.
- Full rotating20 judge after repair was 12C/3P/5I; q129 improved while q63 variance was unrelated to this repair.
- Registry protection validation after the source change found 59/59 artifacts and gate flow PASS.

### ownership_chain_v1

- Name: Corporate Ownership Chain Repair
- Status: Candidate promote
- Risk: medium
- Auto approval: review_required
- Goal: Answer explicit SEC corporate-structure questions asking whether a Cayman parent controls a main China operating company through a 100% ownership chain.
- Boundary: Do not broaden into a general factbook. Keep this limited to explicit disclosed ownership-chain questions; broader subsidiaries, non-wholly-owned entities, VIE arrangements, and latest post-merger ownership require separate review.

Trigger conditions:
- question mentions Cayman parent
- question asks for a 100% or wholly owned chain
- question asks about the main China operating company
- ownership links are stable and disclosed in corporate-structure filings

Primary files:
- `src/utils/profile_fact_repair.py`
- `test/colm/retrieval/apply_profile_fact_repair.py`

Evidence artifacts:
- `test/colm/retrieval/OWNERSHIP_CHAIN_SKILL_V1_20260603.md` (ok)
- `test/colm/retrieval/skill_evolution_rotating_run_20260603/ownership_chain_skill_v1/q122_judge/summary.json` (ok)
- `test/colm/retrieval/skill_evolution_rotating_run_20260603/ownership_chain_skill_v1/full_validation/judge/summary.json` (ok)
- `test/colm/retrieval/skill_evolution_rotating_run_20260603/ownership_chain_skill_v1/full_validation/answer_gate_numeric_audit.json` (ok)
- `test/colm/retrieval/skill_registry_validation_after_ownership_chain_20260603/SKILL_REGISTRY_VALIDATION.md` (ok)

Promotion evidence:
- Target q122 moved from INCORRECT to CORRECT with correctness score 5.0.
- Rotating20 improved from 12C/3P/5I after capitalization to 14C/2P/4I after ownership-chain repair.
- The skill applied to exactly one row in rotating20.
- Deterministic gate remained 20 ALLOW / 0 REVIEW.
- Registry protection validation after the source change found 66/66 artifacts and gate flow PASS.

### latest_financial_snapshot_v1

- Name: Latest Financial Snapshot Guard
- Status: Candidate promote
- Risk: medium
- Auto approval: review_required
- Goal: Answer latest market-cap/liquidity and liability-level questions without falling back to stale annual-report values or transaction-implied valuation math.
- Boundary: Keep review-required. Q72 is table-backed by 2025Q1 6-K liabilities, but q21 mixes latest share/liquidity profile facts and source-date sensitivity. Do not use this skill to infer a market cap from privatization offer prices, do not answer live market-cap questions without current price evidence, and do not generalize it into a company factbook without separate source-policy review.

Trigger conditions:
- question explicitly asks Zeekr market capitalization and liquidity together
- question asks Zeekr asset-liability or liability level with latest-period intent
- retrieval contains stale annual-report or privatization-offer distractors

Primary files:
- `src/utils/profile_fact_repair.py`
- `test/colm/retrieval/apply_profile_fact_repair.py`

Evidence artifacts:
- `test/colm/retrieval/LATEST_FINANCIAL_SNAPSHOT_SKILL_V1_20260603.md` (ok)
- `test/colm/retrieval/skill_evolution_rotating_run_20260603/latest_snapshot_skill_v1/q21_q72_latest_snapshot_target.json` (ok)
- `test/colm/retrieval/skill_evolution_rotating_run_20260603/latest_snapshot_skill_v1/target2_judge/summary.json` (ok)
- `test/colm/retrieval/skill_evolution_rotating_run_20260603/latest_snapshot_skill_v1/target2_judge/results.json` (ok)
- `test/colm/retrieval/skill_evolution_rotating_run_20260603/latest_snapshot_skill_v1/full_validation/validation_summary.json` (ok)
- `test/colm/retrieval/skill_evolution_rotating_run_20260603/latest_snapshot_skill_v1/full_validation/eval_summary.json` (ok)
- `test/colm/retrieval/skill_evolution_rotating_run_20260603/latest_snapshot_skill_v1/full_validation/answer_gate_numeric_audit.json` (ok)
- `test/colm/retrieval/skill_evolution_rotating_run_20260603/latest_snapshot_skill_v1/full_validation/judge/summary.json` (ok)
- `test/colm/retrieval/skill_evolution_rotating_run_20260603/latest_snapshot_skill_v1/full_validation/judge/results.json` (ok)

Promotion evidence:
- Target q21/q72 judge: 2/2 CORRECT, correctness score 5.0.
- Rotating20 improved from 14/2/4 to 16/2/2 with no regressions versus ownership_chain baseline.
- Gate result stayed clean: 20 ALLOW, 0 BLOCK, severity none for all rows.
- The skill fixes a recurring latest-snapshot/stale-period failure bucket.

### profile_descriptor_numeric_cleanup_v1

- Name: Profile Descriptor And Numeric Cleanup
- Status: Candidate promote
- Risk: medium
- Auto approval: review_required
- Goal: Complete missing narrative descriptors and remove conflicting ancillary numeric details when the core answer is already on the right evidence path.
- Boundary: Keep review-required. This skill is limited to COVID impact descriptors, SEA platform descriptors, and H1 2023 operating leverage cleanup. Do not use it to patch product-roadmap questions, live latest facts, or metric-definition conflicts such as q85.

Trigger conditions:
- question asks Zeekr COVID impact
- question asks what platform Zeekr cars are built/developed on
- question asks H1 2023 operating leverage versus H1 2022

Primary files:
- `src/utils/profile_fact_repair.py`
- `src/utils/answer_coverage_repair.py`
- `test/colm/retrieval/apply_profile_fact_repair.py`
- `test/colm/retrieval/apply_answer_coverage_repair.py`

Evidence artifacts:
- `test/colm/retrieval/PROFILE_DESCRIPTOR_NUMERIC_CLEANUP_SKILL_V1_20260603.md` (ok)
- `test/colm/retrieval/skill_evolution_rotating_run_20260603/profile_descriptor_skill_v1/q45_q56_q59_q111_descriptor_cleanup_target.json` (ok)
- `test/colm/retrieval/skill_evolution_rotating_run_20260603/profile_descriptor_skill_v1/target4_judge/summary.json` (ok)
- `test/colm/retrieval/skill_evolution_rotating_run_20260603/profile_descriptor_skill_v1/target4_judge/results.json` (ok)
- `test/colm/retrieval/skill_evolution_rotating_run_20260603/profile_descriptor_skill_v1/full_validation_coverage_cleanup/validation_summary.json` (ok)
- `test/colm/retrieval/skill_evolution_rotating_run_20260603/profile_descriptor_skill_v1/full_validation_coverage_cleanup/eval_summary.json` (ok)
- `test/colm/retrieval/skill_evolution_rotating_run_20260603/profile_descriptor_skill_v1/full_validation_coverage_cleanup/answer_gate_numeric_audit.json` (ok)
- `test/colm/retrieval/skill_evolution_rotating_run_20260603/profile_descriptor_skill_v1/full_validation_coverage_cleanup/judge/summary.json` (ok)
- `test/colm/retrieval/skill_evolution_rotating_run_20260603/profile_descriptor_skill_v1/full_validation_coverage_cleanup/judge/results.json` (ok)

Promotion evidence:
- Target q45/q56/q59/q111 judge: 4/4 CORRECT, correctness score 5.0.
- Rotating20 improved from 16/2/2 to 18/0/2 versus latest_snapshot baseline.
- Baseline deltas: improved 2, same 18, regressed 0.
- Gate stayed clean: 20 ALLOW, 0 BLOCK, severity none.

### source_conflict_v1

- Name: Source Conflict / Discrepancy Reporting
- Status: Promoted guarded
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
- Status: Promoted guarded
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

### product_roadmap_latest_v1

- Name: Product Roadmap Latest Boundary
- Status: Candidate promote
- Risk: high
- Auto approval: review_required
- Goal: Answer narrow latest Zeekr product-roadmap and fuel-car boundary questions without mixing old launches or misclassifying hybrid vehicles as pure fuel cars.
- Boundary: Use only for explicit latest Zeekr new-model plan / fuel-car boundary questions. Do not broaden into a general product portfolio or company factbook. Local SEC evidence supports the 7GT/9X/Q3 hybrid disclosure, but Zeekr 9S / super-hybrid / 2.0T details require manual latest-news review before broad promotion.

Trigger conditions:
- Zeekr new car plan / new-model plan questions
- questions asking whether Zeekr plans to launch fuel cars
- product roadmap questions that explicitly mention fuel or hybrid boundary

Primary files:
- `src/utils/profile_fact_repair.py`
- `test/colm/retrieval/apply_profile_fact_repair.py`

Evidence artifacts:
- `test/colm/retrieval/PRODUCT_ROADMAP_LATEST_SKILL_V1_20260603.md` (ok)
- `test/colm/retrieval/skill_evolution_rotating_run_20260603/product_roadmap_skill_v1/q65_judge/summary.json` (ok)
- `test/colm/retrieval/skill_evolution_rotating_run_20260603/product_roadmap_skill_v1/q65_judge/results.json` (ok)
- `test/colm/retrieval/skill_evolution_rotating_run_20260603/product_roadmap_skill_v1/full_validation/judge/summary.json` (ok)
- `test/colm/retrieval/skill_evolution_rotating_run_20260603/product_roadmap_skill_v1/full_validation/eval_summary.json` (ok)
- `test/colm/retrieval/skill_evolution_rotating_run_20260603/product_roadmap_skill_v1/full_validation/answer_gate_numeric_audit.json` (ok)

Promotion evidence:
- q65 targeted judge reached 1/1 CORRECT with correctness score 5.0.
- rotating20 improved from 18C/0P/2I to 19C/0P/1I, correctness score 4.8.
- baseline delta: improved 1, same 19, regressed 0.
- numeric answer gate remained 20 ALLOW with no blocked rows.

## Next Recommended Steps

- P0: Investigate q85 other-sales-revenue definition conflict as the only remaining rotating20 incorrect case. Exit: Decide whether q85 is a gold/source-definition conflict, a deterministic table-mapping fix, or a case to leave as review_required.
- P0: Review product_roadmap_latest_v1 evidence boundary before promotion. Exit: Manual reviewer confirms whether Zeekr 9S / super-hybrid / 2.0T facts are acceptable latest-news evidence outside stable SEC table evidence.
- P0: Review latest_financial_snapshot_v1 source policy before promotion; q21 cash-reserve wording needs clean source-date confirmation. Exit: Latest snapshot source policy is reviewed before promotion.
- P0: Generate a single registry report from this manifest. Exit: A reviewer can see which skills are active, guarded, candidate, or backlog in one page.
- P0: Wire the registry into promotion gate output. Exit: Every candidate skill has a status, risk level, evidence artifacts, and a stop rule.
- P1: Add a small CLI runner for skill evolution. Exit: One command can analyze failures, update candidate cards, and render a report without changing production code.
- P2: Build a minimal frontend over the manifest. Exit: User can approve, reject, or pause skill candidates with validation evidence visible.
