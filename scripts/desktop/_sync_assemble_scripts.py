#!/usr/bin/env python3
"""Sync assemble scripts with portable-runtime fixes (no PowerShell quoting)."""
from __future__ import annotations

from pathlib import Path

ROOT = Path("/home/code/pravite_fund_ai_research")

# --- assemble_win_native.sh ---
assemble = ROOT / "scripts/desktop/assemble_win_native.sh"
text = assemble.read_text(encoding="utf-8")

# Only exclude monorepo top-level examples/, not omnigent/resources/examples
text = text.replace(
    "  --exclude 'tests' \\\n  --exclude 'examples' \\\n",
    "  --exclude 'tests' \\\n  --exclude '/examples' \\\n",
)

# Ensure apply_runtime_fixes is called once near the end (before VERSION block)
if "apply_runtime_fixes.sh" not in text:
    marker = 'echo "native-windows" > "$RUNTIME_DIR/NATIVE_STACK"'
    hook = (
        'bash "$ROOT_DIR/scripts/desktop/apply_runtime_fixes.sh" "$RUNTIME_DIR"\n\n'
        + marker
    )
    if marker in text:
        text = text.replace(marker, hook, 1)
    else:
        text = text.rstrip() + "\n\n" + hook + "\n"

assemble.write_text(text, encoding="utf-8")
print("updated", assemble)

# --- _fix_symlinks_and_repack.sh: do NOT delete examples ---
fix = ROOT / "scripts/desktop/_fix_symlinks_and_repack.sh"
if fix.exists():
    t = fix.read_text(encoding="utf-8")
    t2 = t.replace(
        """# Also drop heavy unused example trees if present
rm -rf "$RUNTIME/python/Lib/site-packages/omnigent/resources/examples" 2>/dev/null || true
rm -rf "$RUNTIME/project/omnigent/omnigent/resources/examples" 2>/dev/null || true
""",
        """# Keep examples package importable; only remove broken symlinks above.
# Real polly/debby copies are applied by apply_runtime_fixes.sh.
bash "$ROOT/scripts/desktop/apply_runtime_fixes.sh" "$RUNTIME"
""",
    )
    if t2 == t:
        # insert apply after broken symlink cleanup if not present
        if "apply_runtime_fixes.sh" not in t:
            t2 = t.replace(
                "done\n",
                'done\nbash "$ROOT/scripts/desktop/apply_runtime_fixes.sh" "$RUNTIME"\n',
                1,
            )
    fix.write_text(t2, encoding="utf-8")
    print("updated", fix)

# --- install_win_packages: use templates ---
install = ROOT / "scripts/desktop/install_win_packages.sh"
it = install.read_text(encoding="utf-8")
old_sc = '''# Portable embeddable Python ignores PYTHONPATH — inject project paths.
cat > "$SITE/sitecustomize.py" <<'PY'
"""Private Fund desktop portable runtime path bootstrap."""
from __future__ import annotations

import sys
from pathlib import Path


def _bootstrap() -> None:
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
PY
'''
new_sc = '''# Portable embeddable Python ignores PYTHONPATH — inject project paths.
cp -f "$ROOT_DIR/scripts/desktop/templates/sitecustomize.py" "$SITE/sitecustomize.py"
'''
if old_sc in it:
    it = it.replace(old_sc, new_sc)
    install.write_text(it, encoding="utf-8")
    print("updated install_win_packages sitecustomize")
elif "templates/sitecustomize.py" not in it:
    # softer: if inline still there with different quotes, append cp after vendor
    if 'sitecustomize.py' in it and 'templates/sitecustomize.py' not in it:
        it = it.replace(
            'cat > "$SITE/sitecustomize.py"',
            'cp -f "$ROOT_DIR/scripts/desktop/templates/sitecustomize.py" "$SITE/sitecustomize.py"\n# legacy inline removed; using template\nfalse && cat > "$SITE/sitecustomize.py"',
            1,
        )
        # cleaner approach: call apply at end of install
        if "apply_runtime_fixes.sh" not in it:
            it = it.rstrip() + '\n\nbash "$ROOT_DIR/scripts/desktop/apply_runtime_fixes.sh" "${RUNTIME_OUT:-$ROOT_DIR/omnigent/web/electron/resources/runtime}"\n'
        install.write_text(it, encoding="utf-8")
        print("patched install_win_packages loosely")
    else:
        print("install_win_packages already ok or unexpected")
else:
    print("install already uses template")

print("done")
