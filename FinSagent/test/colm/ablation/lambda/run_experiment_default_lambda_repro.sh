# deprecated

#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
EVAL_SCRIPT="${PROJECT_ROOT}/test/colm/retrieval/eval_retrieval.py"
PYTHON="${PYTHON:-/root/autodl-tmp/miniconda3/envs/lotusenv/bin/python}"
BASE_CONFIG="${BASE_CONFIG:-${PROJECT_ROOT}/config/production.yaml}"
SOURCE_ROOT="${SOURCE_ROOT:-${PROJECT_ROOT}/test/e2e/0322_force_general_lightgbm_new_calibrate_ts10_fb_table_rerun}"
SOURCE_RUN_PATTERN="${SOURCE_RUN_PATTERN:-%s_run3_ret%s_rer%s_multi_role_chunkrisk_percentile}"
SOURCE_JSONL_PATTERN="${SOURCE_JSONL_PATTERN:-%s_run3_ret%s_rer%s_multi_role_chunkrisk_percentile.jsonl}"
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
WORKERS="${WORKERS:-6}"
ALIGNMENT_TOLERANCE="${ALIGNMENT_TOLERANCE:-0.01}"
FAIL_ON_MISALIGNMENT="${FAIL_ON_MISALIGNMENT:-0}"

BENCHMARKS="${BENCHMARKS:-lotus zeekr financebench finder secque}"
RETRIEVE_TOPKS="${RETRIEVE_TOPKS:-10}"
RERANK_TOPKS="${RERANK_TOPKS:-5}"

SEP="$(printf '=%.0s' {1..70})"
THIN_SEP="$(printf -- '-%.0s' {1..70})"

EXPERIMENT_DIR="${EXPERIMENT_DIR:-${SCRIPT_DIR}/experiment_default_lambda_repro_${TIMESTAMP}}"
mkdir -p "${EXPERIMENT_DIR}"
LOG_FILE="${EXPERIMENT_DIR}/ablation.log"

log() {
    echo "$1" | tee -a "${LOG_FILE}"
}

is_truthy() {
    local value="${1:-}"
    case "${value,,}" in
        1|true|yes|y|on)
            return 0
            ;;
        *)
            return 1
            ;;
    esac
}

append_bool_flag() {
    local -n args_ref="$1"
    local flag_name="$2"
    local flag_value="$3"
    if is_truthy "${flag_value}"; then
        args_ref+=("${flag_name}")
    else
        args_ref+=("--no-${flag_name#--}")
    fi
}

resolve_source_run_name() {
    local bench="$1"
    local retrieve_top_k="$2"
    local rerank_top_k="$3"
    printf "${SOURCE_RUN_PATTERN}" "${bench}" "${retrieve_top_k}" "${rerank_top_k}"
}

resolve_source_jsonl_path() {
    local bench="$1"
    local retrieve_top_k="$2"
    local rerank_top_k="$3"
    local source_jsonl_name
    source_jsonl_name="$(printf "${SOURCE_JSONL_PATTERN}" "${bench}" "${retrieve_top_k}" "${rerank_top_k}")"
    printf "%s/%s" "${SOURCE_ROOT}" "${source_jsonl_name}"
}

