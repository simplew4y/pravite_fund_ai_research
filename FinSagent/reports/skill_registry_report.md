# SkillOps Registry Report

This report lists governed SEC QA skills currently represented as skill cards.

## Summary

- Total skill cards: 8
- Status counts: {'promoted': 5, 'experimental': 3}
- Failure-type coverage: {'answer_coverage_failure': 3, 'profile_boundary_error': 2, 'wrong_source': 3, 'retrieval_miss': 2, 'source_conflict': 4, 'table_alignment_error': 3, 'metric_alias_error': 3, 'period_mismatch': 2}

## Skill Cards

| Skill | Status | Failure Types | Scope | Implementation |
| --- | --- | --- | --- | --- |
| `answer_coverage` v0.1.0 | promoted | answer_coverage_failure, profile_boundary_error | Adds stable missing context when an answer contains the core fact but misses benchmark-required comparisons... | src/utils/answer_coverage_repair.py |
| `company_profile_boundary` v0.1.0 | promoted | profile_boundary_error, wrong_source, answer_coverage_failure | Handles stable corporate-profile facts such as headquarters, holding structure, ownership chain, service bo... | src/utils/profile_fact_repair.py |
| `evidence_rescue_scorer` v0.1.0 | experimental | retrieval_miss, source_conflict, table_alignment_error | Scores candidate evidence for rescue retrieval when the initial retrieval set may miss key table, date, or... | src/utils/evidence_rescue_scorer.py |
| `exact_evidence_probe` v0.1.0 | experimental | retrieval_miss, metric_alias_error, source_conflict | Uses grep-style lexical matching to produce auditable evidence snippets for concrete question terms. | src/utils/exact_evidence_preview.py |
| `period_alignment` v0.1.0 | promoted | period_mismatch, wrong_source, source_conflict | Controls retrieval around fiscal/calendar periods and prevents later filings from dominating period-specifi... | test/colm/retrieval/run_rescue_e2e_sample.py |
| `quant_skill_hints` v0.1.0 | experimental | metric_alias_error, table_alignment_error | Provides hints for financial metric interpretation, unit handling, and table-derived calculations. | src/utils/quant_skill_hints.py |
| `source_conflict` v0.1.0 | promoted | source_conflict, period_mismatch, wrong_source | Repairs answers that use later conflicting disclosures for a period-specific SEC question when period-compa... | src/utils/period_source_conflict_repair.py<br>test/colm/retrieval/run_rescue_e2e_sample.py |
| `table_evidence_verifier` v0.1.0 | promoted | table_alignment_error, metric_alias_error, answer_coverage_failure | Verifies and canonicalizes high-confidence numeric/table answers using extracted table facts, including del... | src/utils/table_fact_verifier.py<br>src/utils/table_answer_repair.py<br>src/utils/table_answer_gate.py |

## Audit Notes

### answer_coverage

- Trigger: Question intent matches a guarded coverage fact and the original answer is incomplete.
- Inputs: question, generated_answer
- Outputs: repaired_answer, coverage_fact_id, repair_reason, skill_trace
- Risks: Can be perceived as company-specific if facts are not clearly bounded and reviewed., Should not be used as a hidden answer factbook for unseen companies.
- Eval sets: zeekr_small30, zeekr_holdout20, final_stack_validation_20260603
- Last reviewed: 2026-06-05

For paper framing, this should be described as a guarded coverage skill with audit traces, not as free-form answer injection.

### company_profile_boundary

- Trigger: Question asks for stable company profile or corporate-structure facts covered by reviewed profile facts.
- Inputs: question, generated_answer
- Outputs: repaired_answer, profile_fact_id, cutoff, skill_trace
- Risks: Highest overfitting risk among current skills; should remain company-profile metadata, not answer memorization., Needs cross-company adaptation before being presented as a general mechanism.
- Eval sets: zeekr_holdout20, blind_holdout20_validation
- Last reviewed: 2026-06-05

Keep this skill explicitly bounded. Future work should move reusable parts into company_profiles and client_policies.

### evidence_rescue_scorer

- Trigger: Retrieval confidence is low or risk calibration suggests missing key evidence.
- Inputs: question, candidate_chunks, retrieval_scores
- Outputs: rescue_scores, selected_rescue_chunks, skill_trace
- Risks: Learning-based scorer can overfit if trained on a narrow diagnostic set., Must be evaluated on cross-company protected sets before promotion.
- Eval sets: rescue_scorer_v1_smoke_20260531, cross_company_benchmark_v1_1
- Last reviewed: 2026-06-05

Keep as experimental until cross-company and holdout gates show stable benefit.

### exact_evidence_probe

- Trigger: Question contains concrete terms, metrics, dates, product names, or entity names suitable for lexical probing.
- Inputs: question, filing_roots
- Outputs: exact_terms, evidence_hits, matched_terms, snippets
- Risks: Lexical hits can be noisy and should not directly answer questions., Exact matching misses paraphrases and filing-specific aliases without pattern expansion.
- Eval sets: exact_evidence_preview_smoke_20260604, lotus_mini10_generalization_20260604
- Last reviewed: 2026-06-05

This is the seed for the new grep evidence probe. It should be reframed as Evidence Preview / Audit Preview in reports.

### period_alignment

- Trigger: Question contains explicit fiscal year, quarter, reporting date, or cutoff phrasing.
- Inputs: question, filing_metadata, retrieved_chunks
- Outputs: period_cutoff_decision, backfill_decision, audit_metadata
- Risks: Over-filtering may hide useful later restatement or comparative evidence., Ambiguous natural-language dates may be mapped to the wrong fiscal period.
- Eval sets: zeekr_small30, zeekr_holdout20, cross_company_benchmark_v1_1
- Last reviewed: 2026-06-05

This card represents the existing guarded period-cutoff and backfill behavior used in final evaluation runs.

### quant_skill_hints

- Trigger: Question asks for financial metrics, percentage points, margin changes, capitalization, or period-over-period numeric comparisons.
- Inputs: question
- Outputs: metric_hints, unit_hints, calculation_hints
- Risks: Hints should guide verification, not replace evidence-backed calculation., Ambiguous metric names require filing-specific evidence anchors.
- Eval sets: quant_skill_integration_v1, zeekr_small30
- Last reviewed: 2026-06-05

Useful as a bridge between deterministic table verification and future metric-alias skill evolution.

### source_conflict

- Trigger: Generated answer contains later-period leakage markers and retrieved evidence contains a period-compatible source.
- Inputs: question, generated_answer, retrieved_chunks
- Outputs: repaired_answer, supporting_source, repair_reason, skill_trace
- Risks: Initial implementation is intentionally narrow and may not generalize to all fiscal-period conflicts., Bad trigger patterns could suppress legitimate later-period context.
- Eval sets: nvidia_mini10_period_source_conflict_20260605, cross_company_benchmark_v1_1
- Last reviewed: 2026-06-05

First guarded example of period-aware source arbitration; validated on the only NVIDIA cross-company miss.

### table_evidence_verifier

- Trigger: Question asks for numeric SEC table facts and retrieved or fallback chunks contain table evidence.
- Inputs: question, generated_answer, retrieved_chunks, reconstructed_table_chunks
- Outputs: verification_result, repaired_answer, quant_skill_hints, skill_trace
- Risks: Renderer coverage is intentionally partial and may leave unsupported table types unchanged., Canonicalization can look rigid if the answer requires qualitative interpretation.
- Eval sets: zeekr_small30, zeekr_holdout20, final_stack_validation_20260603
- Last reviewed: 2026-06-05

This is the main deterministic numeric verifier used to reduce harmful self-check behavior on table questions.
