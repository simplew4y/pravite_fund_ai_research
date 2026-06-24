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
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
WORKERS="${WORKERS:-1}"
CHUNK_RISK_PENALTY_MODE="${CHUNK_RISK_PENALTY_MODE:-percentile_rank}"
INCLUDE_DEFAULT_RUN="${INCLUDE_DEFAULT_RUN:-1}"

DEFAULT_CHUNK_RISK_MODEL_PATH="${DEFAULT_CHUNK_RISK_MODEL_PATH:-/root/autodl-tmp/cjj/FinSagent_0212/lightgbm/outputs_reduced_13788_no_balance_binary/artifacts/model.pkl}"
LOTUS_ZEEKR_CHUNK_RISK_MODEL_PATH="${LOTUS_ZEEKR_CHUNK_RISK_MODEL_PATH:-/root/autodl-tmp/cjj/FinSagent_0212/lightgbm/outputs_reduced_13788_no_balance_binary/artifacts/model.pkl}"

BENCH_lotus_PERSIST="${BENCH_lotus_PERSIST:-/root/autodl-tmp/RAG_Agent_data/lotus/20250701/database_lotus}"
BENCH_lotus_GT="${BENCH_lotus_GT:-${PROJECT_ROOT}/test/gt/lotus_108_dedup_gt.json}"
BENCH_lotus_COLLECTION="${BENCH_lotus_COLLECTION:-lotus}"

BENCH_zeekr_PERSIST="${BENCH_zeekr_PERSIST:-/root/autodl-tmp/RAG_Agent_data/Zeekr/20250729/database_zeekr}"
BENCH_zeekr_GT="${BENCH_zeekr_GT:-${PROJECT_ROOT}/test/gt/zeekr_134_dedup_gt.json}"
BENCH_zeekr_COLLECTION="${BENCH_zeekr_COLLECTION:-zeekr}"

BENCH_financebench_PERSIST="${BENCH_financebench_PERSIST:-/root/autodl-tmp/RAG_Agent_data/finance_bench/database_financebench}"
BENCH_financebench_GT="${BENCH_financebench_GT:-${PROJECT_ROOT}/test/gt/financebench_145_gt.json}"
BENCH_financebench_COLLECTION="${BENCH_financebench_COLLECTION:-financebench}"

BENCH_finder_PERSIST="${BENCH_finder_PERSIST:-/root/autodl-tmp/RAG_Agent_data/finder/database_finder}"
BENCH_finder_GT="${BENCH_finder_GT:-${PROJECT_ROOT}/test/gt/finder_sampled_71_gt.json}"
BENCH_finder_COLLECTION="${BENCH_finder_COLLECTION:-finder}"

BENCH_secque_PERSIST="${BENCH_secque_PERSIST:-/root/autodl-tmp/RAG_Agent_data/secque/database_secque}"
BENCH_secque_GT="${BENCH_secque_GT:-${PROJECT_ROOT}/test/gt/secque_sample_100_retrieval_gt.json}"
BENCH_secque_COLLECTION="${BENCH_secque_COLLECTION:-secque}"

BENCHMARKS="${BENCHMARKS:-lotus zeekr financebench finder secque}"
AGENTS="${AGENTS:-legal_risk quant company_researcher general market_researcher}"
LAMBDA_VALUES="${LAMBDA_VALUES:-0 0.1 0.3 0.6 0.9}"
RETRIEVE_TOPKS="${RETRIEVE_TOPKS:-10}"
RERANK_TOPKS="${RERANK_TOPKS:-5}"

SEP="$(printf '=%.0s' {1..70})"
THIN_SEP="$(printf -- '-%.0s' {1..70})"

EXPERIMENT_DIR="${EXPERIMENT_DIR:-${SCRIPT_DIR}/experiment_lambda_${TIMESTAMP}}"
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

format_lambda_token() {
    local value="$1"
    "${PYTHON}" - "$value" <<'PY'
import sys
value = float(sys.argv[1])
print(f"{value:.3f}".replace("-", "neg").replace(".", "p"))
PY
}

resolve_source_run_name() {
    local bench="$1"
    local retrieve_top_k="$2"
    local rerank_top_k="$3"
    printf "${SOURCE_RUN_PATTERN}" "${bench}" "${retrieve_top_k}" "${rerank_top_k}"
}

