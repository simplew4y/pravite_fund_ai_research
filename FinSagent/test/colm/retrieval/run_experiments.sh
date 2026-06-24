#!/usr/bin/env bash
# ===========================================================================
# Incremental ablation study for retrieval evaluation.
#
# Supports 4 benchmarks: lotus, zeekr, financebench, finder
# Each benchmark has its own persist_directory and GT file.
#
# Features:
#   - Concurrent evaluation via WORKERS env var (default: 1)
#   - Stop & resume: set EXPERIMENT_DIR to a previous run's directory and
#     re-run; already-completed questions are skipped automatically.
# 
# Usage:
# Run with 4 concurrent workers
# WORKERS=4 bash test/colm/retrieval/run_experiments.sh
#
# Resume a previous interrupted run
# EXPERIMENT_DIR=test/colm/retrieval/experiment_20260314_111000 bash test/colm/retrieval/run_experiments.sh
#
# Single benchmark, 8 workers
# WORKERS=8 BENCHMARKS="lotus zeekr" bash test/colm/retrieval/run_experiments.sh
#
# Run 1 (Baseline) : general agent only, all features off, default top_k
# Run 2            : + multi-role agent routing
# Run 3            : + query decomposition (title-summary)
# Run 4            : + Bayesian RAG
# Run 5            : + memory (shared session across questions)
# Run 6            : all features
# ===========================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EVAL_SCRIPT="${SCRIPT_DIR}/eval_retrieval.py"
PYTHON="${PYTHON:-/root/autodl-tmp/miniconda3/envs/lotusenv/bin/python}"
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")

# Number of concurrent workers (override with WORKERS env var)
WORKERS="${WORKERS:-1}"

# ── Benchmark registry ────────────────────────────────────────────────────
# Format: BENCH_<name>_PERSIST, BENCH_<name>_GT, BENCH_<name>_COLLECTION
# Override any of these with environment variables before running.

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

# Which benchmarks to run (space-separated). Override with BENCHMARKS env var.
# NOTE: zeekr GT currently has no 'content' field – it will yield 0 valid entries.
BENCHMARKS="${BENCHMARKS:-lotus financebench finder}"

DEFAULT_TOP_K=5

SEP="$(printf '=%.0s' {1..70})"
THIN_SEP="$(printf -- '-%.0s' {1..70})"

# All outputs for this experiment session live under one directory.
# To RESUME a previous run, set EXPERIMENT_DIR to that run's directory.
EXPERIMENT_DIR="${EXPERIMENT_DIR:-${SCRIPT_DIR}/experiment_${TIMESTAMP}}"
mkdir -p "${EXPERIMENT_DIR}"

LOG_FILE="${EXPERIMENT_DIR}/ablation.log"

log() {
    echo "$1" | tee -a "${LOG_FILE}"
}

run_experiment() {
    local bench="$1"
    local run_num="$2"
    local run_name="$3"
    shift 3
    local extra_args=("$@")

    # Resolve benchmark-specific variables via indirect expansion
    local persist_var="BENCH_${bench}_PERSIST"
    local gt_var="BENCH_${bench}_GT"
    local coll_var="BENCH_${bench}_COLLECTION"
    local persist="${!persist_var}"
    local gt="${!gt_var}"
    local collection="${!coll_var}"

    local full_run_name="${bench}_run${run_num}_${run_name}"

    log ""
    log "${SEP}"
    log "  [${bench}] RUN ${run_num}: ${run_name}"
    log "${SEP}"
    log "  Persist Dir  : ${persist}"
    log "  GT File      : ${gt}"
    log "  Collection   : ${collection}"
    log "  Workers      : ${WORKERS}"
    log "  Args: ${extra_args[*]}"
    log "${THIN_SEP}"

    "${PYTHON}" "${EVAL_SCRIPT}" \
        --gt_path "${gt}" \
        --persist_directory "${persist}" \
        --collection_name "${collection}" \
        --output_dir "${EXPERIMENT_DIR}" \
        --run_name "${full_run_name}" \
        --workers "${WORKERS}" \
        --stop_after_retrieval \
        "${extra_args[@]}" \
        2>&1 | tee -a "${LOG_FILE}"

    log "${THIN_SEP}"
    log "  [${bench}] RUN ${run_num} COMPLETE"
    log "${SEP}"
}

# ==== Header =========================================================
log "${SEP}"
log "  RETRIEVAL ABLATION STUDY  –  ${TIMESTAMP}"
log "  Experiment Dir : ${EXPERIMENT_DIR}"
log "  Benchmarks     : ${BENCHMARKS}"
log "  Workers        : ${WORKERS}"
log "${SEP}"

for BENCH in ${BENCHMARKS}; do
    log ""
    log "$(printf '#%.0s' {1..70})"
    log "  BENCHMARK: ${BENCH}"
    log "$(printf '#%.0s' {1..70})"

    # ==== Run 1: Baseline =============================================
    run_experiment "${BENCH}" 1 "baseline" \
        --top_k_chunks "${DEFAULT_TOP_K}"

    # ==== Run 2: + Multi-role =========================================
    run_experiment "${BENCH}" 2 "multi_role" \
        --use_multi_role \
        --top_k_chunks "${DEFAULT_TOP_K}"

    # ==== Run 3: + Query decomposition ================================
    run_experiment "${BENCH}" 3 "multi_role_decomp" \
        --use_multi_role \
        --enable_query_decomp \
        --top_k_chunks "${DEFAULT_TOP_K}"

    # ==== Run 4: Baseline + Multi-role + Bayesian RAG =======================================
    run_experiment "${BENCH}" 4 "multi_role_bayesian" \
        --use_multi_role \
        --use_bayesian_rag \
        --top_k_chunks "${DEFAULT_TOP_K}"

    # ==== Run 5: + Memory (shared session across questions) ===========
    # run_experiment "${BENCH}" 5 "multi_role_decomp_bayesian_memory" \
    #     --use_multi_role \
    #     --enable_query_decomp \
    #     --use_bayesian_rag \
    #     --enable_memory \
    #     --top_k_chunks "${DEFAULT_TOP_K}"

    # ==== Run 6: All features ==========================
    run_experiment "${BENCH}" 6 "all_features" \
        --use_multi_role \
        --enable_query_decomp \
        --use_bayesian_rag \
        --top_k_chunks "${DEFAULT_TOP_K}"
done

# ==== Footer =========================================================
log ""
log "${SEP}"
log "  ALL RUNS COMPLETE"
log "  Experiment Dir      : ${EXPERIMENT_DIR}"
log "  Comparative Metrics : ${EXPERIMENT_DIR}/_metrics.json"
log "  Full Log            : ${LOG_FILE}"
log "  To resume: EXPERIMENT_DIR=${EXPERIMENT_DIR} bash $0"
log "${SEP}"
