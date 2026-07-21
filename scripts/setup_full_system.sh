#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OMNIGENT_DIR="$ROOT_DIR/omnigent"
CC_HAHA_DIR="$ROOT_DIR/cc-haha"
OMNIGENT_PATCH="$ROOT_DIR/patches/omnigent_private_fund_integration_20260706.patch"

export PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH"

need_cmd() {
  local name="$1"
  if ! command -v "$name" >/dev/null 2>&1; then
    echo "Missing required command: $name" >&2
    return 1
  fi
}

optional_cmd() {
  local name="$1"
  local note="$2"
  if ! command -v "$name" >/dev/null 2>&1; then
    echo "Warning: $name not found. $note" >&2
  fi
}

echo "==> Checking required commands"
need_cmd git
need_cmd python3
need_cmd curl
need_cmd tmux
need_cmd uv
need_cmd bun
optional_cmd pdftotext "PDF text extraction and source highlighting need Poppler."
optional_cmd pdftoppm "PDF page rendering in Omnigent source panel needs Poppler."

echo "==> Initializing submodules"
cd "$ROOT_DIR"
if [[ -f "$OMNIGENT_DIR/.git" || -f "$CC_HAHA_DIR/.git" ]]; then
  git submodule update --init --recursive omnigent cc-haha
else
  echo "Omnigent and cc-haha are checked in as regular directories; skipping submodule init."
fi

echo "==> Applying Omnigent private-fund patch"
if [[ -f "$OMNIGENT_DIR/omnigent/server/routes/private_fund_pdf.py" \
  && -f "$OMNIGENT_DIR/omnigent/tools/builtins/private_fund_dataset.py" \
  && -f "$OMNIGENT_DIR/CLAUDE.md" ]]; then
  echo "Private-fund Omnigent integration is already present; skipping legacy patch."
elif git -C "$OMNIGENT_DIR" apply --reverse --check "$OMNIGENT_PATCH" >/dev/null 2>&1; then
  echo "Omnigent patch is already applied."
elif git -C "$OMNIGENT_DIR" apply --check "$OMNIGENT_PATCH" >/dev/null 2>&1; then
  git -C "$OMNIGENT_DIR" apply "$OMNIGENT_PATCH"
  echo "Applied Omnigent patch."
else
  echo "Could not apply Omnigent patch cleanly." >&2
  echo "Check: $OMNIGENT_PATCH" >&2
  exit 1
fi

echo "==> Installing cc-haha dependencies"
if [[ ! -d "$CC_HAHA_DIR/node_modules" ]]; then
  (cd "$CC_HAHA_DIR" && bun install)
else
  echo "cc-haha/node_modules already exists; skipping bun install."
fi

echo "==> Preparing Omnigent Python environment"
(cd "$OMNIGENT_DIR" && uv sync)

cat <<'MSG'

Setup complete.

Before starting the full Omnigent + Claude Code Haha stack, provide model credentials
with either environment variables:

  export DASHSCOPE_BASE_URL="https://dashscope.aliyuncs.com/compatible-mode/v1"
  export DASHSCOPE_API_KEY="<your-key>"

or a local FinSagent/config/production.yaml containing llm_base_url and llm_api_key.

Start the full stack:

  scripts/run_omnigent_cc_haha.sh

MSG