resolve_table_lookup_jsonl() {
    local config_path="$1"
    SOURCE_CONFIG_PATH="${config_path}" "${PYTHON}" - <<'PY'
import os
import yaml
path = os.environ["SOURCE_CONFIG_PATH"]
with open(path, "r", encoding="utf-8") as f:
    payload = yaml.safe_load(f) or {}
value = payload.get("table_lookup_jsonl") or ""
print(value)
PY
}

resolve_chunk_risk_model_path() {
    local bench="$1"
    if [ "${bench}" = "lotus" ] || [ "${bench}" = "zeekr" ]; then
        echo "${LOTUS_ZEEKR_CHUNK_RISK_MODEL_PATH}"
    else
        echo "${DEFAULT_CHUNK_RISK_MODEL_PATH}"
    fi
}

run_eval_with_agent_lambda() {
    local agent="$1"
    local lambda_value="$2"
    shift 2
    local eval_args=("$@")

    AGENT_NAME="${agent}" \
    LAMBDA_VALUE="${lambda_value}" \
    PROJECT_ROOT="${PROJECT_ROOT}" \
    "${PYTHON}" - "${eval_args[@]}" <<'PY'
import os
import sys
from pathlib import Path

project_root = Path(os.environ["PROJECT_ROOT"])
sys.path.insert(0, str(project_root / "src"))
sys.path.insert(0, str(project_root / "test" / "retrieval"))

import eval_retrieval
from utils import bayesian_retrieval

agent = os.environ.get("AGENT_NAME", "").strip()
lambda_value_raw = os.environ.get("LAMBDA_VALUE", "").strip()
original = dict(bayesian_retrieval.AGENT_BAYESIAN_LAMBDA)

try:
    if agent and lambda_value_raw:
        updated = dict(original)
        updated[agent] = float(lambda_value_raw)
        bayesian_retrieval.AGENT_BAYESIAN_LAMBDA.clear()
        bayesian_retrieval.AGENT_BAYESIAN_LAMBDA.update(updated)
    sys.argv = ["eval_retrieval.py", *sys.argv[1:]]
    eval_retrieval.main()
finally:
    bayesian_retrieval.AGENT_BAYESIAN_LAMBDA.clear()
    bayesian_retrieval.AGENT_BAYESIAN_LAMBDA.update(original)
PY
}

run_experiment() {
    local bench="$1"
    local run_num="$2"
    local run_name="$3"
    local agent="$4"
    local lambda_value="$5"
    local retrieve_top_k="$6"
    local rerank_top_k="$7"

    local persist_var="BENCH_${bench}_PERSIST"
    local gt_var="BENCH_${bench}_GT"
    local coll_var="BENCH_${bench}_COLLECTION"
    local persist="${!persist_var}"
    local gt="${!gt_var}"
    local collection="${!coll_var}"
    local chunk_risk_model_path
    chunk_risk_model_path="$(resolve_chunk_risk_model_path "${bench}")"

    local source_run_name
    source_run_name="$(resolve_source_run_name "${bench}" "${retrieve_top_k}" "${rerank_top_k}")"
    local source_pre_run_jsonl="${SOURCE_ROOT}/${source_run_name}.jsonl"
    local source_config_path="${SOURCE_ROOT}/${source_run_name}_config.yaml"

    if [ ! -f "${source_pre_run_jsonl}" ]; then
        echo "Missing pre-run JSONL: ${source_pre_run_jsonl}" >&2
        exit 1
    fi
    if [ ! -f "${source_config_path}" ]; then
        echo "Missing source config: ${source_config_path}" >&2
        exit 1
    fi

    local table_lookup_jsonl
    table_lookup_jsonl="$(resolve_table_lookup_jsonl "${source_config_path}")"

    local full_run_name="${bench}_run${run_num}_${run_name}"
    local cmd_args=(
        --gt_path "${gt}"
        --persist_directory "${persist}"
        --collection_name "${collection}"
        --output_dir "${EXPERIMENT_DIR}"
        --run_name "${full_run_name}"
        --workers "${WORKERS}"
        --config_path "${BASE_CONFIG}"
        --bayesian_type rerank
        --use_multi_role
        # --enable_ctx_decomp
        --no-use_bayesian_rag
        --use_chunk_risk_calibration
        --chunk_risk_model_path "${chunk_risk_model_path}"
        --chunk_risk_penalty_mode "${CHUNK_RISK_PENALTY_MODE}"
        --retrieve_top_k "${retrieve_top_k}"
        --rerank_top_k "${rerank_top_k}"
        --pre_run_jsonl "${source_pre_run_jsonl}"
        --stop_after_retrieval
    )

    if [ -n "${table_lookup_jsonl}" ]; then
        cmd_args+=(--table_lookup_jsonl "${table_lookup_jsonl}")
    fi

    log ""
    log "${SEP}"
    log "  [${bench}] RUN ${run_num}: ${run_name}"
    log "${SEP}"
    log "  Persist Dir           : ${persist}"
    log "  GT File               : ${gt}"
    log "  Collection            : ${collection}"
    log "  Chunk Risk Model Path : ${chunk_risk_model_path}"
    log "  Source Run            : ${source_run_name}"
    log "  Pre-run JSONL         : ${source_pre_run_jsonl}"
    log "  Source Config         : ${source_config_path}"
    log "  Table Lookup JSONL    : ${table_lookup_jsonl:-N/A}"
    log "  Agent Override        : ${agent:-default}"
    log "  Lambda Override       : ${lambda_value:-default}"
    log "  Workers               : ${WORKERS}"
    log "  Config Path           : ${BASE_CONFIG}"
    log "  Args: ${cmd_args[*]}"
    log "${THIN_SEP}"

    run_eval_with_agent_lambda "${agent}" "${lambda_value}" "${cmd_args[@]}" 2>&1 | tee -a "${LOG_FILE}"

    log "${THIN_SEP}"
    log "  [${bench}] RUN ${run_num} COMPLETE"
    log "${SEP}"
}

