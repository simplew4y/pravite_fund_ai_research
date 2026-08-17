# RSI Round 1 Skill Replay Report

## Outcome

The first real-code, non-production RSI cycle completed on 2026-08-17. The
candidate was classified as `needs_more_evidence`; it was not promoted or
applied to the main worktree.

- Cycle: `period_noop_guard_round_1`
- Candidate: `cand-period-noop-guard-v1`
- Baseline commit: `155df0389b2ded02f383548f3e06e4ccb4490b22`
- Patch SHA-256: `bb3cf7395218a8af49b76672aa8931a5b4495b7084d1117d14c85379447daf6d`
- Evaluator snapshot SHA-256: `1b02cdb0b7889e83564a330e65f4c71579bbab928efb6d0d0961d005ac55401e`
- Target: real `repair_period_source_conflict` loaded from separate baseline and candidate worktrees
- Evaluation: 4 cases × 3 identical seeds = 12 paired observations
- Production service/config/data changes: none

## Candidate mechanism

The baseline treats any `H20`, `FY2026`, or other configured future marker as
leakage. It therefore rewrites a correct answer that explicitly says later
evidence **must not** be used for the requested period. The L2 candidate ignores
a future marker only when the same segment contains an explicit exclusion phrase
such as “should not be used” or “不应覆盖”.

The patch is stored at
`FinSagent/configs/rsi/candidates/period_noop_guard_v1.patch`. It was applied
only in a detached worktree after path-policy and `git apply --check` validation.

## Metrics

| Metric | Baseline | Candidate | Delta |
| --- | ---: | ---: | ---: |
| Success | 0.75 | 1.00 | +0.25 |
| Atomic correctness | 0.875 | 1.00 | +0.125 |
| Citation support | 1.00 | 1.00 | 0.00 |
| Scope control | 0.75 | 1.00 | +0.25 |
| Refusal quality | 1.00 | 1.00 | 0.00 |

Candidate critical errors and false-positive triggers were zero, mechanism
attribution was 100%, and the protected replay slice had no regression. The
overall success-delta bootstrap 95% interval was `[0.0, 0.5]`.

## Why it was not promoted

Only one independent fresh-internal case was available. Three seeds create
three observations, not three independent questions. Policy requires at least
five independent fresh cases, so the only blocking result was:

`fresh internal case count below minimum`

This validates the machinery and candidate hypothesis locally; it does not
establish general FinSagent capability gain.

## Isolation and next gate

Evaluator rubrics live outside the target repository with directory mode `0700`
and file mode `0600`. The run produced a hash-chained trace, content-addressed
archive, paired observations, retained candidate worktree, and cycle summary.

Before full-agent A/B, curate at least four more independent fresh period/source
cases from local authorized evidence, including cross-company and missing-evidence
refusal cases. Then connect the same hidden judge contract to
`ChatService.generate_response_debug_async` in an isolated process with a
separate session database.
