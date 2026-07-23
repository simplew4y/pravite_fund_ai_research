#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OMNIGENT_DIR="$ROOT_DIR/omnigent"
OMNIGENT_CLI="$OMNIGENT_DIR/.venv/bin/omnigent"
STACK_SESSION="${OMNIGENT_STACK_TMUX_SESSION:-omnigent-stack}"
LEGACY_SERVER_SESSION="${OMNIGENT_SERVER_TMUX_SESSION:-omnigent-server}"
LEGACY_LITELLM_SESSION="${LITELLM_TMUX_SESSION:-omnigent-litellm}"
SERVER_HOST="${OMNIGENT_SERVER_HOST:-127.0.0.1}"
SERVER_PORT="${OMNIGENT_SERVER_PORT:-6767}"
SERVER_URL="${OMNIGENT_SERVER_URL:-http://$SERVER_HOST:$SERVER_PORT}"
LITELLM_HOST="${LITELLM_HOST:-127.0.0.1}"
LITELLM_PORT="${LITELLM_PORT:-4000}"
LITELLM_URL="http://$LITELLM_HOST:$LITELLM_PORT"
WAIT_SECONDS="${OMNIGENT_STACK_WAIT_SECONDS:-180}"
SCRIPT_PATH="$ROOT_DIR/scripts/manage_omnigent_services.sh"

usage() {
  cat <<EOF
Usage: $0 {start|stop|restart|status|logs|attach}

Commands:
  start    Start LiteLLM, Omnigent Server, both tracking workers, and Omnigent Host in tmux.
  stop     Stop the managed tmux stack and legacy service sessions.
  restart  Stop and start the complete stack.
  status   Show tmux, HTTP, and Host connection status.
  logs     Print recent output from each service window.
  attach   Attach to the managed tmux session.
EOF
}

require_runtime() {
  local command_name
  for command_name in tmux curl; do
    if ! command -v "$command_name" >/dev/null 2>&1; then
      echo "Missing required command: $command_name" >&2
      exit 1
    fi
  done
  if [[ ! -x "$OMNIGENT_CLI" ]]; then
    echo "Omnigent CLI not found: $OMNIGENT_CLI" >&2
    echo "Run scripts/setup_full_system.sh first." >&2
    exit 1
  fi
}

configure_agent_runtime() {
  export OMNIGENT_AUTH_ENABLED="${OMNIGENT_AUTH_ENABLED:-0}"
  export OMNIGENT_NO_UPDATE_CHECK="${OMNIGENT_NO_UPDATE_CHECK:-1}"
  # Claude Native is the primary private-fund agent. Route it through the
  # managed LiteLLM proxy by default so Claude Code can use the configured
  # third-party Anthropic-compatible model instead of requiring an Anthropic
  # login. Dedicated OMNIGENT_* overrides remain available for operators, but
  # inherited ANTHROPIC_* values cannot accidentally bypass this stack.
  export ANTHROPIC_AUTH_TOKEN="${OMNIGENT_CLAUDE_API_TOKEN:-sk-local-cc-haha}"
  unset ANTHROPIC_API_KEY || true
  export ANTHROPIC_BASE_URL="${OMNIGENT_CLAUDE_API_BASE_URL:-$LITELLM_URL}"
  export ANTHROPIC_MODEL="${OMNIGENT_CLAUDE_MODEL:-qwen3-max}"
  export ANTHROPIC_DEFAULT_SONNET_MODEL="${ANTHROPIC_DEFAULT_SONNET_MODEL:-$ANTHROPIC_MODEL}"
  export ANTHROPIC_DEFAULT_HAIKU_MODEL="${ANTHROPIC_DEFAULT_HAIKU_MODEL:-$ANTHROPIC_MODEL}"
  export ANTHROPIC_DEFAULT_OPUS_MODEL="${ANTHROPIC_DEFAULT_OPUS_MODEL:-$ANTHROPIC_MODEL}"
  export API_TIMEOUT_MS="${API_TIMEOUT_MS:-3000000}"
  export DISABLE_TELEMETRY="${DISABLE_TELEMETRY:-1}"
  export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC="${CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:-1}"
}

