"""Private Fund desktop portable runtime path bootstrap.

Embeddable CPython ignores PYTHONPATH; this runs on interpreter startup
(via site) and injects the packaged project tree onto sys.path.
"""
from __future__ import annotations

import sys
from pathlib import Path


def _bootstrap() -> None:
    current = Path(__file__).resolve()
    python_home = next(
        (
            parent
            for parent in current.parents
            if (parent / "python.exe").is_file()
            or (parent / "bin" / "python3").is_file()
        ),
        None,
    )
    if python_home is None:
        return
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