load_source_context() {
    local source_config_path="$1"
    local source_metrics_path="$2"
    local source_run_name="$3"
    local source_run_jsonl="$4"

    SOURCE_CONFIG_PATH="${source_config_path}" \
    SOURCE_METRICS_PATH="${source_metrics_path}" \
    SOURCE_RUN_NAME="${source_run_name}" \
    SOURCE_RUN_JSONL="${source_run_jsonl}" \
    "${PYTHON}" - <<'PY'
import json
import os
import shlex
import yaml

config_path = os.environ["SOURCE_CONFIG_PATH"]
metrics_path = os.environ["SOURCE_METRICS_PATH"]
source_run_name = os.environ["SOURCE_RUN_NAME"]
source_run_jsonl = os.environ["SOURCE_RUN_JSONL"]

with open(config_path, "r", encoding="utf-8") as f:
    config = yaml.safe_load(f) or {}

with open(metrics_path, "r", encoding="utf-8") as f:
    payload = json.load(f)

source_summary = {}
if isinstance(payload, list):
    source_summary = next(
        (item for item in payload if isinstance(item, dict) and item.get("run_name") == source_run_name),
        {},
    )

pairs = {
    "SOURCE_PERSIST": config.get("persist_directory") or "",
    "SOURCE_GT": config.get("gt_path") or "",
    "SOURCE_COLLECTION": config.get("collection_name") or "",
    "SOURCE_CONFIG_SOURCE": config.get("config_source") or "",
    "SOURCE_BAYESIAN_TYPE": config.get("bayesian_type") or "rerank",
    "SOURCE_RETRIEVE_TOP_K": str(config.get("retrieve_top_k") or ""),
    "SOURCE_RERANK_TOP_K": str(config.get("rerank_top_k") or ""),
    "SOURCE_USE_MULTI_ROLE": "1" if config.get("use_multi_role") else "0",
    "SOURCE_ENABLE_CTX_DECOMP": "1" if config.get("enable_ctx_decomp") else "0",
    "SOURCE_USE_BAYESIAN_RAG": "1" if config.get("use_bayesian_rag") else "0",
    "SOURCE_USE_CHUNK_RISK_CALIBRATION": "1" if config.get("use_chunk_risk_calibration") else "0",
    "SOURCE_STOP_AFTER_RETRIEVAL": "1" if config.get("stop_after_retrieval") else "0",
    "SOURCE_ENABLE_MEMORY": "1" if config.get("enable_memory") else "0",
    "SOURCE_CHUNK_RISK_MODEL_PATH": config.get("chunk_risk_model_path") or "",
    "SOURCE_CHUNK_RISK_PENALTY_MODE": config.get("chunk_risk_penalty_mode") or "",
    "SOURCE_CHUNK_RISK_LAMBDA": "" if config.get("chunk_risk_lambda") is None else str(config.get("chunk_risk_lambda")),
    "SOURCE_PRE_RUN_JSONL": source_run_jsonl,
    "SOURCE_TABLE_LOOKUP_JSONL": config.get("table_lookup_jsonl") or "",
    "SOURCE_MACRO_RECALL": "" if not source_summary else str(source_summary.get("macro_recall", "")),
    "SOURCE_MICRO_RECALL": "" if not source_summary else str(source_summary.get("micro_recall", "")),
    "SOURCE_AVG_PRECISION": "" if not source_summary else str(source_summary.get("avg_precision", "")),
    "SOURCE_AVG_JACCARD": "" if not source_summary else str(source_summary.get("avg_jaccard", "")),
    "SOURCE_AVG_RETRIEVED": "" if not source_summary else str(source_summary.get("avg_retrieved", "")),
}

for key, value in pairs.items():
    print(f"{key}={shlex.quote(value)}")
PY
}

compare_run_metrics() {
    local source_metrics_path="$1"
    local source_run_name="$2"
    local target_metrics_path="$3"
    local target_run_name="$4"

    SOURCE_METRICS_PATH="${source_metrics_path}" \
    SOURCE_RUN_NAME="${source_run_name}" \
    TARGET_METRICS_PATH="${target_metrics_path}" \
    TARGET_RUN_NAME="${target_run_name}" \
    ALIGNMENT_TOLERANCE="${ALIGNMENT_TOLERANCE}" \
    FAIL_ON_MISALIGNMENT="${FAIL_ON_MISALIGNMENT}" \
    "${PYTHON}" - <<'PY'
import json
import math
import os

source_metrics_path = os.environ["SOURCE_METRICS_PATH"]
source_run_name = os.environ["SOURCE_RUN_NAME"]
target_metrics_path = os.environ["TARGET_METRICS_PATH"]
target_run_name = os.environ["TARGET_RUN_NAME"]
tolerance = float(os.environ["ALIGNMENT_TOLERANCE"])
fail_on_misalignment = os.environ.get("FAIL_ON_MISALIGNMENT", "0").lower() in {"1", "true", "yes", "y", "on"}

with open(source_metrics_path, "r", encoding="utf-8") as f:
    source_payload = json.load(f)
with open(target_metrics_path, "r", encoding="utf-8") as f:
    target_payload = json.load(f)

source_summary = next(
    (item for item in source_payload if isinstance(item, dict) and item.get("run_name") == source_run_name),
    None,
)
target_summary = next(
    (item for item in target_payload if isinstance(item, dict) and item.get("run_name") == target_run_name),
    None,
)

if source_summary is None:
    raise SystemExit(f"Missing source summary for {source_run_name} in {source_metrics_path}")
if target_summary is None:
    raise SystemExit(f"Missing target summary for {target_run_name} in {target_metrics_path}")

keys = ["macro_recall", "micro_recall", "avg_precision", "avg_jaccard", "avg_retrieved"]
print("  Metric Comparison")
max_delta = 0.0
for key in keys:
    source_value = float(source_summary.get(key, 0.0))
    target_value = float(target_summary.get(key, 0.0))
    delta = target_value - source_value
    max_delta = max(max_delta, abs(delta))
    print(f"    {key:14s}: source={source_value:.4f} current={target_value:.4f} delta={delta:+.4f}")

recall_aligned = (
    abs(float(target_summary.get("macro_recall", 0.0)) - float(source_summary.get("macro_recall", 0.0))) <= tolerance
    and abs(float(target_summary.get("micro_recall", 0.0)) - float(source_summary.get("micro_recall", 0.0))) <= tolerance
)
print(f"    aligned_within_tolerance({tolerance:.4f}): {str(recall_aligned).lower()}")
print(f"    max_metric_delta: {max_delta:.4f}")

if fail_on_misalignment and not recall_aligned:
    raise SystemExit(
        f"Run {target_run_name} is outside tolerance {tolerance:.4f} compared with {source_run_name}"
    )
PY
}

