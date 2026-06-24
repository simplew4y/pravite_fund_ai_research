#!/usr/bin/env bash
set -euo pipefail

# Runs the three retrieval architecture groups:
#   1. baseline: existing FAISS + Title Summary + BM25 + Table + Reranker
#   2. replace_bm25: existing retrieval, but PageIndex replaces BM25
#   3. hybrid: existing retrieval plus PageIndex as an additional structural branch

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
EVAL_SCRIPT="${SCRIPT_DIR}/eval_retrieval.py"
PYTHON="${PYTHON:-/root/autodl-tmp/miniconda3/envs/lotusenv/bin/python}"
BASE_CONFIG="${BASE_CONFIG:-${PROJECT_ROOT}/config/production.yaml}"
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")

WORKERS="${WORKERS:-1}"
RETRIEVE_TOP_K="${RETRIEVE_TOP_K:-10}"
RERANK_TOP_K="${RERANK_TOP_K:-5}"
PAGEINDEX_TOP_K="${PAGEINDEX_TOP_K:-${RETRIEVE_TOP_K}}"
PAGEINDEX_NODE_TOP_K="${PAGEINDEX_NODE_TOP_K:-${PAGEINDEX_TOP_K}}"
PAGEINDEX_MAX_CHUNKS_PER_NODE="${PAGEINDEX_MAX_CHUNKS_PER_NODE:-3}"
PAGEINDEX_PAGE_WINDOW="${PAGEINDEX_PAGE_WINDOW:-0}"
PAGEINDEX_INCLUDE_NODE_SUMMARY="${PAGEINDEX_INCLUDE_NODE_SUMMARY:-0}"
PAGEINDEX_RECENCY_BOOST="${PAGEINDEX_RECENCY_BOOST:-}"
PAGEINDEX_FINAL_CAP="${PAGEINDEX_FINAL_CAP:-}"
PAGEINDEX_SCORE_MULTIPLIER="${PAGEINDEX_SCORE_MULTIPLIER:-}"
EVIDENCE_RESCUE="${EVIDENCE_RESCUE:-0}"
EVIDENCE_RESCUE_K="${EVIDENCE_RESCUE_K:-2}"
EVIDENCE_RESCUE_MIN_SCORE="${EVIDENCE_RESCUE_MIN_SCORE:-0.45}"
EVIDENCE_RESCUE_MIN_YEAR="${EVIDENCE_RESCUE_MIN_YEAR:-2024}"
ANSWER_SELF_CHECK="${ANSWER_SELF_CHECK:-0}"
ANSWER_SELF_CHECK_MAX_CHARS="${ANSWER_SELF_CHECK_MAX_CHARS:-12000}"
USE_MULTI_ROLE="${USE_MULTI_ROLE:-1}"
ENABLE_CTX_DECOMP="${ENABLE_CTX_DECOMP:-0}"
BENCHMARKS="${BENCHMARKS:-lotus financebench finder}"

BENCH_lotus_PERSIST="${BENCH_lotus_PERSIST:-/root/autodl-tmp/RAG_Agent_data/lotus/20250701/database_lotus}"
BENCH_lotus_GT="${BENCH_lotus_GT:-${SCRIPT_DIR}/../gt/lotus_colm_109_gt.json}"
BENCH_lotus_COLLECTION="${BENCH_lotus_COLLECTION:-lotus}"

BENCH_zeekr_PERSIST="${BENCH_zeekr_PERSIST:-/root/autodl-tmp/RAG_Agent_data/Zeekr/20250729/database_zeekr}"
BENCH_zeekr_GT="${BENCH_zeekr_GT:-${SCRIPT_DIR}/../gt/zeekr_colm_136_gt.json}"
BENCH_zeekr_COLLECTION="${BENCH_zeekr_COLLECTION:-zeekr}"

BENCH_financebench_PERSIST="${BENCH_financebench_PERSIST:-/root/autodl-tmp/RAG_Agent_data/finance_bench/database_financebench}"
BENCH_financebench_GT="${BENCH_financebench_GT:-${SCRIPT_DIR}/../gt/financebench_145_gt.json}"
BENCH_financebench_COLLECTION="${BENCH_financebench_COLLECTION:-financebench}"

BENCH_finder_PERSIST="${BENCH_finder_PERSIST:-/root/autodl-tmp/RAG_Agent_data/finder/database_finder}"
BENCH_finder_GT="${BENCH_finder_GT:-${SCRIPT_DIR}/../gt/finder_sampled_71_gt.json}"
BENCH_finder_COLLECTION="${BENCH_finder_COLLECTION:-finder}"

