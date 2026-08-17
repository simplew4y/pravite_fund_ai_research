"""Append-only, hash-chained RSI traces with evaluator-secret leakage guards."""

from __future__ import annotations

import hashlib
import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


FORBIDDEN_TRACE_KEYS = {
    "answer_key",
    "ground_truth_answer",
    "hidden_answer",
    "judge_key",
    "critic_private_reasoning",
    "evaluator_secret",
}


def _canonical(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def assert_trace_safe(value: Any, path: str = "trace") -> None:
    if isinstance(value, dict):
        for key, child in value.items():
            normalized = str(key).casefold()
            if normalized in FORBIDDEN_TRACE_KEYS or normalized.startswith("hidden_"):
                raise ValueError(f"forbidden evaluator field in target trace: {path}.{key}")
            assert_trace_safe(child, f"{path}.{key}")
    elif isinstance(value, (list, tuple)):
        for index, child in enumerate(value):
            assert_trace_safe(child, f"{path}[{index}]")


class TraceCollector:
    """Write immutable JSONL events. Existing bytes are never rewritten."""

    def __init__(self, path: str | Path, *, run_id: str) -> None:
        self.path = Path(path)
        self.run_id = run_id
        self.path.parent.mkdir(parents=True, exist_ok=True)

    def append(self, event_type: str, payload: dict[str, Any]) -> dict[str, Any]:
        assert_trace_safe(payload)
        previous_hash, sequence = self._tail()
        record = {
            "schema_version": "rsi-trace/v1",
            "run_id": self.run_id,
            "sequence": sequence,
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "event_type": event_type,
            "payload": payload,
            "previous_hash": previous_hash,
        }
        record["record_hash"] = hashlib.sha256(_canonical(record).encode("utf-8")).hexdigest()
        line = (_canonical(record) + "\n").encode("utf-8")
        descriptor = os.open(self.path, os.O_APPEND | os.O_CREAT | os.O_WRONLY, 0o600)
        try:
            os.write(descriptor, line)
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
        return record

    def verify(self) -> list[str]:
        errors: list[str] = []
        previous_hash = ""
        for expected_sequence, line in enumerate(self.path.read_text(encoding="utf-8").splitlines()):
            record = json.loads(line)
            record_hash = record.pop("record_hash", "")
            expected_hash = hashlib.sha256(_canonical(record).encode("utf-8")).hexdigest()
            if record_hash != expected_hash:
                errors.append(f"sequence {expected_sequence}: record hash mismatch")
            if record.get("previous_hash") != previous_hash:
                errors.append(f"sequence {expected_sequence}: chain mismatch")
            if record.get("sequence") != expected_sequence:
                errors.append(f"sequence {expected_sequence}: sequence mismatch")
            previous_hash = record_hash
        return errors

    def _tail(self) -> tuple[str, int]:
        if not self.path.exists() or not self.path.stat().st_size:
            return "", 0
        lines = self.path.read_text(encoding="utf-8").splitlines()
        last = json.loads(lines[-1])
        return str(last.get("record_hash") or ""), int(last.get("sequence", -1)) + 1
