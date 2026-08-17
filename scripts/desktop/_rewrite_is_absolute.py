#!/usr/bin/env python3
from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

WPATH = Path(
    "/home/code/pravite_fund_ai_research/omnigent/omnigent/server/routes/_workspace_validation.py"
)

# Build source lines with repr() so escaping is always correct.
unc = "\\\\"  # two backslash chars for UNC prefix
drive_sep = "\\"  # one backslash char

FUNC = "\n".join(
    [
        "def is_absolute_workspace_path(workspace: str) -> bool:",
        '    """Return True when *workspace* is an absolute host filesystem path.',
        "",
        "    Accepts POSIX absolute paths (/home/me/repo), Windows drive paths",
        "    (C:/data or drive-letter + backslash), and Windows UNC paths.",
        "",
        "    Rejects empty, relative, and tilde-prefixed paths. The server never",
        "    expands ~; the host must receive an unambiguous absolute path.",
        '    """',
        "    trimmed = workspace.strip()",
        "    if not trimmed:",
        "        return False",
        '    if trimmed.startswith("/"):',
        "        return True",
        "    # UNC: two leading backslashes, or //server/share",
        f"    if trimmed.startswith({repr(unc)}) or trimmed.startswith(\"//\"):",
        "        return True",
        "    # Drive letter: C:\\ or C:/",
        "    if (",
        "        len(trimmed) >= 3",
        "        and trimmed[0].isalpha()",
        '        and trimmed[1] == ":"',
        f"        and trimmed[2] in ({repr(drive_sep)}, \"/\")",
        "    ):",
        "        return True",
        "    return False",
        "",
        "",
    ]
)

text = WPATH.read_text(encoding="utf-8")
pattern = re.compile(
    r"def is_absolute_workspace_path\(workspace: str\) -> bool:.*?return False\n",
    re.S,
)
if not pattern.search(text):
    raise SystemExit("function not found")
text2 = pattern.sub(FUNC, text, count=1)
text2 = re.sub(
    r"raise WorkspaceValidationError\(\s*[\s\S]*?absolute path[\s\S]*?\)",
    'raise WorkspaceValidationError(\n'
    '            "workspace must be an absolute path "\n'
    '            "(POSIX /path or Windows drive/UNC path)"\n'
    "        )",
    text2,
    count=1,
)
WPATH.write_text(text2, encoding="utf-8")
compile(text2, str(WPATH), "exec")
for i, line in enumerate(WPATH.read_text(encoding="utf-8").splitlines(), 1):
    if "startswith" in line or "trimmed[2]" in line:
        if "absolute" not in line and "boundary" not in line:
            print(i, repr(line))
print("helper ok")

spath = Path(
    "/home/code/pravite_fund_ai_research/omnigent/omnigent/server/routes/sessions.py"
)
st = spath.read_text(encoding="utf-8")
st2 = re.sub(
    r"raise OmnigentError\(\s*[\s\S]*?workspace must be an absolute path[\s\S]*?code=ErrorCode\.INVALID_INPUT,\s*\)",
    'raise OmnigentError(\n'
    '            "workspace must be an absolute path "\n'
    '            "(POSIX /path or Windows drive/UNC path)",\n'
    "            code=ErrorCode.INVALID_INPUT,\n"
    "        )",
    st,
    count=1,
)
spath.write_text(st2, encoding="utf-8")
compile(st2, str(spath), "exec")
print("sessions ok")

sys.path.insert(0, "/home/code/pravite_fund_ai_research/omnigent")
for mod in list(sys.modules):
    if "workspace_validation" in mod:
        del sys.modules[mod]
from omnigent.server.routes._workspace_validation import (  # noqa: E402
    is_absolute_workspace_path as f,
    _is_subpath_of,
)

assert f(r"C:\Users\a") is True
assert f("C:/Users/a") is True
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
if r.returncode:
    print(r.stderr)
sys.exit(r.returncode)
