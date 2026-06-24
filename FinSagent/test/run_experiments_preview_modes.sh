#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
EVAL_SCRIPT="${PROJECT_ROOT}/test/eval_preview_modes.py"
PYTHON="${PYTHON:-/root/autodl-tmp/miniconda3/envs/lotusenv/bin/python}"
BASE_CONFIG="${BASE_CONFIG:-${PROJECT_ROOT}/config/config_nvidia_0425.yaml}"
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
WORKERS="${WORKERS:-1}"

# Benchmark configurations - only zeekr run4 as requested (multi-role + ctx decomp)
BENCH_zeekr_PERSIST="${BENCH_zeekr_PERSIST:-/root/autodl-tmp/RAG_Agent_data/Zeekr/20250729/database_zeekr}"
BENCH_zeekr_GT="${BENCH_zeekr_GT:-${PROJECT_ROOT}/test/gt/zeekr_134_dedup_gt.json}"
BENCH_zeekr_COLLECTION="${BENCH_zeekr_COLLECTION:-zeekr}"

BENCH_nvidia_PERSIST="${BENCH_nvidia_PERSIST:-/root/autodl-tmp/RAG_Agent_data/nvidia/20260425/5_database_nvidia}"
BENCH_nvidia_GT="${BENCH_nvidia_GT:-/root/autodl-tmp/RAG_Agent_data/nvidia/gt/nvidia_sec_questions_30_2025.json}"
BENCH_nvidia_COLLECTION="${BENCH_nvidia_COLLECTION:-nvidia}"

BENCH="nvidia"
run_num=4


# Configuration for run4: multi-role + ctx decomp
RETRIEVE_TOP_K=10
RERANK_TOP_K=5
USE_MULTI_ROLE=true
ENABLE_CTX_DECOMP=true
USE_CHUNK_RISK_CALIBRATION=false
# false for gt without pos/neg chunks
IDENTIFY_EVIDENCE=false 

SEP="$(printf '=%.0s' {1..70})"
THIN_SEP="$(printf -- '-%.0s' {1..70})"

EXPERIMENT_DIR="${EXPERIMENT_DIR:-${SCRIPT_DIR}/experiment_preview_modes_${TIMESTAMP}}"
mkdir -p "${EXPERIMENT_DIR}"

LOG_FILE="${EXPERIMENT_DIR}/preview_modes.log"

log() {
    echo "$1" | tee -a "${LOG_FILE}"
}

run_experiment() {
    local bench="$1"
    local run_num="$2"
    local mode="$3"  # preview or non_preview
    
    local persist_var="BENCH_${bench}_PERSIST"
    local gt_var="BENCH_${bench}_GT"
    local coll_var="BENCH_${bench}_COLLECTION"
    local persist="${!persist_var}"
    local gt="${!gt_var}"
    local collection="${!coll_var}"
    local full_run_name="${bench}_run${run_num}"
    
    log ""
    log "${SEP}"
    log "  [${bench}] RUN ${run_num}: ${mode} MODE (multi-role + ctx decomp)"
    log "${SEP}"
    log "  Persist Dir    : ${persist}"
    log "  GT File        : ${gt}"
    log "  Collection     : ${collection}"
    log "  Retrieve TopK  : ${RETRIEVE_TOP_K}"
    log "  Rerank TopK    : ${RERANK_TOP_K}"
    log "  Multi-Role     : ${USE_MULTI_ROLE}"
    log "  Ctx Decomp.    : ${ENABLE_CTX_DECOMP}"
    log "  Workers        : ${WORKERS}"
    log "  Config Path    : ${BASE_CONFIG}"
    log "  Output Dir     : ${EXPERIMENT_DIR}"
    log "${THIN_SEP}"
    
    "${PYTHON}" "${EVAL_SCRIPT}" \
        --mode "${mode}" \
        --gt_path "${gt}" \
        --config_path "${BASE_CONFIG}" \
        --output_dir "${EXPERIMENT_DIR}" \
        --run_name "${full_run_name}" \
        --persist_directory "${persist}" \
        --collection_name "${collection}" \
        --retrieve_top_k "${RETRIEVE_TOP_K}" \
        --rerank_top_k "${RERANK_TOP_K}" \
        --use_multi_role "${USE_MULTI_ROLE}" \
        --enable_ctx_decomp "${ENABLE_CTX_DECOMP}" \
        --use_chunk_risk_calibration "${USE_CHUNK_RISK_CALIBRATION}" \
        --workers "${WORKERS}" \
        --identify_evidence "${IDENTIFY_EVIDENCE}" \
        2>&1 | tee -a "${LOG_FILE}"
    
    log "${THIN_SEP}"
    log "  [${bench}] RUN ${run_num} COMPLETE"
    log "${SEP}"
}

