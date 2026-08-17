"""Launch isolated baseline/candidate FinSagent debug batch workers."""

from __future__ import annotations

import hashlib
import json
import os
import subprocess
from dataclasses import asdict, dataclass
from pathlib import Path


@dataclass(frozen=True)
class DebugArmRun:
    arm: str
    repo: str
    commit: str
    output: str
    output_sha256: str
    row_count: int

    def to_dict(self) -> dict:
        return asdict(self)


def run_debug_arm(
    *, arm: str, repo: str | Path, config: str | Path, questions: str | Path,
    out_dir: str | Path, python: str, seeds: tuple[int, ...], candidate_id: str = "",
    max_cases: int = 0, timeout_seconds: int = 7200,
) -> DebugArmRun:
    repo = Path(repo).resolve()
    output_root = Path(out_dir).resolve() / arm
    output_root.mkdir(parents=True, exist_ok=False)
    output = output_root / "target_outputs.jsonl"
    command = (
        python, "-m", "evaluation.rsi_benchmark.debug_batch_worker",
        "--repo", str(repo / "FinSagent"), "--config", str(Path(config).resolve()),
        "--questions", str(Path(questions).resolve()), "--out", str(output),
        "--state-dir", str(output_root / "state"), "--arm", arm,
        "--candidate-id", candidate_id, "--seeds", ",".join(str(seed) for seed in seeds),
        "--max-cases", str(max_cases),
    )
    env = os.environ.copy()
    env["PYTHONPATH"] = f"{repo / 'FinSagent' / 'src'}:{repo / 'FinSagent'}"
    completed = subprocess.run(command, cwd=repo / "FinSagent", env=env, text=True, capture_output=True, timeout=timeout_seconds)
    (output_root / "worker.stdout.log").write_text(completed.stdout, encoding="utf-8")
    (output_root / "worker.stderr.log").write_text(completed.stderr, encoding="utf-8")
    if completed.returncode:
        raise RuntimeError(f"{arm} debug worker failed ({completed.returncode}); see {output_root}")
    rows = [line for line in output.read_text(encoding="utf-8").splitlines() if line.strip()]
    digest = hashlib.sha256(output.read_bytes()).hexdigest()
    commit = subprocess.run(("git", "rev-parse", "HEAD"), cwd=repo, text=True, capture_output=True, check=True).stdout.strip()
    result = DebugArmRun(arm, str(repo), commit, str(output), digest, len(rows))
    (output_root / "run_manifest.json").write_text(json.dumps(result.to_dict(), indent=2) + "\n", encoding="utf-8")
    return result
