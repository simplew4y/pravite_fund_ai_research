"""
Research Memory — REST API 路由

依赖主模块中的 `chat_service.memory` (ResearchMemory 实例)。
"""

from __future__ import annotations

from typing import List, Optional

import app as app_module
from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

router = APIRouter(prefix="/memory", tags=["memory"])


def _require_memory():
    cs = app_module.chat_service
    if cs is None:
        raise HTTPException(status_code=503, detail="Chat service not initialized")
    mm = getattr(cs, "memory", None)
    if mm is None:
        raise HTTPException(
            status_code=503,
            detail="ResearchMemory is not initialized on chat_service",
        )
    return mm


# ── Request / Response 模型 ──


class CitationInput(BaseModel):
    doc_id: str = ""
    doc_type: str = ""
    page: Optional[int] = None
    evidence_text: str = ""
    claim: str = ""
    display: str = ""


class FactInput(BaseModel):
    entity: str = ""
    metric: str = ""
    value: str = ""
    unit: str = ""
    period: str = ""
    fact_type: str = "metric"
    source_ref: str = ""
    confidence: float = 1.0


class AuditInput(BaseModel):
    model_name: str = ""
    latency_ms: int = 0
    rewritten_query: str = ""
    exact_results: list = []
    semantic_results: list = []
    merged_results: list = []


class TurnRequest(BaseModel):
    session_id: str
    question: str
    answer: str
    citations: List[CitationInput] = []
    facts: List[FactInput] = []
    audit: Optional[AuditInput] = None


class TurnResponse(BaseModel):
    ok: bool
    message_id: str = ""
    citation_ids: List[str] = []


class RetrieveItem(BaseModel):
    content: str
    score: float
    tier: str
    source: str


class RetrieveResponse(BaseModel):
    items: List[RetrieveItem]


class FactsResponse(BaseModel):
    facts: list


class AuditResponse(BaseModel):
    trail: list


class CitationsResponse(BaseModel):
    citations: list


# ── Endpoints ──


@router.post("/turn", response_model=TurnResponse, status_code=201)
async def record_turn(req: TurnRequest):
    """记录一次问答。"""
    mm = _require_memory()
    result = mm.record_turn(
        session_id=req.session_id,
        question=req.question,
        answer=req.answer,
        citations=[c.model_dump() for c in req.citations] if req.citations else None,
        facts=[f.model_dump() for f in req.facts] if req.facts else None,
        audit=req.audit.model_dump() if req.audit else None,
    )
    if not result.get("ok"):
        raise HTTPException(status_code=500, detail=result.get("error", "unknown"))
    return TurnResponse(
        ok=True,
        message_id=result.get("message_id", ""),
        citation_ids=result.get("citation_ids", []),
    )


@router.get("/retrieve", response_model=RetrieveResponse)
async def retrieve(
    q: str = Query(..., min_length=1, description="查询文本"),
    k: int = Query(5, ge=1, le=50, description="返回条数"),
):
    """检索历史记忆。"""
    mm = _require_memory()
    items = mm.retrieve(q, k)
    return RetrieveResponse(
        items=[
            RetrieveItem(content=i["content"], score=i["score"], tier=i["tier"], source=i["source"])
            for i in items
        ]
    )


@router.get("/facts", response_model=FactsResponse)
async def get_facts(
    entity: str = Query(..., min_length=1, description="实体名称"),
    metric: Optional[str] = Query(None, description="指标名称（可选）"),
):
    """查询某实体的历史事实。"""
    mm = _require_memory()
    facts = mm.get_facts(entity, metric)
    return FactsResponse(facts=facts)


@router.get("/audit/{session_id}", response_model=AuditResponse)
async def get_audit(session_id: str):
    """查询某次会话的审计轨迹。"""
    mm = _require_memory()
    trail = mm.get_audit(session_id)
    return AuditResponse(trail=trail)


@router.get("/citations", response_model=CitationsResponse)
async def get_citations(
    source_type: str = Query(..., description="来源类型: qa_message|fact"),
    source_id: str = Query(..., description="来源 ID"),
):
    """查询引用记录。"""
    mm = _require_memory()
    citations = mm.get_citations(source_type, source_id)
    return CitationsResponse(citations=citations)
