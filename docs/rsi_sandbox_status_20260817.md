# RSI candidate sandbox and full-agent status (2026-08-17)

## Implemented

- Baseline full-agent debug runs accept question-only evaluator inputs.
- Debug-only Skill replay capture is disabled by default and enabled only in the RSI batch worker.
- Candidate pure-Skill replay runs without production configuration, credentials, databases, or hidden rubrics.
- `tools/rsi_landlock_exec.c` applies a filesystem allow list and seccomp denial for network, ptrace, mount, namespace, BPF, and performance-event syscalls before candidate execution.
- Private judge inputs are joined after target execution in a mode-0700 directory with mode-0600 files.

## Verified

- Evaluator tests: 12 passed.
- RSI control-plane tests: 9 passed.
- Landlock probe denied opening a non-allow-listed file.
- Seccomp probe denied `socket()` with `EPERM`.
- One full-agent baseline capture was replayed through `cand-period-noop-guard-v1`; its trace input hash matched, and both arms correctly produced a no-op with identical output.

## Not yet a production promotion

- One smoke case is a wiring check, not calibration evidence.
- The 70-case x 3-seed frozen evaluator has not completed paired scoring.
- Calling the configured LLM judge with hidden answers requires explicit authorization of that model endpoint as an approved private-data destination.
- Promotion remains human-reviewed; automatic production mutation is disabled.
- A production shadow/canary controller and service-level kill switch are still required before traffic exposure.
