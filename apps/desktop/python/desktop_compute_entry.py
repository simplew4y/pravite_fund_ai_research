"""PyInstaller entrypoint for the canonical desktop compute sidecar."""

import sys

from compute_worker.cli import main


def desktop_main() -> int:
    # The TypeScript compute client normally invokes ``python worker.py``.
    # A frozen executable is already the interpreter and worker together, so
    # discard that compatibility path while preserving --health/--once.
    if len(sys.argv) > 1 and sys.argv[1].endswith("worker.py"):
        del sys.argv[1]
    return main()


if __name__ == "__main__":
    raise SystemExit(desktop_main())
