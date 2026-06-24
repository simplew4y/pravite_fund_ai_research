# PageIndex Retrieval Experiments

This ablation compares three retrieval architectures while keeping the rest of
FinSagent unchanged.

## Architectures

- `baseline`: FAISS + Title Summary + BM25 + Table + Reranker
- `replace_bm25`: FAISS + Title Summary + PageIndex + Table + Reranker
- `hybrid`: FAISS + Title Summary + BM25 + PageIndex + Table + Reranker

PageIndex is used as a structural retrieval branch over pre-built PageIndex tree
JSON files. At runtime, selected PageIndex page ranges are mapped back to the
existing Chroma chunks and passed through the existing reranker.

## Build PageIndex Trees

Run once per benchmark, on the server where raw PDFs are available:

```bash
python data_pipeline/build_pageindex_index.py \
  --input_dir /path/to/raw_pdf \
  --output_dir /path/to/database/pageindex \
  --pageindex_repo_path /path/to/PageIndex \
  --config_path config/production.yaml
```

The experiment script expects the PageIndex workspace at
`${BENCH_<name>_PERSIST}/pageindex` by default. You can override each benchmark:

```bash
BENCH_lotus_PAGEINDEX=/path/to/lotus/pageindex \
BENCH_financebench_PAGEINDEX=/path/to/financebench/pageindex \
bash test/colm/retrieval/run_pageindex_experiments.sh
```

Or use one root directory containing `lotus`, `financebench`, etc.:

```bash
PAGEINDEX_ROOT=/path/to/pageindex_workspaces \
bash test/colm/retrieval/run_pageindex_experiments.sh
```

`--config_path` reads `llm_model_name`, `llm_api_key`, and `llm_base_url` from
the FinSagent config and exposes them to PageIndex as OpenAI-compatible
environment variables. You can still override them explicitly:

```bash
python data_pipeline/build_pageindex_index.py \
  --input_dir /path/to/raw_pdf \
  --output_dir /path/to/database/pageindex \
  --pageindex_repo_path /path/to/PageIndex \
  --api_key "$OPENAI_API_KEY" \
  --base_url "https://dashscope.aliyuncs.com/compatible-mode/v1" \
  --model qwen3-max
```

## Run Three Groups

```bash
WORKERS=1 \
BENCHMARKS="lotus financebench finder" \
RETRIEVE_TOP_K=10 \
RERANK_TOP_K=5 \
bash test/colm/retrieval/run_pageindex_experiments.sh
```

Outputs are written to `test/colm/retrieval/experiment_pageindex_<timestamp>/`.
The combined metrics file is `_metrics.json`.

For NVIDIA, build the PageIndex workspace against the NVIDIA raw PDFs and run
only that benchmark:

```bash
python data_pipeline/build_pageindex_index.py \
  --input_dir /root/autodl-tmp/RAG_Agent_data/nvidia/20260424/0_raw_pdf \
  --output_dir /root/autodl-tmp/RAG_Agent_data/nvidia/20260425/5_database_nvidia/pageindex \
  --pageindex_repo_path /root/autodl-tmp/PageIndex \
  --config_path config/config_nvidia_0425.yaml

BENCHMARKS="nvidia" \
bash test/colm/retrieval/run_pageindex_experiments.sh
```
