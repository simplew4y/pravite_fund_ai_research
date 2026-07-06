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

export DASHSCOPE_BASE_URL="${DASHSCOPE_BASE_URL:-$(read_yaml_value llm_base_url)}"
export DASHSCOPE_API_KEY="${DASHSCOPE_API_KEY:-$(read_yaml_value llm_api_key)}"

if [[ -z "$DASHSCOPE_BASE_URL" || -z "$DASHSCOPE_API_KEY" ]]; then
  echo "Missing llm_base_url or llm_api_key in $FINSAGENT_CONFIG" >&2
  exit 1
fi

python3 - "$LITELLM_CONFIG" <<'PY'
import sys
from pathlib import Path

path = Path(sys.argv[1])
model_names = [
    "qwen3-max",
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
            "      model: dashscope/qwen3-max",
            "      api_base: os.environ/DASHSCOPE_BASE_URL",
            "      api_key: os.environ/DASHSCOPE_API_KEY",
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
