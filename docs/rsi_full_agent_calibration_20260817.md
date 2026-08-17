# RSI full-agent calibration (2026-08-17)

## Run

- Frozen evaluator: `period_source_full_agent_v2_2`
- Baseline commit: `a0a028f`
- Candidate: `cand-period-noop-guard-v1`
- Sample: 6 cases x 3 seeds = 18 paired observations
- Target execution received question-only inputs.
- Hidden answers were joined only inside the private judge process.
- Candidate Skill replay ran under Landlock filesystem allow-listing and seccomp network denial.

## Results

| Metric | Baseline | Candidate |
|---|---:|---:|
| Pass count | 3/18 | 3/18 |
| Pass rate | 16.67% | 16.67% |
| Key-point coverage | 18.06% | 19.17% |
| Fail to pass | - | 0 |
| Pass to fail | - | 0 |

All 18 paired answers were byte-identical and all period/source Skill transitions were `no-op -> no-op`. Two independently judged verdicts differed despite identical answer text. Those differences are judge variance and must not be attributed to the candidate.

The dominant baseline error subtype was D2 (9/18). Human inspection of the first failed case confirmed a real retrieval/scope failure: evidence from unrelated companies displaced the requested company's answerable local evidence.

## Decision

`needs_more_evidence`; not production eligible.

The full-agent sample did not activate the candidate mechanism and produced no pass-rate gain. The earlier isolated Skill replay remains useful mechanism evidence, but it is insufficient for production promotion without full-agent trigger coverage, protected-suite stability, and a larger frozen-suite run.

## Next calibration changes

1. Stratify the next sample by expected Skill trigger/no-op instead of taking the first N evaluator rows.
2. Re-judge identical outputs or use a single paired-comparison prompt when verdict changes occur without answer changes.
3. Add retrieval-scope candidates for the observed D2 cluster; the current period no-op guard cannot address this dominant failure.
4. Keep automatic promotion disabled and require human review after shadow/canary gates.
