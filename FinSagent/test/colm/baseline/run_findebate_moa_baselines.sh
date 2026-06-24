#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
PYTHON="${PYTHON:-/root/autodl-tmp/miniconda3/envs/lotusenv/bin/python}"
BASE_CONFIG="${BASE_CONFIG:-${PROJECT_ROOT}/config/production.yaml}"
TIMESTAMP="$(date +"%Y%m%d_%H%M%S")"

BENCHMARKS="${BENCHMARKS:-lotus financebench finder zeekr}"

BENCH_lotus_PERSIST="${BENCH_lotus_PERSIST:-/root/autodl-tmp/RAG_Agent_data/lotus/20250701/database_lotus}"
BENCH_lotus_GT="${BENCH_lotus_GT:-${SCRIPT_DIR}/../gt/lotus_108_dedup_gt.json}"
BENCH_lotus_COLLECTION="${BENCH_lotus_COLLECTION:-lotus}"

BENCH_zeekr_PERSIST="${BENCH_zeekr_PERSIST:-/root/autodl-tmp/RAG_Agent_data/Zeekr/20250729/database_zeekr}"
BENCH_zeekr_GT="${BENCH_zeekr_GT:-${SCRIPT_DIR}/../gt/zeekr_134_dedup_gt.json}"
BENCH_zeekr_COLLECTION="${BENCH_zeekr_COLLECTION:-zeekr}"

BENCH_financebench_PERSIST="${BENCH_financebench_PERSIST:-/root/autodl-tmp/RAG_Agent_data/finance_bench/database_financebench}"
BENCH_financebench_GT="${BENCH_financebench_GT:-${SCRIPT_DIR}/../gt/financebench_145_gt.json}"
BENCH_financebench_COLLECTION="${BENCH_financebench_COLLECTION:-financebench}"

BENCH_finder_PERSIST="${BENCH_finder_PERSIST:-/root/autodl-tmp/RAG_Agent_data/finder/database_finder}"
BENCH_finder_GT="${BENCH_finder_GT:-${SCRIPT_DIR}/../gt/finder_sampled_71_gt.json}"
BENCH_finder_COLLECTION="${BENCH_finder_COLLECTION:-finder}"

BENCH_secque_PERSIST="${BENCH_secque_PERSIST:-/root/autodl-tmp/RAG_Agent_data/secque/database_secque}"
BENCH_secque_GT="${BENCH_secque_GT:-${PROJECT_ROOT}/test/gt/secque_sample_100_retrieval_gt.json}"
BENCH_secque_COLLECTION="${BENCH_secque_COLLECTION:-secque}"

TOPK="${TOPK:-10}"
RERANK_TOPK="${RERANK_TOPK:-5}"
WORKERS="${WORKERS:-8}"

FIND_SCRIPT="${SCRIPT_DIR}/findebate/findebate_batch_qa_test.py"
MOA_SCRIPT="${SCRIPT_DIR}/moa/moa_batch_qa_test.py"
EXPERIMENT_DIR="${EXPERIMENT_DIR:-${SCRIPT_DIR}/experiment_baselines_${TIMESTAMP}}"
mkdir -p "${EXPERIMENT_DIR}"
LOG_FILE="${EXPERIMENT_DIR}/run.log"

SEP="$(printf '=%.0s' {1..70})"
THIN_SEP="$(printf -- '-%.0s' {1..70})"

log() {
    echo "$1" | tee -a "${LOG_FILE}"
}

read -r -a DATASET_LIST <<< "${BENCHMARKS}"

if [ "${#DATASET_LIST[@]}" -eq 0 ]; then
    echo "No benchmarks specified. Set BENCHMARKS." >&2
    exit 1
fi

resolve_dataset_config() {
    local dataset_name="$1"

    case "${dataset_name}" in
        lotus|zeekr|financebench|finder|secque)
            ;;
        *)
            echo "Unsupported dataset: ${dataset_name}" >&2
            echo "Expected one of: lotus zeekr financebench finder secque" >&2
            exit 1
            ;;
    esac

    local persist_var="BENCH_${dataset_name}_PERSIST"
    local gt_var="BENCH_${dataset_name}_GT"
    local collection_var="BENCH_${dataset_name}_COLLECTION"

    RESOLVED_GT_PATH="${GT_PATH:-${!gt_var}}"
    RESOLVED_PERSIST_DIRECTORY="${PERSIST_DIRECTORY:-${!persist_var}}"
    RESOLVED_COLLECTION_NAME="${COLLECTION_NAME:-${!collection_var}}"
}

