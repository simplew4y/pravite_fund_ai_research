# Test

# Preview Mode Evaluation
* Retrieval + e2e: `test/eval_preview_modes.py`
    * Retrieval only: Add `--stop_after_retrieval true`
    * Run with preview/non-preview mode: `bash test/run_experiments_preview_modes.sh`

## Evaluation
* LLM judge: `test/qa_llm_judge.py`


# COLM

## Experiments
* Main Experiment (End-to-end)
    * `test/retrieval/run_experiments_chunk_risk_percentile.sh`
    * FinSAgent results: `test/e2e/0322_force_general_lightgbm_new_calibrate_ts10_fb_table_rerun`
    * Baseline:
        * Results: `test/baseline/e2e/0324`
    * Run5 with other apis:
        * script: `test/retrieval/run_run5_alt_llm_apis.sh` (Run this based on previous end-to-end configs)
        * Results: `test/e2e/run5_alt_llm_apis_20260331_171959`
    
* Retrieval
    * Same as Main Results.

* Retrieval ablation
    * `test/ablation/README.md`
    * plot: `test/retrieval/plot_unify.py`
    * Reproduction
        * Rerun Main Experiment with system default lambda `test/ablation/lambda/run_experiment_default_lambda_repro.sh`

* System overhead
    * run: `test/overhead/run_llm_overhead_eval.py`
    * plot: `test/overhead/plot_overhead.py`

## LightGBM

### Data
* 4 datasets, no balancing: `lightgbm/data/chunk_features_reduced_46804.csv`
* 5 datasets, no balancing: `lightgbm/data/chunk_features_reduced_5datasets_51972.csv`
* 4 datasets, balanced to 20% positive: `lightgbm/data/chunk_features_reduced_13788.csv`
* 5 datasets, balanced to 20% positive: `lightgbm/data/chunk_features_reduced_5datasets_balanced_14816.csv`
