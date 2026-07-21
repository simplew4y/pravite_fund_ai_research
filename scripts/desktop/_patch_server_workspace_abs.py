#!/usr/bin/env python3
"""Allow Windows absolute paths in server workspace validation."""
from __future__ import annotations

from pathlib import Path

# ---------------------------------------------------------------------------
# _workspace_validation.py
# ---------------------------------------------------------------------------
wpath = Path(
    "/home/code/pravite_fund_ai_research/omnigent/omnigent/server/routes/_workspace_validation.py"
)
text = wpath.read_text(encoding="utf-8")

helper = '''
def is_absolute_workspace_path(workspace: str) -> bool:
    """Return True when *workspace* is an absolute host filesystem path.

    Accepts:
    - POSIX absolute paths: ``/Users/me/repo``, ``/``
    - Windows drive paths: ``C:\\\\Users\\\\me``, ``D:/data``
    - Windows UNC paths: ``\\\\\\\\server\\\\share\\\\repo``

    Rejects empty, relative, and tilde-prefixed paths. The server never
    expands ``~``; the host must receive an unambiguous absolute path.
    """
    trimmed = workspace.strip()
    if not trimmed:
        return False
    if trimmed.startswith("/"):
        return True
    # UNC \\\\server\\share
    if trimmed.startswith("\\\\\\\\") or trimmed.startswith("//"):
        return True
    # Drive letter C:\\ or C:/
    if len(trimmed) >= 3 and trimmed[0].isalpha() and trimmed[1] == ":" and trimmed[2] in "\\\\/":
        return True
    return False


'''

# Fix UNC check - in actual file we need proper Python strings
helper = '''
def is_absolute_workspace_path(workspace: str) -> bool:
    """Return True when *workspace* is an absolute host filesystem path.

    Accepts:
    - POSIX absolute paths: ``/Users/me/repo``, ``/``
    - Windows drive paths: ``C:\\\\Users\\\\me``, ``D:/data``
    - Windows UNC paths: ``\\\\\\\\server\\\\share\\\\repo``

    Rejects empty, relative, and tilde-prefixed paths. The server never
    expands ``~``; the host must receive an unambiguous absolute path.
    """
    trimmed = workspace.strip()
    if not trimmed:
        return False
    if trimmed.startswith("/"):
        return True
    # UNC \\\\server\\share (two leading backslashes) or //server/share
    if trimmed.startswith("\\\\\\\\") or trimmed.startswith("//"):
        return True
    # Drive letter C:\\\\ or C:/
    if (
        len(trimmed) >= 3
        and trimmed[0].isalpha()
        and trimmed[1] == ":"
        and trimmed[2] in "\\\\/"
    ):
        return True
    return False


'''

# Write helper with correct escape sequences for the .py source file
helper = r'''
def is_absolute_workspace_path(workspace: str) -> bool:
    """Return True when *workspace* is an absolute host filesystem path.

    Accepts:
    - POSIX absolute paths: ``/Users/me/repo``, ``/``
    - Windows drive paths: ``C:\Users\me``, ``D:/data``
    - Windows UNC paths: ``\\server\share\repo``

    Rejects empty, relative, and tilde-prefixed paths. The server never
    expands ``~``; the host must receive an unambiguous absolute path.
    """
    trimmed = workspace.strip()
    if not trimmed:
        return False
    if trimmed.startswith("/"):
        return True
    # UNC \\server\share (two leading backslashes) or //server/share
    if trimmed.startswith("\\\\") or trimmed.startswith("//"):
        return True
    # Drive letter C:\ or C:/
    if (
        len(trimmed) >= 3
        and trimmed[0].isalpha()
        and trimmed[1] == ":"
        and trimmed[2] in "\\/"
    ):
        return True
    return False


'''

if "def is_absolute_workspace_path" not in text:
    # Insert before class WorkspaceValidationError
    needle = "class WorkspaceValidationError(Exception):"
    if needle not in text:
        raise SystemExit("WorkspaceValidationError not found")
    text = text.replace(needle, helper + needle, 1)

