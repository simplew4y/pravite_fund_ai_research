#!/usr/bin/env bash
set -euo pipefail
ROOT=/home/code/pravite_fund_ai_research
RUNTIME="$ROOT/omnigent/web/electron/resources/runtime"
ELECTRON="$ROOT/omnigent/web/electron"
export WINEDEBUG=-all
export WINEPREFIX="$HOME/.cache/private-fund-desktop/wineprefix"
mkdir -p "$WINEPREFIX"

echo "==> Finalize native runtime markers"
test -f "$RUNTIME/python/python.exe"
test -d "$RUNTIME/python/Lib/site-packages/omnigent"
test -d "$RUNTIME/project/FinSagent/data_pipeline"
echo "native-windows" > "$RUNTIME/NATIVE_STACK"
date -u +"%Y-%m-%dT%H:%M:%SZ" > "$RUNTIME/VERSION"

# Prefer launchers
test -f "$RUNTIME/bin/omnigent.cmd" || {
  cat > "$RUNTIME/bin/omnigent.cmd" <<'EOF'
@echo off
call "%~dp0env.cmd"
"%PY_HOME%\python.exe" -m omnigent %*
EOF
}

# Pin click for omnigent (best-effort under wine)
wine64 "$RUNTIME/python/python.exe" -m pip install --no-warn-script-location 'click>=8.0,<8.2' 2>&1 | tail -8 || true

echo "==> Sizes"
du -sh "$RUNTIME" "$RUNTIME/python" "$RUNTIME/project"
ls "$RUNTIME/python/Lib/site-packages" | wc -l

echo "==> Electron package"
cd "$ELECTRON"
if [[ ! -x node_modules/.bin/electron-builder ]]; then
  npm install --registry=https://registry.npmjs.org/
fi
export CSC_IDENTITY_AUTO_DISCOVERY=false
export DESKTOP_MODE=bundled
./node_modules/.bin/electron-builder --win --x64

echo "==> Verify package contents"
ls -lah dist/*.exe 2>/dev/null || true
test -f dist/win-unpacked/resources/app.asar && echo OK_app_asar
test -f dist/win-unpacked/resources/runtime/python/python.exe && echo OK_python
test -f dist/win-unpacked/resources/runtime/NATIVE_STACK && echo OK_native_marker
test -d dist/win-unpacked/resources/runtime/python/Lib/site-packages/omnigent && echo OK_omnigent
du -sh dist/win-unpacked dist/*.exe 2>/dev/null || true
echo DONE
