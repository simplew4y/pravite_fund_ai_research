#!/usr/bin/env bash
set -euo pipefail

# ========= user config =========
BASE_DIR="/Users/fchi/Code/FinSagent/required_magic_pdf_finder"    # <-- change to your target dir
PY_FILE="process_table.py"    # <-- change to where you saved the .py above
OUT_JSON=""    # optional: set path, or leave empty to use default
CLAUDE_MODEL="claude-sonnet-4-6"
TENCENT_MODEL="deepseek-v4-pro"
WORKERS="5"
RPM="50"
CONTEXT_WINDOW="3"
SAVE_INTERVAL="1"
TENCENT_BASE_URL="https://api.lkeap.cloud.tencent.com/v1"

# ========== secrets ==========
# : "${TENCENT_API_KEY:?Please export TENCENT_API_KEY first}"
# optional, otherwise Anthropic SDK reads ANTHROPIC_API_KEY from env
# : "${ANTHROPIC_API_KEY:?Please export ANTHROPIC_API_KEY first}"
OUT_ROOT="/Users/fchi/Code/FinSagent/required_magic_pdf_finder_table"
# only mkdir when OUT_ROOT is set
if [[ -n "$OUT_ROOT" ]]; then
  mkdir -p "$OUT_ROOT"
fi

# ========== run over all dirs ==========
shopt -s nullglob

# collect dirs first so we know the total
dirs=()
for d in "$BASE_DIR"/*; do
  [[ -d "$d" ]] && dirs+=("$d")
done

total=${#dirs[@]}
if [[ $total -eq 0 ]]; then
  echo "No directories found in $BASE_DIR"
  exit 0
fi

echo "Found $total director$([ $total -eq 1 ] && echo y || echo ies) to process."
echo

current=0

for input_dir in "${dirs[@]}"; do
  current=$((current + 1))
  dir_name="$(basename "$input_dir")"

  echo "=============================="
  echo "[$current/$total] $dir_name"
  echo "Input dir : $input_dir"
  echo "=============================="

  # choose output path (either centralized OUT_ROOT or per-dir default)
  out_json=""
  if [[ -n "$OUT_ROOT" ]]; then
    out_json="$OUT_ROOT/${dir_name}_table_reconstructed.json"
  fi

  cmd=(python3 "$PY_FILE" "$input_dir"
    --tencent-base-url "$TENCENT_BASE_URL"
    --claude-model "$CLAUDE_MODEL"
    --tencent-model "$TENCENT_MODEL"
    -w "$WORKERS"
    --rpm "$RPM"
    --context-window "$CONTEXT_WINDOW"
    --save-interval "$SAVE_INTERVAL"
  )

  if [[ -n "$out_json" ]]; then
    cmd+=(-o "$out_json")
  fi

  echo "Running:"
  printf '  %q' "${cmd[@]}"
  echo

  "${cmd[@]}"
  echo "Done [$current/$total]: $dir_name"
  echo
done

echo "=============================="
echo "All $total directories processed successfully."
echo "=============================="
