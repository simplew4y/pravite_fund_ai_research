#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

if [ -f "${SCRIPT_DIR}/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  source "${SCRIPT_DIR}/.env"
  set +a
fi

if ! command -v vllm >/dev/null 2>&1; then
  echo "vllm command not found. Install vLLM in this environment first."
  exit 1
fi

MODEL="${MODEL:-Qwen/Qwen3-4B}"
SERVED_MODEL_NAME="${SERVED_MODEL_NAME:-xiaomoxing}"
HOST="${HOST:-0.0.0.0}"
PORT="${PORT:-8008}"
TENSOR_PARALLEL_SIZE="${TENSOR_PARALLEL_SIZE:-1}"
GPU_MEMORY_UTILIZATION="${GPU_MEMORY_UTILIZATION:-0.25}"
MAX_MODEL_LEN="${MAX_MODEL_LEN:-8192}"

cd "${PROJECT_ROOT}"

exec vllm serve "${MODEL}" \
  --served-model-name "${SERVED_MODEL_NAME}" \
  --host "${HOST}" \
  --port "${PORT}" \
  --tensor-parallel-size "${TENSOR_PARALLEL_SIZE}" \
  --gpu-memory-utilization "${GPU_MEMORY_UTILIZATION}" \
  --max-model-len "${MAX_MODEL_LEN}"
