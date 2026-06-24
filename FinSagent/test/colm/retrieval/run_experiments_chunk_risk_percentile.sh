#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
EVAL_SCRIPT="${SCRIPT_DIR}/eval_retrieval.py"
PYTHON="${PYTHON:-/root/autodl-tmp/miniconda3/envs/lotusenv/bin/python}"
BASE_CONFIG="${BASE_CONFIG:-${PROJECT_ROOT}/config/production.yaml}"
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
WORKERS="${WORKERS:-1}"
PRERUN_DIR="${PRERUN_DIR:-}"

# DEFAULT_CHUNK_RISK_MODEL_PATH="${DEFAULT_CHUNK_RISK_MODEL_PATH:-/root/autodl-tmp/cjj/FinSagent_0212/lightgbm/outputs_ff_reduced_binary/artifacts/model.pkl}"
# LOTUS_ZEEKR_CHUNK_RISK_MODEL_PATH="${LOTUS_ZEEKR_CHUNK_RISK_MODEL_PATH:-/root/autodl-tmp/cjj/FinSagent_0212/lightgbm/outputs_reduced_46804_binary/artifacts/model.pkl}"

DEFAULT_CHUNK_RISK_MODEL_PATH="${DEFAULT_CHUNK_RISK_MODEL_PATH:-/root/autodl-tmp/cjj/FinSagent_0212/lightgbm/outputs_reduced_13788_no_balance_binary/artifacts/model.pkl}"
LOTUS_ZEEKR_CHUNK_RISK_MODEL_PATH="${LOTUS_ZEEKR_CHUNK_RISK_MODEL_PATH:-/root/autodl-tmp/cjj/FinSagent_0212/lightgbm/outputs_reduced_13788_no_balance_binary/artifacts/model.pkl}"

# CHUNK_RISK_PENALTY_MODE="${CHUNK_RISK_PENALTY_MODE:-percentile_rank}"
# CHUNK_RISK_LAMBDA="${CHUNK_RISK_LAMBDA:-0.2}"

BENCH_lotus_PERSIST="${BENCH_lotus_PERSIST:-/root/autodl-tmp/RAG_Agent_data/lotus/20250701/database_lotus}"
BENCH_lotus_GT="${BENCH_lotus_GT:-${SCRIPT_DIR}/../gt/lotus_108_dedup_gt.json}"
BENCH_lotus_COLLECTION="${BENCH_lotus_COLLECTION:-lotus}"
BENCH_lotus_PRERUN_JSONL="${BENCH_lotus_PRERUN_JSONL:-}"
BENCH_lotus_TABLE_LOOKUP_JSONL="${BENCH_lotus_TABLE_LOOKUP_JSONL:-}"

BENCH_zeekr_PERSIST="${BENCH_zeekr_PERSIST:-/root/autodl-tmp/RAG_Agent_data/Zeekr/20250729/database_zeekr}"
BENCH_zeekr_GT="${BENCH_zeekr_GT:-${SCRIPT_DIR}/../gt/zeekr_134_dedup_gt.json}"
BENCH_zeekr_COLLECTION="${BENCH_zeekr_COLLECTION:-zeekr}"
BENCH_zeekr_PRERUN_JSONL="${BENCH_zeekr_PRERUN_JSONL:-}"
BENCH_zeekr_TABLE_LOOKUP_JSONL="${BENCH_zeekr_TABLE_LOOKUP_JSONL:-}"

BENCH_financebench_PERSIST="${BENCH_financebench_PERSIST:-/root/autodl-tmp/RAG_Agent_data/finance_bench/database_financebench}"
BENCH_financebench_GT="${BENCH_financebench_GT:-${SCRIPT_DIR}/../gt/financebench_145_gt.json}"
BENCH_financebench_COLLECTION="${BENCH_financebench_COLLECTION:-financebench}"
BENCH_financebench_PRERUN_JSONL="${BENCH_financebench_PRERUN_JSONL:-}"
BENCH_financebench_TABLE_LOOKUP_JSONL="${BENCH_financebench_TABLE_LOOKUP_JSONL:-/root/autodl-tmp/cjj/FinSagent_0212/test/e2e/0322_force_general_lightgbm_new_calibrate_ts10/financebench_run2_ret10_rer5_multi_role.jsonl}"

BENCH_finder_PERSIST="${BENCH_finder_PERSIST:-/root/autodl-tmp/RAG_Agent_data/finder/database_finder}"
BENCH_finder_GT="${BENCH_finder_GT:-${SCRIPT_DIR}/../gt/finder_sampled_71_gt.json}"
BENCH_finder_COLLECTION="${BENCH_finder_COLLECTION:-finder}"
BENCH_finder_PRERUN_JSONL="${BENCH_finder_PRERUN_JSONL:-}"
BENCH_finder_TABLE_LOOKUP_JSONL="${BENCH_finder_TABLE_LOOKUP_JSONL:-}"

