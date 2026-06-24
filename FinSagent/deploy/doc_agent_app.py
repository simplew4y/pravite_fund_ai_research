"""Standalone FastAPI app for the document triage prototype.

Run this when you want to test upload-time document classification without
booting the full RAG stack:

    uvicorn deploy.doc_agent_app:app --host 0.0.0.0 --port 6010
"""

from __future__ import annotations

import os
import sys
from pathlib import Path
from typing import Any

import yaml
from fastapi import FastAPI, File, HTTPException, Query, UploadFile
from fastapi.middleware.cors import CORSMiddleware

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "src"))
sys.path.insert(0, str(REPO_ROOT))

from doc_agent import DocumentTriageAgent


def load_config() -> dict[str, Any]:
    config: dict[str, Any] = {}
    for path in (REPO_ROOT / "config" / "production.yaml", REPO_ROOT / "config" / "example.yaml"):
        if not path.is_file():
            continue
        try:
            payload = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
            if isinstance(payload, dict):
                config.update(payload)
                break
        except Exception:
            continue

    env_overrides = {
        "llm_base_url": os.environ.get("LLM_BASE_URL") or os.environ.get("OPENAI_BASE_URL"),
        "llm_api_key": os.environ.get("LLM_API_KEY") or os.environ.get("OPENAI_API_KEY"),
        "llm_model_name": os.environ.get("LLM_MODEL_NAME") or os.environ.get("OPENAI_MODEL"),
    }
    for key, value in env_overrides.items():
        if value:
            config[key] = value
    return config


app = FastAPI(
    title="FinSagent Document Triage Agent",
    description="Prototype upload-time classifier and summarizer for financial documents.",
    version="0.1.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
async def health():
    return {"status": "healthy"}


@app.post("/doc-agent/analyze")
async def analyze_document(
    file: UploadFile = File(..., description="PDF/DOCX/TXT/MD/HTML/JSON 等文档"),
    use_llm: bool = Query(True, description="是否调用 LLM；关闭后只使用规则兜底"),
):
    body = await file.read()
    if not body:
        raise HTTPException(status_code=400, detail="空文件")
    agent = DocumentTriageAgent(load_config())
    return await agent.analyze_upload(file.filename or "upload", body, use_llm=use_llm)


@app.post("/doc-agent/analyze-batch")
async def analyze_documents(
    files: list[UploadFile] = File(..., description="批量文档"),
    use_llm: bool = Query(True, description="是否调用 LLM；关闭后只使用规则兜底"),
):
    if not files:
        raise HTTPException(status_code=400, detail="未提供任何文件")
    agent = DocumentTriageAgent(load_config())
    results = []
    for uploaded in files:
        body = await uploaded.read()
        if not body:
            results.append({"filename": uploaded.filename or "upload", "error": "空文件"})
            continue
        try:
            results.append(await agent.analyze_upload(uploaded.filename or "upload", body, use_llm=use_llm))
        except Exception as exc:
            results.append({"filename": uploaded.filename or "upload", "error": str(exc)})
    return {"count": len(results), "results": results}
