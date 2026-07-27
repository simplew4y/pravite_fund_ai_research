#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OMNIGENT_DIR="$ROOT_DIR/omnigent"
FINSAGENT_CONFIG="${FINSAGENT_CONFIG:-$ROOT_DIR/FinSagent/config/production.yaml}"
LITELLM_HOST="${LITELLM_HOST:-127.0.0.1}"
LITELLM_PORT="${LITELLM_PORT:-4000}"
LITELLM_CONFIG="${LITELLM_CONFIG:-$OMNIGENT_DIR/.tmp-litellm-runtime/config.yaml}"
LITELLM_LOG="$OMNIGENT_DIR/.tmp-litellm.log"

PYTHON_BIN="$OMNIGENT_DIR/.venv/bin/python"
if [[ ! -x "$PYTHON_BIN" ]]; then
  echo "Omnigent Python environment not found: $PYTHON_BIN" >&2
  echo "Run scripts/setup_full_system.sh first." >&2
  exit 1
fi

export PRIVATE_FUND_PROJECT_ROOT="$ROOT_DIR"
export FINSAGENT_CONFIG
export LITELLM_CONFIG
export LITELLM_URL="http://$LITELLM_HOST:$LITELLM_PORT"

PYTHONPATH="$ROOT_DIR:$ROOT_DIR/src:$OMNIGENT_DIR${PYTHONPATH:+:$PYTHONPATH}" \
  "$PYTHON_BIN" -c \
  "from omnigent.server.private_fund_llm_config import write_generated_litellm_config; write_generated_litellm_config()"

cd "$(dirname "$LITELLM_CONFIG")"
exec uvx --from 'litellm[proxy]==1.91.4' litellm \
  --config "$LITELLM_CONFIG" \
  --reload \
  --host "$LITELLM_HOST" \
  --port "$LITELLM_PORT" \
  >>"$LITELLM_LOG" 2>&1
