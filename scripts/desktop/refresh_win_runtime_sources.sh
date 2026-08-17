#!/usr/bin/env bash
# Refresh application sources inside an already assembled Windows runtime.
# This intentionally preserves Python wheels and the compiled cc-haha sidecar.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RUNTIME_DIR="${RUNTIME_OUT:-$ROOT_DIR/omnigent/web/electron/resources/runtime}"
PROJECT="$RUNTIME_DIR/project"

test -f "$RUNTIME_DIR/python/python.exe"
test -d "$RUNTIME_DIR/python/Lib/site-packages"
test -f "$RUNTIME_DIR/NATIVE_STACK"
test -f "$RUNTIME_DIR/bin/claude-haha.exe"

mkdir -p "$PROJECT/FinSagent/data_pipeline" "$PROJECT/src" "$PROJECT/scripts"

echo "==> Refresh FinSagent data pipeline"
rsync -a --delete \
  --exclude '__pycache__' --exclude '*.pyc' --exclude 'file2chunk' \
  "$ROOT_DIR/FinSagent/data_pipeline/" \
  "$PROJECT/FinSagent/data_pipeline/"

echo "==> Refresh PDF research runtime"
rsync -a --delete --exclude '__pycache__' --exclude '*.pyc' \
  "$ROOT_DIR/src/pdf_research_demo/" \
  "$PROJECT/src/pdf_research_demo/"
touch "$PROJECT/src/__init__.py"

echo "==> Refresh Omnigent sources and web UI"
rsync -a --delete \
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

# Embedded Python currently resolves the installed package before the slim
# project tree. Keep that import root in lockstep with the repository when a
# previously assembled dependency runtime is reused for a source-only release.
# Package metadata and third-party wheels live outside this directory and are
# intentionally preserved.
SITE_OMNIGENT="$RUNTIME_DIR/python/Lib/site-packages/omnigent"
test -d "$SITE_OMNIGENT"
rsync -a --delete \
  --exclude '__pycache__' \
  --exclude '*.pyc' \
  "$ROOT_DIR/omnigent/omnigent/" \
  "$SITE_OMNIGENT/"
cp -f "$ROOT_DIR/product-release.json" "$PROJECT/product-release.json"

# Repository-relative example symlinks are not portable in an Electron
# archive. Materialize the packages needed by the bundled runtime.
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

bash "$ROOT_DIR/scripts/desktop/apply_runtime_fixes.sh" "$RUNTIME_DIR"

test -f "$PROJECT/omnigent/omnigent/server/static/web-ui/index.html"
echo "==> Existing Windows dependencies retained; application sources refreshed"