BENCH_nvidia_PERSIST="${BENCH_nvidia_PERSIST:-/root/autodl-tmp/RAG_Agent_data/nvidia/20260425/5_database_nvidia}"
BENCH_nvidia_GT="${BENCH_nvidia_GT:-/root/autodl-tmp/RAG_Agent_data/nvidia/gt/nvidia_sec_questions_30_2025.json}"
BENCH_nvidia_COLLECTION="${BENCH_nvidia_COLLECTION:-nvidia}"

if [ -n "${PAGEINDEX_ROOT:-}" ]; then
    BENCH_lotus_PAGEINDEX="${BENCH_lotus_PAGEINDEX:-${PAGEINDEX_ROOT}/lotus}"
    BENCH_zeekr_PAGEINDEX="${BENCH_zeekr_PAGEINDEX:-${PAGEINDEX_ROOT}/zeekr}"
    BENCH_financebench_PAGEINDEX="${BENCH_financebench_PAGEINDEX:-${PAGEINDEX_ROOT}/financebench}"
    BENCH_finder_PAGEINDEX="${BENCH_finder_PAGEINDEX:-${PAGEINDEX_ROOT}/finder}"
    BENCH_nvidia_PAGEINDEX="${BENCH_nvidia_PAGEINDEX:-${PAGEINDEX_ROOT}/nvidia}"
else
    BENCH_lotus_PAGEINDEX="${BENCH_lotus_PAGEINDEX:-${BENCH_lotus_PERSIST}/pageindex}"
    BENCH_zeekr_PAGEINDEX="${BENCH_zeekr_PAGEINDEX:-${BENCH_zeekr_PERSIST}/pageindex}"
    BENCH_financebench_PAGEINDEX="${BENCH_financebench_PAGEINDEX:-${BENCH_financebench_PERSIST}/pageindex}"
    BENCH_finder_PAGEINDEX="${BENCH_finder_PAGEINDEX:-${BENCH_finder_PERSIST}/pageindex}"
    BENCH_nvidia_PAGEINDEX="${BENCH_nvidia_PAGEINDEX:-${BENCH_nvidia_PERSIST}/pageindex}"
fi

EXPERIMENT_DIR="${EXPERIMENT_DIR:-${SCRIPT_DIR}/experiment_pageindex_${TIMESTAMP}}"
mkdir -p "${EXPERIMENT_DIR}"
LOG_FILE="${EXPERIMENT_DIR}/pageindex_ablation.log"

SEP="$(printf '=%.0s' {1..70})"
THIN_SEP="$(printf -- '-%.0s' {1..70})"

log() {
    echo "$1" | tee -a "${LOG_FILE}"
}

COMMON_ARGS=()
if [ "${USE_MULTI_ROLE}" = "1" ]; then
    COMMON_ARGS+=(--use_multi_role)
else
    COMMON_ARGS+=(--no-use_multi_role)
fi

if [ "${ENABLE_CTX_DECOMP}" = "1" ]; then
    COMMON_ARGS+=(--enable_ctx_decomp)
else
    COMMON_ARGS+=(--no-enable_ctx_decomp)
fi

if [ "${ANSWER_SELF_CHECK}" = "1" ]; then
    COMMON_ARGS+=(--answer_self_check_enabled)
else
    COMMON_ARGS+=(--no-answer_self_check_enabled)
fi
COMMON_ARGS+=(--answer_self_check_max_chars "${ANSWER_SELF_CHECK_MAX_CHARS}")

if [ "${EVIDENCE_RESCUE}" = "1" ]; then
    COMMON_ARGS+=(--evidence_rescue_enabled)
else
    COMMON_ARGS+=(--no-evidence_rescue_enabled)
fi
COMMON_ARGS+=(
    --evidence_rescue_k "${EVIDENCE_RESCUE_K}"
    --evidence_rescue_min_score "${EVIDENCE_RESCUE_MIN_SCORE}"
    --evidence_rescue_min_year "${EVIDENCE_RESCUE_MIN_YEAR}"
)