run_baseline() {
    local label="$1"
    local script_path="$2"
    local run_name="$3"
    local dataset_name="$4"
    local gt_path="$5"
    local persist_directory="$6"
    local collection_name="$7"

    log ""
    log "${SEP}"
    log "  RUNNING ${label}"
    log "${SEP}"
    log "  Dataset Name        : ${dataset_name}"
    log "  Script              : ${script_path}"
    log "  Run Name            : ${run_name}"
    log "  GT Path             : ${gt_path}"
    log "  Persist Directory   : ${persist_directory}"
    log "  Collection          : ${collection_name}"
    log "  TopK                : ${TOPK}"
    log "  Rerank TopK         : ${RERANK_TOPK}"
    log "  Workers             : ${WORKERS}"
    log "  Base Config         : ${BASE_CONFIG}"
    log "  Add-on Features     : bayesian=off, ctx_decomp=off, chunk_risk=off"
    log "${THIN_SEP}"

    EXPERIMENT_NAME="${run_name}" "${PYTHON}" "${script_path}" \
        --config "${BASE_CONFIG}" \
        --input "${gt_path}" \
        --output_dir "${EXPERIMENT_DIR}" \
        --run_name "${run_name}" \
        --persist_directory "${persist_directory}" \
        --collection_name "${collection_name}" \
        --topk "${TOPK}" \
        --rerank_topk "${RERANK_TOPK}" \
        --workers "${WORKERS}" \
        2>&1 | tee -a "${LOG_FILE}"

    log "${THIN_SEP}"
    log "  COMPLETED ${label}"
    log "${SEP}"
}

log "${SEP}"
log "  MOA + FINDEBATE BASELINE RUNNER"
log "  Experiment Dir      : ${EXPERIMENT_DIR}"
log "  Benchmarks          : ${BENCHMARKS}"
log "  TopK                : ${TOPK}"
log "  Rerank TopK         : ${RERANK_TOPK}"
log "  Workers             : ${WORKERS}"
log "  Base Config         : ${BASE_CONFIG}"
log "  Add-on Features     : bayesian=off, ctx_decomp=off, chunk_risk=off"
log "${SEP}"

for dataset_name in "${DATASET_LIST[@]}"; do
    resolve_dataset_config "${dataset_name}"

    log ""
    log "$(printf '#%.0s' {1..70})"
    log "  DATASET: ${dataset_name}"
    log "  GT Path             : ${RESOLVED_GT_PATH}"
    log "  Persist Directory   : ${RESOLVED_PERSIST_DIRECTORY}"
    log "  Collection          : ${RESOLVED_COLLECTION_NAME}"
    log "$(printf '#%.0s' {1..70})"

    run_baseline \
        "FinDebate Baseline" \
        "${FIND_SCRIPT}" \
        "${dataset_name}_findebate_baseline" \
        "${dataset_name}" \
        "${RESOLVED_GT_PATH}" \
        "${RESOLVED_PERSIST_DIRECTORY}" \
        "${RESOLVED_COLLECTION_NAME}"

    run_baseline \
        "MoA Baseline" \
        "${MOA_SCRIPT}" \
        "${dataset_name}_moa_baseline" \
        "${dataset_name}" \
        "${RESOLVED_GT_PATH}" \
        "${RESOLVED_PERSIST_DIRECTORY}" \
        "${RESOLVED_COLLECTION_NAME}"
done

log ""
log "${SEP}"
log "  ALL RUNS COMPLETE"
log "  Experiment Dir      : ${EXPERIMENT_DIR}"
log "  Metrics File        : ${EXPERIMENT_DIR}/_metrics.json"
log "  Log File            : ${LOG_FILE}"
log "  Example JSONL       : ${EXPERIMENT_DIR}/zeekr_findebate_baseline.jsonl"
log "  Example JSON        : ${EXPERIMENT_DIR}/zeekr_findebate_baseline.json"
log "${SEP}"
