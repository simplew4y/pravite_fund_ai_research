#!/usr/bin/env bash
set -euo pipefail
ROOT=/home/code/pravite_fund_ai_research
RUNTIME="$ROOT/omnigent/web/electron/resources/runtime"
ELECTRON="$ROOT/omnigent/web/electron"

echo "==> Remove broken symlinks under runtime"
# examples/polly and debby often are broken symlinks after vendor copy
find "$RUNTIME" -type l 2>/dev/null | while read -r L; do
  if [[ ! -e "$L" ]]; then
    echo "  rm broken: $L"
    rm -f "$L"
  fi
done
# Keep examples package importable; only remove broken symlinks above.
# Real polly/debby copies are applied by apply_runtime_fixes.sh.
bash "$ROOT/scripts/desktop/apply_runtime_fixes.sh" "$RUNTIME"

# Fix package.json artifactName via python (avoid shell eating $)
python3 "$ROOT/scripts/desktop/_fix_package_json.py"
python3 - <<'PY'
import json
from pathlib import Path
p = Path("/home/code/pravite_fund_ai_research/omnigent/web/electron/package.json")
data = json.loads(p.read_text(encoding="utf-8"))
data["productName"] = "PrivateFundWorkbench"
b = data.setdefault("build", {})
b["productName"] = "PrivateFundWorkbench"
b["appId"] = "ai.privatefund.workbench"
b.setdefault("win", {})["executableName"] = "PrivateFundWorkbench"
b.setdefault("win", {})["signAndEditExecutable"] = False  # skip wine signtool on hundreds of py exes
b["nsis"] = {
    "oneClick": False,
    "allowToChangeInstallationDirectory": True,
    "artifactName": "PrivateFundWorkbench-Setup-${version}-${arch}.${ext}",
    "shortcutName": "PrivateFundWorkbench",
}
# Don't try to sign (CSC false already)
b["forceCodeSigning"] = False
p.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
print("nsis", b["nsis"]["artifactName"])
print("signAndEditExecutable", b["win"].get("signAndEditExecutable"))
PY

export CSC_IDENTITY_AUTO_DISCOVERY=false
export DESKTOP_MODE=bundled
cd "$ELECTRON"
./node_modules/.bin/electron-builder --win --x64

echo "==> Results"
ls -lah dist/*.exe 2>/dev/null || true
du -sh dist/win-unpacked 2>/dev/null || true
test -f dist/win-unpacked/resources/app.asar && echo OK_app_asar
test -f dist/win-unpacked/resources/runtime/python/python.exe && echo OK_python
test -f dist/win-unpacked/resources/runtime/NATIVE_STACK && echo OK_native
test -d dist/win-unpacked/resources/runtime/python/Lib/site-packages/omnigent && echo OK_omnigent
test -f dist/win-unpacked/resources/runtime/config/desktop.env && echo OK_env
echo DONE
