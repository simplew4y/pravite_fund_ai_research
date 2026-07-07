#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OMNIGENT_DIR="$ROOT_DIR/omnigent"
FINSAGENT_CONFIG="${FINSAGENT_CONFIG:-$ROOT_DIR/FinSagent/config/production.yaml}"
LITELLM_HOST="${LITELLM_HOST:-127.0.0.1}"
LITELLM_PORT="${LITELLM_PORT:-4000}"
LITELLM_CONFIG="$OMNIGENT_DIR/.tmp-litellm-dashscope.yaml"
LITELLM_LOG="$OMNIGENT_DIR/.tmp-litellm.log"

read_yaml_value() {
  local key="$1"
  python3 - "$FINSAGENT_CONFIG" "$key" <<'PY'
import re
import sys
from pathlib import Path

path = Path(sys.argv[1])
key = sys.argv[2]
pattern = re.compile(rf"^\s*{re.escape(key)}\s*:\s*(.*?)\s*$")
for line in path.read_text(encoding="utf-8").splitlines():
    match = pattern.match(line)
    if match:
        value = match.group(1).strip()
        if (
            len(value) >= 2
            and value[0] == value[-1]
            and value[0] in {"'", '"'}
        ):
            value = value[1:-1]
        print(value)
        raise SystemExit(0)
raise SystemExit(1)
PY
}

export LITELLM_TARGET_MODEL_NAME="${LITELLM_TARGET_MODEL_NAME:-$(read_yaml_value llm_model_name)}"
export LITELLM_TARGET_API_BASE="${LITELLM_TARGET_API_BASE:-${OPENAI_BASE_URL:-${DEEPSEEK_BASE_URL:-${DASHSCOPE_BASE_URL:-$(read_yaml_value llm_base_url)}}}}"
export LITELLM_TARGET_API_KEY="${LITELLM_TARGET_API_KEY:-${OPENAI_API_KEY:-${DEEPSEEK_API_KEY:-${DASHSCOPE_API_KEY:-$(read_yaml_value llm_api_key)}}}}"

if [[ -z "${LITELLM_TARGET_PROVIDER:-}" ]]; then
  case "$LITELLM_TARGET_API_BASE" in
    *deepseek*) LITELLM_TARGET_PROVIDER="deepseek" ;;
    *dashscope*) LITELLM_TARGET_PROVIDER="dashscope" ;;
    *) LITELLM_TARGET_PROVIDER="openai" ;;
  esac
fi
export LITELLM_TARGET_PROVIDER

if [[ -z "$LITELLM_TARGET_MODEL_NAME" || -z "$LITELLM_TARGET_API_BASE" || -z "$LITELLM_TARGET_API_KEY" ]]; then
  echo "Missing llm_model_name, llm_base_url, or llm_api_key in $FINSAGENT_CONFIG" >&2
  exit 1
fi

python3 - "$LITELLM_CONFIG" <<'PY'
import os
import sys
from pathlib import Path

path = Path(sys.argv[1])
target_model_name = os.environ["LITELLM_TARGET_MODEL_NAME"]
target_provider = os.environ["LITELLM_TARGET_PROVIDER"].strip().strip("/")
target_model = target_model_name if "/" in target_model_name else f"{target_provider}/{target_model_name}"

model_names = [
    target_model_name,
    "claude-sonnet-4-6",
    "claude-sonnet-4-5",
    "claude-opus-4-6",
    "claude-opus-4-7",
    "claude-opus-4-8",
    "claude-haiku-4-6",
    "claude-haiku-4-5",
]

lines = ["model_list:"]
for name in model_names:
    lines.extend(
        [
            f"  - model_name: {name}",
            "    litellm_params:",
            f"      model: {target_model}",
            "      api_base: os.environ/LITELLM_TARGET_API_BASE",
            "      api_key: os.environ/LITELLM_TARGET_API_KEY",
        ]
    )

lines.extend(
    [
        "",
        "litellm_settings:",
        "  drop_params: true",
        "  request_timeout: 600",
        "",
    ]
)
path.write_text("\n".join(lines), encoding="utf-8")
PY

cd "$OMNIGENT_DIR"
exec uvx --from 'litellm[proxy]' litellm \
  --config "$LITELLM_CONFIG" \
  --host "$LITELLM_HOST" \
  --port "$LITELLM_PORT" \
  >>"$LITELLM_LOG" 2>&1