read -r -a retrieve_topks <<< "${RETRIEVE_TOPKS}"
read -r -a rerank_topks <<< "${RERANK_TOPKS}"
read -r -a agents <<< "${AGENTS}"
read -r -a lambda_values <<< "${LAMBDA_VALUES}"

if [ "${#retrieve_topks[@]}" -ne "${#rerank_topks[@]}" ]; then
    echo "RETRIEVE_TOPKS and RERANK_TOPKS must have the same number of entries" >&2
    exit 1
fi

log "${SEP}"
log "  LAMBDA ABLATION STUDY  –  ${TIMESTAMP}"
log "  Experiment Dir        : ${EXPERIMENT_DIR}"
log "  Base Config           : ${BASE_CONFIG}"
log "  Source Root           : ${SOURCE_ROOT}"
log "  Source Run Pattern    : ${SOURCE_RUN_PATTERN}"
log "  Benchmarks            : ${BENCHMARKS}"
log "  Agents                : ${AGENTS}"
log "  Lambda Grid           : ${LAMBDA_VALUES}"
log "  Retrieve TopKs        : ${RETRIEVE_TOPKS}"
log "  Rerank TopKs          : ${RERANK_TOPKS}"
log "  Workers               : ${WORKERS}"
log "  Include Default Run   : ${INCLUDE_DEFAULT_RUN}"
log "  Default Chunk Risk Model Path     : ${DEFAULT_CHUNK_RISK_MODEL_PATH}"
log "  Lotus/Zeekr Chunk Risk Model Path : ${LOTUS_ZEEKR_CHUNK_RISK_MODEL_PATH}"
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
        setup_label="ret${retrieve_top_k}_rer${rerank_top_k}_multi_role_chunkrisk_percentile_ctx_decomp"

        if is_truthy "${INCLUDE_DEFAULT_RUN}"; then
            run_experiment "${BENCH}" "${run_num}" "${setup_label}_default_lambda" "" "" "${retrieve_top_k}" "${rerank_top_k}"
            run_num=$((run_num + 1))
        fi

        for agent in "${agents[@]}"; do
            for lambda_value in "${lambda_values[@]}"; do
                lambda_token="$(format_lambda_token "${lambda_value}")"
                run_experiment "${BENCH}" "${run_num}" "${setup_label}_${agent}_lambda_${lambda_token}" "${agent}" "${lambda_value}" "${retrieve_top_k}" "${rerank_top_k}"
                run_num=$((run_num + 1))
            done
        done
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
