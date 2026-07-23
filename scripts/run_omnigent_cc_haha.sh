#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OMNIGENT_DIR="$ROOT_DIR/omnigent"
CC_HAHA_BIN="$ROOT_DIR/scripts/qwen-bin/claude-haha"
PRIVATE_FUND_SYSTEM_PROMPT_FILE="${PRIVATE_FUND_SYSTEM_PROMPT_FILE:-$OMNIGENT_DIR/CLAUDE.md}"
LITELLM_HOST="${LITELLM_HOST:-127.0.0.1}"
LITELLM_PORT="${LITELLM_PORT:-4000}"
LITELLM_LOG="$OMNIGENT_DIR/.tmp-litellm.log"
LITELLM_TMUX_SESSION="${LITELLM_TMUX_SESSION:-omnigent-litellm}"
OMNIGENT_SERVER_URL="${OMNIGENT_SERVER_URL:-http://127.0.0.1:6767}"

if [[ ! -x "$CC_HAHA_BIN" ]]; then
  echo "cc-haha executable not found: $CC_HAHA_BIN" >&2
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

local_model="${PRIVATE_FUND_LITELLM_MODEL:-private-fund-default}"
local_key="${PRIVATE_FUND_LITELLM_KEY:-sk-local-cc-haha}"
export ANTHROPIC_AUTH_TOKEN="$local_key"
unset ANTHROPIC_API_KEY
export ANTHROPIC_BASE_URL="$proxy_url"
export ANTHROPIC_MODEL="$local_model"
export ANTHROPIC_DEFAULT_SONNET_MODEL="$local_model"
export ANTHROPIC_DEFAULT_HAIKU_MODEL="$local_model"
export ANTHROPIC_DEFAULT_OPUS_MODEL="$local_model"
export OPENAI_BASE_URL="$proxy_url/v1"
export OPENAI_API_KEY="$local_key"
export LLM_BASE_URL="$OPENAI_BASE_URL"
export LLM_API_KEY="$local_key"
export LLM_MODEL_NAME="$local_model"
export PDF_RESEARCH_LLM_BASE_URL="$OPENAI_BASE_URL"
export PDF_RESEARCH_LLM_API_KEY="$local_key"
export PDF_RESEARCH_LLM_MODEL="$local_model"
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
