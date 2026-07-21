#!/usr/bin/env bash
# Assemble a self-contained Windows native runtime under
# omnigent/web/electron/resources/runtime for zero-dependency installs.
#
# Produces:
#   runtime/python/          Windows embeddable CPython + site-packages
#   runtime/bin/*.cmd        launchers (omnigent, litellm helpers)
#   runtime/project/         slim monorepo subset (pipeline + pdf_research_demo + omnigent src)
#   runtime/config/          desktop.env + litellm.yaml
#
# Requires: curl, unzip, wine64 (to run Windows python.exe pip on Linux/WSL).
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ELECTRON_DIR="$ROOT_DIR/omnigent/web/electron"
RUNTIME_DIR="${RUNTIME_OUT:-$ELECTRON_DIR/resources/runtime}"
REQ_FILE="$ROOT_DIR/scripts/desktop/requirements-desktop.txt"
PY_VER="${DESKTOP_PYTHON_VERSION:-3.12.10}"
PY_SHORT="${PY_VER%.*}"          # 3.12
PY_SHORT_NODOT="${PY_SHORT//./}" # 312
EMBED_URL="https://www.python.org/ftp/python/${PY_VER}/python-${PY_VER}-embed-amd64.zip"
GET_PIP_URL="https://bootstrap.pypa.io/get-pip.py"
CACHE_DIR="${DESKTOP_CACHE_DIR:-$HOME/.cache/private-fund-desktop}"
WINE="${WINE:-wine64}"

echo "==> Native Windows runtime → $RUNTIME_DIR"
mkdir -p "$CACHE_DIR" "$RUNTIME_DIR"/{bin,config,project}

if ! command -v "$WINE" >/dev/null 2>&1; then
  if command -v wine >/dev/null 2>&1; then
    WINE=wine
  else
    echo "ERROR: wine/wine64 required to install Windows Python packages from WSL." >&2
    echo "  sudo apt-get install -y wine64 wine" >&2
    exit 1
  fi
fi

# ---------------------------------------------------------------------------
# 1) Windows embeddable CPython
# ---------------------------------------------------------------------------
EMBED_ZIP="$CACHE_DIR/python-${PY_VER}-embed-amd64.zip"
if [[ ! -f "$EMBED_ZIP" ]]; then
  echo "==> Downloading embeddable Python $PY_VER"
  curl -fL --retry 3 -o "$EMBED_ZIP" "$EMBED_URL"
fi

PY_HOME="$RUNTIME_DIR/python"
rm -rf "$PY_HOME"
mkdir -p "$PY_HOME"
unzip -q -o "$EMBED_ZIP" -d "$PY_HOME"

# Enable site + pip layout for embeddable distribution
PTH_FILE="$PY_HOME/python${PY_SHORT_NODOT}._pth"
if [[ -f "$PTH_FILE" ]]; then
  # Uncomment import site; add Lib and site-packages
  python3 - "$PTH_FILE" <<'PY'
from pathlib import Path
import sys
p = Path(sys.argv[1])
lines = []
for line in p.read_text(encoding="utf-8").splitlines():
    s = line.strip()
    if s.startswith("#import site"):
        lines.append("import site")
    elif s == "import site":
        lines.append("import site")
    else:
        lines.append(line)
text = "\n".join(lines)
if "Lib" not in text:
    text = text.rstrip() + "\nLib\nLib\\site-packages\n.\n"
if "import site" not in text:
    text = text.rstrip() + "\nimport site\n"
p.write_text(text + "\n", encoding="utf-8")
print("patched", p)
PY
fi

mkdir -p "$PY_HOME/Lib/site-packages" "$PY_HOME/Scripts"

GET_PIP="$CACHE_DIR/get-pip.py"
if [[ ! -f "$GET_PIP" ]]; then
  curl -fL --retry 3 -o "$GET_PIP" "$GET_PIP_URL"
fi

