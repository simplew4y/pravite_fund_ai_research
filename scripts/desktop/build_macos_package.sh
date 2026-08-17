#!/usr/bin/env bash
# Build the unsigned/ad-hoc-signed Apple Silicon desktop application.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WEB_DIR="$ROOT_DIR/omnigent/web"
ELECTRON_DIR="$WEB_DIR/electron"
DIST_DIR="$ELECTRON_DIR/dist"

if [[ "$(uname -s)" != "Darwin" || "$(uname -m)" != "arm64" ]]; then
  echo "ERROR: build_macos_package.sh requires an Apple Silicon Mac." >&2
  exit 1
fi
for command in node npm bun xcode-select codesign hdiutil file shasum curl; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "ERROR: required command is missing: $command" >&2
    exit 1
  fi
done
if ! xcode-select -p >/dev/null 2>&1; then
  echo "ERROR: Xcode Command Line Tools are not configured." >&2
  exit 1
fi

echo "==> Building web UI"
(
  cd "$WEB_DIR"
  npm ci --registry=https://registry.npmjs.org/
  npm run build
)

echo "==> Assembling Apple Silicon native runtime"
bash "$ROOT_DIR/scripts/desktop/assemble_mac_native.sh"

echo "==> Installing Electron dependencies and running tests"
(
  cd "$ELECTRON_DIR"
  npm ci --registry=https://registry.npmjs.org/
  npm test
)

rm -rf "$DIST_DIR"
export DESKTOP_MODE=bundled
export DESKTOP_MAC_SIGN_MODE="${DESKTOP_MAC_SIGN_MODE:-adhoc}"
export CSC_IDENTITY_AUTO_DISCOVERY=false

if [[ "$DESKTOP_MAC_SIGN_MODE" != "adhoc" ]]; then
  echo "ERROR: v1 supports DESKTOP_MAC_SIGN_MODE=adhoc only." >&2
  exit 1
fi

echo "==> Packaging DMG and ZIP"
(
  cd "$ELECTRON_DIR"
  npm run build:mac:internal
)

APP_PATH="$(find "$DIST_DIR" -maxdepth 3 -type d -name 'PrivateFundWorkbench.app' -print -quit)"
if [[ -z "$APP_PATH" ]]; then
  echo "ERROR: packaged .app was not found under $DIST_DIR" >&2
  exit 1
fi

RUNTIME="$APP_PATH/Contents/Resources/runtime"
PYTHON="$RUNTIME/python/bin/python3"
SIDECAR="$RUNTIME/bin/claude-haha"
for executable in "$PYTHON" "$SIDECAR"; do
  description="$(file -L -b "$executable")"
  if [[ "$description" != *"Mach-O"* || "$description" != *"arm64"* ]]; then
    echo "ERROR: packaged executable is not arm64 Mach-O: $executable ($description)" >&2
    exit 1
  fi
done

codesign --verify --deep --strict --verbose=2 "$APP_PATH"
shopt -s nullglob
DMG_ARTIFACTS=("$DIST_DIR"/*.dmg)
ZIP_ARTIFACTS=("$DIST_DIR"/*.zip)
if [[ "${#DMG_ARTIFACTS[@]}" -eq 0 || "${#ZIP_ARTIFACTS[@]}" -eq 0 ]]; then
  echo "ERROR: both DMG and ZIP artifacts are required." >&2
  exit 1
fi
for dmg in "${DMG_ARTIFACTS[@]}"; do
  hdiutil verify "$dmg"
done

if [[ "${SKIP_MAC_PACKAGE_SMOKE:-0}" != "1" ]]; then
  echo "==> Launching packaged app for health smoke"
  APP_EXECUTABLE="$APP_PATH/Contents/MacOS/PrivateFundWorkbench"
  SMOKE_LOG="$DIST_DIR/macos-package-smoke.log"
  "$APP_EXECUTABLE" >"$SMOKE_LOG" 2>&1 &
  APP_PID=$!
  cleanup() {
    kill -TERM "$APP_PID" >/dev/null 2>&1 || true
    for _ in $(seq 1 20); do
      kill -0 "$APP_PID" >/dev/null 2>&1 || break
      sleep 1
    done
    kill -KILL "$APP_PID" >/dev/null 2>&1 || true
    wait "$APP_PID" >/dev/null 2>&1 || true
  }
  trap cleanup EXIT
  healthy=0
  for _ in $(seq 1 180); do
    if curl -fsS --max-time 2 http://127.0.0.1:6767/health >/dev/null 2>&1; then
      healthy=1
      break
    fi
    if ! kill -0 "$APP_PID" >/dev/null 2>&1; then
      break
    fi
    sleep 1
  done
  if [[ "$healthy" -ne 1 ]]; then
    echo "ERROR: packaged application did not become healthy. Log: $SMOKE_LOG" >&2
    tail -100 "$SMOKE_LOG" >&2 || true
    exit 1
  fi
  cleanup
  trap - EXIT
  for _ in $(seq 1 20); do
    if ! curl -fsS --max-time 1 http://127.0.0.1:6767/health >/dev/null 2>&1; then
      break
    fi
    sleep 1
  done
  if curl -fsS --max-time 1 http://127.0.0.1:6767/health >/dev/null 2>&1; then
    echo "ERROR: local services remained alive after the packaged app exited." >&2
    exit 1
  fi
fi

echo "==> Writing build metadata and checksums"
COMMIT="$(git -C "$ROOT_DIR" rev-parse HEAD)"
CC_HAHA_DESC="$(file -b "$SIDECAR")"
cat > "$DIST_DIR/BUILD_INFO.txt" <<EOF
product=PrivateFundWorkbench
version=$(node -p "require('$ELECTRON_DIR/package.json').version")
platform=macos-arm64
signing=adhoc
commit=$COMMIT
built=$(date -u +%Y-%m-%dT%H:%M:%SZ)
node=$(node --version)
npm=$(npm --version)
bun=$(bun --version)
python=$($PYTHON --version 2>&1)
cc_haha=$CC_HAHA_DESC
EOF

(
  cd "$DIST_DIR"
  shopt -s nullglob
  artifacts=(*.dmg *.zip)
  if [[ "${#artifacts[@]}" -eq 0 ]]; then
    echo "ERROR: no DMG or ZIP artifacts were produced." >&2
    exit 1
  fi
  shasum -a 256 "${artifacts[@]}" > SHA256SUMS
)

echo "==> macOS artifacts"
ls -lah "$DIST_DIR"/*.dmg "$DIST_DIR"/*.zip \
  "$DIST_DIR/SHA256SUMS" "$DIST_DIR/BUILD_INFO.txt"
