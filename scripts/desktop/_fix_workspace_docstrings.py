#!/usr/bin/env python3
from pathlib import Path

# Fix _workspace_validation.py docstring and ensure code is correct
wpath = Path(
    "/home/code/pravite_fund_ai_research/omnigent/omnigent/server/routes/_workspace_validation.py"
)
text = wpath.read_text(encoding="utf-8")

# Replace broken function entirely with a clean version
import re

pattern = re.compile(
    r"def is_absolute_workspace_path\(workspace: str\) -> bool:.*?return False\n",
    re.S,
)
replacement = '''def is_absolute_workspace_path(workspace: str) -> bool:
    """Return True when *workspace* is an absolute host filesystem path.

    Accepts POSIX absolute paths (``/Users/me/repo``), Windows drive paths
    (``C:/Users/me`` or ``C:\\\\Users\\\\me``), and Windows UNC paths
    (``\\\\\\\\server\\\\share\\\\repo``).

    Rejects empty, relative, and tilde-prefixed paths. The server never
    expands ``~``; the host must receive an unambiguous absolute path.
    """
    trimmed = workspace.strip()
    if not trimmed:
        return False
    if trimmed.startswith("/"):
        return True
    # UNC \\\\server\\share or //server/share
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

# Use a version written carefully with only doubled backslashes for source
replacement = r'''def is_absolute_workspace_path(workspace: str) -> bool:
    """Return True when *workspace* is an absolute host filesystem path.

    Accepts POSIX absolute paths (/Users/me/repo), Windows drive paths
    (C:/Users/me or C:\Users\me), and Windows UNC paths (\\server\share).

    Rejects empty, relative, and tilde-prefixed paths. The server never
    expands ~; the host must receive an unambiguous absolute path.
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

# Avoid \U in docstring: don't write C:\Users in docstring at all
replacement = '''def is_absolute_workspace_path(workspace: str) -> bool:
    """Return True when *workspace* is an absolute host filesystem path.

    Accepts:
    - POSIX absolute paths: ``/home/me/repo``, ``/``
    - Windows drive paths: ``C:/data`` or drive-letter + backslash form
    - Windows UNC paths: ``//server/share`` or double-backslash UNC form

    Rejects empty, relative, and tilde-prefixed paths. The server never
    expands ``~``; the host must receive an unambiguous absolute path.
    """
    trimmed = workspace.strip()
    if not trimmed:
        return False
    if trimmed.startswith("/"):
        return True
    # UNC: two leading backslashes, or //server/share
    if trimmed.startswith("\\\\\\\\") or trimmed.startswith("//"):
        return True
    # Drive letter: C:\\\\ or C:/
    if (
        len(trimmed) >= 3
        and trimmed[0].isalpha()
        and trimmed[1] == ":"
        and trimmed[2] in "\\\\/"
    ):
        return True
    return False
'''

# Final clean version - write with explicit chars
def build_helper_source() -> str:
    lines = [
        "def is_absolute_workspace_path(workspace: str) -> bool:",
        '    """Return True when *workspace* is an absolute host filesystem path.',
        "",
        "    Accepts POSIX absolute paths (/home/me/repo), Windows drive paths",
        "    (C:/data or C:\\\\data), and Windows UNC paths (\\\\\\\\server\\\\share).",
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
        '    if trimmed.startswith("\\\\\\\\") or trimmed.startswith("//"):',
        "        return True",
        "    # Drive letter: C:\\\\ or C:/",
        "    if (",
        "        len(trimmed) >= 3",
        "        and trimmed[0].isalpha()",
        '        and trimmed[1] == ":"',
        '        and trimmed[2] in "\\\\/"',
        "    ):",
        "        return True",
        "    return False",
        "",
        "",
    ]
    # Fix the actual Python string literals for startswith - need exactly two backslashes in source for one in runtime
    # In the written file:
    #   trimmed.startswith("\\\\")  means starts with one \ - WRONG for UNC
    # For UNC we need starts with two backslashes: source should be "\\\\\\\\" which is 4 chars of backslash in source = 2 in string
    return "\n".join(lines)


