#!/usr/bin/env bash
# Assemble a self-contained Apple Silicon runtime under
# omnigent/web/electron/resources/runtime.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ELECTRON_DIR="$ROOT_DIR/omnigent/web/electron"
RUNTIME_DIR="${RUNTIME_OUT:-$ELECTRON_DIR/resources/runtime}"
REQ_FILE="$ROOT_DIR/scripts/desktop/requirements-desktop.txt"
CACHE_DIR="${DESKTOP_CACHE_DIR:-$HOME/Library/Caches/PrivateFundWorkbench/build}"

PY_VER="3.12.12"
PY_BUILD="20260211"
DEFAULT_PYTHON_URL="https://github.com/astral-sh/python-build-standalone/releases/download/${PY_BUILD}/cpython-${PY_VER}%2B${PY_BUILD}-aarch64-apple-darwin-install_only_stripped.tar.gz"
DEFAULT_PYTHON_SHA256="22625deaf5757e7c266cf1a096c9151a06b598b1e14632a2ec9993d58ec5fe84"
PYTHON_URL="${MACOS_PYTHON_ARCHIVE_URL:-$DEFAULT_PYTHON_URL}"
PYTHON_SHA256="${MACOS_PYTHON_ARCHIVE_SHA256:-$DEFAULT_PYTHON_SHA256}"
PYTHON_ARCHIVE="$CACHE_DIR/cpython-${PY_VER}+${PY_BUILD}-aarch64-apple-darwin-install_only_stripped.tar.gz"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "ERROR: assemble_mac_native.sh must run on macOS." >&2
  exit 1
fi
if [[ "$(uname -m)" != "arm64" ]]; then
  echo "ERROR: the first macOS release only supports Apple Silicon (arm64)." >&2
  exit 1
fi

for command in curl tar rsync shasum file codesign bun; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "ERROR: required command is missing: $command" >&2
    exit 1
  fi
done
if ! xcode-select -p >/dev/null 2>&1; then
  echo "ERROR: Xcode Command Line Tools are required (run: xcode-select --install)." >&2
  exit 1
fi

mkdir -p "$CACHE_DIR"
rm -rf "$RUNTIME_DIR"
mkdir -p "$RUNTIME_DIR"/{bin,config,project}

verify_archive() {
  printf '%s  %s\n' "$PYTHON_SHA256" "$PYTHON_ARCHIVE" | shasum -a 256 -c - >/dev/null
}

if [[ ! -f "$PYTHON_ARCHIVE" ]] || ! verify_archive; then
  rm -f "$PYTHON_ARCHIVE"
  echo "==> Downloading pinned CPython ${PY_VER} for Apple Silicon"
  curl -fL --retry 3 --retry-delay 2 -o "$PYTHON_ARCHIVE" "$PYTHON_URL"
fi
if ! verify_archive; then
  echo "ERROR: CPython archive SHA256 verification failed." >&2
  rm -f "$PYTHON_ARCHIVE"
  exit 1
fi

echo "==> Extracting bundled CPython"
tar -xzf "$PYTHON_ARCHIVE" -C "$RUNTIME_DIR"
PY_HOME="$RUNTIME_DIR/python"
PYTHON="$PY_HOME/bin/python3"
if [[ ! -x "$PYTHON" ]]; then
  echo "ERROR: bundled Python was not extracted at $PYTHON" >&2
  exit 1
fi

echo "==> Installing desktop Python dependencies"
"$PYTHON" -m pip install --upgrade pip setuptools wheel
"$PYTHON" -m pip install -r "$REQ_FILE"

echo "==> Installing Omnigent packages from this checkout"
"$PYTHON" -m pip install --no-deps "$ROOT_DIR/omnigent/sdks/python-client"
"$PYTHON" -m pip install --no-deps "$ROOT_DIR/omnigent/sdks/ui"
"$PYTHON" -m pip install --no-deps "$ROOT_DIR/omnigent"

PROJECT="$RUNTIME_DIR/project"
mkdir -p "$PROJECT/FinSagent/data_pipeline" "$PROJECT/src" \
  "$PROJECT/output/private_fund_datasets" "$PROJECT/scripts"

echo "==> Copying private-fund pipeline and application sources"
rsync -a --delete \
  --exclude '__pycache__' --exclude '*.pyc' --exclude 'file2chunk' \
  "$ROOT_DIR/FinSagent/data_pipeline/" "$PROJECT/FinSagent/data_pipeline/"
rsync -a --delete --exclude '__pycache__' --exclude '*.pyc' \
  "$ROOT_DIR/src/pdf_research_demo/" "$PROJECT/src/pdf_research_demo/"
touch "$PROJECT/src/__init__.py"
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
  "$ROOT_DIR/omnigent/" "$PROJECT/omnigent/"

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
touch "$PROJECT/output/private_fund_datasets/.keep"

if [[ ! -f "$PROJECT/omnigent/omnigent/server/static/web-ui/index.html" ]]; then
  echo "ERROR: built web UI is missing; run the web build before assembling runtime." >&2
  exit 1
fi

