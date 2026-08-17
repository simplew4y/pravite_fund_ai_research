#!/usr/bin/env python3
"""Stable executable entrypoint for the compute worker."""

from compute_worker.cli import main


if __name__ == "__main__":
    raise SystemExit(main())
