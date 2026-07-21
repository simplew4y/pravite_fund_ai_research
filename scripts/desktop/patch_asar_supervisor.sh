#!/usr/bin/env bash
# Rebuild electron app.asar after process_supervisor.js fix, then copy to
# optional Windows target paths.
set -euo pipefail
ROOT=/home/code/pravite_fund_ai_research
ELECTRON="$ROOT/omnigent/web/electron"
cd "$ELECTRON"

export CSC_IDENTITY_AUTO_DISCOVERY=false
export DESKTOP_MODE=bundled

# Fast repack: only re-run electron-builder if asar tools fail
if [[ -x node_modules/.bin/electron-builder ]]; then
  echo "==> electron-builder --win --x64 (repack with fixed supervisor)"
  ./node_modules/.bin/electron-builder --win --x64
else
  echo "electron-builder missing" >&2
  exit 1
fi

echo "==> Verify litellm spawn uses litellm.exe or proxy_cli"
# Extract one string check from asar
python3 - <<'PY'
import pathlib, re, subprocess, tempfile, os, shutil
asar = pathlib.Path("dist/win-unpacked/resources/app.asar")
assert asar.exists(), asar
# use npx asar extract-file if available
import zipfile
# app.asar is not a zip; use @electron/asar via node
node = """
const asar = require('@electron/asar');
const fs = require('fs');
const path = require('path');
const text = asar.extractFile('dist/win-unpacked/resources/app.asar', 'src/process_supervisor.js').toString('utf8');
if (!text.includes('litellm.proxy.proxy_cli') && !text.includes('litellm.exe')) {
  console.error('PATCH MISSING in asar');
  process.exit(1);
}
console.log('OK asar contains fixed LiteLLM launch');
"""
open('/tmp/check_asar.js','w').write(node)
PY
node /tmp/check_asar.js || node -e "
const asar=require('@electron/asar');
const t=asar.extractFile('dist/win-unpacked/resources/app.asar','src/process_supervisor.js').toString('utf8');
console.log(t.includes('proxy_cli')||t.includes('litellm.exe') ? 'OK' : 'FAIL');
if(!(t.includes('proxy_cli')||t.includes('litellm.exe'))) process.exit(1);
"

ls -lah dist/PrivateFundWorkbench-Setup-*.exe dist/win-unpacked/resources/app.asar
echo DONE