# Main experiment execution
log "${SEP}"
log "  PREVIEW vs NON-PREVIEW MODE EVALUATION  –  ${TIMESTAMP}"
log "  Experiment Dir      : ${EXPERIMENT_DIR}"
log "  Base Config         : ${BASE_CONFIG}"
log "  Benchmark           : zeekr (run4 - multi-role + ctx decomp)"
log "  Retrieve TopK       : ${RETRIEVE_TOP_K}"
log "  Rerank TopK         : ${RERANK_TOP_K}"
log "  Multi-Role          : ${USE_MULTI_ROLE}"
log "  Context Decomp      : ${ENABLE_CTX_DECOMP}"
log "  Workers             : ${WORKERS}"
log "${SEP}"

log ""
log "$(printf '#%.0s' {1..70})"
log "  BENCHMARK: ${BENCH} (run${run_num})"
log "$(printf '#%.0s' {1..70})"

# Run non-preview mode first
run_experiment "${BENCH}" "${run_num}" "non_preview"

# Run preview mode
run_experiment "${BENCH}" "${run_num}" "preview"

# Create comparative summary
log ""
log "${SEP}"
log "  GENERATING COMPARATIVE SUMMARY"
log "${SEP}"

# Consolidate results into a single metrics file
NON_PREVIEW_JSONL="${EXPERIMENT_DIR}/zeekr_run${run_num}_non_preview.jsonl"
PREVIEW_JSONL="${EXPERIMENT_DIR}/zeekr_run${run_num}_preview.jsonl"
METRICS_FILE="${EXPERIMENT_DIR}/_comparison_metrics.json"

"${PYTHON}" << EOF | tee -a "${LOG_FILE}"
import json
import sys

def load_jsonl(path):
    results = []
    try:
        with open(path, 'r') as f:
            for line in f:
                if line.strip():
                    results.append(json.loads(line))
    except Exception as e:
        print(f"Error loading {path}: {e}")
    return results

def compute_avg(results, key):
    values = [r.get(key, 0) for r in results if key in r and 'error' not in r]
    return sum(values) / len(values) if values else 0.0

non_preview = load_jsonl("${NON_PREVIEW_JSONL}")
preview = load_jsonl("${PREVIEW_JSONL}")

summary = {
    "timestamp": "${TIMESTAMP}",
    "benchmark": "zeekr",
    "run": ${run_num},
    "non_preview": {
        "count": len(non_preview),
        "errors": sum(1 for r in non_preview if 'error' in r),
        "avg_precision": compute_avg(non_preview, "precision"),
        "avg_recall": compute_avg(non_preview, "recall"),
        "avg_jaccard": compute_avg(non_preview, "jaccard"),
        "avg_retrieved": compute_avg(non_preview, "total_retrieved"),
        "avg_total_time": compute_avg(non_preview, "total_time"),
        "avg_time_to_first": compute_avg(non_preview, "time_to_first_response"),
    },
    "preview": {
        "count": len(preview),
        "errors": sum(1 for r in preview if 'error' in r),
        "avg_precision": compute_avg(preview, "precision"),
        "avg_recall": compute_avg(preview, "recall"),
        "avg_jaccard": compute_avg(preview, "jaccard"),
        "avg_retrieved": compute_avg(preview, "total_retrieved"),
        "avg_total_time": compute_avg(preview, "total_time"),
        "avg_time_to_first": compute_avg(preview, "time_to_first_response"),
    }
}

with open("${METRICS_FILE}", 'w') as f:
    json.dump(summary, f, indent=2)

print("\\n📊 COMPARATIVE METRICS:")
print("-" * 50)
print(f"Non-Preview Questions : {summary['non_preview']['count']}")
print(f"Preview Questions     : {summary['preview']['count']}")
print("-" * 50)
print("NON-PREVIEW MODE:")
print(f"  Precision  : {summary['non_preview']['avg_precision']:.4f}")
print(f"  Recall     : {summary['non_preview']['avg_recall']:.4f}")
print(f"  Jaccard    : {summary['non_preview']['avg_jaccard']:.4f}")
print(f"  Avg Time   : {summary['non_preview']['avg_total_time']:.3f}s")
print(f"  Time to 1st: {summary['non_preview']['avg_time_to_first']:.3f}s")
print("-" * 50)
print("PREVIEW MODE:")
print(f"  Precision  : {summary['preview']['avg_precision']:.4f}")
print(f"  Recall     : {summary['preview']['avg_recall']:.4f}")
print(f"  Jaccard    : {summary['preview']['avg_jaccard']:.4f}")
print(f"  Avg Time   : {summary['preview']['avg_total_time']:.3f}s")
print(f"  Time to 1st: {summary['preview']['avg_time_to_first']:.3f}s")
print("-" * 50)
EOF

log ""
log "${SEP}"
log "  ALL RUNS COMPLETE"
log "  Experiment Dir      : ${EXPERIMENT_DIR}"
log "  Comparison Metrics  : ${METRICS_FILE}"
log "  Non-Preview Results : ${NON_PREVIEW_JSONL}"
log "  Preview Results     : ${PREVIEW_JSONL}"
log "  Full Log            : ${LOG_FILE}"
log "  To resume: EXPERIMENT_DIR=${EXPERIMENT_DIR} bash $0"
log "${SEP}"
