#!/usr/bin/env bash
# Build a zero-dependency Windows installer:
#   Electron shell + bundled Windows Python full stack (no WSL required on target PC).
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ELECTRON_DIR="$ROOT_DIR/omnigent/web/electron"
WEB_DIR="$ROOT_DIR/omnigent/web"

echo "==> Private Fund desktop — ZERO-DEPENDENCY Windows package"
echo "    ROOT=$ROOT_DIR"

# 1) Web SPA → omnigent/server/static/web-ui
if [[ "${DESKTOP_SKIP_WEB_BUILD:-0}" != "1" ]]; then
  if [[ -f "$WEB_DIR/package.json" ]]; then
    echo "==> Building web UI"
    if [[ ! -d "$WEB_DIR/node_modules" ]]; then
      (cd "$WEB_DIR" && npm install --registry=https://registry.npmjs.org/)
    fi
    (cd "$WEB_DIR" && npm run build)
  fi
else
  echo "==> Skipping web build (DESKTOP_SKIP_WEB_BUILD=1)"
fi

# 2) Native Windows runtime (embeddable Python + wheels + slim project)
echo "==> Assembling native Windows runtime (this takes a while)"
bash "$ROOT_DIR/scripts/desktop/assemble_win_native.sh"

if [[ ! -f "$ELECTRON_DIR/resources/runtime/python/python.exe" ]]; then
  echo "ERROR: native python.exe missing after assemble" >&2
  exit 1
fi
if [[ ! -f "$ELECTRON_DIR/resources/runtime/NATIVE_STACK" ]]; then
  echo "ERROR: NATIVE_STACK marker missing" >&2
  exit 1
fi

# 3) Electron deps
echo "==> Electron npm install"
cd "$ELECTRON_DIR"
if [[ ! -x node_modules/.bin/electron-builder ]]; then
  if grep -q 'npm-proxy.cloud.databricks.com' package-lock.json 2>/dev/null; then
    rm -rf node_modules package-lock.json
  fi
  npm install --registry=https://registry.npmjs.org/
fi

if ! command -v wine >/dev/null 2>&1 && ! command -v wine64 >/dev/null 2>&1; then
  echo "ERROR: wine required for NSIS packaging from WSL" >&2
  exit 1
fi

export ELECTRON_BUILDER_CACHE="${ELECTRON_BUILDER_CACHE:-$HOME/.cache/electron-builder}"
export DESKTOP_MODE=bundled
export CSC_IDENTITY_AUTO_DISCOVERY="${CSC_IDENTITY_AUTO_DISCOVERY:-false}"

echo "==> electron-builder --win --x64"
./node_modules/.bin/electron-builder --win --x64

echo "==> Artifacts:"
ls -lah "$ELECTRON_DIR/dist"/*.exe 2>/dev/null || true
du -sh "$ELECTRON_DIR/dist/win-unpacked" 2>/dev/null || true
test -f "$ELECTRON_DIR/dist/win-unpacked/resources/runtime/python/python.exe" && echo "OK: bundled python.exe in package"
test -f "$ELECTRON_DIR/dist/win-unpacked/resources/app.asar" && echo "OK: app.asar present"
echo ""
echo "Install on a CLEAN Windows PC (no WSL/Python required):"
echo "  $ELECTRON_DIR/dist/PrivateFundWorkbench-Setup-*.exe"
echo "Or portable:"
echo "  $ELECTRON_DIR/dist/win-unpacked/PrivateFundWorkbench.exe"
echo "User data will live under %APPDATA%\\PrivateFundWorkbench\\data\\users"