BENCH_secque_PERSIST="${BENCH_secque_PERSIST:-/root/autodl-tmp/RAG_Agent_data/secque/database_secque}"
BENCH_secque_GT="${BENCH_secque_GT:-${PROJECT_ROOT}/test/gt/secque_sample_100_retrieval_gt.json}"
BENCH_secque_COLLECTION="${BENCH_secque_COLLECTION:-secque}"
BENCH_secque_PRERUN_JSONL="${BENCH_secque_PRERUN_JSONL:-}"
BENCH_secque_TABLE_LOOKUP_JSONL="${BENCH_secque_TABLE_LOOKUP_JSONL:-}"

BENCHMARKS="${BENCHMARKS:-lotus financebench finder zeekr secque}"
RETRIEVE_TOPKS="${RETRIEVE_TOPKS:-10}"
RERANK_TOPKS="${RERANK_TOPKS:-5}"

SEP="$(printf '=%.0s' {1..70})"
THIN_SEP="$(printf -- '-%.0s' {1..70})"

EXPERIMENT_DIR="${EXPERIMENT_DIR:-${SCRIPT_DIR}/experiment_chunk_risk_percentile_${TIMESTAMP}}"
mkdir -p "${EXPERIMENT_DIR}"

LOG_FILE="${EXPERIMENT_DIR}/ablation.log"

log() {
    echo "$1" | tee -a "${LOG_FILE}"
}

run_experiment() {
    local bench="$1"
    local run_num="$2"
    local run_name="$3"
    local prerun_strategy="$4"
    local prerun_source_run_name="$5"
    shift 5
    local extra_args=("$@")

    local persist_var="BENCH_${bench}_PERSIST"
    local gt_var="BENCH_${bench}_GT"
    local coll_var="BENCH_${bench}_COLLECTION"
    local prerun_var="BENCH_${bench}_PRERUN_JSONL"
    local table_lookup_var="BENCH_${bench}_TABLE_LOOKUP_JSONL"
    local persist="${!persist_var}"
    local gt="${!gt_var}"
    local collection="${!coll_var}"
    local prerun_jsonl=""
    local table_lookup_jsonl="${!table_lookup_var}"
    local full_run_name="${bench}_run${run_num}_${run_name}"
    local cmd_extra_args=("${extra_args[@]}")
    local chunk_risk_model_path="${DEFAULT_CHUNK_RISK_MODEL_PATH}"

    if [ "${bench}" = "lotus" ] || [ "${bench}" = "zeekr" ]; then
        chunk_risk_model_path="${LOTUS_ZEEKR_CHUNK_RISK_MODEL_PATH}"
    fi

    case "${prerun_strategy}" in
        default)
            prerun_jsonl="${!prerun_var}"
            if [ -z "${prerun_jsonl}" ] && [ -n "${PRERUN_DIR}" ]; then
                prerun_jsonl="${PRERUN_DIR}/${bench}.jsonl"
            fi
            ;;
        none)
            prerun_jsonl=""
            ;;
        from_run)
            local prerun_base_dir="${PRERUN_DIR:-${EXPERIMENT_DIR}}"
            prerun_jsonl="${prerun_base_dir}/${prerun_source_run_name}.jsonl"
            ;;
        *)
            echo "Unsupported prerun strategy: ${prerun_strategy}" >&2
            exit 1
            ;;
    esac

    # if [ -n "${prerun_jsonl}" ]; then
    #     cmd_extra_args+=(--pre_run_jsonl "${prerun_jsonl}")
    # fi

    if [ -n "${table_lookup_jsonl}" ]; then
        cmd_extra_args+=(--table_lookup_jsonl "${table_lookup_jsonl}")
    fi

    log ""
    log "${SEP}"
    log "  [${bench}] RUN ${run_num}: ${run_name}"
    log "${SEP}"
    log "  Persist Dir           : ${persist}"
    log "  GT File               : ${gt}"
    log "  Collection            : ${collection}"
    log "  Chunk Risk Model Path : ${chunk_risk_model_path}"
    # log "  Chunk Risk Mode       : ${CHUNK_RISK_PENALTY_MODE}"
    # log "  Chunk Risk Lambda     : ${CHUNK_RISK_LAMBDA}"
    log "  Pre-run JSONL         : ${prerun_jsonl:-N/A}"
    log "  Table Lookup JSONL    : ${table_lookup_jsonl:-N/A}"
    log "  Workers               : ${WORKERS}"
    log "  Config Path           : ${BASE_CONFIG}"
    log "  Args: ${cmd_extra_args[*]}"
    log "${THIN_SEP}"

    "${PYTHON}" "${EVAL_SCRIPT}" \
        --gt_path "${gt}" \
        --persist_directory "${persist}" \
        --collection_name "${collection}" \
        --output_dir "${EXPERIMENT_DIR}" \
        --run_name "${full_run_name}" \
        --workers "${WORKERS}" \
        --config_path "${BASE_CONFIG}" \
        --bayesian_type rerank \
        --chunk_risk_model_path "${chunk_risk_model_path}" \
        --chunk_risk_penalty_mode percentile_rank \
        "${cmd_extra_args[@]}" \
        2>&1 | tee -a "${LOG_FILE}"
        # --stop_after_retrieval \
        # --chunk_risk_lambda "${CHUNK_RISK_LAMBDA}" \

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
log "  CHUNK-RISK PERCENTILE-RANK STUDY  –  ${TIMESTAMP}"
log "  Experiment Dir        : ${EXPERIMENT_DIR}"
log "  Base Config           : ${BASE_CONFIG}"
log "  Benchmarks            : ${BENCHMARKS}"
log "  Retrieve TopKs        : ${RETRIEVE_TOPKS}"
log "  Rerank TopKs          : ${RERANK_TOPKS}"
log "  Workers               : ${WORKERS}"
log "  Default Chunk Risk Model Path     : ${DEFAULT_CHUNK_RISK_MODEL_PATH}"
log "  Lotus/Zeekr Chunk Risk Model Path : ${LOTUS_ZEEKR_CHUNK_RISK_MODEL_PATH}"
# log "  Chunk Risk Mode       : ${CHUNK_RISK_PENALTY_MODE}"
# log "  Chunk Risk Lambda     : ${CHUNK_RISK_LAMBDA}"
log "  PRERUN_DIR            : ${PRERUN_DIR:-N/A}"
log "${SEP}"