litellm_healthy() {
  curl -fsS --max-time 3 "$LITELLM_URL/health/liveliness" >/dev/null 2>&1 \
    || curl -fsS --max-time 3 "$LITELLM_URL/health" >/dev/null 2>&1
}

server_healthy() {
  curl -fsS --max-time 3 "$SERVER_URL/health" >/dev/null 2>&1
}

host_online() {
  "$OMNIGENT_CLI" host status --server "$SERVER_URL" 2>/dev/null \
    | tr -d '\r' \
    | grep -q 'process=online.*host=online'
}

tracking_worker_online() {
  tmux has-session -t "$STACK_SESSION" 2>/dev/null \
    && tmux list-windows -t "$STACK_SESSION" -F '#{window_name}' 2>/dev/null \
      | grep -qx 'tracking'
}

valuation_worker_online() {
  tmux has-session -t "$STACK_SESSION" 2>/dev/null \
    && tmux list-windows -t "$STACK_SESSION" -F '#{window_name}' 2>/dev/null \
      | grep -qx 'valuation'
}

wait_until() {
  local label="$1"
  local check_function="$2"
  local elapsed=0
  while (( elapsed < WAIT_SECONDS )); do
    if "$check_function"; then
      echo "$label is ready."
      return 0
    fi
    sleep 1
    elapsed=$((elapsed + 1))
  done
  echo "$label did not become ready within ${WAIT_SECONDS}s." >&2
  return 1
}

run_litellm() {
  exec "$ROOT_DIR/scripts/start_litellm_dashscope.sh"
}

run_server() {
  configure_agent_runtime
  until litellm_healthy; do sleep 1; done
  cd "$OMNIGENT_DIR"
  exec uv run --offline omnigent server --host "$SERVER_HOST" --port "$SERVER_PORT" --no-open
}

run_host() {
  configure_agent_runtime
  until server_healthy; do sleep 1; done
  cd "$OMNIGENT_DIR"
  exec "$OMNIGENT_CLI" host --server "$SERVER_URL" --non-interactive
}

run_tracking_worker() {
  configure_agent_runtime
  until litellm_healthy; do sleep 1; done
  cd "$OMNIGENT_DIR"
  exec uv run --offline python -m omnigent.server.private_fund_tracking_worker
}

run_valuation_worker() {
  configure_agent_runtime
  until litellm_healthy; do sleep 1; done
  export PDF_RESEARCH_LLM_BASE_URL="${PRIVATE_FUND_VALUATION_LLM_BASE_URL:-$LITELLM_URL/v1}"
  cd "$OMNIGENT_DIR"
  exec uv run --offline python -m omnigent.server.private_fund_valuation_worker
}

run_control() {
  while :; do sleep 3600; done
}

start_stack() {
  require_runtime
  if tmux has-session -t "$STACK_SESSION" 2>/dev/null; then
    if litellm_healthy && server_healthy && host_online \
      && tracking_worker_online && valuation_worker_online; then
      echo "Omnigent stack is already online in tmux session '$STACK_SESSION'."
      status_stack
      return 0
    fi
    echo "Existing stack is incomplete; restarting it."
    stop_stack
  fi

  tmux new-session -d -s "$STACK_SESSION" -n control "$SCRIPT_PATH" _run-control
  tmux new-window -d -t "$STACK_SESSION" -n litellm "$SCRIPT_PATH" _run-litellm
  tmux new-window -d -t "$STACK_SESSION" -n server "$SCRIPT_PATH" _run-server
  tmux new-window -d -t "$STACK_SESSION" -n tracking "$SCRIPT_PATH" _run-tracking
  tmux new-window -d -t "$STACK_SESSION" -n valuation "$SCRIPT_PATH" _run-valuation
  tmux new-window -d -t "$STACK_SESSION" -n host "$SCRIPT_PATH" _run-host
  tmux select-window -t "$STACK_SESSION:server"

  if ! wait_until "LiteLLM" litellm_healthy; then
    logs_stack
    return 1
  fi
  if ! wait_until "Omnigent Server" server_healthy; then
    logs_stack
    return 1
  fi
  if ! wait_until "Research Tracking Worker" tracking_worker_online; then
    logs_stack
    return 1
  fi
  if ! wait_until "Valuation Tracking Worker" valuation_worker_online; then
    logs_stack
    return 1
  fi
  if ! wait_until "Omnigent Host" host_online; then
    logs_stack
    return 1
  fi
  status_stack
}

