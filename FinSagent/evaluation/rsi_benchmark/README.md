# Private Fund AI Recursive Report Benchmark

The primary benchmark unit is a complete investment research report, not a
standalone QA response. Existing questions are imported as hidden `ClaimRubric`
checks inside a `ResearchTask`; they test whether the final report covers and
correctly supports the underlying facts without forcing the output into a list of
unconnected answers.

## Build report tasks from the five source sets

```bash
python3 -m evaluation.rsi_benchmark.cli bootstrap-reports \
  --source /path/lotus.json \
  --source /path/financebench.json \
  --source /path/finder.json \
  --source /path/secque.json \
  --source /path/zeekr_fix.json \
  --out evaluation/benchmarks/private_fund_report_v0
```

The current inputs yield 77 report tasks backed by 555 hidden claim rubrics:
57 public development tasks and 20 internal hidden tasks. A task contains an
investment-research objective, required report sections, research requirements,
and source-document IDs. Expected answers, claim IDs, server paths, and page-level
evidence remain under the ignored `hidden/` evaluator directory.

After the target Agent writes a Markdown report, run the cheap format gate and
then create the evidence-aware judge packet:

```bash
python3 -m evaluation.rsi_benchmark.cli check-report \
  --task /path/one_task.json --report /path/report.md --out /tmp/format_gate.json

python3 -m evaluation.rsi_benchmark.cli prepare-report-judge \
  --task-id report-... \
  --tasks evaluation/benchmarks/private_fund_report_v0/hidden/tasks_with_claim_ids.jsonl \
  --claims evaluation/benchmarks/private_fund_report_v0/hidden/claim_rubrics.jsonl \
  --report /path/report.md --out /tmp/report_judge_packet.json
```

The format gate never claims factual correctness. The independent judge scores
claim coverage and evidence support plus thesis coherence, completeness, risk
balance, decision usefulness, and citation quality.

## Legacy claim-level bootstrap

This module turns the existing FinSAgent questions into a versioned benchmark and
creates the feedback packets used by a question-generating agent in later rounds.

The recursive loop is deliberately asymmetric:

1. Curators freeze a canonical dataset with answer keys and evidence provenance.
2. A public package exposes questions and capability metadata, never hidden answers.
3. The target agent is evaluated and an independent judge emits structured failures.
4. The generator sees abstract failure signals and coverage gaps, not internal items.
5. A critic verifies grounding, novelty, temporal scope, and answerability before a
   candidate can enter a future frozen benchmark version.

This separation prevents the improvement loop from silently training on its hidden
test answers. A generated question is a proposal, not a benchmark item, until it has
passed deterministic validation and evidence review.

## Bootstrap from the repository seeds

Run from `FinSagent/`:

```bash
python3 -m evaluation.rsi_benchmark.cli bootstrap \
  --source "Zeekr=evaluation/question_generation/qa_pairs.json" \
  --source "Lotus Technology=test/colm/retrieval/lotus_mini10_generalization_20260604/lotus_mini10.json" \
  --source "NVIDIA=test/colm/retrieval/nvidia_mini10_period_source_conflict_20260605/judge/results.json" \
  --out evaluation/benchmarks/private_fund_rsi_v0
```

The output contains:

- `canonical.jsonl`: complete curator copy; never provide it to the target agent.
- `public/questions.jsonl`: publishable questions without answer/evidence leakage.
- `internal/answer_key.jsonl`: hidden evaluation slice.
- `manifest.json`: source hashes, coverage, split policy, and rejected duplicates.

## Run the benchmark with the existing FinSAgent harness

Materialize a target-only input and a separate judge key. For an internal run,
both outputs should be created by the evaluator outside the target Agent's
filesystem or access scope.

```bash
python3 -m evaluation.rsi_benchmark.cli prepare-run \
  evaluation/benchmarks/private_fund_rsi_v0/canonical.jsonl \
  --split public --questions /tmp/rsi_public_questions.json \
  --judge-key /tmp/rsi_public_judge_key.json

EXPERIMENT_NAME=rsi_public_v0 \
QUESTIONS_JSON=/tmp/rsi_public_questions.json \
OUTPUT_JSON=/tmp/rsi_public_answers.json \
python3 batch_qa_test.py

python3 test/qa_llm_judge.py \
  --config config/production.yaml \
  --input_json /tmp/rsi_public_judge_key.json \
  --generated_answers_json /tmp/rsi_public_answers.json \
  --out_dir /tmp/rsi_public_judge
```

Use the same commands with `--split internal` only inside the hidden evaluator.
Never mount the generated judge key into the target Agent runtime.

## Produce the next agent generation packet

```bash
python3 -m evaluation.rsi_benchmark.cli next-round \
  evaluation/benchmarks/private_fund_rsi_v0/canonical.jsonl \
  --results /path/to/judge_results.json --round 1 \
  --out evaluation/benchmarks/private_fund_rsi_v0/round_1_generation_packet.json
```

The packet is provider-neutral and may be sent to an OpenAI-compatible agent, a
local model, or an orchestration workflow. Proposed rows should use the canonical
item schema. Apply the deterministic critic before independent evidence review:

```bash
python3 -m evaluation.rsi_benchmark.cli review-proposals \
  --frozen evaluation/benchmarks/private_fund_rsi_v0/canonical.jsonl \
  --proposals /path/to/agent_proposals.jsonl \
  --accepted /path/to/pre_review_accepted.jsonl \
  --report /path/to/proposal_review.json
```

This gate checks schema, evidence references, generator/round provenance, and
near-duplicates against frozen and same-round items. Passing it is not final
promotion: an independent model or human must still resolve the evidence and
verify every answer key. Do not promote questions merely because they make the
current agent fail.

## Adding the remaining company sets

The checked-in seeds currently resolve to Zeekr, Lotus Technology, and NVIDIA.
Additional FinSAgent company files can be appended with another `--source
"Company=/path/questions.json"`; flat QA, judge-result, and screenshot-QA formats
are supported. Keep source documents or stable source IDs available so generated
answers can be independently re-grounded.