for BENCH in ${BENCHMARKS}; do
    log ""
    log "$(printf '#%.0s' {1..70})"
    log "  BENCHMARK: ${BENCH}"
    log "$(printf '#%.0s' {1..70})"

    run_num=1

    case "${BENCH}" in
        lotus)
            baseline_retrieve_top_k=15
            baseline_rerank_top_k=27
            ;;
        zeekr)
            baseline_retrieve_top_k=20
            baseline_rerank_top_k=37
            ;;
        financebench)
            baseline_retrieve_top_k=10
            baseline_rerank_top_k=15
            ;;
        finder)
            baseline_retrieve_top_k=10
            baseline_rerank_top_k=20
            ;;
        *)
            baseline_retrieve_top_k=10
            baseline_rerank_top_k=20
            ;;
    esac


    for idx in "${!retrieve_topks[@]}"; do
        retrieve_top_k="${retrieve_topks[idx]}"
        rerank_top_k="${rerank_topks[idx]}"
        setup_label="ret${retrieve_top_k}_rer${rerank_top_k}"

        run_experiment "${BENCH}" "${run_num}" "${setup_label}_baseline" none "" \
            --no-use_multi_role \
            --rerank_top_k "${baseline_rerank_top_k}" \
            --retrieve_top_k "${baseline_retrieve_top_k}"
        run_num=$((run_num + 1))

        multi_role_run_num="${run_num}"
        multi_role_run_name="${BENCH}_run${multi_role_run_num}_${setup_label}_multi_role"

        run_experiment "${BENCH}" "${run_num}" "${setup_label}_multi_role" none "" \
            --use_multi_role \
            --rerank_top_k "${rerank_top_k}" \
            --retrieve_top_k "${retrieve_top_k}"
        run_num=$((run_num + 1))

        run_experiment "${BENCH}" "${run_num}" "${setup_label}_multi_role_chunkrisk_percentile" from_run "${multi_role_run_name}" \
            --use_multi_role \
            --use_chunk_risk_calibration \
            --rerank_top_k "${rerank_top_k}" \
            --retrieve_top_k "${retrieve_top_k}"
        run_num=$((run_num + 1))

        ctx_decomp_run_num="${run_num}"
        ctx_decomp_run_name="${BENCH}_run${ctx_decomp_run_num}_${setup_label}_multi_role_ctx_decomp"

        run_experiment "${BENCH}" "${run_num}" "${setup_label}_multi_role_ctx_decomp" none "" \
            --use_multi_role \
            --enable_ctx_decomp \
            --rerank_top_k "${rerank_top_k}" \
            --retrieve_top_k "${retrieve_top_k}"
        run_num=$((run_num + 1))
        
        run_experiment "${BENCH}" "${run_num}" "${setup_label}_multi_role_chunkrisk_percentile_ctx_decomp" from_run "${ctx_decomp_run_name}" \
            --use_multi_role \
            --enable_ctx_decomp \
            --use_chunk_risk_calibration \
            --rerank_top_k "${rerank_top_k}" \
            --retrieve_top_k "${retrieve_top_k}"
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
