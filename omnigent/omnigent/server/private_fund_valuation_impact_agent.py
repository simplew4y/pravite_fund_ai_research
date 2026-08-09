"""Skill-driven valuation impacts extracted from current supporting documents."""

from __future__ import annotations

import hashlib
import json
import math
import re
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Protocol

SKILL_NAME = "private-fund-valuation-impacts"
EXTRACTOR_VERSION = "valuation-impact-skill-v2"
MAX_DOCUMENTS = 12
MAX_CHUNKS_PER_DOCUMENT = 6
MAX_TOTAL_CHARS = 12_000

_SKILL_ROOT = (
    Path(__file__).resolve().parents[1] / "resources" / "private_fund_skills" / SKILL_NAME
)
_SKILL_PATH = _SKILL_ROOT / "SKILL.md"
_SCHEMA_PATH = _SKILL_ROOT / "references" / "output-schema.json"

_MODEL_SUBTYPES = frozenset(
    {
        "dcf_model",
        "comparable_company_model",
        "financial_forecast_model",
        "integrated_valuation_model",
    }
)
_DIRECTIONS = frozenset({"up", "down", "mixed"})
_AFFECTED_INPUTS = frozenset(
    {
        "revenue_growth",
        "gross_margin",
        "operating_margin",
        "unit_economics",
        "r_and_d",
        "capex",
        "working_capital",
        "free_cash_flow",
        "wacc",
        "terminal_growth",
        "valuation_multiple",
        "success_probability",
        "timing_discount",
        "overseas_revenue",
        "order_conversion",
    }
)
_VALUATION_TERMS = (
    "收入",
    "利润",
    "毛利",
    "成本",
    "订单",
    "交付",
    "价格",
    "市场",
    "增长",
    "资本开支",
    "研发",
    "现金流",
    "风险",
    "政策",
    "合规",
    "客户",
    "量产",
    "投产",
    "指引",
    "revenue",
    "profit",
    "margin",
    "cost",
    "order",
    "delivery",
    "growth",
    "capex",
    "cash flow",
    "risk",
    "policy",
)


class ValuationImpactChatClient(Protocol):
    def chat(
        self,
        messages: list[dict[str, str]],
        *,
        max_tokens: int | None = None,
        temperature: float | None = None,
    ) -> str: ...


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True)


def _decode(value: Any, default: Any) -> Any:
    if value in (None, ""):
        return default
    try:
        return json.loads(str(value))
    except (TypeError, ValueError, json.JSONDecodeError):
        return default


def _digest(*parts: Any, length: int = 32) -> str:
    payload = "\0".join(str(part or "") for part in parts)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:length]


