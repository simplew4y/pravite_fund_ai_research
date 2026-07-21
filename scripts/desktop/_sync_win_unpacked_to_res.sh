#!/usr/bin/env bash
# Sync latest electron dist/win-unpacked -> /mnt/i/code/res/win-unpacked
set -euo pipefail
ROOT=/home/code/pravite_fund_ai_research
SRC="$ROOT/omnigent/web/electron/dist/win-unpacked"
DEST_ROOT=/mnt/i/code/res
DEST="$DEST_ROOT/win-unpacked"

test -f "$SRC/PrivateFundWorkbench.exe"
test -f "$SRC/icudtl.dat"

mkdir -p "$DEST_ROOT"

# Remove previous packages (including partial/trash)
for name in win-unpacked PrivateFundWorkbench; do
  if [[ -e "$DEST_ROOT/$name" ]]; then
    echo "removing $DEST_ROOT/$name"
    rm -rf "$DEST_ROOT/$name" || true
  fi
done
# trash dirs from prior failed Windows deletes
shopt -s nullglob
for t in "$DEST_ROOT"/_trash_*; do
  echo "removing $t"
  rm -rf "$t" || true
done
shopt -u nullglob

echo "copying $SRC -> $DEST"
# Prefer rsync if available (can skip unreadable ios assets); else cp -a
if command -v rsync >/dev/null 2>&1; then
  # Exclude known-broken long/ios asset paths that break UNC/host tools
  rsync -a --delete \
    --exclude '**/web/ios/**' \
    --exclude '**/bazel-cel-python-build-*/**' \
    "$SRC/" "$DEST/"
else
  mkdir -p "$DEST"
  cp -a "$SRC/." "$DEST/"
fi

# Required checks
for f in \
  PrivateFundWorkbench.exe \
  icudtl.dat \
  resources.pak \
  locales/en-US.pak \
  resources/app.asar \
  resources/runtime/python/python.exe
do
  test -e "$DEST/$f" || { echo "MISSING $DEST/$f" >&2; exit 1; }
  echo "OK $f"
done

echo "SRC mtime:  $(stat -c %y "$SRC/PrivateFundWorkbench.exe")"
echo "DEST mtime: $(stat -c %y "$DEST/PrivateFundWorkbench.exe")"
echo "SYNC_RES_OK"
echo "Launch: I:\\code\\res\\win-unpacked\\PrivateFundWorkbench.exe"
