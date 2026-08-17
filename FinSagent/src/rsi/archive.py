"""Content-addressed, append-only candidate and experiment archive."""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
from typing import Any


def canonical_hash(payload: dict[str, Any]) -> str:
    encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


class AppendOnlyArchive:
    def __init__(self, root: str | Path) -> None:
        self.root = Path(root)
        self.objects = self.root / "objects"
        self.log = self.root / "index.jsonl"
        self.objects.mkdir(parents=True, exist_ok=True)

    def put(self, kind: str, object_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        digest = canonical_hash(payload)
        object_path = self.objects / f"{digest}.json"
        if not object_path.exists():
            descriptor = os.open(object_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
            try:
                os.write(descriptor, (json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n").encode("utf-8"))
            finally:
                os.close(descriptor)
        existing = [json.loads(line) for line in self.log.read_text(encoding="utf-8").splitlines()] if self.log.exists() else []
        collision = next((row for row in existing if row["kind"] == kind and row["object_id"] == object_id and row["digest"] != digest), None)
        if collision:
            raise ValueError(f"append-only identity collision for {kind}:{object_id}")
        entry = {"kind": kind, "object_id": object_id, "digest": digest, "object_path": str(object_path)}
        if entry not in existing:
            descriptor = os.open(self.log, os.O_APPEND | os.O_CREAT | os.O_WRONLY, 0o600)
            try:
                os.write(descriptor, (json.dumps(entry, ensure_ascii=False, sort_keys=True) + "\n").encode("utf-8"))
            finally:
                os.close(descriptor)
        return entry


def pareto_frontier(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Return non-dominated candidates: maximize quality, minimize latency/cost."""
    frontier: list[dict[str, Any]] = []
    for candidate in rows:
        dominated = False
        for other in rows:
            if other is candidate:
                continue
            no_worse = (
                float(other.get("quality", 0.0)) >= float(candidate.get("quality", 0.0))
                and float(other.get("latency_ms", float("inf"))) <= float(candidate.get("latency_ms", float("inf")))
                and float(other.get("cost_units", float("inf"))) <= float(candidate.get("cost_units", float("inf")))
            )
            strictly_better = (
                float(other.get("quality", 0.0)) > float(candidate.get("quality", 0.0))
                or float(other.get("latency_ms", float("inf"))) < float(candidate.get("latency_ms", float("inf")))
                or float(other.get("cost_units", float("inf"))) < float(candidate.get("cost_units", float("inf")))
            )
            if no_worse and strictly_better:
                dominated = True
                break
        if not dominated:
            frontier.append(candidate)
    return sorted(frontier, key=lambda row: (-float(row.get("quality", 0.0)), float(row.get("cost_units", 0.0))))