echo "==> Building cc-haha Apple Silicon sidecar"
(
  cd "$ROOT_DIR/cc-haha"
  bun install --frozen-lockfile
)
(
  cd "$ROOT_DIR/cc-haha/adapters"
  bun install --frozen-lockfile
)
(
  cd "$ROOT_DIR/cc-haha/desktop"
  SIDECAR_TARGET_TRIPLE=aarch64-apple-darwin bun run build:sidecars
)
CC_HAHA_BUILD="$ROOT_DIR/cc-haha/desktop/src-tauri/binaries/claude-sidecar-aarch64-apple-darwin"
if [[ ! -f "$CC_HAHA_BUILD" ]]; then
  echo "ERROR: cc-haha sidecar was not produced at $CC_HAHA_BUILD" >&2
  exit 1
fi
cp -f "$CC_HAHA_BUILD" "$RUNTIME_DIR/bin/claude-haha"
chmod 755 "$RUNTIME_DIR/bin/claude-haha"
codesign --remove-signature "$RUNTIME_DIR/bin/claude-haha" >/dev/null 2>&1 || true
codesign --force --sign - --timestamp=none "$RUNTIME_DIR/bin/claude-haha"

cat > "$RUNTIME_DIR/config/desktop.env" <<'EOF'
# Generated by assemble_mac_native.sh. LLM credentials live in user Settings.
DESKTOP_MODE=bundled
DESKTOP_STACK=native
LITELLM_HOST=127.0.0.1
LITELLM_PORT=4000
OMNIGENT_SERVER_HOST=127.0.0.1
OMNIGENT_SERVER_PORT=6767
OMNIGENT_AUTH_ENABLED=1
OMNIGENT_AUTH_PROVIDER=cloud_accounts
OMNIGENT_ACCOUNTS_ENABLED=1
OMNIGENT_ACCOUNTS_REGISTRATION_MODE=open
OMNIGENT_CLOUD_BACKEND_URL=https://capoo.fun/private_fund/backend
OMNIGENT_CLOUD_REQUEST_TIMEOUT_SECONDS=10
OMNIGENT_CLOUD_UPLOAD_TIMEOUT_SECONDS=180
OMNIGENT_CLOUD_REGISTRATION_ENABLED=1
OMNIGENT_LOCAL_SINGLE_USER=0
OMNIGENT_NO_UPDATE_CHECK=1
ANTHROPIC_AUTH_TOKEN=sk-local-cc-haha
OMNIGENT_CLAUDE_NATIVE_AUTO_APPROVE=1
EOF

cat > "$RUNTIME_DIR/config/litellm.yaml" <<'EOF'
# Compatibility placeholder. Electron writes the active model map to the
# per-user config directory before starting LiteLLM.
model_list: []
EOF

cat > "$RUNTIME_DIR/bin/env" <<'EOF'
#!/usr/bin/env bash
set -e
RUNTIME_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PY_HOME="$RUNTIME_ROOT/python"
export PROJECT_ROOT="$RUNTIME_ROOT/project"
export PYTHONPATH="$PROJECT_ROOT:$PROJECT_ROOT/src:$PROJECT_ROOT/omnigent:$PY_HOME/lib/python3.12/site-packages${PYTHONPATH:+:$PYTHONPATH}"
export PATH="$RUNTIME_ROOT/bin:$PY_HOME/bin:$PATH"
export PYTHONUTF8=1
export PYTHONIOENCODING=utf-8
EOF

cat > "$RUNTIME_DIR/bin/omnigent" <<'EOF'
#!/usr/bin/env bash
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
source "$DIR/env"
exec "$PY_HOME/bin/python3" -m omnigent "$@"
EOF

cat > "$RUNTIME_DIR/bin/python" <<'EOF'
#!/usr/bin/env bash
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
source "$DIR/env"
exec "$PY_HOME/bin/python3" "$@"
EOF
chmod 755 "$RUNTIME_DIR/bin/env" "$RUNTIME_DIR/bin/omnigent" "$RUNTIME_DIR/bin/python"

DESKTOP_RUNTIME_TARGET=macos bash "$ROOT_DIR/scripts/desktop/apply_runtime_fixes.sh" "$RUNTIME_DIR"

echo "==> Running bundled runtime smoke checks"
"$PYTHON" -c 'import akshare, litellm, fitz, pandas, openpyxl, omnigent; print("runtime imports: ok")'
"$RUNTIME_DIR/bin/omnigent" --help >/dev/null

echo "==> Removing packaged Python bytecode caches"
find "$RUNTIME_DIR" -type d -name '__pycache__' -prune -exec rm -rf {} +
find "$RUNTIME_DIR" -type f \( -name '*.pyc' -o -name '*.pyo' \) -delete

echo "==> Verifying packaged Mach-O architecture"
bad_arch=0
while IFS= read -r -d '' candidate; do
  description="$(file -b "$candidate")"
  if [[ "$description" == *"Mach-O"* && "$description" != *"arm64"* ]]; then
    echo "ERROR: non-arm64 Mach-O file: $candidate ($description)" >&2
    bad_arch=1
  fi
done < <(find "$RUNTIME_DIR" -type f \( -perm -111 -o -name '*.so' -o -name '*.dylib' \) -print0)
if [[ "$bad_arch" -ne 0 ]]; then
  exit 1
fi

echo "native-macos-arm64" > "$RUNTIME_DIR/NATIVE_STACK"
{
  echo "platform=macos-arm64"
  echo "python=$PY_VER"
  echo "python_build=$PY_BUILD"
  echo "python_sha256=$PYTHON_SHA256"
  echo "built=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
} > "$RUNTIME_DIR/VERSION"

echo "==> macOS native runtime ready"
du -sh "$RUNTIME_DIR" "$PY_HOME" "$PROJECT" 2>/dev/null || true
