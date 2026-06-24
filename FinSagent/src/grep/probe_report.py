"""Markdown report renderer for grep evidence probe results."""

from __future__ import annotations

import argparse
import json
from collections import Counter
from pathlib import Path
from typing import Any


def render_probe_report(result: dict[str, Any]) -> str:
    anchors = list(result.get("anchors") or [])
    counts = Counter(str(anchor.get("anchor_type") or "unknown") for anchor in anchors)
    lines = [
        "# Grep Evidence Probe Report",
        "",
        "## Question",
        "",
        str(result.get("question") or ""),
        "",
        "## Probe Summary",
        "",
        f"- Files scanned: {result.get('files_scanned', 0)}",
        f"- Query terms: {', '.join(result.get('query_terms') or [])}",
        f"- Period terms: {', '.join(result.get('period_terms') or [])}",
        f"- Metric aliases: {_format_metric_aliases(result.get('metric_aliases') or {})}",
        f"- Anchor counts: {dict(counts)}",
        "",
        "## Top Anchors",
        "",
        "| Type | Text | Source | Confidence | Snippet |",
        "| --- | --- | --- | ---: | --- |",
    ]
    for anchor in anchors[:15]:
        lines.append(
            "| "
            + " | ".join(
                [
                    str(anchor.get("anchor_type") or ""),
                    _escape(str(anchor.get("text") or "")),
                    _escape(_short_path(str(anchor.get("source_path") or ""))),
                    f"{float(anchor.get('confidence_hint') or 0):.2f}",
                    _escape(_compact(str(anchor.get("snippet") or ""), 220)),
                ]
            )
            + " |"
        )
    return "\n".join(lines).rstrip() + "\n"


def _format_metric_aliases(value: dict[str, list[str]]) -> str:
    if not value:
        return ""
    return "; ".join(f"{metric}={aliases[:4]}" for metric, aliases in value.items())


def _short_path(path: str) -> str:
    parts = path.replace("\\", "/").split("/")
    return "/".join(parts[-3:]) if len(parts) > 3 else path


def _compact(value: str, max_chars: int) -> str:
    if len(value) <= max_chars:
        return value
    return value[: max_chars - 3].rstrip() + "..."


def _escape(value: str) -> str:
    return value.replace("|", "\\|").replace("\n", " ")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input_json", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    result = json.loads(Path(args.input_json).read_text(encoding="utf-8"))
    output = Path(args.out)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(render_probe_report(result), encoding="utf-8")
    print(output)


if __name__ == "__main__":
    main()

