#!/usr/bin/env bash
set -euo pipefail
ROOT=/home/code/pravite_fund_ai_research
WEB_UI_SRC="$ROOT/omnigent/omnigent/server/static/web-ui"
test -f "$WEB_UI_SRC/index.html"

sync_ui() {
  local dest="$1"
  local parent
  parent="$(dirname "$dest")"
  if [[ ! -d "$parent" ]]; then
    echo "skip (no parent): $dest"
    return 0
  fi
  rm -rf "$dest"
  cp -a "$WEB_UI_SRC" "$dest"
  echo "synced $dest"
}

sync_ui "$ROOT/omnigent/web/electron/resources/runtime/project/omnigent/omnigent/server/static/web-ui"
sync_ui "$ROOT/omnigent/web/electron/resources/runtime/python/Lib/site-packages/omnigent/server/static/web-ui"
sync_ui "$ROOT/omnigent/web/electron/dist/win-unpacked/resources/runtime/project/omnigent/omnigent/server/static/web-ui"
sync_ui "$ROOT/omnigent/web/electron/dist/win-unpacked/resources/runtime/python/Lib/site-packages/omnigent/server/static/web-ui"

bash "$ROOT/scripts/desktop/apply_runtime_fixes.sh" "$ROOT/omnigent/web/electron/resources/runtime" || true
bash "$ROOT/scripts/desktop/repack_electron_only.sh"
echo REBUILD_OK
