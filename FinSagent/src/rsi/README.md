# FinSagent bounded RSI control plane

This package is an evaluator-side control plane. It does not change production
answers by itself and it never promotes a candidate automatically.

Lifecycle:

1. `TraceCollector` stores target-safe, append-only traces.
2. `cluster_failures` groups independently confirmed failures by mechanism.
3. `propose_candidates` emits multiple bounded hypotheses.
4. `validate_candidate` enforces mutation-level path and leakage policy.
5. `run_paired_experiment` runs baseline and candidate on identical cases/seeds.
6. `summarize` reports paired deltas, bootstrap confidence intervals, slices,
   critical errors, trigger quality, mechanism attribution, latency, and cost.
7. `decide_promotion` can only mark a candidate eligible for human review.
8. `PromotionRegistry` requires a reviewer and approval ticket; rollback is an
   audited intent referencing exact immutable artifacts.

Run unit and closed-loop tests from `FinSagent/`:

```bash
PYTHONPATH=src:. python -m unittest discover -s test/rsi -p 'test_*.py' -v
```

The first pilot is defined in
`configs/rsi/pilot_period_source_conflict_v1.yaml`. Frozen benchmarks, hidden
answers, evaluator code, production configuration, credentials, data, and model
weights are immutable boundaries.
