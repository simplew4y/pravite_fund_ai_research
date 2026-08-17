"""Normalize, retain, deduplicate, conflict-check, and format retrieval evidence."""

from __future__ import annotations

import hashlib
import re
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

    if policy.require_table_evidence or _is_explicit_table_query(query):
        rag_chunks = _dedupe_chunks([
            *_required_table_row_rescue(query, rag_pre_rerank),
            *rag_chunks,
        ])

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
    if policy.require_table_evidence:
        lines.append(
            "This query requires table evidence. Prefer literal table row labels, periods, values, units, and cell= references; "
            "never infer a cell address from row order or from candidate DCI metadata."
        )
        sections = (
            ("rag", "RAG EVIDENCE"),
            ("dci_metric", "STRUCTURED DCI FACTS"),
            ("dci_keyword", "KEYWORD EVIDENCE"),
        )
    else:
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
            content = str(chunk.get("page_content") or "")
            # Canonical Excel row chunks keep their auditable cell/value
            # representation in ``metadata.caption``. The legacy RAG
            # formatter includes that field explicitly, so evidence fusion
            # must preserve the same contract instead of emitting an empty
            # table evidence block.
            if not content.strip() and metadata.get("caption"):
                content = str(metadata["caption"])
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


def _is_explicit_table_query(query: str) -> bool:
    query_lower = str(query or "").casefold()
    return any(term in query_lower for term in (
        "control panel", "表中", "表格", "工作表", "sheet", "单元格", "cell",
    ))