echo "==> Installing pip into embeddable Python (via wine)"
export WINEDEBUG=-all
export WINEPREFIX="${WINEPREFIX:-$CACHE_DIR/wineprefix}"
mkdir -p "$WINEPREFIX"
# First-run wine can be slow; allow long timeout
set +e
"$WINE" "$PY_HOME/python.exe" "$GET_PIP" --no-warn-script-location 2>&1 | tail -30
PIP_RC=${PIPESTATUS[0]}
set -e
if [[ "$PIP_RC" -ne 0 ]]; then
  echo "WARN: wine get-pip failed (rc=$PIP_RC); trying ensurepip fallback" >&2
  "$WINE" "$PY_HOME/python.exe" -m ensurepip --upgrade 2>&1 | tail -20 || true
fi

WIN_PY="$PY_HOME/python.exe"
if ! "$WINE" "$WIN_PY" -m pip --version >/dev/null 2>&1; then
  echo "ERROR: pip not available under wine python.exe" >&2
  exit 1
fi
echo "==> $($WINE "$WIN_PY" -m pip --version 2>/dev/null | tr -d '\r')"

# ---------------------------------------------------------------------------
# 2) Install PyPI deps (Windows wheels via wine pip)
# ---------------------------------------------------------------------------
echo "==> pip install requirements-desktop.txt"
set +e
"$WINE" "$WIN_PY" -m pip install --no-warn-script-location \
  -r "$REQ_FILE" 2>&1 | tail -80
REQ_RC=${PIPESTATUS[0]}
set -e
if [[ "$REQ_RC" -ne 0 ]]; then
  echo "WARN: some requirements failed (rc=$REQ_RC); continuing with best-effort extras" >&2
fi

# Best-effort extras that often fail on Windows under wine
for extra in "cel-expr-python>=0.1"; do
  "$WINE" "$WIN_PY" -m pip install --no-warn-script-location "$extra" 2>&1 | tail -5 || true
done

# ---------------------------------------------------------------------------
# 3) Install monorepo packages: sdks + omnigent (from source)
# ---------------------------------------------------------------------------
echo "==> Installing omnigent SDKs + omnigent from source"
# Wine path: Z: maps to / on many wine prefixes
install_editable() {
  local dir="$1"
  echo "  - $dir"
  "$WINE" "$WIN_PY" -m pip install --no-warn-script-location --no-deps "$dir" 2>&1 | tail -15 || \
    "$WINE" "$WIN_PY" -m pip install --no-warn-script-location --no-deps -e "$dir" 2>&1 | tail -15 || true
}

# Prefer non-editable copy install so runtime doesn't depend on monorepo path after packaging
"$WINE" "$WIN_PY" -m pip install --no-warn-script-location --no-deps \
  "$ROOT_DIR/omnigent/sdks/python-client" 2>&1 | tail -20 || true
"$WINE" "$WIN_PY" -m pip install --no-warn-script-location --no-deps \
  "$ROOT_DIR/omnigent/sdks/ui" 2>&1 | tail -20 || true
"$WINE" "$WIN_PY" -m pip install --no-warn-script-location --no-deps \
  "$ROOT_DIR/omnigent" 2>&1 | tail -40 || true

# Robust package install (binary wheels + vendor omnigent sources)
if [[ -x "$ROOT_DIR/scripts/desktop/install_win_packages.sh" ]]; then
  echo "==> install_win_packages.sh (binary wheels + vendor)"
  bash "$ROOT_DIR/scripts/desktop/install_win_packages.sh" || true
fi

# Drop broken symlinks only (keep examples package; copy real polly/debby if needed)
find "$PY_HOME/Lib/site-packages" -type l 2>/dev/null | while read -r L; do
  [[ -e "$L" ]] || rm -f "$L"
