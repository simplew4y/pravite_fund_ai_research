#!/usr/bin/env bash
# Install Windows wheels into an already-unpacked embeddable CPython (via wine).
# Prefer binary wheels only so wine doesn't need maturin/compilers.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RUNTIME_DIR="${RUNTIME_OUT:-$ROOT_DIR/omnigent/web/electron/resources/runtime}"
PY_HOME="$RUNTIME_DIR/python"
WIN_PY="$PY_HOME/python.exe"
WINE="${WINE:-wine64}"
command -v "$WINE" >/dev/null 2>&1 || WINE=wine
export WINEDEBUG=-all
export WINEPREFIX="${WINEPREFIX:-$HOME/.cache/private-fund-desktop/wineprefix}"

if [[ ! -f "$WIN_PY" ]]; then
  echo "ERROR: $WIN_PY missing — run assemble_win_native.sh first" >&2
  exit 1
fi

wpip() {
  "$WINE" "$WIN_PY" -m pip "$@"
}

echo "==> Bootstrap build tools + only-binary critical stack"
wpip install --no-warn-script-location -U pip setuptools wheel hatchling

# Install in batches with --only-binary=:all: first
BATCH1=(
  fastapi "uvicorn[standard]" starlette httpx websockets anyio
  pydantic pydantic-settings pyyaml openai rich "prompt_toolkit"
  mcp psutil keyring tomlkit alembic cachetools "click<8.2"
  sqlalchemy tiktoken "PyJWT[crypto]" argon2-cffi packaging ftfy
  python-multipart aiofiles orjson
)
BATCH2=(
  "numpy<3" "pandas<3" "matplotlib<4" "pymupdf<2" openpyxl xlrd Pillow
)
BATCH3=(
  "litellm[proxy]" "openai-agents"
)
BATCH4=(
  opentelemetry-api opentelemetry-sdk
  opentelemetry-exporter-otlp-proto-http
  opentelemetry-instrumentation-fastapi
  opentelemetry-instrumentation-httpx
)

install_batch() {
  local name="$1"
  shift
  echo "==> Batch $name (only-binary)"
  set +e
  wpip install --no-warn-script-location --only-binary=:all: "$@" 2>&1 | tail -40
  local rc=${PIPESTATUS[0]}
  set -e
  if [[ $rc -ne 0 ]]; then
    echo "WARN: only-binary failed for $name; retry without only-binary" >&2
    wpip install --no-warn-script-location "$@" 2>&1 | tail -40 || true
  fi
}

install_batch "server" "${BATCH1[@]}"
install_batch "data" "${BATCH2[@]}"
install_batch "llm" "${BATCH3[@]}"
install_batch "otel" "${BATCH4[@]}"

# Best-effort
wpip install --no-warn-script-location --only-binary=:all: "claude-agent-sdk>=0.1.62" 2>&1 | tail -10 || true
wpip install --no-warn-script-location --only-binary=:all: "cel-expr-python>=0.1" 2>&1 | tail -10 || true

# ---------------------------------------------------------------------------
# Copy monorepo Python packages into site-packages (no build backend needed)
# ---------------------------------------------------------------------------
SITE="$PY_HOME/Lib/site-packages"
echo "==> Vendor omnigent packages into $SITE"

vendor_pkg() {
  local src="$1"
  local name="$2"
  if [[ -d "$src" ]]; then
    rm -rf "$SITE/$name"
    cp -a "$src" "$SITE/$name"
    echo "  vendored $name"
  else
    echo "  SKIP missing $src" >&2
  fi
}

# sdks
if [[ -d "$ROOT_DIR/omnigent/sdks/python-client/omnigent_client" ]]; then
  vendor_pkg "$ROOT_DIR/omnigent/sdks/python-client/omnigent_client" "omnigent_client"
elif [[ -d "$ROOT_DIR/omnigent/sdks/python-client/src/omnigent_client" ]]; then
  vendor_pkg "$ROOT_DIR/omnigent/sdks/python-client/src/omnigent_client" "omnigent_client"
else
  # discover package dir
  find "$ROOT_DIR/omnigent/sdks/python-client" -maxdepth 3 -type d -name 'omnigent*' 2>/dev/null | head -5
fi

if [[ -d "$ROOT_DIR/omnigent/sdks/ui/omnigent_ui_sdk" ]]; then
  vendor_pkg "$ROOT_DIR/omnigent/sdks/ui/omnigent_ui_sdk" "omnigent_ui_sdk"
elif [[ -d "$ROOT_DIR/omnigent/sdks/ui/src/omnigent_ui_sdk" ]]; then
  vendor_pkg "$ROOT_DIR/omnigent/sdks/ui/src/omnigent_ui_sdk" "omnigent_ui_sdk"
else
  find "$ROOT_DIR/omnigent/sdks/ui" -maxdepth 3 -type d -name 'omnigent*' 2>/dev/null | head -5
fi

vendor_pkg "$ROOT_DIR/omnigent/omnigent" "omnigent"

# resources/examples has symlinks (polly/debby) that break packaging — replace
# with real copies + empty package always importable.
EX_PKG="$SITE/omnigent/resources/examples"
mkdir -p "$EX_PKG"
: > "$EX_PKG/__init__.py"
for name in polly debby; do
  if [[ -d "$ROOT_DIR/omnigent/examples/$name" ]]; then
    rm -rf "$EX_PKG/$name"
    cp -a "$ROOT_DIR/omnigent/examples/$name" "$EX_PKG/$name"
  fi
done
# Drop any remaining broken symlinks under omnigent
find "$SITE/omnigent" -type l 2>/dev/null | while read -r L; do
  [[ -e "$L" ]] || rm -f "$L"
done

# Portable embeddable Python ignores PYTHONPATH — inject project paths.
cp -f "$ROOT_DIR/scripts/desktop/templates/sitecustomize.py" "$SITE/sitecustomize.py"

# Write simple dist-info so import tools don't complain
python3 - "$SITE" <<'PY'
from pathlib import Path
import sys
site = Path(sys.argv[1])
for name, ver in [("omnigent", "0.3.0"), ("omnigent_client", "0.3.0"), ("omnigent_ui_sdk", "0.3.0")]:
    if not (site / name).exists():
        continue
    d = site / f"{name.replace('_', '_')}-{ver}.dist-info"
    # normalize names for dist-info
    dist = site / f"{name}-{ver}.dist-info"
    dist.mkdir(exist_ok=True)
    (dist / "METADATA").write_text(f"Metadata-Version: 2.1\nName: {name}\nVersion: {ver}\n", encoding="utf-8")
    (dist / "INSTALLER").write_text("vendor\n", encoding="utf-8")
    print("dist-info", dist)
PY

echo "==> Smoke imports"
"$WINE" "$WIN_PY" - <<'PY'
import sys
print("python", sys.version)
for m in ["fastapi", "uvicorn", "httpx", "pydantic", "yaml", "litellm", "pymupdf", "pandas", "omnigent", "omnigent.server"]:
    try:
        __import__(m)
        print("OK", m)
    except Exception as e:
        print("FAIL", m, type(e).__name__, e)
PY

echo "==> install_win_packages: done"