old_check = '''    if not workspace.startswith("/"):
        # Belt-and-suspenders. The Pydantic schema layer also
        # rejects this; pin it here so direct callers (tests,
        # other server-internal paths) can't bypass.
        raise WorkspaceValidationError("workspace must be an absolute path starting with /")
'''
new_check = '''    if not is_absolute_workspace_path(workspace):
        # Belt-and-suspenders. Pin it here so direct callers (tests,
        # other server-internal paths) can't bypass frontend checks.
        raise WorkspaceValidationError(
            "workspace must be an absolute path "
            "(POSIX /path, Windows C:\\\\path, or UNC \\\\\\\\server\\\\share)"
        )
'''
if old_check not in text:
    # simpler
    old_check2 = '''    if not workspace.startswith("/"):
        # Belt-and-suspenders. The Pydantic schema layer also
        # rejects this; pin it here so direct callers (tests,
        # other server-internal paths) can't bypass.
        raise WorkspaceValidationError("workspace must be an absolute path starting with /")
'''
    if "if not is_absolute_workspace_path(workspace):" not in text:
        if "if not workspace.startswith(\"/\")" not in text:
            raise SystemExit("workspace startswith check not found")
        text = text.replace(
            'if not workspace.startswith("/"):',
            "if not is_absolute_workspace_path(workspace):",
            1,
        )
        text = text.replace(
            'raise WorkspaceValidationError("workspace must be an absolute path starting with /")',
            'raise WorkspaceValidationError(\n'
            '            "workspace must be an absolute path "\n'
            '            "(POSIX /path, Windows C:\\\\path, or UNC \\\\\\\\server\\\\share)"\n'
            "        )",
            1,
        )
else:
    text = text.replace(old_check, new_check, 1)

# Fix _is_subpath_of for Windows separators
old_sub = '''    if canonical_workspace == canonical_boundary:
        return True
    # Add a trailing separator so ``/a/foo`` is not treated as a
    # subpath of ``/a/fo`` (prefix collision). ``/`` is the only
    # separator the host stat returns since ``canonical_path`` is
    # always absolute.
    boundary_with_sep = (
        canonical_boundary if canonical_boundary.endswith("/") else canonical_boundary + "/"
    )
    return canonical_workspace.startswith(boundary_with_sep)
'''
new_sub = '''    if canonical_workspace == canonical_boundary:
        return True
    # Normalize separators so Windows "C:\\a\\b" and POSIX "/a/b" compare
    # consistently. Add a trailing separator so ``/a/foo`` is not treated as a
    # subpath of ``/a/fo`` (prefix collision).
    ws = canonical_workspace.replace("\\\\", "/")
    bd = canonical_boundary.replace("\\\\", "/")
    boundary_with_sep = bd if bd.endswith("/") else bd + "/"
    return ws.startswith(boundary_with_sep)
'''
# Use raw for backslash in source
new_sub = r'''    if canonical_workspace == canonical_boundary:
        return True
    # Normalize separators so Windows "C:\a\b" and POSIX "/a/b" compare
    # consistently. Add a trailing separator so ``/a/foo`` is not treated as a
    # subpath of ``/a/fo`` (prefix collision).
    ws = canonical_workspace.replace("\\", "/")
    bd = canonical_boundary.replace("\\", "/")
    boundary_with_sep = bd if bd.endswith("/") else bd + "/"
    return ws.startswith(boundary_with_sep)
'''
if old_sub in text:
    text = text.replace(old_sub, new_sub, 1)
    print("updated _is_subpath_of")
else:
    print("_is_subpath_of pattern skip or already patched")

# subdir_path join for Windows in step 6
old_join = '        subdir_path = canonical_workspace.rstrip("/") + "/" + subdir'
new_join = (
    '        sep = "\\\\" if "\\\\" in canonical_workspace or (\n'
    '            len(canonical_workspace) >= 2 and canonical_workspace[1] == ":"\n'
    '        ) else "/"\n'
    '        subdir_path = canonical_workspace.rstrip("/\\\\") + sep + subdir'
)
# simpler portable join
new_join = r'''        # Join with the host's separator (Windows drive paths use \).
        if "\\" in canonical_workspace or (
            len(canonical_workspace) >= 2 and canonical_workspace[1] == ":"
        ):
            subdir_path = canonical_workspace.rstrip("\\/") + "\\" + subdir.replace("/", "\\")
        else:
            subdir_path = canonical_workspace.rstrip("/") + "/" + subdir'''
if old_join in text:
    text = text.replace(old_join, new_join, 1)
    print("updated subdir join")

wpath.write_text(text, encoding="utf-8")
print("patched", wpath)

