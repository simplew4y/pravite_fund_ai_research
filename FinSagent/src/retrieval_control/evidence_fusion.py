"""Normalize, retain, deduplicate, conflict-check, and format retrieval evidence."""

from __future__ import annotations

import hashlib
from collections import defaultdict
from typing import Any, Iterable

from retrieval_control.models import EvidenceConflict, EvidenceFusionResult, RetrievalPolicy


def fuse_evidence(
    *,
    query: str,
    policy: RetrievalPolicy,
    metric_result: dict[str, Any] | None,
    keyword_result: dict[str, Any] | None,
    rag_result: dict[str, Any] | tuple | None,
    rag_executed: bool,
    rag_succeeded: bool,
    config: dict[str, Any] | None = None,
) -> EvidenceFusionResult:
    cfg = config if isinstance(config, dict) else {}
    fusion_cfg = cfg.get("evidence_fusion") if isinstance(cfg.get("evidence_fusion"), dict) else {}

    metric_chunks = _annotate_chunks(
        (metric_result or {}).get("chunks", []),
        source_kind="dci_metric",
        confidence_tier="answer_grade" if (metric_result or {}).get("high_confidence") else "candidate",
    )
    keyword_chunks = _annotate_chunks(
        (keyword_result or {}).get("chunks", []),
        source_kind="dci_keyword",
        confidence_tier="candidate",
    )
    rag_chunks, rag_pre_rerank, time_info = _rag_parts(rag_result)
    rag_chunks = _annotate_chunks(rag_chunks, source_kind="rag", confidence_tier="retrieved")
    rag_pre_rerank = _annotate_chunks(
        rag_pre_rerank, source_kind="rag_candidate", confidence_tier="candidate"
    )

    metric_chunks = metric_chunks[: _limit(fusion_cfg, "max_metric_facts", 12)]
    keyword_chunks = keyword_chunks[: _limit(fusion_cfg, "max_keyword_chunks", 6)]
    rag_chunks = _cap_rag_channels(rag_chunks, fusion_cfg)

    final_chunks = _dedupe_chunks([*metric_chunks, *keyword_chunks, *rag_chunks])
    pre_rerank_chunks = _dedupe_chunks([*metric_chunks, *keyword_chunks, *rag_pre_rerank])
    conflicts = detect_conflicts(final_chunks)
    trace = [
        {
            "event": "evidence_fusion",
            "query": query,
            "policy": policy.to_dict(),
            "metric_chunks": len(metric_chunks),
            "keyword_chunks": len(keyword_chunks),
            "rag_chunks": len(rag_chunks),
            "final_chunks": len(final_chunks),
            "rag_executed": rag_executed,
            "rag_succeeded": rag_succeeded,
        }
    ]
    context = compose_context(
        query,
        policy,
        final_chunks,
        conflicts,
        max_chunk_chars=_limit(fusion_cfg, "max_chunk_chars", 4000),
    )
    return EvidenceFusionResult(
        query=query,
        context=context,
        final_chunks=final_chunks,
        pre_rerank_chunks=pre_rerank_chunks,
        time_info=time_info,
        policy=policy,
        conflicts=conflicts,
        retrieval_trace=trace,
        rag_executed=rag_executed,
        rag_succeeded=rag_succeeded,
    )


def detect_conflicts(chunks: Iterable[dict[str, Any]]) -> list[EvidenceConflict]:
    grouped: dict[tuple[str, str], list[dict[str, Any]]] = defaultdict(list)
    for chunk in chunks:
        metadata = chunk.get("metadata") or {}
        metric = _normalized(metadata.get("metric_name") or metadata.get("metric"))
        period = _normalized(metadata.get("period"))
        if metric:
            grouped[(metric, period)].append(chunk)

    conflicts: list[EvidenceConflict] = []
    for (metric, period), facts in grouped.items():
        if len(facts) < 2:
            continue
        values = {
            _normalized((fact.get("metadata") or {}).get("value"))
            for fact in facts
            if (fact.get("metadata") or {}).get("value") not in (None, "")
        }
        estimate_types = {
            _normalized((fact.get("metadata") or {}).get("actual_or_estimate"))
            for fact in facts
            if (fact.get("metadata") or {}).get("actual_or_estimate")
        }
        evidence_ids = tuple(str((fact.get("metadata") or {}).get("evidence_id") or "") for fact in facts)
        if len(estimate_types) > 1:
            conflicts.append(EvidenceConflict(
                conflict_type="actual_estimate_conflict",
                evidence_ids=evidence_ids,
                metric_name=metric,
                period=period,
                reason="The evidence mixes actual and estimate values for the same metric and period.",
            ))
        if len(values) > 1:
            conflicts.append(EvidenceConflict(
                conflict_type="value_conflict",
                evidence_ids=evidence_ids,
                metric_name=metric,
                period=period,
                reason="Different values were found for the same metric and period.",
            ))
    return conflicts