done
EX_PKG="$PY_HOME/Lib/site-packages/omnigent/resources/examples"
if [[ -d "$PY_HOME/Lib/site-packages/omnigent/resources" ]]; then
  mkdir -p "$EX_PKG"
  : > "$EX_PKG/__init__.py"
  for name in polly debby; do
    if [[ -d "$ROOT_DIR/omnigent/examples/$name" && ! -d "$EX_PKG/$name" ]]; then
      cp -a "$ROOT_DIR/omnigent/examples/$name" "$EX_PKG/$name"
    fi
  done
fi

# ---------------------------------------------------------------------------
# 4) Slim project tree (paths Omnigent private-fund code expects)
# ---------------------------------------------------------------------------
PROJECT="$RUNTIME_DIR/project"
rm -rf "$PROJECT"
mkdir -p "$PROJECT/FinSagent/data_pipeline" "$PROJECT/src" "$PROJECT/output/private_fund_datasets" "$PROJECT/scripts"

echo "==> Copy FinSagent data_pipeline (slim)"
rsync -a --delete \
  --exclude '__pycache__' --exclude '*.pyc' --exclude 'file2chunk' \
  "$ROOT_DIR/FinSagent/data_pipeline/" \
  "$PROJECT/FinSagent/data_pipeline/"

echo "==> Copy src/pdf_research_demo"
rsync -a --delete --exclude '__pycache__' --exclude '*.pyc' \
  "$ROOT_DIR/src/pdf_research_demo/" \
  "$PROJECT/src/pdf_research_demo/"
touch "$PROJECT/src/__init__.py" 2>/dev/null || true

# Keep a copy of omnigent sources for PRIVATE_FUND_PROJECT_ROOT resolution /
# static web-ui path (package install may put modules in site-packages, but
# private_fund_pdf resolves parents relative to repo layout).
echo "==> Copy omnigent tree (no venv / node_modules)"
rsync -a \
  --exclude '.venv' \
  --exclude 'web/node_modules' \
  --exclude 'web/electron/node_modules' \
  --exclude 'web/electron/dist' \
  --exclude 'web/electron/resources' \
  --exclude '**/__pycache__' \
  --exclude '**/*.pyc' \
  --exclude '.git' \
  --exclude 'tests' \
  --exclude '/examples' \
  "$ROOT_DIR/omnigent/" \
  "$PROJECT/omnigent/"

# resources/examples contains repository-relative symlinks. The top-level
# examples tree is intentionally excluded above, so materialize the linked
# packages to keep Windows packagers from seeing dangling entries.
PROJECT_EXAMPLES="$PROJECT/omnigent/omnigent/resources/examples"
mkdir -p "$PROJECT_EXAMPLES"
for name in polly debby; do
  rm -rf "$PROJECT_EXAMPLES/$name"
  if [[ -d "$ROOT_DIR/omnigent/examples/$name" ]]; then
    cp -a "$ROOT_DIR/omnigent/examples/$name" "$PROJECT_EXAMPLES/$name"
  fi
done
find "$PROJECT/omnigent" -type l 2>/dev/null | while read -r link; do
  [[ -e "$link" ]] || rm -f "$link"
done

if [[ ! -f "$PROJECT/omnigent/omnigent/server/static/web-ui/index.html" ]]; then
  echo "WARN: web-ui static missing — run: (cd omnigent/web && npm run build)" >&2
else
  echo "==> web-ui static present"
fi

touch "$PROJECT/output/private_fund_datasets/.keep"

# ---------------------------------------------------------------------------
# 5) Compile the cc-haha Windows sidecar
# ---------------------------------------------------------------------------
BUN_BIN="${BUN:-$(command -v bun 2>/dev/null || true)}"
if [[ -z "$BUN_BIN" && -x "$HOME/.bun/bin/bun" ]]; then
  BUN_BIN="$HOME/.bun/bin/bun"
fi
if [[ -z "$BUN_BIN" ]]; then
  echo "ERROR: bun is required to compile the cc-haha Windows sidecar." >&2
  exit 1
