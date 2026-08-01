#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PATH="${HOME}/.bun/bin:${HOME}/.local/bin:${PATH}"
LOCAL_ENV_FILE="${OMNIGENT_LOCAL_ENV_FILE:-$ROOT_DIR/.env}"
if [[ -f "$LOCAL_ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$LOCAL_ENV_FILE"
  set +a
fi
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
LITELLM_MODEL="${PRIVATE_FUND_LITELLM_MODEL:-private-fund-default}"
LITELLM_KEY="${PRIVATE_FUND_LITELLM_KEY:-sk-local-cc-haha}"
WAIT_SECONDS="${OMNIGENT_STACK_WAIT_SECONDS:-180}"
SCRIPT_PATH="$ROOT_DIR/scripts/manage_omnigent_services.sh"
AUTH_RUNTIME_DIR="$ROOT_DIR/tmp/multi-user-auth"
AUTH_SECRETS_FILE="$AUTH_RUNTIME_DIR/secrets.env"

usage() {
  cat <<EOF
Usage: $0 {start|stop|restart|status|logs|attach}

Commands:
  start    Start LiteLLM, Omnigent Server, all research workers, and Omnigent Host in tmux.
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

ensure_runtime_secrets() {
  mkdir -p "$AUTH_RUNTIME_DIR"
  chmod 700 "$AUTH_RUNTIME_DIR"
  if [[ ! -f "$AUTH_SECRETS_FILE" ]]; then
    local cookie_secret user_secret shared_host_token
    cookie_secret="$(openssl rand -hex 32)"
    user_secret="$(openssl rand -hex 32)"
    shared_host_token="$(openssl rand -hex 32)"
    umask 077
    cat >"$AUTH_SECRETS_FILE" <<EOF
OMNIGENT_ACCOUNTS_COOKIE_SECRET=$cookie_secret
OMNIGENT_USER_SECRETS_KEY=$user_secret
OMNIGENT_SHARED_HOST_TOKEN=$shared_host_token
EOF
  fi
  chmod 600 "$AUTH_SECRETS_FILE"
}

configure_agent_runtime() {
  ensure_runtime_secrets
  set -a
  # shellcheck disable=SC1090
  source "$AUTH_SECRETS_FILE"
  set +a
  export OMNIGENT_AUTH_ENABLED="${OMNIGENT_AUTH_ENABLED:-1}"
  export OMNIGENT_AUTH_PROVIDER="${OMNIGENT_AUTH_PROVIDER:-cloud_accounts}"
  export OMNIGENT_ACCOUNTS_ENABLED="${OMNIGENT_ACCOUNTS_ENABLED:-1}"
  export OMNIGENT_ACCOUNTS_REGISTRATION_MODE="${OMNIGENT_ACCOUNTS_REGISTRATION_MODE:-open}"
  export OMNIGENT_ACCOUNTS_BASE_URL="${OMNIGENT_ACCOUNTS_BASE_URL:-http://127.0.0.1:6768}"
  export OMNIGENT_CLOUD_BACKEND_URL="${OMNIGENT_CLOUD_BACKEND_URL:-https://capoo.fun/private_fund/backend}"
  export OMNIGENT_CLOUD_REQUEST_TIMEOUT_SECONDS="${OMNIGENT_CLOUD_REQUEST_TIMEOUT_SECONDS:-10}"
  export OMNIGENT_CLOUD_UPLOAD_TIMEOUT_SECONDS="${OMNIGENT_CLOUD_UPLOAD_TIMEOUT_SECONDS:-180}"
  export OMNIGENT_CLOUD_REGISTRATION_ENABLED="${OMNIGENT_CLOUD_REGISTRATION_ENABLED:-1}"
  export OMNIGENT_LOCAL_SINGLE_USER="${OMNIGENT_LOCAL_SINGLE_USER:-0}"
  export OMNIGENT_SHARED_HOST_ID="${OMNIGENT_SHARED_HOST_ID:-host_private_fund_service}"
  export OMNIGENT_SHARED_HOST_NAME="${OMNIGENT_SHARED_HOST_NAME:-private-fund-service}"
  export OMNIGENT_INTERNAL_LLM_GATEWAY_URL="${OMNIGENT_INTERNAL_LLM_GATEWAY_URL:-$SERVER_URL/internal/private-fund/llm}"
  export OMNIGENT_WS_ALLOWED_ORIGINS="${OMNIGENT_WS_ALLOWED_ORIGINS:-http://127.0.0.1:6767,http://localhost:6767,http://127.0.0.1:6768,http://localhost:6768}"
  export OMNIGENT_NO_UPDATE_CHECK="${OMNIGENT_NO_UPDATE_CHECK:-1}"
  export LITELLM_LOCAL_MODEL_COST_MAP="${LITELLM_LOCAL_MODEL_COST_MAP:-True}"
  # Citation repair is bounded to one targeted pass. Tests and ad-hoc library
  # use remain deterministic unless this managed runtime explicitly enables it.
  export PRIVATE_FUND_CITATION_GATE_RETRY="${PRIVATE_FUND_CITATION_GATE_RETRY:-1}"
  # Every model consumer uses a stable local alias. LiteLLM hot-reloads the
  # user-selected upstream provider without restarting Omnigent or workers.
  export ANTHROPIC_AUTH_TOKEN="$LITELLM_KEY"
  unset ANTHROPIC_API_KEY || true
  export ANTHROPIC_BASE_URL="$LITELLM_URL"
  export ANTHROPIC_MODEL="$LITELLM_MODEL"
  export ANTHROPIC_DEFAULT_SONNET_MODEL="$LITELLM_MODEL"
  export ANTHROPIC_DEFAULT_HAIKU_MODEL="$LITELLM_MODEL"
  export ANTHROPIC_DEFAULT_OPUS_MODEL="$LITELLM_MODEL"
  export OPENAI_BASE_URL="$LITELLM_URL/v1"
  export OPENAI_API_KEY="$LITELLM_KEY"
  export LLM_BASE_URL="$OPENAI_BASE_URL"
  export LLM_API_KEY="$LITELLM_KEY"
  export LLM_MODEL_NAME="$LITELLM_MODEL"
  export PDF_RESEARCH_LLM_BASE_URL="$OPENAI_BASE_URL"
  export PDF_RESEARCH_LLM_API_KEY="$LITELLM_KEY"
  export PDF_RESEARCH_LLM_MODEL="$LITELLM_MODEL"
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
  tmux has-session -t "$STACK_SESSION" 2>/dev/null \
    && tmux list-windows -t "$STACK_SESSION" -F '#{window_name}' 2>/dev/null \
      | grep -qx 'host' \
    && tmux capture-pane -p -t "$STACK_SESSION:host" -S -80 2>/dev/null \
      | grep -q 'Connected'
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

obsidian_worker_online() {
  tmux has-session -t "$STACK_SESSION" 2>/dev/null \
    && tmux list-windows -t "$STACK_SESSION" -F '#{window_name}' 2>/dev/null \
      | grep -qx 'obsidian'
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
  export LITELLM_LOCAL_MODEL_COST_MAP="${LITELLM_LOCAL_MODEL_COST_MAP:-True}"
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
  export OMNIGENT_HOST_ID="$OMNIGENT_SHARED_HOST_ID"
  export OMNIGENT_HOST_NAME="$OMNIGENT_SHARED_HOST_NAME"
  export OMNIGENT_HOST_TOKEN="$OMNIGENT_SHARED_HOST_TOKEN"
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
  cd "$OMNIGENT_DIR"
  exec uv run --offline python -m omnigent.server.private_fund_valuation_worker
}

run_obsidian_worker() {
  export PRIVATE_FUND_OBSIDIAN_VAULT_PATH="${PRIVATE_FUND_OBSIDIAN_VAULT_PATH:-$HOME/feiyuzi/personal_obsidian_workspace}"
  if [[ ! -d "$PRIVATE_FUND_OBSIDIAN_VAULT_PATH" ]]; then
    echo "Obsidian vault not found: $PRIVATE_FUND_OBSIDIAN_VAULT_PATH" >&2
    echo "Set PRIVATE_FUND_OBSIDIAN_VAULT_PATH to the real Vault root." >&2
    exit 1
  fi
  cd "$OMNIGENT_DIR"
  exec uv run --offline python -m omnigent.server.private_fund_obsidian_worker
}

run_control() {
  while :; do sleep 3600; done
}

start_stack() {
  require_runtime
  if tmux has-session -t "$STACK_SESSION" 2>/dev/null; then
    if litellm_healthy && server_healthy && host_online \
      && tracking_worker_online && valuation_worker_online && obsidian_worker_online; then
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
  tmux new-window -d -t "$STACK_SESSION" -n obsidian "$SCRIPT_PATH" _run-obsidian
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
  if ! wait_until "Obsidian Projection Worker" obsidian_worker_online; then
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
  if obsidian_worker_online; then
    echo "Obsidian:  online"
  else
    echo "Obsidian:  offline"
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
  for window_name in litellm server tracking valuation obsidian host; do
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
  stop)
    if ! command -v tmux >/dev/null 2>&1; then
      echo "Missing required command: tmux" >&2
      exit 1
    fi
    stop_stack
    ;;
  restart) require_runtime; stop_stack; start_stack ;;
  status) require_runtime; status_stack ;;
  logs) require_runtime; logs_stack ;;
  attach) attach_stack ;;
  _run-control) run_control ;;
  _run-litellm) run_litellm ;;
  _run-server) run_server ;;
  _run-tracking) run_tracking_worker ;;
  _run-valuation) run_valuation_worker ;;
  _run-obsidian) run_obsidian_worker ;;
  _run-host) run_host ;;
  *) usage; exit 2 ;;
esac