run_experiment() {
    local bench="$1"
    local run_num="$2"
    local retrieve_top_k="$3"
    local rerank_top_k="$4"

    local source_run_name
    source_run_name="$(resolve_source_run_name "${bench}" "${retrieve_top_k}" "${rerank_top_k}")"
    local source_config_path="${SOURCE_ROOT}/${source_run_name}_config.yaml"
    local source_metrics_path="${SOURCE_ROOT}/_metrics.json"
    local source_run_jsonl
    source_run_jsonl="$(resolve_source_jsonl_path "${bench}" "${retrieve_top_k}" "${rerank_top_k}")"

    if [ ! -f "${source_config_path}" ]; then
        echo "Missing source config: ${source_config_path}" >&2
        exit 1
    fi
    if [ ! -f "${source_metrics_path}" ]; then
        echo "Missing source metrics: ${source_metrics_path}" >&2
        exit 1
    fi
    if [ ! -f "${source_run_jsonl}" ]; then
        echo "Missing source run JSONL: ${source_run_jsonl}" >&2
        exit 1
    fi

    eval "$(load_source_context "${source_config_path}" "${source_metrics_path}" "${source_run_name}" "${source_run_jsonl}")"

    local full_run_name="${bench}_run${run_num}_ret${retrieve_top_k}_rer${rerank_top_k}_multi_role_chunkrisk_percentile_default_lambda_repro"
    local config_source="${SOURCE_CONFIG_SOURCE:-${BASE_CONFIG}}"

    local cmd_args=(
        --gt_path "${SOURCE_GT}"
        --persist_directory "${SOURCE_PERSIST}"
        --collection_name "${SOURCE_COLLECTION}"
        --output_dir "${EXPERIMENT_DIR}"
        --run_name "${full_run_name}"
        --workers "${WORKERS}"
        --config_path "${config_source}"
        --bayesian_type "${SOURCE_BAYESIAN_TYPE}"
        --retrieve_top_k "${SOURCE_RETRIEVE_TOP_K}"
        --rerank_top_k "${SOURCE_RERANK_TOP_K}"
    )

    append_bool_flag cmd_args --use_multi_role "${SOURCE_USE_MULTI_ROLE}"
    append_bool_flag cmd_args --enable_ctx_decomp "${SOURCE_ENABLE_CTX_DECOMP}"
    append_bool_flag cmd_args --use_bayesian_rag "${SOURCE_USE_BAYESIAN_RAG}"
    append_bool_flag cmd_args --use_chunk_risk_calibration "${SOURCE_USE_CHUNK_RISK_CALIBRATION}"
    append_bool_flag cmd_args --stop_after_retrieval "${SOURCE_STOP_AFTER_RETRIEVAL}"
    append_bool_flag cmd_args --enable_memory "${SOURCE_ENABLE_MEMORY}"

    if [ -n "${SOURCE_CHUNK_RISK_MODEL_PATH}" ]; then
        cmd_args+=(--chunk_risk_model_path "${SOURCE_CHUNK_RISK_MODEL_PATH}")
    fi
    if [ -n "${SOURCE_CHUNK_RISK_PENALTY_MODE}" ]; then
        cmd_args+=(--chunk_risk_penalty_mode "${SOURCE_CHUNK_RISK_PENALTY_MODE}")
    fi
    if [ -n "${SOURCE_CHUNK_RISK_LAMBDA}" ]; then
        cmd_args+=(--chunk_risk_lambda "${SOURCE_CHUNK_RISK_LAMBDA}")
    fi
    if [ -n "${SOURCE_PRE_RUN_JSONL}" ]; then
        cmd_args+=(--pre_run_jsonl "${SOURCE_PRE_RUN_JSONL}")
    fi
    if [ -n "${SOURCE_TABLE_LOOKUP_JSONL}" ]; then
        cmd_args+=(--table_lookup_jsonl "${SOURCE_TABLE_LOOKUP_JSONL}")
    fi

    log ""
    log "${SEP}"
    log "  [${bench}] RUN ${run_num}: ${full_run_name}"
    log "${SEP}"
    log "  Source Run            : ${source_run_name}"
    log "  Source Run JSONL      : ${source_run_jsonl}"
    log "  Source Config         : ${source_config_path}"
    log "  Source Metrics        : ${source_metrics_path}"
    log "  Persist Dir           : ${SOURCE_PERSIST}"
    log "  GT File               : ${SOURCE_GT}"
    log "  Collection            : ${SOURCE_COLLECTION}"
    log "  Retrieve / Rerank TopK: ${SOURCE_RETRIEVE_TOP_K} / ${SOURCE_RERANK_TOP_K}"
    log "  Workers               : ${WORKERS}"
    log "  Config Path           : ${config_source}"
    log "  Table Lookup JSONL    : ${SOURCE_TABLE_LOOKUP_JSONL:-N/A}"
    log "  Pre-run JSONL         : ${SOURCE_PRE_RUN_JSONL:-N/A}"
    log "  Reuse Saved Routing   : activated_agents + sub_queries from original run3 JSONL"
    log "  Source Macro Recall   : ${SOURCE_MACRO_RECALL:-N/A}"
    log "  Source Micro Recall   : ${SOURCE_MICRO_RECALL:-N/A}"
    log "  Args: ${cmd_args[*]}"
    log "${THIN_SEP}"

    "${PYTHON}" "${EVAL_SCRIPT}" "${cmd_args[@]}" 2>&1 | tee -a "${LOG_FILE}"

    log "${THIN_SEP}"
    compare_run_metrics "${source_metrics_path}" "${source_run_name}" "${EXPERIMENT_DIR}/_metrics.json" "${full_run_name}" | tee -a "${LOG_FILE}"
    log "${THIN_SEP}"
    log "  [${bench}] RUN ${run_num} COMPLETE"
    log "${SEP}"
}

