#!/usr/bin/env python3
"""Single entry point for canonical ingest plus retrieval-index publication.

Use this command in CI and evaluation setup instead of invoking the legacy
loaders, which reset live Chroma collections before parsing has completed.
"""

from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]
PYTHON = sys.executable


def _run(command: list[str], *, accepted_codes: set[int] = {0}) -> None:
    result = subprocess.run(command, cwd=PROJECT_ROOT, check=False)
    if result.returncode not in accepted_codes:
        raise SystemExit(result.returncode)


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Prepare a private-fund dataset and publish a verified retrieval bundle."
    )
    parser.add_argument("--dataset-root", required=True)
    parser.add_argument("--source-directory", default="")
    parser.add_argument("--workspace-root", default="")
    parser.add_argument("--dataset-name", default="")
    parser.add_argument("--company-name", default="")
    parser.add_argument("--company-ticker", default="")
    parser.add_argument("--config", default=str(PROJECT_ROOT / "config" / "production.yaml"))
    parser.add_argument("--batch-size", type=int, default=48)
    parser.add_argument("--check-only", action="store_true")
    parser.add_argument("--force", action="store_true")
    parser.add_argument(
        "--allow-ingest-warnings",
        action="store_true",
        help="publish indexes even when ingestion exits 2 for reviewable warnings",
    )
    args = parser.parse_args()

    dataset_root = Path(args.dataset_root).expanduser().resolve()
    dataset_id = dataset_root.name
    if args.source_directory and args.check_only:
        parser.error("--source-directory and --check-only cannot be combined")

    if args.source_directory:
        workspace_root = (
            Path(args.workspace_root).expanduser().resolve()
            if args.workspace_root
            else dataset_root.parent
        )
        ingest = [
            PYTHON,
            str(PROJECT_ROOT / "data_pipeline" / "private_fund_directory_ingest.py"),
            "--directory", args.source_directory,
            "--workspace-root", str(workspace_root),
            "--dataset-id", dataset_id,
        ]
        for flag, value in (
            ("--dataset-name", args.dataset_name),
            ("--company-name", args.company_name),
            ("--company-ticker", args.company_ticker),
        ):
            if value:
                ingest.extend([flag, value])
        _run(ingest, accepted_codes={0, 2} if args.allow_ingest_warnings else {0})

    rebuild = [
        PYTHON,
        str(PROJECT_ROOT / "data_pipeline" / "rebuild_private_fund_indexes.py"),
        "--dataset-root", str(dataset_root),
        "--config", args.config,
        "--batch-size", str(args.batch_size),
    ]
    if args.check_only:
        rebuild.append("--check-only")
    if args.force:
        rebuild.append("--force")
    _run(rebuild)


if __name__ == "__main__":
    main()
