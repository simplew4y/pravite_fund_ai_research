#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
EVAL_SCRIPT="${SCRIPT_DIR}/eval_retrieval.py"
PYTHON="${PYTHON:-/root/autodl-tmp/miniconda3/envs/lotusenv/bin/python}"
SOURCE_DIR="${SOURCE_DIR:-${PROJECT_ROOT}/test/e2e/0322_force_general_lightgbm_new_calibrate_ts10_fb_table_rerun}"
BENCHMARKS="${BENCHMARKS:-secque zeekr lotus finder financebench}"
MODEL_TARGETS="${MODEL_TARGETS:-kimi qwen}"
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
OUTPUT_ROOT="${OUTPUT_ROOT:-${PROJECT_ROOT}/test/e2e/run5_alt_llm_apis_${TIMESTAMP}}"
TMP_DIR="${TMP_DIR:-${OUTPUT_ROOT}/tmp_configs}"

mkdir -p "${OUTPUT_ROOT}" "${TMP_DIR}"
LOG_FILE="${OUTPUT_ROOT}/ablation.log"
SEP="$(printf '=%.0s' {1..70})"
THIN_SEP="$(printf -- '-%.0s' {1..70})"

log() {
    echo "$1" | tee -a "${LOG_FILE}"
}

load_yaml_value() {
    local yaml_path="$1"
    local key="$2"
    "${PYTHON}" - "$yaml_path" "$key" <<'PY'
import sys
import yaml

path, key = sys.argv[1:3]
with open(path, "r", encoding="utf-8") as f:
    data = yaml.safe_load(f) or {}
value = data.get(key)
if value is None:
    print("")
elif isinstance(value, bool):
    print(str(value).lower())
else:
    print(value)
PY
}

write_temp_config() {
    local source_config="$1"
    local target_config="$2"
    local model_name="$3"
    local base_url="$4"
    local api_key="$5"
    "${PYTHON}" - "$source_config" "$target_config" "$model_name" "$base_url" "$api_key" <<'PY'
import sys
import yaml

source_path, target_path, model_name, base_url, api_key = sys.argv[1:]
with open(source_path, "r", encoding="utf-8") as f:
    data = yaml.safe_load(f) or {}
data["llm_model_name"] = model_name
data["llm_base_url"] = base_url
data["llm_api_key"] = api_key
data["pre_run_jsonl"] = None
with open(target_path, "w", encoding="utf-8") as f:
    yaml.safe_dump(data, f, sort_keys=False, allow_unicode=True)
PY
}

append_bool_flag() {
    local -n cmd_ref=$1
    local flag_name="$2"
    local flag_value="${3:-}"
    case "${flag_value}" in
        true)
            cmd_ref+=("${flag_name}")
            ;;
        false)
            cmd_ref+=("--no-${flag_name#--}")
            ;;
        "")
            ;;
        *)
            echo "Invalid boolean value '${flag_value}' for ${flag_name}" >&2
            exit 1
            ;;
    esac
}

resolve_model_target() {
    local target="$1"
    case "${target}" in
        kimi)
            MODEL_NAME="${KIMI_MODEL_NAME:-kimi-k2.5}"
            MODEL_BASE_URL="${KIMI_BASE_URL:-https://api.moonshot.cn/v1}"
            MODEL_API_KEY="${KIMI_API_KEY:?Set KIMI_API_KEY before running kimi target}"
            MODEL_TAG="${KIMI_TAG:-kimi_k2_5}"
            ;;
        qwen)
            MODEL_NAME="${QWEN_MODEL_NAME:-qwen3-max}"
            MODEL_BASE_URL="${QWEN_BASE_URL:-https://dashscope.aliyuncs.com/compatible-mode/v1}"
            MODEL_API_KEY="${QWEN_API_KEY:?Set QWEN_API_KEY before running qwen target}"
            MODEL_TAG="${QWEN_TAG:-qwen3_max}"
            ;;
        *)
            echo "Unsupported MODEL_TARGETS entry: ${target}" >&2
            exit 1
            ;;
    esac
}