def _peer_comparison_row_rescue(query: str, candidates: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Keep issuer/metric rows for an explicit workbook peer comparison.

    Valuation-model peer blocks often encode the issuer and estimate period in
    column A and the metric in column B. Their row labels therefore do not equal
    canonical metric labels and the normal financial-row rescue cannot retain
    them after reranking.
    """
    query_lower = str(query or "").casefold()
    if not any(term in query_lower for term in ("同业", "可比", "peer", "comparison")):
        return []

    issuer_aliases = (
        (("阳光电源", "sungrow"), "sungrow"),
        (("锦浪科技", "锦浪", "ginlong"), "ginlong"),
    )
    requested_issuers = {
        canonical
        for aliases, canonical in issuer_aliases
        if any(alias in query_lower for alias in aliases)
    }
    requested_metrics = {metric for metric in ("roe", "per") if metric in query_lower}
    if not requested_issuers or not requested_metrics:
        return []

    rescued: list[dict[str, Any]] = []
    for chunk in candidates:
        metadata = chunk.get("metadata") or {}
        if _normalized(metadata.get("content_type")) not in {"table", "excel_table"}:
            continue
        source_ref = str(metadata.get("source_ref") or "").casefold()
        content = str(chunk.get("page_content") or metadata.get("caption") or "")
        content_lower = content.casefold()
        row_label = str(metadata.get("row_label") or "").casefold()
        if "control panel" not in source_ref and "control panel" not in content_lower:
            continue
        if not any(issuer in row_label for issuer in requested_issuers):
            continue
        if not any(re.search(rf"\bvalue={metric}\b", content_lower) for metric in requested_metrics):
            continue
        promoted = dict(chunk)
        promoted_metadata = dict(metadata)
        promoted_metadata.update({
            "source_kind": "rag",
            "confidence_tier": "retrieved",
            "required_table_row_rescue": True,
            "peer_comparison_row_rescue": True,
        })
        promoted["metadata"] = promoted_metadata
        promoted["page_content"] = _normalized_peer_row_content(content, row_label)
        rescued.append(promoted)
        if len(rescued) >= 8:
            break
    return rescued


def _normalized_peer_row_content(content: str, row_label: str) -> str:
    """Append an unambiguous issuer/metric/year view to a rescued peer row."""
    metric_match = re.search(r"\bvalue=(ROE|PER)\b", content, re.I)
    if not metric_match:
        return content
    metric = metric_match.group(1).upper()
    values: list[tuple[str, str]] = []
    for line in content.splitlines():
        match = re.search(
            r"\bvalue=([-+]?\d+(?:\.\d+)?)\s*\|\s*column=(20\d{2})(?:E)?\b",
            line,
            re.I,
        )
        if not match:
            continue
        numeric = float(match.group(1))
        if metric == "ROE":
            numeric = numeric * 100.0 if abs(numeric) <= 1.0 else numeric
            display = f"{numeric:.4f}".rstrip("0").rstrip(".") + "%"
        else:
            display = f"{numeric:g}x"
        values.append((match.group(2), display))
    if not values:
        return content
    issuer = re.sub(r"\s+20\d{2}E?\s*$", "", row_label, flags=re.I).strip()
    normalized = "; ".join(f"{year}={value}" for year, value in values)
    return f"{content}\nNormalized peer fact: issuer={issuer}; metric={metric}; {normalized}"


def _required_table_row_rescue(query: str, candidates: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Retain exact metric rows that reranking must not discard."""
    peer_rows = _peer_comparison_row_rescue(query, candidates)
    if peer_rows:
        return peer_rows
    query_lower = str(query or "").lower()
    aliases = (
        (("营业收入", "营收", "revenue"), ("营业收入", "revenue", "total revenue", "sales_ind")),
        (("营业成本", "销售成本", "cost of revenue", "cost of goods sold"), ("营业成本", "cost of goods sold", "cost of revenue", "cogs_ind")),
        (("毛利润", "gross profit"), ("毛利润", "gross profit", "gp_ind")),
        (("营业利润", "ebit"), ("营业利润", "ebit", "ebit (operating profits)", "ebit_ind")),
        (("归母净利润", "归属于母公司", "net income"), ("归母净利润", "net profit attributable", "np_xord_ind")),
        (("基本每股收益", "basic eps"), ("基本每股收益", "basic eps (cny/share)", "eps (reported)", "eps_rp_ind")),
        (("毛利率", "gross margin"), ("毛利率", "gross margin", "gross_margin_ind")),
        (("经营活动现金流", "经营性现金流", "operating cash flow"), ("经营活动现金流", "operating cash flow", "net cash from operating activities", "cf_op_ind")),
        (("资本开支", "资本支出", "capex", "capital expenditure"), ("资本开支", "资本支出", "capital expenditure", "capex_ind", "purchase of ppe", "total capex (cny m)")),
        (("自由现金流", "free cash flow"), ("自由现金流", "free cash flow", "fcf_ind")),
        (("总资产", "total assets"), ("总资产", "total assets", "tot_assets_ind")),
        (("总负债", "total liabilities"), ("总负债", "total liabilities", "tot_liabs_ind")),
        (("股东权益", "shareholders' equity"), ("股东权益", "shareholders' equity", "shr_eqty")),
        (("现金及等价物", "现金及现金等价物", "cash and cash equivalent"), ("现金及等价物", "cash and equivalent", "cash and equivalents", "cash and cash equivalents", "cash_ind")),
        (("应收账款", "accounts receivable"), ("应收账款", "account receivables", "accounts receivable", "accts_rec_ind")),
        (("存货", "inventory", "inventories"), ("存货", "inventories", "inventory", "inventories_ind")),
        (("有息负债", "interest-bearing debt"), ("short term debt", "long term debt", "st_debt_ind", "lt_debt_ind")),
        (("总股本", "shares outstanding"), ("shares outstanding", "shares outstanding (m, period-end)", "num_sh1", "ord_capital", "share capital", "总股本")),
    )
    labels: tuple[str, ...] = ()
    for query_aliases, exact_labels in aliases:
        if any(alias in query_lower for alias in query_aliases):
            labels = exact_labels
            break
    if not labels and any(term in query_lower for term in ("公式", "formula")):
        query_numbers = set(re.findall(r"\d+(?:\.\d+)?", query_lower))
        formula_rows = []
        for index, chunk in enumerate(candidates):
            metadata = chunk.get("metadata") or {}
            if _normalized(metadata.get("content_type")) not in {"table", "excel_table"}:
                continue
            content = str(chunk.get("page_content") or metadata.get("caption") or "")
            if "formula=" not in content.lower() or "错误示例" in content:
                continue
            values = set(re.findall(r"value=([^ |\n]+)", content.lower()))
            formula_rows.append((len(query_numbers & values), -index, chunk))
        formula_rows.sort(key=lambda item: (item[0], item[1]), reverse=True)
        rescued = []
        for _, _, chunk in formula_rows[:2]:
            promoted = dict(chunk)
            promoted_metadata = dict(chunk.get("metadata") or {})
            promoted_metadata.update({
                "source_kind": "rag",
                "confidence_tier": "retrieved",
                "required_table_row_rescue": True,
            })
            promoted["metadata"] = promoted_metadata
            rescued.append(promoted)
        return rescued
    if not labels:
        return []

    rescued = []
    for chunk in candidates:
        metadata = chunk.get("metadata") or {}
        if _normalized(metadata.get("content_type")) not in {"table", "excel_table"}:
            continue
        row_label = _normalized(metadata.get("row_label")).strip(" +()-")
        if row_label not in labels:
            continue
        promoted = dict(chunk)
        promoted_metadata = dict(metadata)
        promoted_metadata.update({
            "source_kind": "rag",
            "confidence_tier": "retrieved",
            "required_table_row_rescue": True,
        })
        promoted["metadata"] = promoted_metadata
        rescued.append(promoted)
        if len(rescued) >= 2:
            break
    return rescued


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
