"""Bridges phase execution into agent evidence without importing agent tools."""

from __future__ import annotations

import json
from typing import Any

from skills_runtime.models import SkillContext


async def apply_retrieval_skills(
    *,
    runtime: Any,
    question: str,
    agent: str,
    evidences: list[dict[str, Any]],
    request_id: str = "",
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Run evidence/calculation/prompt phases before agent drafting."""
    if runtime is None or not getattr(runtime, "enabled", False):
        return evidences, []

    chunks: list[dict[str, Any]] = []
    pre_rerank: list[dict[str, Any]] = []
    allowed_doc_ids: set[str] = set()
    dataset_id = ""
    for evidence in evidences:
        chunks.extend(evidence.get("chunks", []))
        pre_rerank.extend(evidence.get("pre_rerank_chunks", []))
        scope = evidence.get("retrieval_scope") or {}
        dataset_id = dataset_id or str(scope.get("dataset_id") or "")
        allowed_doc_ids.update(str(doc_id) for doc_id in scope.get("source_doc_ids", []) if doc_id)

    metric_facts = [
        dict(chunk.get("metadata") or {})
        for chunk in chunks
        if str((chunk.get("metadata") or {}).get("content_type") or "") == "metric_fact"
    ]
    context = SkillContext(
        request_id=request_id,
        question=question,
        original_question=question,
        agent=agent,
        dataset_id=dataset_id,
        allowed_doc_ids=sorted(allowed_doc_ids),
        metric_facts=metric_facts,
        retrieved_chunks=chunks,
        pre_rerank_candidates=pre_rerank,
    )
    traces: list[dict[str, Any]] = []
    for phase in ("post_retrieval", "calculation", "pre_answer"):
        execution = await runtime.execute_phase(phase, context)
        traces.extend(result.to_dict() for result in execution.results)

    if getattr(runtime, "mode", "shadow") in {"prompt_active", "active"} and (
        context.derived_facts or context.prompt_instructions
    ):
        skill_context_parts: list[str] = []
        if context.derived_facts:
            skill_context_parts.append(
                "Deterministic Skill Facts:\n"
                + json.dumps(context.derived_facts, ensure_ascii=False, default=str)
            )
        for instruction in context.prompt_instructions:
            skill_context_parts.append(
                f"Skill Instruction ({instruction.get('skill_id', '')}):\n"
                f"{instruction.get('instruction', '')}"
            )
        evidences = list(evidences) + [
            {
                "agent": agent,
                "query": question,
                "context": "\n\n".join(skill_context_parts),
                "chunks": [],
                "source_ids": [],
                "time_info": [],
                "pre_rerank_chunks": [],
                "pre_rerank_source_ids": [],
                "retrieval_scope": {
                    "dataset_id": dataset_id,
                    "source_doc_ids": sorted(allowed_doc_ids),
                    "explicit_company": bool(allowed_doc_ids),
                },
                "content_type": "skill_context",
            }
        ]
    return evidences, traces
