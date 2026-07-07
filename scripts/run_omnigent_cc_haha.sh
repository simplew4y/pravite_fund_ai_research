#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OMNIGENT_DIR="$ROOT_DIR/omnigent"
CC_HAHA_BIN="$ROOT_DIR/cc-haha/bin/claude-haha"
PRIVATE_FUND_SYSTEM_PROMPT_FILE="${PRIVATE_FUND_SYSTEM_PROMPT_FILE:-$OMNIGENT_DIR/CLAUDE.md}"
FINSAGENT_CONFIG="${FINSAGENT_CONFIG:-$ROOT_DIR/FinSagent/config/production.yaml}"
LITELLM_HOST="${LITELLM_HOST:-127.0.0.1}"
LITELLM_PORT="${LITELLM_PORT:-4000}"
LITELLM_CONFIG="$OMNIGENT_DIR/.tmp-litellm-dashscope.yaml"
LITELLM_LOG="$OMNIGENT_DIR/.tmp-litellm.log"
LITELLM_TMUX_SESSION="${LITELLM_TMUX_SESSION:-omnigent-litellm}"
OMNIGENT_SERVER_URL="${OMNIGENT_SERVER_URL:-http://127.0.0.1:6767}"

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

if [[ ! -x "$CC_HAHA_BIN" ]]; then
  echo "cc-haha executable not found: $CC_HAHA_BIN" >&2
  exit 1
fi

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

proxy_url="http://$LITELLM_HOST:$LITELLM_PORT"
if ! curl -fsS "$proxy_url/health/liveliness" >/dev/null 2>&1 \
  && ! curl -fsS "$proxy_url/health" >/dev/null 2>&1; then
  echo "Starting LiteLLM proxy on $proxy_url ..."
  if tmux has-session -t "$LITELLM_TMUX_SESSION" 2>/dev/null; then
    tmux kill-session -t "$LITELLM_TMUX_SESSION"
  fi
  : > "$LITELLM_LOG"
  tmux new-session -d -s "$LITELLM_TMUX_SESSION" "$ROOT_DIR/scripts/start_litellm_dashscope.sh"

  for _ in {1..90}; do
    if curl -fsS "$proxy_url/health/liveliness" >/dev/null 2>&1 \
      || curl -fsS "$proxy_url/health" >/dev/null 2>&1; then
      break
    fi
    sleep 1
  done
fi

if ! curl -fsS "$proxy_url/health/liveliness" >/dev/null 2>&1 \
  && ! curl -fsS "$proxy_url/health" >/dev/null 2>&1; then
  echo "LiteLLM proxy did not become healthy. Log: $LITELLM_LOG" >&2
  tail -80 "$LITELLM_LOG" >&2 || true
  exit 1
fi

export ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-${ANTHROPIC_AUTH_TOKEN:-sk-local-cc-haha}}"
unset ANTHROPIC_AUTH_TOKEN
export ANTHROPIC_BASE_URL="${ANTHROPIC_BASE_URL:-$proxy_url}"
export ANTHROPIC_MODEL="${ANTHROPIC_MODEL:-$LITELLM_TARGET_MODEL_NAME}"
export ANTHROPIC_DEFAULT_SONNET_MODEL="${ANTHROPIC_DEFAULT_SONNET_MODEL:-$ANTHROPIC_MODEL}"
export ANTHROPIC_DEFAULT_HAIKU_MODEL="${ANTHROPIC_DEFAULT_HAIKU_MODEL:-$ANTHROPIC_MODEL}"
export ANTHROPIC_DEFAULT_OPUS_MODEL="${ANTHROPIC_DEFAULT_OPUS_MODEL:-$ANTHROPIC_MODEL}"
export API_TIMEOUT_MS="${API_TIMEOUT_MS:-3000000}"
export DISABLE_TELEMETRY="${DISABLE_TELEMETRY:-1}"
export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC="${CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:-1}"
export CLAUDE_CODE_EFFORT_LEVEL="${CLAUDE_CODE_EFFORT_LEVEL:-low}"
export OMNIGENT_CLAUDE_NATIVE_AUTO_APPROVE="${OMNIGENT_CLAUDE_NATIVE_AUTO_APPROVE:-1}"

claude_extra_args=()
if [[ -n "$PRIVATE_FUND_SYSTEM_PROMPT_FILE" ]]; then
  has_system_prompt_arg=0
  for arg in "$@"; do
    case "$arg" in
      --system-prompt|--system-prompt=*|--system-prompt-file|--system-prompt-file=*|--append-system-prompt|--append-system-prompt=*|--append-system-prompt-file|--append-system-prompt-file=*)
        has_system_prompt_arg=1
        ;;
    esac
  done
  if [[ "$has_system_prompt_arg" -eq 0 ]]; then
    claude_extra_args+=(--append-system-prompt-file "$PRIVATE_FUND_SYSTEM_PROMPT_FILE")
  fi
fi

cd "$OMNIGENT_DIR"
exec uv run omnigent claude \
  --server "$OMNIGENT_SERVER_URL" \
  --command "$CC_HAHA_BIN" \
  --use-native-config \
  "${claude_extra_args[@]}" \
  "$@"
