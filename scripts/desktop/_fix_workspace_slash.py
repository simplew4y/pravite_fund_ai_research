#!/usr/bin/env python3
from pathlib import Path
import re
import subprocess
import sys

p = Path(
    "/home/code/pravite_fund_ai_research/omnigent/omnigent/server/routes/_workspace_validation.py"
)
t = p.read_text(encoding="utf-8")
# Replace any broken "in ..." line for drive separator check
t2, n = re.subn(
    r"        and trimmed\[2\] in .+",
    r'        and trimmed[2] in ("\\", "/")',
    t,
    count=1,
)
if n != 1:
    # try to find what we have
    for i, line in enumerate(t.splitlines(), 1):
        if "trimmed[2]" in line:
            print("line", i, repr(line))
    raise SystemExit(f"replace count={n}")
p.write_text(t2, encoding="utf-8")
compile(t2, str(p), "exec")
print("fixed line")

# import via monorepo package
sys.path.insert(0, "/home/code/pravite_fund_ai_research/omnigent")
from omnigent.server.routes._workspace_validation import (  # noqa: E402
    is_absolute_workspace_path as f,
    _is_subpath_of,
)

assert f(r"C:\Users\a") is True, f(r"C:\Users\a")
assert f("/tmp") is True
assert f("rel") is False
assert f(r"\\server\share") is True
assert _is_subpath_of(r"C:\a\b\c", r"C:\a\b") is True
print("asserts ok")

r = subprocess.run(
    [
        "/home/code/pravite_fund_ai_research/omnigent/.venv/bin/python",
        "-m",
        "pytest",
        "tests/server/routes/test_workspace_validation_helpers.py",
        "-q",
    ],
    cwd="/home/code/pravite_fund_ai_research/omnigent",
    capture_output=True,
    text=True,
)
print(r.stdout)
print(r.stderr[-500:] if r.stderr else "")
sys.exit(r.returncode)
