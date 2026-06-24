from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any, Dict, Iterable, List


DEFAULT_BENCHMARKS = ("financebench", "finder", "lotus")
METRIC_FILE_NAME = "_metrics.json"
DISPLAY_NAME_MAP = {
    "baseline": "baseline",
    "multi_role": "multi_role",
    "multi_role_decomp": "multi_role_decomp",
    "all_features": "all_features",
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Collect retrieval evaluation metrics into a table.",
    )
    parser.add_argument(
        "--retrieval-root",
        type=Path,
        default=Path(__file__).resolve().parent,
        help="Root directory containing financebench/, finder/, lotus/.",
    )
    parser.add_argument(
        "--benchmarks",
        nargs="+",
        default=list(DEFAULT_BENCHMARKS),
        help="Benchmark subdirectories to scan.",
    )
    parser.add_argument(
        "--format",
        choices=("markdown", "csv", "plain"),
        default="markdown",
        help="Table output format.",
    )
    parser.add_argument(
        "--sort-by",
        choices=("benchmark", "method", "precision", "recall", "jaccard", "retrieved_chunks"),
        default="benchmark",
        help="Column to sort by.",
    )
    parser.add_argument(
        "--descending",
        action="store_true",
        help="Sort in descending order.",
    )
    return parser.parse_args()


def load_metrics(metrics_path: Path) -> List[Dict[str, Any]]:
    with metrics_path.open("r", encoding="utf-8") as f:
        data = json.load(f)
    if not isinstance(data, list):
        raise ValueError(f"Expected a list in {metrics_path}, got {type(data).__name__}")
    return data


def extract_method(run_name: str, benchmark: str) -> str:
    prefix = f"{benchmark}_"
    if run_name.startswith(prefix):
        run_name = run_name[len(prefix):]
    method = run_name
    if "_" in run_name:
        first, remainder = run_name.split("_", maxsplit=1)
        if first.startswith("run") and first[3:].isdigit():
            method = remainder
    return DISPLAY_NAME_MAP.get(method, method)


def to_row(benchmark: str, item: Dict[str, Any]) -> Dict[str, Any]:
    run_name = str(item.get("run_name", ""))
    return {
        "benchmark": benchmark,
        "method": extract_method(run_name, benchmark),
        "precision": item.get("avg_precision", 0.0),
        "recall": item.get("avg_recall", 0.0),
        "jaccard": item.get("avg_jaccard", 0.0),
        "retrieved_chunks": item.get("avg_retrieved", 0.0),
        "run_name": run_name,
    }


def collect_rows(retrieval_root: Path, benchmarks: Iterable[str]) -> List[Dict[str, Any]]:
    rows: List[Dict[str, Any]] = []
    missing: List[Path] = []

    for benchmark in benchmarks:
        metrics_path = retrieval_root / benchmark / METRIC_FILE_NAME
        if not metrics_path.exists():
            missing.append(metrics_path)
            continue
        for item in load_metrics(metrics_path):
            rows.append(to_row(benchmark, item))

    if missing:
        missing_text = "\n".join(str(path) for path in missing)
        raise FileNotFoundError(f"Missing metrics files:\n{missing_text}")

    return rows


def sort_rows(rows: List[Dict[str, Any]], sort_by: str, descending: bool) -> List[Dict[str, Any]]:
    if sort_by in {"precision", "recall", "jaccard", "retrieved_chunks"}:
        key = lambda row: (float(row[sort_by]), row["benchmark"], row["method"])
    else:
        key = lambda row: (str(row[sort_by]), row["benchmark"], row["method"])
    return sorted(rows, key=key, reverse=descending)


def format_value(column: str, value: Any) -> str:
    if column in {"precision", "recall", "jaccard", "retrieved_chunks"}:
        return f"{float(value):.4f}"
    return str(value)


def render_markdown(rows: List[Dict[str, Any]], columns: List[str]) -> str:
    header = "| " + " | ".join(columns) + " |"
    separator = "| " + " | ".join("---" for _ in columns) + " |"
    body = [
        "| " + " | ".join(format_value(column, row[column]) for column in columns) + " |"
        for row in rows
    ]
    return "\n".join([header, separator, *body])


def render_csv(rows: List[Dict[str, Any]], columns: List[str]) -> str:
    lines = [",".join(columns)]
    for row in rows:
        lines.append(
            ",".join(format_value(column, row[column]) for column in columns)
        )
    return "\n".join(lines)


def render_plain(rows: List[Dict[str, Any]], columns: List[str]) -> str:
    widths = {
        column: max(len(column), *(len(format_value(column, row[column])) for row in rows))
        for column in columns
    }
    header = "  ".join(column.ljust(widths[column]) for column in columns)
    separator = "  ".join("-" * widths[column] for column in columns)
    body = [
        "  ".join(format_value(column, row[column]).ljust(widths[column]) for column in columns)
        for row in rows
    ]
    return "\n".join([header, separator, *body])


def render_table(rows: List[Dict[str, Any]], fmt: str) -> str:
    columns = ["benchmark", "method", "precision", "recall", "jaccard", "retrieved_chunks"]
    if fmt == "markdown":
        return render_markdown(rows, columns)
    if fmt == "csv":
        return render_csv(rows, columns)
    return render_plain(rows, columns)


def main() -> None:
    args = parse_args()
    rows = collect_rows(args.retrieval_root.resolve(), args.benchmarks)
    rows = sort_rows(rows, args.sort_by, args.descending)
    print(render_table(rows, args.format))


if __name__ == "__main__":
    main()
