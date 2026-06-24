#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="${SCRIPT_DIR}"
LOG_DIR="${PROJECT_ROOT}/logs"

CONDA_ENV_NAME="${CONDA_ENV_NAME:-vllm}"

EMBEDDING_MODEL="${EMBEDDING_MODEL:-BAAI/bge-m3}"
EMBEDDING_HOST="${EMBEDDING_HOST:-0.0.0.0}"
EMBEDDING_PORT="${EMBEDDING_PORT:-5433}"
EMBEDDING_GPU_MEMORY_UTILIZATION="${EMBEDDING_GPU_MEMORY_UTILIZATION:-0.03}"

RERANKER_MODEL="${RERANKER_MODEL:-BAAI/bge-reranker-v2-gemma}"
RERANKER_HOST="${RERANKER_HOST:-0.0.0.0}"
RERANKER_PORT="${RERANKER_PORT:-5432}"
RERANKER_GPU_MEMORY_UTILIZATION="${RERANKER_GPU_MEMORY_UTILIZATION:-0.25}"
RERANKER_MAX_MODEL_LEN="${RERANKER_MAX_MODEL_LEN:-8192}"
RERANKER_TOP_N="${RERANKER_TOP_N:-5}"
STARTUP_TIMEOUT_SECONDS="${STARTUP_TIMEOUT_SECONDS:-600}"
POLL_INTERVAL_SECONDS="${POLL_INTERVAL_SECONDS:-5}"

mkdir -p "${LOG_DIR}"

echo "======================================"
echo "  FinSagent vLLM 服务启动脚本"
echo "======================================"
echo "Project root    : ${PROJECT_ROOT}"
echo "Conda env       : ${CONDA_ENV_NAME}"
echo "Embedding model : ${EMBEDDING_MODEL}"
echo "Embedding port  : ${EMBEDDING_PORT}"
echo "Reranker model  : ${RERANKER_MODEL}"
echo "Reranker port   : ${RERANKER_PORT}"
echo "Reranker top_n  : ${RERANKER_TOP_N} (aligned with active FinSagent service)"
echo "Log dir         : ${LOG_DIR}"

if [ -f "/root/autodl-tmp/miniconda3/etc/profile.d/conda.sh" ]; then
  # shellcheck disable=SC1091
  source "/root/autodl-tmp/miniconda3/etc/profile.d/conda.sh"
elif [ -f "${HOME}/miniconda3/etc/profile.d/conda.sh" ]; then
  # shellcheck disable=SC1091
  source "${HOME}/miniconda3/etc/profile.d/conda.sh"
elif command -v conda >/dev/null 2>&1; then
  eval "$(conda shell.bash hook)"
else
  echo "Error: conda not found. Please install conda or update this script."
  exit 1
fi

conda activate "${CONDA_ENV_NAME}"

if ! command -v vllm >/dev/null 2>&1; then
  echo "Error: vllm command not found in conda env '${CONDA_ENV_NAME}'."
  exit 1
fi

if ! command -v curl >/dev/null 2>&1; then
  echo "Error: curl not found."
  exit 1
fi

cleanup() {
  local exit_code=$?
  if [ -n "${EMBEDDING_PID:-}" ] && kill -0 "${EMBEDDING_PID}" >/dev/null 2>&1; then
    kill "${EMBEDDING_PID}" >/dev/null 2>&1 || true
  fi
  if [ -n "${RERANKER_PID:-}" ] && kill -0 "${RERANKER_PID}" >/dev/null 2>&1; then
    kill "${RERANKER_PID}" >/dev/null 2>&1 || true
  fi
  exit "${exit_code}"
}

trap cleanup INT TERM EXIT

cd "${PROJECT_ROOT}"

print_log_preview() {
  local title="$1"
  local log_file="$2"
  echo "----- ${title} recent log -----"
  if [ -f "${log_file}" ]; then
    tail -n 20 "${log_file}" || true
  else
    echo "Log file not created yet: ${log_file}"
  fi
  echo "--------------------------------"
}