def _safe_float(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def _clean_text(value: Any, limit: int) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()[:limit]


def _tables(conn: sqlite3.Connection) -> set[str]:
    return {
        str(row[0]) for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")
    }


def _columns(conn: sqlite3.Connection, table_name: str) -> set[str]:
    return {str(row[1]) for row in conn.execute(f"PRAGMA table_info({table_name})")}


def ensure_impact_schema(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS valuation_impact_agent_runs (
            run_id TEXT PRIMARY KEY,
            dataset_id TEXT NOT NULL,
            series_id TEXT NOT NULL,
            model_version_id TEXT NOT NULL,
            source_fingerprint TEXT NOT NULL,
            extractor_version TEXT NOT NULL,
            skill_name TEXT NOT NULL,
            status TEXT NOT NULL,
            card_count INTEGER NOT NULL DEFAULT 0,
            output_json TEXT NOT NULL DEFAULT '{}',
            raw_response TEXT,
            error_message TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            UNIQUE(model_version_id, source_fingerprint, extractor_version)
        );

        CREATE TABLE IF NOT EXISTS valuation_impact_cards (
            card_id TEXT PRIMARY KEY,
            run_id TEXT NOT NULL,
            dataset_id TEXT NOT NULL,
            series_id TEXT NOT NULL,
            model_version_id TEXT NOT NULL,
            source_fingerprint TEXT NOT NULL,
            ordinal INTEGER NOT NULL,
            direction TEXT NOT NULL,
            horizon TEXT NOT NULL,
            confidence REAL NOT NULL,
            title TEXT NOT NULL,
            evidence_summary TEXT NOT NULL,
            valuation_impact TEXT NOT NULL,
            affected_inputs_json TEXT NOT NULL DEFAULT '[]',
            watch_items_json TEXT NOT NULL DEFAULT '[]',
            source_refs_json TEXT NOT NULL DEFAULT '[]',
            evidence_ids_json TEXT NOT NULL DEFAULT '[]',
            created_at TEXT NOT NULL,
            UNIQUE(run_id, ordinal)
        );

        CREATE INDEX IF NOT EXISTS ix_valuation_impact_runs_latest
            ON valuation_impact_agent_runs(model_version_id, updated_at DESC);
        CREATE INDEX IF NOT EXISTS ix_valuation_impact_cards_run
            ON valuation_impact_cards(run_id, ordinal);
        """
    )


def _supporting_documents(
    conn: sqlite3.Connection,
    *,
    dataset_id: str,
) -> list[dict[str, Any]]:
    if "documents" not in _tables(conn):
        return []
    document_columns = _columns(conn, "documents")

    def selected(column: str, fallback: str) -> str:
        return column if column in document_columns else f"{fallback} AS {column}"

    subtype_placeholders = ",".join("?" for _ in _MODEL_SUBTYPES)
    model_predicates = [
        "COALESCE(d.doc_type,'')='valuation_model'",
        f"COALESCE(d.doc_subtype,'') IN ({subtype_placeholders})",
    ]
    if "excel_workbooks" in _tables(conn):
        model_predicates.append(
            "EXISTS (SELECT 1 FROM excel_workbooks ew "
            "WHERE ew.doc_id=d.doc_id AND ew.workbook_type='valuation_model')"
        )
    rows = conn.execute(
        f"""
        SELECT d.doc_id, d.original_filename,
               {selected("doc_type", "''")}, {selected("doc_subtype", "''")},
               {selected("document_date", "''")}, {selected("checksum", "''")},
               {selected("created_at", "''")}
        FROM documents d
        WHERE d.dataset_id=? AND d.status='indexed'
          AND COALESCE(d.is_current,1)=1
          AND COALESCE(d.lifecycle_state,'active')='active'
          AND NOT ({" OR ".join(model_predicates)})
        ORDER BY COALESCE(d.document_date,'') DESC, d.created_at DESC
        LIMIT ?
        """,
        (dataset_id, *sorted(_MODEL_SUBTYPES), MAX_DOCUMENTS),
    ).fetchall()
    return [dict(row) for row in rows]


def _chunk_rows(conn: sqlite3.Connection, doc_id: str) -> list[dict[str, Any]]:
    if "chunks" not in _tables(conn):
        return []
    columns = _columns(conn, "chunks")

    def selected(column: str, fallback: str) -> str:
        return column if column in columns else f"{fallback} AS {column}"

    rows = conn.execute(
        f"""
        SELECT chunk_id, chunk_index, {selected("summary", "''")},
               {selected("content", "''")}, {selected("source_ref", "''")},
               {selected("title_path", "''")}, {selected("content_hash", "''")}
        FROM chunks WHERE doc_id=? ORDER BY chunk_index
        """,
        (doc_id,),
    ).fetchall()
    return [dict(row) for row in rows]


def _ranked_chunks(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    ranked: list[tuple[int, int, dict[str, Any]]] = []
    seen: set[str] = set()
    for row in rows:
        text = _clean_text(row.get("content") or row.get("summary"), 6_000)
        if not text:
            continue
        normalized = text.casefold()
        dedupe = str(row.get("content_hash") or _digest(normalized[:1_500]))
        if dedupe in seen:
            continue
        seen.add(dedupe)
        score = sum(1 for term in _VALUATION_TERMS if term in normalized)
        source_ref = str(row.get("source_ref") or "")
        if re.search(r"\bp\.?\s*\d+", source_ref, flags=re.IGNORECASE):
            score += 2
        if "document summary" in str(row.get("title_path") or "").casefold():
            score -= 3
        ranked.append((score, int(row.get("chunk_index") or 0), row))
    ranked.sort(key=lambda item: (-item[0], item[1]))
    return [item[2] for item in ranked[:MAX_CHUNKS_PER_DOCUMENT]]


def _model_context(conn: sqlite3.Connection, model_version_id: str) -> list[dict[str, Any]]:
    required = {"valuation_model_nodes", "valuation_model_node_values"}
    if not required.issubset(_tables(conn)):
        return []
    rows = conn.execute(
        """
        SELECT n.display_name, n.metric_key, n.scope, n.period, n.scenario,
               v.value_numeric, v.value_text, v.unit, v.sheet_name, v.cell_ref
        FROM valuation_model_node_values v
        JOIN valuation_model_nodes n ON n.node_id=v.node_id
        WHERE v.model_version_id=?
          AND (v.value_numeric IS NOT NULL OR NULLIF(v.value_text,'') IS NOT NULL)
        ORDER BY CASE WHEN NULLIF(n.metric_key,'') IS NOT NULL THEN 0 ELSE 1 END,
                 v.confidence DESC, n.display_name
        LIMIT 8
        """,
        (model_version_id,),
    ).fetchall()
    return [dict(row) for row in rows]


def build_evidence_packet(
    conn: sqlite3.Connection,
    *,
    dataset_id: str,
    series_id: str,
    model_version_id: str,
) -> tuple[dict[str, Any], dict[str, str], str]:
    documents = _supporting_documents(conn, dataset_id=dataset_id)
    excerpts: list[dict[str, Any]] = []
    evidence_sources: dict[str, str] = {}
    total_chars = 0
    for document in documents:
        filename = str(document.get("original_filename") or "辅助资料")
        for chunk in _ranked_chunks(_chunk_rows(conn, str(document["doc_id"]))):
            content = _clean_text(chunk.get("content") or chunk.get("summary"), 700)
            if not content or total_chars + len(content) > MAX_TOTAL_CHARS:
                continue
            evidence_id = f"chunk:{chunk['chunk_id']}"
            source_ref = _clean_text(chunk.get("source_ref"), 240)
            source_ref = source_ref or f"{filename} · 片段 {chunk.get('chunk_index', '')}"
            excerpts.append(
                {
                    "evidence_id": evidence_id,
                    "document_id": f"document:{document['doc_id']}",
                    "source_name": filename,
                    "document_type": str(
                        document.get("doc_subtype") or document.get("doc_type") or ""
                    ),
                    "document_date": str(document.get("document_date") or ""),
                    "source_ref": source_ref,
                    "content": content,
                }
            )
            evidence_sources[evidence_id] = source_ref
            total_chars += len(content)
    source_fingerprint = _digest(
        *(
            f"{document.get('doc_id')}:{document.get('checksum')}:{document.get('doc_subtype')}"
            for document in documents
        ),
        *(f"{item['evidence_id']}:{_digest(item['content'])}" for item in excerpts),
        length=40,
    )
    packet = {
        "dataset_id": dataset_id,
        "series_id": series_id,
        "model_version_id": model_version_id,
        "model_context": _model_context(conn, model_version_id),
        "supporting_documents": [
            {
                "evidence_id": f"document:{document['doc_id']}",
                "source_name": str(document.get("original_filename") or ""),
                "document_type": str(
                    document.get("doc_subtype") or document.get("doc_type") or ""
                ),
                "document_date": str(document.get("document_date") or ""),
            }
            for document in documents
        ],
        "evidence_excerpts": excerpts,
    }
    return packet, evidence_sources, source_fingerprint


def _parse_json_object(text: str) -> dict[str, Any]:
    candidate = str(text or "").strip()
    fenced = re.search(r"```(?:json)?\s*([\s\S]*?)```", candidate, flags=re.IGNORECASE)
    if fenced:
        candidate = fenced.group(1).strip()
    try:
        payload = json.loads(candidate)
    except json.JSONDecodeError:
        start = candidate.find("{")
        end = candidate.rfind("}")
        if start < 0 or end <= start:
            raise ValueError("Agent response did not contain a JSON object") from None
        payload = json.loads(candidate[start : end + 1])
    if not isinstance(payload, dict):
        raise ValueError("Agent response must be a JSON object")
    return payload


def _chat_json(
    llm_client: ValuationImpactChatClient,
    messages: list[dict[str, str]],
) -> tuple[dict[str, Any], str]:
    raw = llm_client.chat(messages, max_tokens=3_000, temperature=0.0)
    try:
        return _parse_json_object(raw), raw
    except (ValueError, json.JSONDecodeError):
        repaired = llm_client.chat(
            [
                {
                    "role": "system",
                    "content": (
                        "Repair the response into one valid JSON object matching the requested "
                        "schema. Return JSON only and do not invent or replace evidence IDs."
                    ),
                },
                {"role": "user", "content": raw[:120_000]},
            ],
            max_tokens=3_000,
            temperature=0.0,
        )
        return _parse_json_object(repaired), repaired


def validate_output(
    payload: dict[str, Any],
    *,
    evidence_sources: dict[str, str],
) -> dict[str, Any]:
    warnings = [
        _clean_text(item, 500) for item in payload.get("warnings", []) if _clean_text(item, 500)
    ]
    impacts: list[dict[str, Any]] = []
    titles: set[str] = set()
    raw_impacts = payload.get("impacts") if isinstance(payload.get("impacts"), list) else []
    for ordinal, raw in enumerate(raw_impacts[:8], 1):
        if not isinstance(raw, dict):
            warnings.append(f"第 {ordinal} 项不是对象，已忽略。")
            continue
        direction = str(raw.get("direction") or "")
        confidence = _safe_float(raw.get("confidence"))
        title = _clean_text(raw.get("title"), 120)
        title_key = title.casefold()
        evidence_summary = _clean_text(raw.get("evidence_summary"), 800)
        valuation_impact = _clean_text(raw.get("valuation_impact"), 800)
        submitted_evidence = [str(item) for item in raw.get("evidence_ids") or []]
        valid_evidence = [item for item in submitted_evidence if item in evidence_sources]
        affected_inputs = list(
            dict.fromkeys(
                str(item)
                for item in raw.get("affected_inputs") or []
                if str(item) in _AFFECTED_INPUTS
            )
        )[:6]
        watch_items = list(
            dict.fromkeys(
                _clean_text(item, 180)
                for item in raw.get("watch_items") or []
                if _clean_text(item, 180)
            )
        )[:6]
        valid = (
            direction in _DIRECTIONS
            and confidence is not None
            and 0.35 <= confidence <= 1.0
            and len(title) >= 4
            and title_key not in titles
            and len(evidence_summary) >= 12
            and len(valuation_impact) >= 12
            and bool(affected_inputs)
            and bool(watch_items)
            and bool(valid_evidence)
            and len(valid_evidence) == len(submitted_evidence)
        )
        if not valid:
            warnings.append(f"估值影响“{title or ordinal}”未通过结构或证据校验，已忽略。")
            continue
        titles.add(title_key)
        impacts.append(
            {
                "ordinal": len(impacts) + 1,
                "direction": direction,
                "horizon": _clean_text(raw.get("horizon"), 80) or "待验证",
                "confidence": confidence,
                "title": title,
                "evidence_summary": evidence_summary,
                "valuation_impact": valuation_impact,
                "affected_inputs": affected_inputs,
                "watch_items": watch_items,
                "source_refs": list(
                    dict.fromkeys(evidence_sources[item] for item in valid_evidence)
                ),
                "evidence_ids": list(dict.fromkeys(valid_evidence)),
            }
        )
    return {
        "analysis_summary": _clean_text(payload.get("analysis_summary"), 500),
        "impacts": impacts,
        "warnings": list(dict.fromkeys(warnings)),
    }


def _run_payload(conn: sqlite3.Connection, row: sqlite3.Row) -> dict[str, Any]:
    payload = dict(row)
    formatted = _decode(payload.pop("output_json", None), {})
    payload["analysis_summary"] = str(formatted.get("analysis_summary") or "")
    payload["warnings"] = list(formatted.get("warnings") or [])
    payload.pop("raw_response", None)
    cards = []
    for card_row in conn.execute(
        "SELECT * FROM valuation_impact_cards WHERE run_id=? ORDER BY ordinal",
        (payload["run_id"],),
    ):
        card = dict(card_row)
        card["affected_inputs"] = _decode(card.pop("affected_inputs_json"), [])
        card["watch_items"] = _decode(card.pop("watch_items_json"), [])
        card["source_refs"] = _decode(card.pop("source_refs_json"), [])
        card["evidence_ids"] = _decode(card.pop("evidence_ids_json"), [])
        cards.append(card)
    payload["cards"] = cards
    return payload


def latest_impact_payload(
    conn: sqlite3.Connection,
    *,
    dataset_id: str,
    model_version_id: str,
) -> dict[str, Any]:
    ensure_impact_schema(conn)
    row = conn.execute(
        """
        SELECT * FROM valuation_impact_agent_runs
        WHERE dataset_id=? AND model_version_id=?
        ORDER BY updated_at DESC LIMIT 1
        """,
        (dataset_id, model_version_id),
    ).fetchone()
    if row is None:
        return {
            "run_id": "",
            "status": "pending",
            "source_fingerprint": "",
            "extractor_version": EXTRACTOR_VERSION,
            "skill_name": SKILL_NAME,
            "analysis_summary": "",
            "warnings": [],
            "cards": [],
            "error_message": "等待基于项目资料生成估值影响。",
            "updated_at": "",
        }
    return _run_payload(conn, row)


def extract_with_skill(
    conn: sqlite3.Connection,
    *,
    dataset_id: str,
    series_id: str,
    model_version_id: str,
    llm_client: ValuationImpactChatClient,
) -> dict[str, Any]:
    ensure_impact_schema(conn)
    packet, evidence_sources, source_fingerprint = build_evidence_packet(
        conn,
        dataset_id=dataset_id,
        series_id=series_id,
        model_version_id=model_version_id,
    )
    run_id = "viar_" + _digest(model_version_id, source_fingerprint, EXTRACTOR_VERSION)
    cached = conn.execute(
        """
        SELECT * FROM valuation_impact_agent_runs
        WHERE model_version_id=? AND source_fingerprint=? AND extractor_version=?
          AND status IN ('completed','no_evidence')
        """,
        (model_version_id, source_fingerprint, EXTRACTOR_VERSION),
    ).fetchone()
    if cached is not None:
        return _run_payload(conn, cached)

    now = _now_iso()
    excerpts = packet.get("evidence_excerpts") or []
    if not excerpts:
        formatted = {
            "analysis_summary": "当前项目没有可引用的辅助资料片段。",
            "impacts": [],
            "warnings": [],
        }
        conn.execute(
            """
            INSERT INTO valuation_impact_agent_runs
                (run_id, dataset_id, series_id, model_version_id, source_fingerprint,
                 extractor_version, skill_name, status, card_count, output_json,
                 raw_response, error_message, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'no_evidence', 0, ?, NULL, NULL, ?, ?)
            ON CONFLICT(model_version_id, source_fingerprint, extractor_version) DO UPDATE SET
                status='no_evidence', card_count=0, output_json=excluded.output_json,
                raw_response=NULL, error_message=NULL, updated_at=excluded.updated_at
            """,
            (
                run_id,
                dataset_id,
                series_id,
                model_version_id,
                source_fingerprint,
                EXTRACTOR_VERSION,
                SKILL_NAME,
                _json(formatted),
                now,
                now,
            ),
        )
        row = conn.execute(
            "SELECT * FROM valuation_impact_agent_runs WHERE run_id=?", (run_id,)
        ).fetchone()
        if row is None:
            raise RuntimeError("valuation impact no-evidence run was not persisted")
        return _run_payload(conn, row)

    skill = _SKILL_PATH.read_text(encoding="utf-8")
    schema = json.loads(_SCHEMA_PATH.read_text(encoding="utf-8"))
    messages = [
        {
            "role": "system",
            "content": (
                f"Apply the following skill exactly.\n\n{skill}\n\n"
                "Return one JSON object only. Its JSON Schema is:\n"
                f"{json.dumps(schema, ensure_ascii=False)}"
            ),
        },
        {
            "role": "user",
            "content": (
                "Generate distinct valuation-impact cards from the current supporting "
                "documents. Use no outside facts and cite only supplied chunk IDs.\n"
                + json.dumps(packet, ensure_ascii=False)
            ),
        },
    ]
    raw_response = ""
    try:
        raw_payload, raw_response = _chat_json(llm_client, messages)
        formatted = validate_output(raw_payload, evidence_sources=evidence_sources)
        conn.execute("DELETE FROM valuation_impact_cards WHERE run_id=?", (run_id,))
        for card in formatted["impacts"]:
            card_id = "viac_" + _digest(run_id, card["ordinal"], card["title"])
            conn.execute(
                """
                INSERT INTO valuation_impact_cards
                    (card_id, run_id, dataset_id, series_id, model_version_id,
                     source_fingerprint, ordinal, direction, horizon, confidence, title,
                     evidence_summary, valuation_impact, affected_inputs_json,
                     watch_items_json, source_refs_json, evidence_ids_json, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    card_id,
                    run_id,
                    dataset_id,
                    series_id,
                    model_version_id,
                    source_fingerprint,
                    card["ordinal"],
                    card["direction"],
                    card["horizon"],
                    card["confidence"],
                    card["title"],
                    card["evidence_summary"],
                    card["valuation_impact"],
                    _json(card["affected_inputs"]),
                    _json(card["watch_items"]),
                    _json(card["source_refs"]),
                    _json(card["evidence_ids"]),
                    now,
                ),
            )
        conn.execute(
            """
            INSERT INTO valuation_impact_agent_runs
                (run_id, dataset_id, series_id, model_version_id, source_fingerprint,
                 extractor_version, skill_name, status, card_count, output_json,
                 raw_response, error_message, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'completed', ?, ?, ?, NULL, ?, ?)
            ON CONFLICT(model_version_id, source_fingerprint, extractor_version) DO UPDATE SET
                status='completed', card_count=excluded.card_count,
                output_json=excluded.output_json, raw_response=excluded.raw_response,
                error_message=NULL, updated_at=excluded.updated_at
            """,
            (
                run_id,
                dataset_id,
                series_id,
                model_version_id,
                source_fingerprint,
                EXTRACTOR_VERSION,
                SKILL_NAME,
                len(formatted["impacts"]),
                _json(formatted),
                raw_response[:500_000],
                now,
                now,
            ),
        )
    except Exception as exc:  # noqa: BLE001 - failed Agent output remains auditable
        conn.execute("DELETE FROM valuation_impact_cards WHERE run_id=?", (run_id,))
        conn.execute(
            """
            INSERT INTO valuation_impact_agent_runs
                (run_id, dataset_id, series_id, model_version_id, source_fingerprint,
                 extractor_version, skill_name, status, card_count, output_json,
                 raw_response, error_message, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'failed', 0, '{}', ?, ?, ?, ?)
            ON CONFLICT(model_version_id, source_fingerprint, extractor_version) DO UPDATE SET
                status='failed', card_count=0, output_json='{}',
                raw_response=excluded.raw_response, error_message=excluded.error_message,
                updated_at=excluded.updated_at
            """,
            (
                run_id,
                dataset_id,
                series_id,
                model_version_id,
                source_fingerprint,
                EXTRACTOR_VERSION,
                SKILL_NAME,
                raw_response[:500_000],
                str(exc)[:2_000],
                now,
                now,
            ),
        )
    row = conn.execute(
        "SELECT * FROM valuation_impact_agent_runs WHERE run_id=?", (run_id,)
    ).fetchone()
    if row is None:
        raise RuntimeError("valuation impact Agent run was not persisted")
    return _run_payload(conn, row)


__all__ = [
    "EXTRACTOR_VERSION",
    "SKILL_NAME",
    "build_evidence_packet",
    "ensure_impact_schema",
    "extract_with_skill",
    "latest_impact_payload",
    "validate_output",
]
