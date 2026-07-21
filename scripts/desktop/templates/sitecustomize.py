"""Private Fund desktop portable runtime path bootstrap.

Embeddable CPython ignores PYTHONPATH; this runs on interpreter startup
(via site) and injects the packaged project tree onto sys.path.
"""
from __future__ import annotations

import sys
from pathlib import Path


def _bootstrap() -> None:
    # .../runtime/python/Lib/site-packages/sitecustomize.py
    python_home = Path(__file__).resolve().parents[2]  # .../python
    runtime = python_home.parent
    for p in (
        runtime / "project",
        runtime / "project" / "src",
        runtime / "project" / "omnigent",
    ):
        s = str(p)
        if p.is_dir() and s not in sys.path:
            sys.path.insert(0, s)


_bootstrap()
