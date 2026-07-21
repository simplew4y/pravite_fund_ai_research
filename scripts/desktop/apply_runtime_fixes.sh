#!/usr/bin/env bash
# Apply portable-runtime fixes to an assembled resources/runtime tree.
# Safe to re-run. Used by assemble_win_native.sh and for syncing WSL build tree.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RUNTIME_DIR="${1:-$ROOT_DIR/omnigent/web/electron/resources/runtime}"
TPL="$ROOT_DIR/scripts/desktop/templates"
PY_HOME="$RUNTIME_DIR/python"
SITE="$PY_HOME/Lib/site-packages"

if [[ ! -d "$RUNTIME_DIR" ]]; then
  echo "runtime missing: $RUNTIME_DIR" >&2
  exit 1
fi

echo "==> apply_runtime_fixes → $RUNTIME_DIR"

# 1) sitecustomize (embeddable Python path bootstrap)
if [[ -d "$SITE" ]]; then
  mkdir -p "$SITE"
  cp -f "$TPL/sitecustomize.py" "$SITE/sitecustomize.py"
  echo "  sitecustomize.py"
fi

# 2) python._pth: ensure project paths (Windows separators for embeddable)
PTH="$(ls "$PY_HOME"/python*._pth 2>/dev/null | head -1 || true)"
if [[ -n "$PTH" && -f "$PTH" ]]; then
  if ! grep -q 'project\\src\|\.\./project/src\|\.\.\\project\\src' "$PTH" 2>/dev/null; then
    {
      echo ""
      echo "..\\project"
      echo "..\\project\\src"
      echo "..\\project\\omnigent"
    } >> "$PTH"
    echo "  patched $(basename "$PTH")"
  fi
fi

# 3) omnigent.resources.examples (must be importable; no broken symlinks)
if [[ -d "$SITE/omnigent/resources" ]]; then
  EX_PKG="$SITE/omnigent/resources/examples"
  mkdir -p "$EX_PKG"
  : > "$EX_PKG/__init__.py"
  for name in polly debby; do
    if [[ -d "$ROOT_DIR/omnigent/examples/$name" ]]; then
      rm -rf "$EX_PKG/$name"
      cp -a "$ROOT_DIR/omnigent/examples/$name" "$EX_PKG/$name"
    fi
  done
  find "$SITE/omnigent" -type l 2>/dev/null | while read -r L; do
    [[ -e "$L" ]] || rm -f "$L"
  done
  echo "  examples package + polly/debby"
fi

# 4) private_fund_pdf root resolver (if vendored copy is stale)
SRC_PDF="$ROOT_DIR/omnigent/omnigent/server/routes/private_fund_pdf.py"
DST_PDF="$SITE/omnigent/server/routes/private_fund_pdf.py"
if [[ -f "$SRC_PDF" && -f "$DST_PDF" ]]; then
  if ! grep -q '_desktop_private_fund_root' "$DST_PDF" 2>/dev/null; then
    cp -f "$SRC_PDF" "$DST_PDF"
    echo "  synced private_fund_pdf.py from monorepo"
  elif ! cmp -s "$SRC_PDF" "$DST_PDF" 2>/dev/null; then
    # monorepo is source of truth for desktop root resolution
    if grep -q '_desktop_private_fund_root' "$SRC_PDF"; then
      cp -f "$SRC_PDF" "$DST_PDF"
      echo "  updated private_fund_pdf.py from monorepo"
    fi
  fi
fi

# 5) Claude CLI shim for host harness readiness
mkdir -p "$RUNTIME_DIR/bin"
cp -f "$TPL/claude.cmd" "$RUNTIME_DIR/bin/claude.cmd"
CLAUDE_BUNDLED="$SITE/claude_agent_sdk/_bundled/claude.exe"
if [[ -f "$CLAUDE_BUNDLED" ]]; then
  # Prefer hardlink to avoid 250MB duplicate; fall back to nothing (cmd shim works)
  ln -f "$CLAUDE_BUNDLED" "$RUNTIME_DIR/bin/claude.exe" 2>/dev/null || true
  echo "  claude.cmd (+ claude.exe link if possible)"
fi

# 6) NATIVE_STACK marker
echo "native-windows" > "$RUNTIME_DIR/NATIVE_STACK"

echo "==> apply_runtime_fixes: done"