# Actually write carefully with python string of the function
func_src = (
    "def is_absolute_workspace_path(workspace: str) -> bool:\n"
    '    """Return True when *workspace* is an absolute host filesystem path.\n'
    "\n"
    "    Accepts POSIX absolute paths (/home/me/repo), Windows drive paths\n"
    "    (C:/data), and Windows UNC paths.\n"
    "\n"
    "    Rejects empty, relative, and tilde-prefixed paths. The server never\n"
    "    expands ~; the host must receive an unambiguous absolute path.\n"
    '    """\n'
    "    trimmed = workspace.strip()\n"
    "    if not trimmed:\n"
    "        return False\n"
    '    if trimmed.startswith("/"):\n'
    "        return True\n"
    "    # UNC: two leading backslashes, or //server/share\n"
    '    if trimmed.startswith("\\\\\\\\") or trimmed.startswith("//"):\n'
    "        return True\n"
    "    # Drive letter: C:\\\\ or C:/\n"
    "    if (\n"
    "        len(trimmed) >= 3\n"
    "        and trimmed[0].isalpha()\n"
    '        and trimmed[1] == ":"\n'
    '        and trimmed[2] in "\\\\/"\n'
    "    ):\n"
    "        return True\n"
    "    return False\n"
    "\n"
    "\n"
)

# Wait: in a normal .py file written by Path.write_text:
# 'if trimmed.startswith("\\\\\\\\"):' in the file content means the string has 4 backslashes
# which Python interprets as startswith two backslashes. Correct for UNC.

# 'and trimmed[2] in "\\\\/"' in file means chars: \, /  Correct.

if not pattern.search(text):
    raise SystemExit("function pattern not found")
text2 = pattern.sub(func_src, text, count=1)

# Fix error message in validate_workspace
text2 = text2.replace(
    'raise WorkspaceValidationError(\n'
    '            "workspace must be an absolute path "\n'
    '            "(POSIX /path, Windows C:\\\\path, or UNC \\\\\\\\server\\\\share)"\n'
    "        )",
    'raise WorkspaceValidationError(\n'
    '            "workspace must be an absolute path "\n'
    '            "(POSIX /path or Windows drive/UNC path)"\n'
    "        )",
)
# if previous simple form still has startswith check already replaced
if 'WorkspaceValidationError(\n            "workspace must be an absolute path starting with /")' in text2:
    text2 = text2.replace(
        'WorkspaceValidationError(\n            "workspace must be an absolute path starting with /")',
        'WorkspaceValidationError(\n'
        '            "workspace must be an absolute path "\n'
        '            "(POSIX /path or Windows drive/UNC path)"\n'
        "        )",
    )
# also handle single-line form after our first patch
import re as _re
text2 = _re.sub(
    r'raise WorkspaceValidationError\(\s*"workspace must be an absolute path[^"]*"\s*\)',
    'raise WorkspaceValidationError(\n'
    '            "workspace must be an absolute path "\n'
    '            "(POSIX /path or Windows drive/UNC path)"\n'
    "        )",
    text2,
    count=1,
)

wpath.write_text(text2, encoding="utf-8")
# verify compiles
compile(text2, str(wpath), "exec")
print("fixed", wpath)

# Fix sessions.py error string
spath = Path("/home/code/pravite_fund_ai_research/omnigent/omnigent/server/routes/sessions.py")
st = spath.read_text(encoding="utf-8")
st2 = _re.sub(
    r'raise OmnigentError\(\s*"workspace must be an absolute path[^"]*",\s*code=ErrorCode\.INVALID_INPUT,\s*\)',
    'raise OmnigentError(\n'
    '            "workspace must be an absolute path "\n'
    '            "(POSIX /path or Windows drive/UNC path)",\n'
    "            code=ErrorCode.INVALID_INPUT,\n"
    "        )",
    st,
    count=1,
)
# simpler replace of the bad line
st2 = st.replace(
    '"(POSIX /path, Windows C:\\path, or UNC \\\\server\\share)"',
    '"(POSIX /path or Windows drive/UNC path)"',
)
spath.write_text(st2, encoding="utf-8")
compile(st2, str(spath), "exec")
print("fixed", spath)