stop_stack() {
  local session_name
  for session_name in "$STACK_SESSION" "$LEGACY_SERVER_SESSION" "$LEGACY_LITELLM_SESSION"; do
    if tmux has-session -t "$session_name" 2>/dev/null; then
      echo "Stopping tmux session '$session_name'..."
      tmux kill-session -t "$session_name"
    fi
  done
}

status_stack() {
  local failed=0
  if tmux has-session -t "$STACK_SESSION" 2>/dev/null; then
    echo "tmux:    online ($STACK_SESSION)"
    tmux list-windows -t "$STACK_SESSION" -F '  window: #{window_name} (#{pane_current_command})'
  else
    echo "tmux:    offline ($STACK_SESSION)"
    failed=1
  fi
  if litellm_healthy; then
    echo "LiteLLM: online ($LITELLM_URL)"
  else
    echo "LiteLLM: offline ($LITELLM_URL)"
    failed=1
  fi
  if server_healthy; then
    echo "Server:  online ($SERVER_URL)"
  else
    echo "Server:  offline ($SERVER_URL)"
    failed=1
  fi
  if host_online; then
    echo "Host:    online"
  else
    echo "Host:    offline"
    failed=1
  fi
  if tracking_worker_online; then
    echo "Tracking: online"
  else
    echo "Tracking: offline"
    failed=1
  fi
  if valuation_worker_online; then
    echo "Valuation: online"
  else
    echo "Valuation: offline"
    failed=1
  fi
  return "$failed"
}

logs_stack() {
  if ! tmux has-session -t "$STACK_SESSION" 2>/dev/null; then
    echo "tmux session '$STACK_SESSION' is not running." >&2
    return 1
  fi
  local window_name
  for window_name in litellm server tracking valuation host; do
    echo "===== $window_name ====="
    if [[ "$window_name" == "litellm" && -f "$OMNIGENT_DIR/.tmp-litellm.log" ]]; then
      tail -80 "$OMNIGENT_DIR/.tmp-litellm.log" || true
    else
      tmux capture-pane -p -t "$STACK_SESSION:$window_name" -S -80 || true
    fi
  done
}

attach_stack() {
  require_runtime
  if ! tmux has-session -t "$STACK_SESSION" 2>/dev/null; then
    echo "tmux session '$STACK_SESSION' is not running; start it first." >&2
    exit 1
  fi
  exec tmux attach-session -t "$STACK_SESSION"
}

command_name="${1:-}"
case "$command_name" in
  start) start_stack ;;
  stop) require_runtime; stop_stack ;;
  restart) require_runtime; stop_stack; start_stack ;;
  status) require_runtime; status_stack ;;
  logs) require_runtime; logs_stack ;;
  attach) attach_stack ;;
  _run-control) run_control ;;
  _run-litellm) run_litellm ;;
  _run-server) run_server ;;
  _run-tracking) run_tracking_worker ;;
  _run-valuation) run_valuation_worker ;;
  _run-host) run_host ;;
  *) usage; exit 2 ;;
esac