run_benchmark() {
    local bench="$1"
    local model_output_dir="$2"
    local source_config="${SOURCE_DIR}/${bench}_run5_ret10_rer5_multi_role_chunkrisk_percentile_ctx_decomp_config.yaml"

    if [ ! -f "${source_config}" ]; then
        echo "Missing source config: ${source_config}" >&2
        exit 1
    fi

    local run_name
    run_name="$(load_yaml_value "${source_config}" "run_name")_${MODEL_TAG}"

    local persist_directory
    persist_directory="$(load_yaml_value "${source_config}" "persist_directory")"
    local gt_path
    gt_path="$(load_yaml_value "${source_config}" "gt_path")"
    local collection_name
    collection_name="$(load_yaml_value "${source_config}" "collection_name")"
    local retrieve_top_k
    retrieve_top_k="$(load_yaml_value "${source_config}" "retrieve_top_k")"
    local rerank_top_k
    rerank_top_k="$(load_yaml_value "${source_config}" "rerank_top_k")"
    local workers
    workers="$(load_yaml_value "${source_config}" "workers")"
    local bayesian_type
    bayesian_type="$(load_yaml_value "${source_config}" "bayesian_type")"
    local use_multi_role
    use_multi_role="$(load_yaml_value "${source_config}" "use_multi_role")"
    local enable_ctx_decomp
    enable_ctx_decomp="$(load_yaml_value "${source_config}" "enable_ctx_decomp")"
    local enable_dynamic_retrieval
    enable_dynamic_retrieval="$(load_yaml_value "${source_config}" "enable_dynamic_retrieval")"
    local enable_memory
    enable_memory="$(load_yaml_value "${source_config}" "enable_memory")"
    local use_bayesian_rag
    use_bayesian_rag="$(load_yaml_value "${source_config}" "use_bayesian_rag")"
    local stop_after_retrieval
    stop_after_retrieval="$(load_yaml_value "${source_config}" "stop_after_retrieval")"
    local use_chunk_risk_calibration
    use_chunk_risk_calibration="$(load_yaml_value "${source_config}" "use_chunk_risk_calibration")"
    local chunk_risk_model_path
    chunk_risk_model_path="$(load_yaml_value "${source_config}" "chunk_risk_model_path")"
    local chunk_risk_penalty_mode
    chunk_risk_penalty_mode="$(load_yaml_value "${source_config}" "chunk_risk_penalty_mode")"
    local chunk_risk_lambda
    chunk_risk_lambda="$(load_yaml_value "${source_config}" "chunk_risk_lambda")"
    local table_lookup_jsonl
    table_lookup_jsonl="$(load_yaml_value "${source_config}" "table_lookup_jsonl")"

    local temp_config="${TMP_DIR}/${run_name}_config.yaml"
    write_temp_config "${source_config}" "${temp_config}" "${MODEL_NAME}" "${MODEL_BASE_URL}" "${MODEL_API_KEY}"

    local cmd=(
        "${PYTHON}" "${EVAL_SCRIPT}"
        --config_path "${temp_config}"
        --output_dir "${model_output_dir}"
        --run_name "${run_name}"
        --gt_path "${gt_path}"
        --persist_directory "${persist_directory}"
        --collection_name "${collection_name}"
        --workers "${workers}"
        --bayesian_type "${bayesian_type}"
        --retrieve_top_k "${retrieve_top_k}"
        --rerank_top_k "${rerank_top_k}"
        --chunk_risk_model_path "${chunk_risk_model_path}"
        --chunk_risk_penalty_mode "${chunk_risk_penalty_mode}"
    )

    append_bool_flag cmd --use_multi_role "${use_multi_role}"
    append_bool_flag cmd --enable_ctx_decomp "${enable_ctx_decomp}"
    append_bool_flag cmd --enable_dynamic_retrieval "${enable_dynamic_retrieval}"
    append_bool_flag cmd --enable_memory "${enable_memory}"
    append_bool_flag cmd --use_bayesian_rag "${use_bayesian_rag}"
    append_bool_flag cmd --stop_after_retrieval "${stop_after_retrieval}"
    append_bool_flag cmd --use_chunk_risk_calibration "${use_chunk_risk_calibration}"

    if [ -n "${chunk_risk_lambda}" ]; then
        cmd+=(--chunk_risk_lambda "${chunk_risk_lambda}")
    fi
    if [ -n "${table_lookup_jsonl}" ]; then
        cmd+=(--table_lookup_jsonl "${table_lookup_jsonl}")
    fi

    log ""
    log "${SEP}"
    log "  [${bench}] RUN5 replay with ${MODEL_NAME}"
    log "${SEP}"
    log "  Source Config         : ${source_config}"
    log "  Temp Config           : ${temp_config}"
    log "  Output Dir            : ${model_output_dir}"
    log "  Run Name              : ${run_name}"
    log "  Collection            : ${collection_name}"
    log "  Workers               : ${workers}"
    log "  Table Lookup JSONL    : ${table_lookup_jsonl:-N/A}"
    log "  Args: ${cmd[*]:2}"
    log "${THIN_SEP}"

    "${cmd[@]}" 2>&1 | tee -a "${LOG_FILE}"

    log "${THIN_SEP}"
    log "  [${bench}] COMPLETE for ${MODEL_NAME}"
    log "${SEP}"
}

log "${SEP}"
log "  RUN5 ALT-LLM REPLAY  –  ${TIMESTAMP}"
log "  Source Dir           : ${SOURCE_DIR}"
log "  Output Root          : ${OUTPUT_ROOT}"
log "  Benchmarks           : ${BENCHMARKS}"
log "  Model Targets        : ${MODEL_TARGETS}"
log "${SEP}"

for model_target in ${MODEL_TARGETS}; do
    resolve_model_target "${model_target}"
    model_output_dir="${OUTPUT_ROOT}/${MODEL_TAG}"
    mkdir -p "${model_output_dir}"

    log ""
    log "$(printf '#%.0s' {1..70})"
    log "  MODEL TARGET: ${model_target}"
    log "$(printf '#%.0s' {1..70})"
    log "  Model Name           : ${MODEL_NAME}"
    log "  Base URL             : ${MODEL_BASE_URL}"
    log "  Output Dir           : ${model_output_dir}"

    for bench in ${BENCHMARKS}; do
        run_benchmark "${bench}" "${model_output_dir}"
    done
done

log ""
log "${SEP}"
log "  ALL RUNS COMPLETE"
log "  Output Root          : ${OUTPUT_ROOT}"
log "  Log File             : ${LOG_FILE}"
log "${SEP}"