def compose_context(
    query: str,
    policy: RetrievalPolicy,
    chunks: list[dict[str, Any]],
    conflicts: list[EvidenceConflict],
    *,
    max_chunk_chars: int = 4000,
) -> str:
    channels: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for chunk in chunks:
        source_kind = str((chunk.get("metadata") or {}).get("source_kind") or "rag")
        channels[source_kind].append(chunk)

    lines = [
        "[RETRIEVAL POLICY]",
        f"query_type={policy.query_type}; rag_required={policy.rag_required}; "
        f"rag_executed={policy.run_rag}; reasons={','.join(policy.reason_codes)}",
        "Low-confidence DCI facts are candidate evidence: retain them, but do not let them override stronger dated source evidence.",
    ]
    sections = (
        ("dci_metric", "STRUCTURED DCI FACTS"),
        ("rag", "RAG EVIDENCE"),
        ("dci_keyword", "KEYWORD EVIDENCE"),
    )
    for channel, heading in sections:
        channel_chunks = channels.get(channel, [])
        if not channel_chunks:
            continue
        lines.extend(["", f"[{heading}]"])
        for chunk in channel_chunks:
            metadata = chunk.get("metadata") or {}
            evidence_id = metadata.get("evidence_id", "")
            tier = metadata.get("confidence_tier", "")
            source_ref = metadata.get("source_ref") or metadata.get("source_file") or ""
            source_doc_id = metadata.get("source_doc_id") or metadata.get("doc_id") or ""
            prefix = f"[{evidence_id}] tier={tier} doc_id={source_doc_id} source={source_ref}"
            content = str(chunk.get("page_content", ""))
            if max_chunk_chars > 0 and len(content) > max_chunk_chars:
                content = content[:max_chunk_chars].rstrip() + "\n[chunk truncated]"
            lines.append(f"{prefix}\n{content}")

    if conflicts:
        lines.extend(["", "[EVIDENCE CONFLICTS]"])
        for conflict in conflicts:
            lines.append(
                f"{conflict.conflict_type}: metric={conflict.metric_name} period={conflict.period} "
                f"evidence_ids={','.join(conflict.evidence_ids)}; {conflict.reason}"
            )
        lines.append("Unresolved conflicts must be disclosed; never select a value silently.")
    return "\n".join(lines)


def _annotate_chunks(
    chunks: Iterable[dict[str, Any]], *, source_kind: str, confidence_tier: str
) -> list[dict[str, Any]]:
    annotated: list[dict[str, Any]] = []
    for index, raw in enumerate(chunks):
        if not isinstance(raw, dict):
            continue
        chunk = dict(raw)
        metadata = dict(chunk.get("metadata") or {})
        evidence_id = metadata.get("evidence_id") or _evidence_id(source_kind, chunk, index)
        metadata.update({
            "evidence_id": str(evidence_id),
            "source_kind": source_kind,
            "confidence_tier": confidence_tier,
        })
        chunk["metadata"] = metadata
        annotated.append(chunk)
    return annotated


def _rag_parts(rag_result: dict[str, Any] | tuple | None) -> tuple[list[dict], list[dict], list[Any]]:
    if isinstance(rag_result, dict):
        final_chunks = list(rag_result.get("final_chunks") or [])
        pre_rerank = list(rag_result.get("pre_rerank_chunks") or final_chunks)
        return final_chunks, pre_rerank, list(rag_result.get("time_info") or [])
    if isinstance(rag_result, tuple) and len(rag_result) >= 3:
        chunks = list(rag_result[1] or []) if len(rag_result) > 1 else []
        return chunks, list(chunks), list(rag_result[2] or [])
    return [], [], []


def _cap_rag_channels(chunks: list[dict[str, Any]], cfg: dict[str, Any]) -> list[dict[str, Any]]:
    tables: list[dict[str, Any]] = []
    text: list[dict[str, Any]] = []
    for chunk in chunks:
        content_type = _normalized((chunk.get("metadata") or {}).get("content_type"))
        if "table" in content_type or "excel" in content_type:
            tables.append(chunk)
        else:
            text.append(chunk)
    return [
        *tables[: _limit(cfg, "max_table_chunks", 6)],
        *text[: _limit(cfg, "max_text_chunks", 8)],
    ]


def _dedupe_chunks(chunks: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    seen: set[str] = set()
    for chunk in chunks:
        metadata = chunk.get("metadata") or {}
        key = str(metadata.get("chunk_id") or metadata.get("evidence_id") or "")
        if not key:
            key = hashlib.sha256(str(chunk.get("page_content") or "").encode("utf-8")).hexdigest()
        if key in seen:
            continue
        seen.add(key)
        result.append(chunk)
    return result


def _evidence_id(source_kind: str, chunk: dict[str, Any], index: int) -> str:
    metadata = chunk.get("metadata") or {}
    identity = "|".join((
        source_kind,
        str(metadata.get("source_doc_id") or metadata.get("doc_id") or ""),
        str(metadata.get("chunk_id") or metadata.get("source_ref") or index),
        str(chunk.get("page_content") or "")[:200],
    ))
    return f"{source_kind.upper()}-{hashlib.sha256(identity.encode('utf-8')).hexdigest()[:12]}"


def _limit(cfg: dict[str, Any], key: str, default: int) -> int:
    try:
        return max(0, int(cfg.get(key, default)))
    except (TypeError, ValueError):
        return default


def _normalized(value: Any) -> str:
    return str(value or "").strip().casefold()