read -r -a retrieve_topks <<< "${RETRIEVE_TOPKS}"
read -r -a rerank_topks <<< "${RERANK_TOPKS}"

if [ "${#retrieve_topks[@]}" -ne "${#rerank_topks[@]}" ]; then
    echo "RETRIEVE_TOPKS and RERANK_TOPKS must have the same number of entries" >&2
    exit 1
fi

log "${SEP}"
log "  DEFAULT-LAMBDA REPRO STUDY  –  ${TIMESTAMP}"
log "  Experiment Dir        : ${EXPERIMENT_DIR}"
log "  Base Config           : ${BASE_CONFIG}"
log "  Source Root           : ${SOURCE_ROOT}"
log "  Source Run Pattern    : ${SOURCE_RUN_PATTERN}"
log "  Source JSONL Pattern  : ${SOURCE_JSONL_PATTERN}"
log "  Benchmarks            : ${BENCHMARKS}"
log "  Retrieve TopKs        : ${RETRIEVE_TOPKS}"
log "  Rerank TopKs          : ${RERANK_TOPKS}"
log "  Workers               : ${WORKERS}"
log "  Alignment Tolerance   : ${ALIGNMENT_TOLERANCE}"
log "  Fail On Misalignment  : ${FAIL_ON_MISALIGNMENT}"
log "${SEP}"

for BENCH in ${BENCHMARKS}; do
    log ""
    log "$(printf '#%.0s' {1..70})"
    log "  BENCHMARK: ${BENCH}"
    log "$(printf '#%.0s' {1..70})"

    run_num=1
    for idx in "${!retrieve_topks[@]}"; do
        retrieve_top_k="${retrieve_topks[idx]}"
        rerank_top_k="${rerank_topks[idx]}"
        run_experiment "${BENCH}" "${run_num}" "${retrieve_top_k}" "${rerank_top_k}"
        run_num=$((run_num + 1))
    done
done

log ""
log "${SEP}"
log "  ALL RUNS COMPLETE"
log "  Experiment Dir      : ${EXPERIMENT_DIR}"
log "  Comparative Metrics : ${EXPERIMENT_DIR}/_metrics.json"
log "  Full Log            : ${LOG_FILE}"
log "  To resume: EXPERIMENT_DIR=${EXPERIMENT_DIR} bash $0"
log "${SEP}"