run_experiment() {
    local bench="$1"
    local run_num="$2"
    local run_name="$3"
    local pageindex_mode="$4"

    local persist_var="BENCH_${bench}_PERSIST"
    local gt_var="BENCH_${bench}_GT"
    local coll_var="BENCH_${bench}_COLLECTION"
    local pi_var="BENCH_${bench}_PAGEINDEX"
    local persist="${!persist_var}"
    local gt="${!gt_var}"
    local collection="${!coll_var}"
    local pageindex_dir="${!pi_var}"
    local full_run_name="${bench}_run${run_num}_${run_name}"

    local cmd=(
        "${PYTHON}" "${EVAL_SCRIPT}"
        --config_path "${BASE_CONFIG}"
        --gt_path "${gt}"
        --persist_directory "${persist}"
        --collection_name "${collection}"
        --output_dir "${EXPERIMENT_DIR}"
        --run_name "${full_run_name}"
        --workers "${WORKERS}"
        --retrieve_top_k "${RETRIEVE_TOP_K}"
        --rerank_top_k "${RERANK_TOP_K}"
        --stop_after_retrieval
        --pageindex_mode "${pageindex_mode}"
        "${COMMON_ARGS[@]}"
    )

    if [ "${pageindex_mode}" != "off" ]; then
        if [ ! -d "${pageindex_dir}" ] && [ ! -f "${pageindex_dir}" ]; then
            log "ERROR: PageIndex index not found for ${bench}: ${pageindex_dir}"
            log "Build it first with data_pipeline/build_pageindex_index.py or override BENCH_${bench}_PAGEINDEX."
            return 1
        fi
        cmd+=(
            --pageindex_index_dir "${pageindex_dir}"
            --pageindex_top_k "${PAGEINDEX_TOP_K}"
            --pageindex_node_top_k "${PAGEINDEX_NODE_TOP_K}"
            --pageindex_max_chunks_per_node "${PAGEINDEX_MAX_CHUNKS_PER_NODE}"
            --pageindex_page_window "${PAGEINDEX_PAGE_WINDOW}"
        )
        if [ "${PAGEINDEX_INCLUDE_NODE_SUMMARY}" = "1" ]; then
            cmd+=(--pageindex_include_node_summary)
        else
            cmd+=(--no-pageindex_include_node_summary)
        fi
        if [ -n "${PAGEINDEX_RECENCY_BOOST}" ]; then
            cmd+=(--pageindex_recency_boost "${PAGEINDEX_RECENCY_BOOST}")
        fi
        if [ -n "${PAGEINDEX_FINAL_CAP}" ]; then
            cmd+=(--pageindex_final_cap "${PAGEINDEX_FINAL_CAP}")
        fi
        if [ -n "${PAGEINDEX_SCORE_MULTIPLIER}" ]; then
            cmd+=(--pageindex_score_multiplier "${PAGEINDEX_SCORE_MULTIPLIER}")
        fi
    fi

    log ""
    log "${SEP}"
    log "  [${bench}] RUN ${run_num}: ${run_name}"
    log "${SEP}"
    log "  Persist Dir    : ${persist}"
    log "  GT File        : ${gt}"
    log "  Collection     : ${collection}"
    log "  PageIndex Mode : ${pageindex_mode}"
    log "  PageIndex Dir  : ${pageindex_dir}"
    log "  Workers        : ${WORKERS}"
    log "  Args           : ${cmd[*]}"
    log "${THIN_SEP}"

    "${cmd[@]}" 2>&1 | tee -a "${LOG_FILE}"

    log "${THIN_SEP}"
    log "  [${bench}] RUN ${run_num} COMPLETE"
    log "${SEP}"
}

log "${SEP}"
log "  PAGEINDEX RETRIEVAL ARCHITECTURE STUDY - ${TIMESTAMP}"
log "  Experiment Dir : ${EXPERIMENT_DIR}"
log "  Benchmarks     : ${BENCHMARKS}"
log "  Retrieve TopK  : ${RETRIEVE_TOP_K}"
log "  Rerank TopK    : ${RERANK_TOP_K}"
log "  PageIndex TopK : ${PAGEINDEX_TOP_K}"
log "  PI Node Summary: ${PAGEINDEX_INCLUDE_NODE_SUMMARY}"
log "  PI RecencyBoost: ${PAGEINDEX_RECENCY_BOOST:-0.0}"
log "  PageIndex Cap  : ${PAGEINDEX_FINAL_CAP:-none}"
log "  PI Score Mult  : ${PAGEINDEX_SCORE_MULTIPLIER:-1.0}"
log "  Answer Check   : ${ANSWER_SELF_CHECK}"
log "  Use Multi-role : ${USE_MULTI_ROLE}"
log "  Ctx Decomp     : ${ENABLE_CTX_DECOMP}"
log "${SEP}"

for BENCH in ${BENCHMARKS}; do
    log ""
    log "$(printf '#%.0s' {1..70})"
    log "  BENCHMARK: ${BENCH}"
    log "$(printf '#%.0s' {1..70})"

    run_experiment "${BENCH}" 1 "baseline" "off"
    run_experiment "${BENCH}" 2 "pageindex_replace_bm25" "replace_bm25"
    run_experiment "${BENCH}" 3 "pageindex_hybrid" "hybrid"
done

log ""
log "${SEP}"
log "  ALL PAGEINDEX RUNS COMPLETE"
log "  Experiment Dir      : ${EXPERIMENT_DIR}"
log "  Comparative Metrics : ${EXPERIMENT_DIR}/_metrics.json"
log "  Full Log            : ${LOG_FILE}"
log "${SEP}"
