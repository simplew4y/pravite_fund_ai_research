"""Split a private evaluator into company-scoped question-only target files."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from collections import defaultdict
from pathlib import Path
from typing import Any


def _load_jsonl(path: Path) -> list[dict[str, Any]]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def _write_private_jsonl(path: Path, rows: list[dict[str, Any]]) -> None:
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(row, ensure_ascii=False, sort_keys=True) + "\n")


def build_source_aligned_targets(private_cases: Path, out_dir: Path) -> dict[str, Any]:
    cases = _load_jsonl(private_cases)
    out_dir.mkdir(parents=True, exist_ok=False, mode=0o700)
    os.chmod(out_dir, 0o700)
    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    seen = set()
    for case in cases:
        case_id = str(case.get("case_id") or "")
        company = str(case.get("company") or "").strip().lower()
        question = str((case.get("target") or {}).get("question") or "").strip()
        if not case_id or not company or not question:
            raise ValueError("every private case requires case_id, company, and target.question")
        if case_id in seen:
            raise ValueError(f"duplicate case_id: {case_id}")
        seen.add(case_id)
        grouped[company].append({"case_id": case_id, "question": question})

    files = {}
    for company, rows in sorted(grouped.items()):
        rows.sort(key=lambda row: row["case_id"])
        path = out_dir / f"{company}.questions.jsonl"
        _write_private_jsonl(path, rows)
        files[company] = {
            "count": len(rows),
            "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
            "path": str(path),
        }
    manifest = {
        "schema_version": "rsi-source-aligned-targets/v1",
        "case_count": len(cases),
        "companies": files,
        "exported_fields": ["case_id", "question"],
        "hidden_content_exported": False,
    }
    manifest_path = out_dir / "manifest.json"
    fd = os.open(manifest_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        json.dump(manifest, handle, ensure_ascii=False, indent=2, sort_keys=True)
        handle.write("\n")
    return manifest


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--private-cases", type=Path, required=True)
    parser.add_argument("--out-dir", type=Path, required=True)
    print(json.dumps(build_source_aligned_targets(**vars(parser.parse_args())), indent=2))


if __name__ == "__main__":
    main()
