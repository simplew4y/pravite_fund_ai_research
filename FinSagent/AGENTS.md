# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## Overview

FinSagent is a financial-domain Agentic RAG system built on LangGraph. It serves a FastAPI HTTP/SSE backend (`deploy/app.py`) backed by a multi-agent state graph (`src/core/AgenticRAG.py`) that routes user questions to specialist agents, runs them in parallel, and synthesizes a final answer.

The repo also contains evaluation harnesses (`test/`, `batch_qa_test.py`), the data-ingestion pipeline (`data_pipeline/`), and a LightGBM-based chunk-risk calibrator (`lightgbm/`).

## Common Commands

All Python entry points expect the conda env that contains the LangGraph/OpenAI/LangChain stack:

```bash
conda activate lotusenv     # primary env used by the deploy + eval scripts
```

### Run the API server
```bash
cd deploy && bash start.sh                 # uvicorn on $HOST:$PORT (default 0.0.0.0:6008)
# or directly:
HOST=0.0.0.0 PORT=6008 WORKERS=1 bash deploy/start.sh
```
The server reads `config/production.yaml`. Frontend is mounted at `/`, SSE at `POST /chat/stream`, two-phase preview at `POST /chat/preview`.

### Run vLLM embedding + reranker (only when `retrieval_backend != "dci"`)
```bash
bash start_vllm_services.sh                # boots BGE-M3 embed + BGE reranker
```
DCI mode (current `production.yaml`) bypasses this entirely — it searches a JSON corpus directly via subprocess `rg`/`read_file`/`list_files` tools.

### Quick smoke test (single question)
```bash
python simple_qa_test.py                   # edits in-file question list
```

### Batch evaluation
```bash
EXPERIMENT_NAME=run1 \
QUESTIONS_JSON=/path/to/questions.json \
OUTPUT_JSON=/path/to/out.json \
python batch_qa_test.py                    # incremental write per question
```

### Preview-vs-non-preview retrieval benchmark
```bash
bash test/run_experiments_preview_modes.sh # see script header for env knobs
# single-mode invocation:
python test/eval_preview_modes.py --mode preview --config_path config/production.yaml ...
```

### LLM-as-judge evaluation
```bash
python test/qa_llm_judge.py                # consumes batch_qa_test.py outputs
```

## Architecture

### Request flow (production)
```
HTTP/SSE  →  deploy/app.py  →  ChatService.generate_response_*  →  build_agentic_rag_workflow()
                                                                       ↓
                                                       orchestrator → dispatch → agents_parallel → synthesis
```

`ChatService` (`src/core/ChatService.py`) is the single composition root. It owns:
- the shared retriever (`RAG` *or* `DCIRetriever`, picked from `config["retrieval_backend"]`),
- the compiled LangGraph workflow (singleton),
- a per-`session_id` map of `SessionManager` instances (chat history + LLM client),
- a `SessionHistoryStore` for SQLite persistence of turns + auto-generated titles.

There are four entry points on `ChatService` that all run the same workflow but differ in streaming/preview semantics:
| Method | Behaviour |
| --- | --- |
| `generate_response_async` | one-shot, returns `(answer, history, agents, chunks)` |
| `generate_response_stream` | SSE: pushes `orchestrator` → per-`agent_completed` → `synthesis` → `complete` |
| `generate_response_with_preview` | **two phases run in parallel**: a fast `general`-agent draft (Phase 1) + the full MAS (Phase 2). A `_DraftHolder` (asyncio.Event with timeout) bridges them so `synthesis_node` can await the draft. |
| `generate_response_debug_async` | non-stream debug surface used by evaluation scripts; supports `stop_after_retrieval` |

### LangGraph state machine (`src/core/AgenticRAG.py`)
```
orchestrator ──(off_topic)──► END
     │
     └──► dispatch ──► agents_parallel ──► synthesis ──► END
                            ▲                │
                            └── (re-dispatch when missing_info present)
```
Nodes communicate through the typed `MASState` (TypedDict). Important fields:
- `selected_agents` / `pending_agents`: chosen subgraphs to fan out to.
- `agent_outputs[name]`: per-agent draft + evidence + tool results.
- `merged_pre_rerank_candidates`: union of pre-rerank chunks across agents (used by retrieval evaluation).
- `draft_holder`: present **only** in preview mode; orchestrator excludes `general` from routing when set, and `synthesis_node` `await`s it.
- `emit_cb`: optional callback injected by streaming callers so `agents_parallel_node` can push per-agent events without re-implementing fan-out logic.