# ---------------------------------------------------------------------------
# sessions.py
# ---------------------------------------------------------------------------
spath = Path("/home/code/pravite_fund_ai_research/omnigent/omnigent/server/routes/sessions.py")
st = spath.read_text(encoding="utf-8")
old_s = '''    if not workspace.startswith("/"):
        raise OmnigentError(
            "workspace must be an absolute path starting with /",
            code=ErrorCode.INVALID_INPUT,
        )
'''
new_s = '''    from omnigent.server.routes._workspace_validation import is_absolute_workspace_path

    if not is_absolute_workspace_path(workspace):
        raise OmnigentError(
            "workspace must be an absolute path "
            "(POSIX /path, Windows C:\\\\path, or UNC \\\\\\\\server\\\\share)",
            code=ErrorCode.INVALID_INPUT,
        )
'''
# cleaner message without over-escaping in source
new_s = r'''    from omnigent.server.routes._workspace_validation import is_absolute_workspace_path

    if not is_absolute_workspace_path(workspace):
        raise OmnigentError(
            "workspace must be an absolute path "
            "(POSIX /path, Windows C:\path, or UNC \\server\share)",
            code=ErrorCode.INVALID_INPUT,
        )
'''
if old_s not in st:
    if "is_absolute_workspace_path(workspace)" in st:
        print("sessions.py already patched")
    else:
        raise SystemExit("sessions.py pattern not found")
else:
    spath.write_text(st.replace(old_s, new_s, 1), encoding="utf-8")
    print("patched", spath)

# ---------------------------------------------------------------------------
# hosts.py filesystem path check (optional browsing)
# ---------------------------------------------------------------------------
hpath = Path("/home/code/pravite_fund_ai_research/omnigent/omnigent/server/routes/hosts.py")
ht = hpath.read_text(encoding="utf-8")
# if not path.startswith(("/", "~")):
if 'if not path.startswith(("/", "~")):' in ht:
    ht = ht.replace(
        'if not path.startswith(("/", "~")):',
        'if not (path.startswith(("/", "~")) or is_absolute_workspace_path(path)):',
        1,
    )
    # add import near top of function or module - inject lazy import before check
    # Find first occurrence context
    if "from omnigent.server.routes._workspace_validation import is_absolute_workspace_path" not in ht:
        ht = ht.replace(
            'if not (path.startswith(("/", "~")) or is_absolute_workspace_path(path)):',
            'from omnigent.server.routes._workspace_validation import is_absolute_workspace_path\n'
            '        if not (path.startswith(("/", "~")) or is_absolute_workspace_path(path)):',
            1,
        )
    hpath.write_text(ht, encoding="utf-8")
    print("patched hosts.py")
else:
    print("hosts.py path check skip")

# ---------------------------------------------------------------------------
# tests for helper
# ---------------------------------------------------------------------------
tpath = Path(
    "/home/code/pravite_fund_ai_research/omnigent/tests/server/routes/test_workspace_validation_helpers.py"
)
tt = tpath.read_text(encoding="utf-8")
if "is_absolute_workspace_path" not in tt:
    tt = tt.replace(
        "from omnigent.server.routes._workspace_validation import (\n    _is_relative_cwd,\n    _is_subpath_of,\n)",
        "from omnigent.server.routes._workspace_validation import (\n    _is_relative_cwd,\n    _is_subpath_of,\n    is_absolute_workspace_path,\n)",
        1,
    )
    tt += r'''


class TestIsAbsoluteWorkspacePath:
    def test_posix(self) -> None:
        assert is_absolute_workspace_path("/Users/a/b") is True
        assert is_absolute_workspace_path("/") is True

    def test_windows_drive(self) -> None:
        assert is_absolute_workspace_path(r"C:\Users\a") is True
        assert is_absolute_workspace_path("c:/Users/a") is True

    def test_windows_unc(self) -> None:
        assert is_absolute_workspace_path(r"\\server\share\repo") is True

    def test_rejects_relative_and_tilde(self) -> None:
        assert is_absolute_workspace_path("") is False
        assert is_absolute_workspace_path("   ") is False
        assert is_absolute_workspace_path("~/proj") is False
        assert is_absolute_workspace_path("proj/a") is False
        assert is_absolute_workspace_path("./a") is False
'''
    # also windows subpath test
    if "test_windows_child_path" not in tt:
        tt = tt.replace(
            "    def test_trailing_slash_boundary(self) -> None:\n        assert _is_subpath_of(\"/a/b/c\", \"/a/b/\") is True\n",
            "    def test_trailing_slash_boundary(self) -> None:\n        assert _is_subpath_of(\"/a/b/c\", \"/a/b/\") is True\n\n"
            "    def test_windows_child_path(self) -> None:\n"
            "        assert _is_subpath_of(r\"C:\\\\a\\\\b\\\\c\", r\"C:\\\\a\\\\b\") is True\n",
            1,
        )
    tpath.write_text(tt, encoding="utf-8")
    print("patched tests")
else:
    print("tests already have helper")

print("done")