fi
echo "==> Building cc-haha Windows x64 sidecar"
(
  cd "$ROOT_DIR/cc-haha/desktop"
  export PATH="$(dirname "$BUN_BIN"):$PATH"
  if [[ ! -d "$ROOT_DIR/cc-haha/adapters/node_modules" ]]; then
    echo "==> Installing cc-haha adapter dependencies required by the compiler"
    (cd "$ROOT_DIR/cc-haha/adapters" && "$BUN_BIN" install --frozen-lockfile)
  fi
  SIDECAR_TARGET_TRIPLE=x86_64-pc-windows-msvc "$BUN_BIN" run build:sidecars
)
CC_HAHA_BASE="$ROOT_DIR/cc-haha/desktop/src-tauri/binaries/claude-sidecar-x86_64-pc-windows-msvc"
if [[ -f "${CC_HAHA_BASE}.exe" ]]; then
  CC_HAHA_BUILD="${CC_HAHA_BASE}.exe"
elif [[ -f "$CC_HAHA_BASE" ]]; then
  CC_HAHA_BUILD="$CC_HAHA_BASE"
else
  echo "ERROR: cc-haha sidecar output was not found under $(dirname "$CC_HAHA_BASE")" >&2
  exit 1
fi
cp -f "$CC_HAHA_BUILD" "$RUNTIME_DIR/bin/claude-haha.exe"
chmod +x "$RUNTIME_DIR/bin/claude-haha.exe" 2>/dev/null || true
echo "==> cc-haha sidecar: $RUNTIME_DIR/bin/claude-haha.exe"

# ---------------------------------------------------------------------------
# 6) Non-secret desktop defaults and a compatibility LiteLLM placeholder.
# ---------------------------------------------------------------------------
cat > "$RUNTIME_DIR/config/desktop.env" <<EOF
# Generated by assemble_win_native.sh. LLM credentials are stored in user Settings.
DESKTOP_MODE=bundled
DESKTOP_STACK=native
LITELLM_HOST=127.0.0.1
LITELLM_PORT=4000
OMNIGENT_SERVER_HOST=127.0.0.1
OMNIGENT_SERVER_PORT=6767
OMNIGENT_AUTH_ENABLED=0
OMNIGENT_LOCAL_SINGLE_USER=1
OMNIGENT_NO_UPDATE_CHECK=1
ANTHROPIC_AUTH_TOKEN=sk-local-cc-haha
OMNIGENT_CLAUDE_NATIVE_AUTO_APPROVE=1
EOF

cat > "$RUNTIME_DIR/config/litellm.yaml" <<'EOF'
# Compatibility placeholder. Electron writes the active model map to the
# per-user config directory before starting LiteLLM.
model_list: []
EOF

# ---------------------------------------------------------------------------
# 7) Windows launchers (.cmd)
# ---------------------------------------------------------------------------
# PYTHONPATH includes project so private_fund + pdf_research_demo resolve.
# %~dp0 is runtime/bin/
cat > "$RUNTIME_DIR/bin/env.cmd" <<'EOF'
@echo off
set "RUNTIME_ROOT=%~dp0.."
set "PY_HOME=%RUNTIME_ROOT%\python"
set "PROJECT_ROOT=%RUNTIME_ROOT%\project"
set "PYTHONPATH=%PROJECT_ROOT%;%PROJECT_ROOT%\src;%PROJECT_ROOT%\omnigent;%PY_HOME%\Lib\site-packages"
set "PATH=%PY_HOME%;%PY_HOME%\Scripts;%RUNTIME_ROOT%\bin;%PATH%"
set "PYTHONUTF8=1"
set "PYTHONIOENCODING=utf-8"
if exist "%RUNTIME_ROOT%\config\desktop.env" (
  for /f "usebackq eol=# tokens=1,* delims==" %%A in ("%RUNTIME_ROOT%\config\desktop.env") do (
    if not "%%A"=="" set "%%A=%%B"
  )
)
if "%PRIVATE_FUND_PROJECT_ROOT%"=="" set "PRIVATE_FUND_PROJECT_ROOT=%PROJECT_ROOT%"
if "%OMNIGENT_AUTH_ENABLED%"=="" set "OMNIGENT_AUTH_ENABLED=0"
if "%OMNIGENT_LOCAL_SINGLE_USER%"=="" set "OMNIGENT_LOCAL_SINGLE_USER=1"
if "%PYTHONPYCACHEPREFIX%"=="" (
  if not "%OMNIGENT_CONFIG_HOME%"=="" (
    set "PYTHONPYCACHEPREFIX=%OMNIGENT_CONFIG_HOME%\pycache\python312"
  ) else (
    set "PYTHONPYCACHEPREFIX=%LOCALAPPDATA%\PrivateFundWorkbench\pycache\python312"
  )
)
if not exist "%PYTHONPYCACHEPREFIX%" mkdir "%PYTHONPYCACHEPREFIX%" >nul 2>&1
EOF