### Specialist agents (`src/agents/<name>/`)
Each agent has the same three files — `description.json` (routing metadata + `tools_allowed`), `prompts.py`, `workflow.py` (a LangGraph subgraph) — and is loaded by name in `AgenticRAG.SUBGRAPH_MAP`. Agents share helpers in `src/agents/shared.py` (`rewrite_for_agent`, `retrieve_evidence`, `draft_answer`, tool-plan/tool-execution scaffolding).

Five agents currently exist: `general`, `market_researcher`, `company_researcher`, `quant`, `legal_risk`. To add a sixth:
1. Create `src/agents/<name>/{description.json,prompts.py,workflow.py}` mirroring an existing agent.
2. Import its `build_<name>_subgraph` in `AgenticRAG.py` and register it in `SUBGRAPH_MAP`.
3. `_load_agent_descriptions()` and `_load_agent_tool_allowlists()` pick up `description.json` automatically.

### Retrieval backends
Two interchangeable implementations behind the same `retrieve(query, query_time) -> {rag_context, final_chunks, time_info, pre_rerank_chunks}` contract:
- **`RAG`** (`src/core/RAG.py`) — Chroma + BM25 hybrid (`utils/EnsembleRetriever.py`) → reranker (FlagEmbedding *or* vLLM, switched via `reranker_backend`) → optional LightGBM chunk-risk calibration.
- **`DCIRetriever`** (`src/core/DCIRetriever.py`) — an LLM agent loops over `rg`/`read_file`/`list_files` over a JSON corpus dir. No vector DB or reranker. Selected by `retrieval_backend: "dci"` in config; the deploy `lifespan` then **skips** `RAGManager` initialization.

### Configuration
- `config/production.yaml` is the file read by `deploy/app.py` and the test scripts. It is gitignored except for `example.yaml` / `example_dci.yaml`.
- Key switches: `retrieval_backend` (`rag`|`dci`), `reranker_backend` (`flagembedding`|`vllm`), `enable_ctx_decomp` (per-agent sub-query decomposition), `use_chunk_risk_calibration`, `data_latest_time` (drives orchestrator's time-anchor rewrite for time-sensitive queries), `disable_external_tools`.
- LLM is OpenAI-compatible; `llm_base_url` typically points at a local vLLM server.

### Session persistence
`sessions.sqlite3` (path from `session_history_db`) stores `sessions` (id, title, timestamps) and `session_messages` (one row per turn, including draft + final + activated agents + off-topic flag). `ChatService._summarize_and_update_title` runs an LLM call after the first turn of each session to set its title.

## Things to know before changing code

- **Don't add `general` to `selected_agents` when `draft_holder` is set** — the orchestrator deliberately excludes it; Phase 1 already produces that draft, and duplicate work breaks the preview latency story.
- **`pre_rerank_chunks` must be populated** on every `Evidence` you produce — `utils/chunk_utils.collect_pre_rerank_chunks_from_agent_outputs` and the retrieval evaluation depend on it.
- **Tool gating is per-agent** via `description.json:tools_allowed`. The shared helper enforces this; bypassing it loses the safety net (and `tool_result_filter` config wiring).
- **`SessionManager.call_llm*` currently hard-codes `temperature=1.0`** despite the parameter — there's a comment marking it as a COLM-experiment override. Don't "fix" without checking what's downstream.
- **The `deprecated_c/` directory under `src/` is gitignored** and shouldn't be imported.
- Several baselines live alongside the main workflow: `core/findebate_helper.py`, `core/moa_helper.py`, `core/naiverag_helper.py`. They are invoked by dedicated `ChatService.generate_response_*` methods and share `RAG`/`DCIRetriever` but not the LangGraph workflow.
