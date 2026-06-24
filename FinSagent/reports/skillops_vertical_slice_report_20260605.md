# Human-Governed SkillOps Vertical Slice

## One-Line Claim

Static RAG and structure-aware retrieval are not enough for reliable SEC QA; a governed SkillOps layer can make evidence, failures, candidate skills, and promotion decisions auditable.

## End-to-End Loop

Question -> Retrieval -> Grep Probe -> Evidence Preview -> Failure Diagnosis -> Skill Candidate Proposal -> Regression Gate

## Completed Steps

| Step | Component | What It Adds | Key Artifacts |
| --- | --- | --- | --- |
| Step 1 | Skill Registry | Wrapped existing SEC-specific patches as governed skill cards with status, scope, risk, and eval metadata. | [OK] `configs/skill_cards/`<br>[OK] `reports/skill_registry_report.md` |
| Step 2 | Grep Evidence Probe | Added structured lexical evidence anchors: exact phrase, regex, metric alias, period phrase, and nearby number. | [OK] `src/grep/grep_probe.py`<br>[OK] `test/colm/retrieval/GREP_PROBE_STEP2_REPORT_20260605.md`<br>[OK] `test/colm/retrieval/grep_probe_step2_20260605/lotus_q1_probe_report.md` |
| Step 3 | Evidence Preview | Unified retrieval chunks, grep anchors, final answer, and skill traces into auditable JSON/Markdown previews. | [OK] `src/preview/evidence_preview.py`<br>[OK] `test/colm/retrieval/EVIDENCE_PREVIEW_STEP3_REPORT_20260605.md`<br>[OK] `test/colm/retrieval/evidence_preview_step3_20260605/lotus_q1_success_preview.md`<br>[OK] `test/colm/retrieval/evidence_preview_step3_20260605/nvidia_q15_source_conflict_preview.md` |
| Step 4 | Failure Explainer | Added rule-based failure diagnosis over evidence previews and run rows. | [OK] `configs/failure_taxonomy.yaml`<br>[OK] `src/diagnosis/failure_explainer.py`<br>[OK] `test/colm/retrieval/FAILURE_EXPLAINER_STEP4_REPORT_20260605.md`<br>[OK] `test/colm/retrieval/failure_explainer_step4_20260605/nvidia_q15_source_conflict_failure_report.md` |
| Step 5 | Skill Candidate Proposal | Generated proposal-only YAML/Markdown candidate skills from FailureReport without writing production code. | [OK] `src/diagnosis/skill_candidate_generator.py`<br>[OK] `test/colm/retrieval/SKILL_CANDIDATE_STEP5_REPORT_20260605.md`<br>[OK] `test/colm/retrieval/skill_candidate_step5_20260605/nvidia_q15_skill_candidates.md` |
| Step 6 | Regression Gate | Added conservative gate decisions over proposals and eval summaries; candidates stay proposed without human review. | [OK] `src/skillops/gate_runner.py`<br>[OK] `test/colm/retrieval/REGRESSION_GATE_STEP6_REPORT_20260605.md`<br>[OK] `test/colm/retrieval/skill_candidate_step6_20260605/nvidia_q15_gate_decisions.md` |

## Case Studies

### Success Control: Lotus Revenue Question

- QID: `lotus_gen_01`
- Role: Correct answer with aligned retrieval and grep anchors
- Result: Failure explainer returns no_failure_detected; no skill proposal is generated.
- Key artifacts: `test/colm/retrieval/evidence_preview_step3_20260605/lotus_q1_success_preview.md`, `test/colm/retrieval/failure_explainer_step4_20260605/lotus_q1_success_failure_report.md`, `test/colm/retrieval/skill_candidate_step5_20260605/lotus_q1_success_skill_candidates.md`

This case shows the loop does not hallucinate failures or propose unnecessary skills for a clean successful answer.

### Failure/Repair: NVIDIA FY2025 Export-Control Source Conflict

- QID: `qa_kp_000015`
- Role: Previously incorrect answer repaired by source-conflict skill and diagnosed by Failure Explainer
- Result: Failure explainer classifies source_conflict with 0.95 confidence; proposal generator emits two proposed skills.
- Key artifacts: `test/colm/retrieval/evidence_preview_step3_20260605/nvidia_q15_source_conflict_preview.md`, `test/colm/retrieval/failure_explainer_step4_20260605/nvidia_q15_source_conflict_failure_report.md`, `test/colm/retrieval/skill_candidate_step5_20260605/nvidia_q15_skill_candidates.md`, `test/colm/retrieval/skill_candidate_step6_20260605/nvidia_q15_gate_decisions.md`

This case demonstrates the research loop: evidence preview exposes the issue, diagnosis classifies it, candidate generation proposes bounded fixes, and the gate keeps them proposed until review.

## Benchmark Context

- Cross-company v1.1: 40/40 correct, weighted score 5.0.
- Companies: Zeekr, Lotus Technology, NVIDIA

## Known Gaps / Next Work

- The loop currently summarizes existing run artifacts; it is not yet a single end-to-end command over arbitrary new questions.
- Failure explainer is rule-based and should later be evaluated for diagnosis precision/recall.
- Grep probe is a lexical audit side-channel, not an answerer; aliases and Chinese-English expansion need systematic company-profile support.
- Regression gate uses protected-set summaries and manual-review flags; full implementation-specific reruns are still future work.
- Candidate proposals are proposal-only by design and require human review before implementation.

## Paper Framing

The current artifact is a minimal vertical slice, not a full production platform. Its contribution is a controlled loop that transforms ad hoc SEC QA fixes into governed, inspectable SkillOps objects.

Recommended next engineering step: add a single command that runs this loop on new examples and appends results to a rolling benchmark report.