wait_for_service() {
  local name="$1"
  local port="$2"
  local log_file="$3"
  local start_ts
  start_ts=$(date +%s)

  echo "Waiting for ${name} on port ${port}..."
  while true; do
    if curl -fsS "http://127.0.0.1:${port}/v1/models" >/dev/null 2>&1; then
      echo "[READY] ${name} is available at http://127.0.0.1:${port}/v1/models"
      print_log_preview "${name}" "${log_file}"
      return 0
    fi

    if ! kill -0 "${EMBEDDING_PID}" >/dev/null 2>&1 && [ "${name}" = "Embedding" ]; then
      echo "[ERROR] ${name} process exited before becoming ready."
      print_log_preview "${name}" "${log_file}"
      return 1
    fi

    if ! kill -0 "${RERANKER_PID}" >/dev/null 2>&1 && [ "${name}" = "Reranker" ]; then
      echo "[ERROR] ${name} process exited before becoming ready."
      print_log_preview "${name}" "${log_file}"
      return 1
    fi

    local now elapsed
    now=$(date +%s)
    elapsed=$((now - start_ts))
    if [ "${elapsed}" -ge "${STARTUP_TIMEOUT_SECONDS}" ]; then
      echo "[ERROR] Timeout waiting for ${name} after ${elapsed}s."
      print_log_preview "${name}" "${log_file}"
      return 1
    fi

    echo "[WAITING] ${name} not ready yet after ${elapsed}s. Endpoint: http://127.0.0.1:${port}/v1/models"
    print_log_preview "${name}" "${log_file}"
    sleep "${POLL_INTERVAL_SECONDS}"
  done
}

echo "Starting embedding service..."
vllm serve "${EMBEDDING_MODEL}" \
  --host "${EMBEDDING_HOST}" \
  --port "${EMBEDDING_PORT}" \
  --runner pooling \
  --gpu-memory-utilization "${EMBEDDING_GPU_MEMORY_UTILIZATION}" \
  --hf-overrides '{"architectures": ["BgeM3EmbeddingModel"]}' \
  > "${LOG_DIR}/vllm_embedding.log" 2>&1 &
EMBEDDING_PID=$!

echo "Starting reranker service..."
vllm serve "${RERANKER_MODEL}" \
  --served-model-name "${RERANKER_MODEL}" \
  --host "${RERANKER_HOST}" \
  --port "${RERANKER_PORT}" \
  --runner pooling \
  --convert classify \
  --gpu-memory-utilization "${RERANKER_GPU_MEMORY_UTILIZATION}" \
  --max-model-len "${RERANKER_MAX_MODEL_LEN}" \
  --hf_overrides '{"architectures": ["GemmaForSequenceClassification"], "classifier_from_token": ["Yes"], "method": "no_post_processing"}' \
  > "${LOG_DIR}/vllm_reranker.log" 2>&1 &
RERANKER_PID=$!

echo "Embedding PID : ${EMBEDDING_PID}"
echo "Reranker PID  : ${RERANKER_PID}"
echo "Embedding log : ${LOG_DIR}/vllm_embedding.log"
echo "Reranker log  : ${LOG_DIR}/vllm_reranker.log"
echo

wait_for_service "Embedding" "${EMBEDDING_PORT}" "${LOG_DIR}/vllm_embedding.log"
wait_for_service "Reranker" "${RERANKER_PORT}" "${LOG_DIR}/vllm_reranker.log"

echo
echo "======================================"
echo "  All vLLM services are ready"
echo "======================================"
echo "Embedding models: http://127.0.0.1:${EMBEDDING_PORT}/v1/models"
echo "Reranker models : http://127.0.0.1:${RERANKER_PORT}/v1/models"
echo
echo "Quick checks:"
echo "  curl -s http://127.0.0.1:${EMBEDDING_PORT}/v1/models"
echo "  curl -s http://127.0.0.1:${RERANKER_PORT}/v1/models"
echo
echo "Logs:"
echo "  tail -f ${LOG_DIR}/vllm_embedding.log"
echo "  tail -f ${LOG_DIR}/vllm_reranker.log"
echo
echo "Press Ctrl+C to stop both services."

wait "${EMBEDDING_PID}" "${RERANKER_PID}"
