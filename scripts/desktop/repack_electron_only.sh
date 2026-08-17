#!/usr/bin/env bash
# Fast repack of Electron app (reuse existing resources/runtime).
set -euo pipefail
ROOT=/home/code/pravite_fund_ai_research
ELECTRON="$ROOT/omnigent/web/electron"
cd "$ELECTRON"
test -f resources/runtime/python/python.exe
test -f src/process_supervisor.js
grep -q 'proxy_cli\|litellm.exe' src/process_supervisor.js

export CSC_IDENTITY_AUTO_DISCOVERY=false
export DESKTOP_MODE=bundled
./node_modules/.bin/electron-builder --win --x64

node -e "
const asar=require('@electron/asar');
const t=asar.extractFile('dist/win-unpacked/resources/app.asar','src/process_supervisor.js').toString('utf8');
if(!(t.includes('proxy_cli')||t.includes('Scripts'+require('path').sep+'litellm.exe')||t.includes('litellm.exe'))){
  console.error('asar missing litellm fix');
  process.exit(1);
}
console.log('OK asar litellm fix present');
"
ls -lah dist/PrivateFundWorkbench-Setup-0.2.1-x64.exe dist/win-unpacked/resources/app.asar
echo DONE
