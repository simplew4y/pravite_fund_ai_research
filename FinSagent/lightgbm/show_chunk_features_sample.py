from __future__ import annotations

import argparse
import csv
import json
from pathlib import Path


def load_sample(csv_path: Path, rows: int) -> tuple[list[str], list[dict[str, str]]]:
    with csv_path.open("r", encoding="utf-8-sig", newline="") as file:
        reader = csv.DictReader(file)
        headers = reader.fieldnames or []
        sample_rows: list[dict[str, str]] = []
        for index, row in enumerate(reader):
            if index >= rows:
                break
            sample_rows.append(row)
    return headers, sample_rows


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--csv-path",
        type=Path,
        default=Path(__file__).resolve().parent / "data" / "chunk_features_reduced.csv",
    )
    parser.add_argument("--rows", type=int, default=5)
    args = parser.parse_args()

    csv_path = args.csv_path.resolve()
    if not csv_path.exists():
        raise FileNotFoundError(f"CSV file not found: {csv_path}")

    headers, sample_rows = load_sample(csv_path, args.rows)

    print(f"CSV: {csv_path}")
    print(f"Columns ({len(headers)}): {headers}")
    print(f"Showing {len(sample_rows)} sample rows:")
    print(json.dumps(sample_rows, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
