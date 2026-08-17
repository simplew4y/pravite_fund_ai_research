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
if [[ "${DESKTOP_SKIP_RUNTIME_ASSEMBLY:-0}" != "1" ]]; then
  echo "==> Assembling native Windows runtime (this takes a while)"
  bash "$ROOT_DIR/scripts/desktop/assemble_win_native.sh"
else
  echo "==> Reusing existing native Windows runtime"
  bash "$ROOT_DIR/scripts/desktop/refresh_win_runtime_sources.sh"
fi

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

echo "==> Removing previous Windows package outputs"
rm -rf "$ELECTRON_DIR/dist"

echo "==> electron-builder --win --x64"
./node_modules/.bin/electron-builder --win --x64

echo "==> Writing release metadata"
export PF_RELEASE_ROOT="$ROOT_DIR"
export PF_RELEASE_DIST="$ELECTRON_DIR/dist"
python3 - <<'PY'
from __future__ import annotations

import hashlib
import json
import os
import subprocess
from datetime import datetime, timezone
from pathlib import Path

root = Path(os.environ["PF_RELEASE_ROOT"])
dist = Path(os.environ["PF_RELEASE_DIST"])
release = json.loads((root / "product-release.json").read_text(encoding="utf-8"))
commit = subprocess.check_output(
    ["git", "-C", str(root), "rev-parse", "HEAD"], text=True
).strip()
built_at = datetime.now(timezone.utc).isoformat()
runtime_version = {}
version_file = root / "omnigent/web/electron/resources/runtime/VERSION"
if version_file.is_file():
    for line in version_file.read_text(encoding="utf-8").splitlines():
        key, separator, value = line.partition("=")
        if separator:
            runtime_version[key] = value

artifacts = []
for path in sorted(dist.iterdir()):
    if not path.is_file() or path.suffix.lower() not in {".exe", ".blockmap"}:
        continue
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    artifacts.append({"name": path.name, "size": path.stat().st_size, "sha256": digest})

build_info = [
    f"product_version={release['productVersion']}",
    f"commit={commit}",
    f"built_at={built_at}",
    "platform=windows",
    "arch=x64",
    f"database_changed={str(bool(release['databaseChanged'])).lower()}",
    f"database_target_version={release['databaseTargetVersion']}",
    f"python={runtime_version.get('python', 'unknown')}",
]
(dist / "BUILD_INFO.txt").write_text("\n".join(build_info) + "\n", encoding="utf-8")

manifest = {
    "productVersion": release["productVersion"],
    "commit": commit,
    "builtAt": built_at,
    "platform": "windows",
    "arch": "x64",
    "databaseChanged": bool(release["databaseChanged"]),
    "databaseTargetVersion": release["databaseTargetVersion"],
    "migrationComponents": release["migrations"],
    "artifacts": artifacts,
}
(dist / "RELEASE_MANIFEST.json").write_text(
    json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
)
(dist / "SHA256SUMS").write_text(
    "".join(f"{item['sha256']}  {item['name']}\n" for item in artifacts), encoding="utf-8"
)
PY

echo "==> Artifacts:"
ls -lah "$ELECTRON_DIR/dist"/*.exe 2>/dev/null || true
ls -lah "$ELECTRON_DIR/dist"/*.blockmap "$ELECTRON_DIR/dist"/BUILD_INFO.txt \
  "$ELECTRON_DIR/dist"/RELEASE_MANIFEST.json "$ELECTRON_DIR/dist"/SHA256SUMS 2>/dev/null || true
du -sh "$ELECTRON_DIR/dist/win-unpacked" 2>/dev/null || true
test -f "$ELECTRON_DIR/dist/win-unpacked/resources/runtime/python/python.exe" && echo "OK: bundled python.exe in package"
test -f "$ELECTRON_DIR/dist/win-unpacked/resources/app.asar" && echo "OK: app.asar present"
echo ""
echo "Install on a CLEAN Windows PC (no WSL/Python required):"
echo "  $ELECTRON_DIR/dist/PrivateFundWorkbench-Setup-*.exe"
echo "Or portable:"
echo "  $ELECTRON_DIR/dist/win-unpacked/PrivateFundWorkbench.exe"
echo "User data will live under %APPDATA%\\私募研究工作台\\data\\users"