cat > "$RUNTIME_DIR/bin/omnigent.cmd" <<'EOF'
@echo off
call "%~dp0env.cmd"
"%PY_HOME%\python.exe" -m omnigent %*
EOF

cat > "$RUNTIME_DIR/bin/python.cmd" <<'EOF'
@echo off
call "%~dp0env.cmd"
"%PY_HOME%\python.exe" %*
EOF

cat > "$RUNTIME_DIR/bin/start_litellm.cmd" <<'EOF'
@echo off
call "%~dp0env.cmd"
set "CFG=%RUNTIME_ROOT%\config\litellm.yaml"
"%PY_HOME%\python.exe" -m litellm --config "%CFG%" --host %LITELLM_HOST% --port %LITELLM_PORT%
EOF

# Also provide omnigent without extension for unix-style resolution on non-win (unused on win)
cat > "$RUNTIME_DIR/bin/omnigent" <<'EOF'
#!/usr/bin/env bash
# Linux stub — Windows package uses omnigent.cmd
DIR="$(cd "$(dirname "$0")" && pwd)"
exec "$DIR/../python/python.exe" -m omnigent "$@"
EOF
chmod +x "$RUNTIME_DIR/bin/omnigent" 2>/dev/null || true

# cc-haha.exe was installed above; the harness resolves it from runtime/bin.
# Marker so supervisor detects native strategy
bash "$ROOT_DIR/scripts/desktop/apply_runtime_fixes.sh" "$RUNTIME_DIR"

# Bytecode generated while installing and smoke-testing dependencies nearly
# doubles the Python file count. Ship sources only and let the desktop write
# cache files on demand under its writable per-user PYTHONPYCACHEPREFIX.
echo "==> Removing packaged Python bytecode caches"
PYCACHE_FILES_BEFORE="$(find "$RUNTIME_DIR" -type f \( -name '*.pyc' -o -name '*.pyo' \) | wc -l)"
find "$RUNTIME_DIR" -type d -name '__pycache__' -prune -exec rm -rf {} +
find "$RUNTIME_DIR" -type f \( -name '*.pyc' -o -name '*.pyo' \) -delete
echo "    removed $PYCACHE_FILES_BEFORE bytecode files"

echo "native-windows" > "$RUNTIME_DIR/NATIVE_STACK"
{
  echo "python=$PY_VER"
  echo "built=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "root=$ROOT_DIR"
} > "$RUNTIME_DIR/VERSION"

echo "==> Runtime size:"
du -sh "$RUNTIME_DIR" "$PY_HOME" "$PROJECT" 2>/dev/null || true
echo "==> assemble_win_native: done"
echo "    python: $PY_HOME/python.exe"
echo "    omnigent.cmd: $RUNTIME_DIR/bin/omnigent.cmd"
