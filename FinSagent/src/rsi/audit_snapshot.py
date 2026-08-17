"""Attach a non-secret evaluator snapshot digest to an existing RSI run."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

from .archive import AppendOnlyArchive
from .trace_collector import TraceCollector


def attach_evaluator_snapshot(*, out_dir: str | Path, evaluator_cases: str | Path) -> dict:
    output = Path(out_dir).resolve()
    cases_path = Path(evaluator_cases).resolve()
    summary_path = output / "cycle_summary.json"
    summary = json.loads(summary_path.read_text(encoding="utf-8"))
    case_count = sum(1 for line in cases_path.read_text(encoding="utf-8").splitlines() if line.strip())
    snapshot = {
        "schema_version": "rsi-evaluator-snapshot/v1",
        "cycle_id": str(summary["cycle_id"]),
        "sha256": hashlib.sha256(cases_path.read_bytes()).hexdigest(),
        "case_count": case_count,
        "content_embedded": False,
    }
    archive = AppendOnlyArchive(output / "archive")
    archive.put("evaluator_snapshot", str(summary["cycle_id"]), snapshot)
    trace = TraceCollector(output / "cycle_trace.jsonl", run_id=str(summary["cycle_id"]))
    trace.append("evaluator_snapshot_attached", snapshot)
    summary["evaluator_snapshot"] = snapshot
    summary_path.write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return snapshot


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", required=True)
    parser.add_argument("--evaluator-cases", required=True)
    args = parser.parse_args()
    print(json.dumps(attach_evaluator_snapshot(out_dir=args.out, evaluator_cases=args.evaluator_cases), indent=2))


if __name__ == "__main__":
    main()
