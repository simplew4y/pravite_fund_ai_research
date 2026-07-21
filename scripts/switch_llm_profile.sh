#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ACTIVE_CONFIG="$ROOT_DIR/FinSagent/config/production.yaml"
PREVIOUS_CONFIG="$ROOT_DIR/FinSagent/config/production.before-xiaomoxing.yaml"
XIAOMOXING_MODEL="qwen3.6-35b-awq"
XIAOMOXING_BASE_URL="https://uu310022-ek0l-2bc347cf.westd.seetacloud.com:8443/v1"

read_config_value() {
  local key="$1"
  awk -F: -v key="$key" '
    $1 ~ "^[[:space:]]*" key "[[:space:]]*$" {
      value = substr($0, index($0, ":") + 1)
      gsub(/^[[:space:]\047\042]+|[[:space:]\047\042]+$/, "", value)
      print value
      exit
    }
  ' "$ACTIVE_CONFIG"
}

replace_scalar() {
  local key="$1"
  local value="$2"
  MODEL_CONFIG_KEY="$key" MODEL_CONFIG_VALUE="$value" perl -0pi -e '
    my $key = $ENV{"MODEL_CONFIG_KEY"};
    my $value = $ENV{"MODEL_CONFIG_VALUE"};
    s/^\s*\Q$key\E\s*:.*$/$key . ": \"" . $value . "\""/mge;
  ' "$ACTIVE_CONFIG"
}

use_xiaomoxing() {
  if [[ ! -f "$ACTIVE_CONFIG" ]]; then
    echo "Active model config not found: $ACTIVE_CONFIG" >&2
    exit 1
  fi
  if [[ ! -f "$PREVIOUS_CONFIG" ]]; then
    cp "$ACTIVE_CONFIG" "$PREVIOUS_CONFIG"
    chmod 600 "$PREVIOUS_CONFIG"
  fi
  replace_scalar "llm_model_name" "$XIAOMOXING_MODEL"
  replace_scalar "llm_base_url" "$XIAOMOXING_BASE_URL"
  replace_scalar "llm_api_key" "EMPTY"
  if grep -qE '^[[:space:]]*llm_chat_template_enable_thinking[[:space:]]*:' "$ACTIVE_CONFIG"; then
    replace_scalar "llm_chat_template_enable_thinking" "false"
  else
    printf '\nllm_chat_template_enable_thinking: "false"\n' >> "$ACTIVE_CONFIG"
  fi
  chmod 600 "$ACTIVE_CONFIG"
  echo "Active LLM profile: xiaomoxing ($XIAOMOXING_MODEL)"
  echo "Previous config backup: $PREVIOUS_CONFIG"
}

restore_previous() {
  if [[ ! -f "$PREVIOUS_CONFIG" ]]; then
    echo "Previous model config backup not found: $PREVIOUS_CONFIG" >&2
    exit 1
  fi
  cp "$PREVIOUS_CONFIG" "$ACTIVE_CONFIG"
  chmod 600 "$ACTIVE_CONFIG"
  echo "Restored previous LLM profile from: $PREVIOUS_CONFIG"
}

show_status() {
  if [[ ! -f "$ACTIVE_CONFIG" ]]; then
    echo "Active model config not found: $ACTIVE_CONFIG" >&2
    exit 1
  fi
  echo "model:    $(read_config_value llm_model_name)"
  echo "base_url: $(read_config_value llm_base_url)"
  if [[ -f "$PREVIOUS_CONFIG" ]]; then
    echo "previous: available"
  else
    echo "previous: unavailable"
  fi
}

case "${1:-status}" in
  xiaomoxing)
    use_xiaomoxing
    ;;
  previous)
    restore_previous
    ;;
  status)
    show_status
    ;;
  *)
    echo "Usage: $0 {xiaomoxing|previous|status}" >&2
    exit 2
    ;;
esac
