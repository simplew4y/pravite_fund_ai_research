"""Durable valuation-model snapshots, diffs, jobs, rules, and alerts.

This module deliberately stays separate from ``private_fund_tracking``.  The
generic tracker extracts narrative research items; valuation tracking needs a
model-series boundary and deterministic comparisons across thousands of Excel
facts.  Excel files remain immutable evidence.  This first version reads the
facts already produced by the private-fund ingest pipeline and never executes
macros or rewrites a workbook.
"""

from __future__ import annotations

import hashlib
import json
import math
import re
import sqlite3
import unicodedata
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from omnigent.server import private_fund_valuation_overview

VALUATION_TRACKING_SCHEMA_VERSION = 2
VALUATION_ANALYZER_VERSION = "valuation-tracking-v1"
ALERT_STATUSES = frozenset({"new", "acknowledged", "dismissed", "snoozed"})
JOB_STATUSES = frozenset({"queued", "running", "completed", "failed"})
MATERIALITY_RANK = {"low": 0, "medium": 1, "high": 2, "critical": 3}
_RETRY_DELAYS_SECONDS = (30, 120, 600)


_METRIC_PROFILES: tuple[tuple[str, str, tuple[str, ...]], ...] = (
    (
        "target_price",
        "output",
        (
            "target price",
            "price target",
            "目标价",
            "目标价格",
            "implied share price",
            "fair value per share",
            "每股价值",
        ),
    ),
    (
        "enterprise_value",
        "output",
        ("enterprise value", "企业价值", "ev value", "implied ev"),
    ),
    (
        "equity_value",
        "output",
        ("equity value", "股权价值", "market value of equity", "implied equity"),
    ),
    (
        "upside_downside",
        "output",
        ("upside", "downside", "上涨空间", "下跌空间", "return potential"),
    ),
    ("wacc", "assumption", ("wacc", "weighted average cost of capital", "加权平均资本成本")),
    (
        "terminal_growth",
        "assumption",
        ("terminal growth", "perpetual growth", "永续增长", "永续增长率"),
    ),
    (
        "risk_free_rate",
        "assumption",
        ("risk free rate", "risk-free rate", "无风险利率"),
    ),
    ("cost_of_debt", "assumption", ("cost of debt", "债务成本", "借款成本")),
    ("beta", "assumption", ("beta", "贝塔")),
    ("tax_rate", "assumption", ("tax rate", "effective tax", "税率", "所得税率")),
    ("net_debt", "assumption", ("net debt", "净债务", "net cash", "净现金")),
    (
        "shares_outstanding",
        "assumption",
        ("shares outstanding", "diluted shares", "share count", "总股本", "稀释股本"),
    ),
    ("revenue", "forecast", ("revenue", "sales", "turnover", "营业收入", "收入")),
    (
        "gross_margin",
        "forecast",
        ("gross margin", "gross profit margin", "毛利率"),
    ),
    ("ebitda", "forecast", ("ebitda",)),
    ("ebit", "forecast", ("ebit", "operating profit", "营业利润")),
    (
        "net_profit",
        "forecast",
        ("net profit", "net income", "归母净利润", "净利润"),
    ),
    (
        "free_cash_flow",
        "forecast",
        ("free cash flow", "fcf", "自由现金流"),
    ),
    ("capex", "forecast", ("capex", "capital expenditure", "资本开支", "资本支出")),
    ("eps", "forecast", ("eps", "earnings per share", "每股收益")),
)


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _now_iso() -> str:
    return _now().isoformat()


def _json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True)


def _decode(value: Any, default: Any) -> Any:
    if value in (None, ""):
        return default
    try:
        return json.loads(str(value))
    except (TypeError, ValueError, json.JSONDecodeError):
        return default


def _digest(*parts: Any, length: int = 24) -> str:
    payload = "\0".join(str(part or "") for part in parts)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:length]


def _normalize(value: Any) -> str:
    text = unicodedata.normalize("NFKC", str(value or "")).strip().lower()
    text = text.replace("_", " ").replace("/", " ")
    text = re.sub(r"[^a-z0-9%\u3400-\u9fff.-]+", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def _key_part(value: Any, *, fallback: str = "unknown") -> str:
    text = _normalize(value)
    text = re.sub(r"[^a-z0-9\u3400-\u9fff]+", "-", text).strip("-")
    return text[:100] or fallback


def _safe_float(value: Any) -> float | None:
    if value in (None, ""):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def _connect(collection_db: Path) -> sqlite3.Connection:
    collection_db.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(collection_db), timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=30000")
    return conn


def _tables(conn: sqlite3.Connection) -> set[str]:
    return {
        str(row[0]) for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")
    }


def ensure_valuation_schema(conn: sqlite3.Connection, dataset_id: str | None = None) -> None:
    """Create the additive valuation-tracking schema in one collection DB."""

    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS valuation_model_series (
            series_id TEXT PRIMARY KEY,
            dataset_id TEXT NOT NULL,
            series_key TEXT NOT NULL,
            name TEXT NOT NULL,
            company_name TEXT,
            company_ticker TEXT,
            model_type TEXT,
            current_model_version_id TEXT,
            current_version_no INTEGER NOT NULL DEFAULT 0,
            status TEXT NOT NULL DEFAULT 'active',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            UNIQUE(dataset_id, series_key)
        );

        CREATE TABLE IF NOT EXISTS valuation_model_versions (
            model_version_id TEXT PRIMARY KEY,
            series_id TEXT NOT NULL,
            dataset_id TEXT NOT NULL,
            doc_id TEXT NOT NULL,
            logical_doc_id TEXT,
            document_version_no INTEGER NOT NULL,
            parent_model_version_id TEXT,
            reverted_to_version_id TEXT,
            checksum TEXT NOT NULL,
            snapshot_hash TEXT NOT NULL,
            original_filename TEXT NOT NULL,
            document_date TEXT,
            model_type TEXT,
            node_count INTEGER NOT NULL DEFAULT 0,
            formula_node_count INTEGER NOT NULL DEFAULT 0,
            review_required_count INTEGER NOT NULL DEFAULT 0,
            analyzer_version TEXT NOT NULL,
            created_at TEXT NOT NULL,
            UNIQUE(doc_id, analyzer_version)
        );

        CREATE TABLE IF NOT EXISTS valuation_model_nodes (
            node_id TEXT PRIMARY KEY,
            series_id TEXT NOT NULL,
            canonical_key TEXT NOT NULL,
            node_kind TEXT NOT NULL,
            metric_key TEXT NOT NULL,
            display_name TEXT NOT NULL,
            scope TEXT NOT NULL,
            period TEXT,
            scenario TEXT,
            first_seen_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            UNIQUE(series_id, canonical_key)
        );

        CREATE TABLE IF NOT EXISTS valuation_model_node_values (
            node_value_id TEXT PRIMARY KEY,
            model_version_id TEXT NOT NULL,
            node_id TEXT NOT NULL,
            value_numeric REAL,
            value_text TEXT,
            unit TEXT,
            formula TEXT,
            formula_fingerprint TEXT,
            sheet_name TEXT NOT NULL,
            cell_ref TEXT NOT NULL,
            evidence_id TEXT NOT NULL,
            quality_status TEXT NOT NULL,
            confidence REAL NOT NULL DEFAULT 0.5,
            metadata_json TEXT NOT NULL DEFAULT '{}',
            created_at TEXT NOT NULL,
            UNIQUE(model_version_id, node_id)
        );

        CREATE TABLE IF NOT EXISTS valuation_model_changes (
            change_id TEXT PRIMARY KEY,
            dataset_id TEXT NOT NULL,
            series_id TEXT NOT NULL,
            from_model_version_id TEXT NOT NULL,
            to_model_version_id TEXT NOT NULL,
            node_id TEXT NOT NULL,
            change_type TEXT NOT NULL,
            materiality TEXT NOT NULL,
            summary TEXT NOT NULL,
            old_value_json TEXT NOT NULL DEFAULT '{}',
            new_value_json TEXT NOT NULL DEFAULT '{}',
            absolute_change REAL,
            relative_change REAL,
            evidence_ids_json TEXT NOT NULL DEFAULT '[]',
            created_at TEXT NOT NULL,
            UNIQUE(from_model_version_id, to_model_version_id, node_id, change_type)
        );

        CREATE TABLE IF NOT EXISTS valuation_analysis_versions (
            analysis_version_id TEXT PRIMARY KEY,
            dataset_id TEXT NOT NULL,
            series_id TEXT NOT NULL,
            model_version_id TEXT NOT NULL,
            previous_analysis_version_id TEXT,
            status TEXT NOT NULL,
            summary_markdown TEXT NOT NULL,
            analysis_json TEXT NOT NULL DEFAULT '{}',
            analyzer_version TEXT NOT NULL,
            created_at TEXT NOT NULL,
            UNIQUE(model_version_id, analyzer_version)
        );

        CREATE TABLE IF NOT EXISTS valuation_model_overviews (
            overview_id TEXT PRIMARY KEY,
            dataset_id TEXT NOT NULL,
            series_id TEXT NOT NULL,
            model_version_id TEXT NOT NULL,
            doc_id TEXT NOT NULL,
            status TEXT NOT NULL,
            overview_json TEXT NOT NULL DEFAULT '{}',
            html TEXT NOT NULL,
            overview_version TEXT NOT NULL,
            created_at TEXT NOT NULL,
            UNIQUE(model_version_id, overview_version)
        );

        CREATE TABLE IF NOT EXISTS valuation_watch_rules (
            rule_id TEXT PRIMARY KEY,
            dataset_id TEXT NOT NULL,
            series_id TEXT,
            name TEXT NOT NULL,
            min_materiality TEXT NOT NULL DEFAULT 'medium',
            change_types_json TEXT NOT NULL DEFAULT '[]',
            active INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS valuation_alerts (
            alert_id TEXT PRIMARY KEY,
            dataset_id TEXT NOT NULL,
            series_id TEXT NOT NULL,
            rule_id TEXT,
            change_id TEXT NOT NULL,
            alert_type TEXT NOT NULL,
            priority TEXT NOT NULL,
            title TEXT NOT NULL,
            summary TEXT NOT NULL,
            evidence_ids_json TEXT NOT NULL DEFAULT '[]',
            status TEXT NOT NULL DEFAULT 'new',
            snoozed_until TEXT,
            dedupe_key TEXT NOT NULL UNIQUE,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS valuation_tracking_jobs (
            job_id TEXT PRIMARY KEY,
            dataset_id TEXT NOT NULL,
            job_type TEXT NOT NULL,
            source_id TEXT NOT NULL,
            payload_json TEXT NOT NULL DEFAULT '{}',
            analyzer_version TEXT NOT NULL,
            status TEXT NOT NULL,
            priority INTEGER NOT NULL DEFAULT 100,
            attempt_count INTEGER NOT NULL DEFAULT 0,
            max_attempts INTEGER NOT NULL DEFAULT 4,
            available_at TEXT NOT NULL,
            locked_at TEXT,
            started_at TEXT,
            finished_at TEXT,
            result_json TEXT,
            last_error TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            UNIQUE(dataset_id, job_type, source_id, analyzer_version)
        );

        CREATE TABLE IF NOT EXISTS valuation_agent_analyses (
            analysis_id TEXT PRIMARY KEY,
            dataset_id TEXT NOT NULL,
            series_id TEXT NOT NULL,
            base_model_version_id TEXT NOT NULL,
            comparison_model_version_id TEXT,
            status TEXT NOT NULL DEFAULT 'pending',
            focus TEXT NOT NULL DEFAULT '',
            valuation_method TEXT,
            executive_summary TEXT,
            investment_conclusion TEXT,
            analysis_json TEXT NOT NULL DEFAULT '{}',
            planner_json TEXT NOT NULL DEFAULT '{}',
            evidence_ids_json TEXT NOT NULL DEFAULT '[]',
            raw_response TEXT,
            model_name TEXT,
            agent_version TEXT NOT NULL,
            error_message TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            completed_at TEXT,
            UNIQUE(base_model_version_id, comparison_model_version_id, focus, agent_version)
        );

        CREATE TABLE IF NOT EXISTS valuation_derived_models (
            derived_model_id TEXT PRIMARY KEY,
            dataset_id TEXT NOT NULL,
            series_id TEXT NOT NULL,
            analysis_id TEXT NOT NULL,
            base_model_version_id TEXT NOT NULL,
            derived_version_no INTEGER NOT NULL,
            output_filename TEXT NOT NULL,
            output_path TEXT NOT NULL,
            checksum TEXT NOT NULL,
            applied_changes_json TEXT NOT NULL DEFAULT '[]',
            skipped_changes_json TEXT NOT NULL DEFAULT '[]',
            resource_file_name TEXT,
            resource_pipeline_job_id TEXT,
            resource_status TEXT NOT NULL DEFAULT 'not_added',
            resource_doc_id TEXT,
            resource_added_at TEXT,
            resource_error TEXT,
            created_at TEXT NOT NULL,
            UNIQUE(analysis_id)
        );

        CREATE INDEX IF NOT EXISTS ix_valuation_versions_series
            ON valuation_model_versions(series_id, document_version_no DESC);
        CREATE INDEX IF NOT EXISTS ix_valuation_values_version
            ON valuation_model_node_values(model_version_id, node_id);
        CREATE INDEX IF NOT EXISTS ix_valuation_overviews_version
            ON valuation_model_overviews(model_version_id, overview_version);
        CREATE INDEX IF NOT EXISTS ix_valuation_changes_series
            ON valuation_model_changes(series_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS ix_valuation_alerts_dataset_status
            ON valuation_alerts(dataset_id, status, created_at DESC);
        CREATE INDEX IF NOT EXISTS ix_valuation_jobs_claim
            ON valuation_tracking_jobs(status, available_at, priority, created_at);
        CREATE INDEX IF NOT EXISTS ix_valuation_agent_series
            ON valuation_agent_analyses(series_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS ix_valuation_derived_series
            ON valuation_derived_models(series_id, created_at DESC);
        """
    )
    derived_columns = {
        str(row[1])
        for row in conn.execute("PRAGMA table_info(valuation_derived_models)")
    }
    for column_name, definition in (
        ("resource_file_name", "TEXT"),
        ("resource_pipeline_job_id", "TEXT"),
        ("resource_status", "TEXT NOT NULL DEFAULT 'not_added'"),
        ("resource_doc_id", "TEXT"),
        ("resource_added_at", "TEXT"),
        ("resource_error", "TEXT"),
    ):
        if column_name not in derived_columns:
            conn.execute(
                f"ALTER TABLE valuation_derived_models ADD COLUMN {column_name} {definition}"
            )
    if dataset_id:
        _ensure_default_rule(conn, dataset_id)


def _ensure_default_rule(conn: sqlite3.Connection, dataset_id: str) -> None:
    now = _now_iso()
    rule_id = f"vwr_{_digest(dataset_id, 'default-material-changes')}"
    conn.execute(
        """
        INSERT OR IGNORE INTO valuation_watch_rules
            (rule_id, dataset_id, name, min_materiality, change_types_json,
             active, created_at, updated_at)
        VALUES (?, ?, '自动追踪重大估值变化', 'medium', '[]', 1, ?, ?)
        """,
        (rule_id, dataset_id, now, now),
    )


def _model_documents(
    conn: sqlite3.Connection,
    dataset_id: str,
    *,
    document_ids: list[str] | None = None,
    current_only: bool = False,
) -> list[dict[str, Any]]:
    if "documents" not in _tables(conn):
        return []
    predicates = ["dataset_id=?", "doc_type='valuation_model'", "status='indexed'"]
    params: list[Any] = [dataset_id]
    if current_only:
        predicates.extend(
            ["COALESCE(is_current,1)=1", "COALESCE(lifecycle_state,'active')='active'"]
        )
    else:
        predicates.append("COALESCE(lifecycle_state,'active') IN ('active','superseded')")
    if document_ids:
        placeholders = ",".join("?" for _ in document_ids)
        predicates.append(f"doc_id IN ({placeholders})")
        params.extend(document_ids)
    rows = conn.execute(
        f"""
        SELECT * FROM documents
        WHERE {" AND ".join(predicates)}
        ORDER BY COALESCE(logical_doc_id, doc_id), version_no, created_at
        """,
        params,
    ).fetchall()
    return [dict(row) for row in rows]


def _clean_model_name(filename: str) -> str:
    stem = Path(filename).stem
    stem = re.sub(r"^\d{10,}_", "", stem)
    return stem.replace("+", " ").strip() or "估值模型"


def _series_key(document: dict[str, Any]) -> str:
    return str(document.get("logical_doc_id") or document["doc_id"])


def _ensure_series(
    conn: sqlite3.Connection, dataset_id: str, document: dict[str, Any]
) -> sqlite3.Row:
    key = _series_key(document)
    series_id = f"vms_{_digest(dataset_id, key)}"
    now = _now_iso()
    conn.execute(
        """
        INSERT INTO valuation_model_series
            (series_id, dataset_id, series_key, name, company_name, company_ticker,
             model_type, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(dataset_id, series_key) DO UPDATE SET
            company_name=COALESCE(
                NULLIF(excluded.company_name,''), valuation_model_series.company_name
            ),
            company_ticker=COALESCE(
                NULLIF(excluded.company_ticker,''), valuation_model_series.company_ticker
            ),
            model_type=COALESCE(NULLIF(excluded.model_type,''), valuation_model_series.model_type),
            updated_at=excluded.updated_at
        """,
        (
            series_id,
            dataset_id,
            key,
            _clean_model_name(str(document.get("original_filename") or "估值模型")),
            str(document.get("company_name") or ""),
            str(document.get("company_ticker") or ""),
            str(document.get("doc_subtype") or "valuation_model"),
            now,
            now,
        ),
    )
    row = conn.execute(
        "SELECT * FROM valuation_model_series WHERE dataset_id=? AND series_key=?",
        (dataset_id, key),
    ).fetchone()
    if row is None:
        raise RuntimeError("failed to create valuation model series")
    return row


def _metric_profile(metric_name: str) -> tuple[str, str] | None:
    text = _normalize(metric_name)
    for metric_key, node_kind, terms in _METRIC_PROFILES:
        if any(_normalize(term) in text for term in terms):
            return metric_key, node_kind
    return None


def _scenario(metric_name: str, sheet_name: str) -> str:
    text = _normalize(f"{metric_name} {sheet_name}")
    if any(term in text for term in ("bull", "upside", "进取", "乐观")):
        return "upside"
    if any(term in text for term in ("bear", "downside", "防守", "悲观")):
        return "downside"
    return "base"


def _formula_fingerprint(formula: Any) -> str:
    text = unicodedata.normalize("NFKC", str(formula or "")).strip().lower()
    if not text:
        return ""
    text = text.replace("$", "")
    return re.sub(r"\s+", "", text)


def _candidate_score(candidate: dict[str, Any]) -> float:
    score = float(candidate.get("confidence") or 0)
    if candidate.get("quality_status") == "candidate_complete":
        score += 2.0
    if candidate.get("value_numeric") is not None:
        score += 0.6
    if candidate.get("formula"):
        score += 0.2
    return score


def _extract_snapshot_nodes(
    conn: sqlite3.Connection, document: dict[str, Any]
) -> list[dict[str, Any]]:
    tables = _tables(conn)
    if "metric_facts" not in tables:
        return []
    sheet_join = (
        "LEFT JOIN excel_sheets s ON s.doc_id=f.doc_id AND s.sheet_name=f.sheet_name"
        if "excel_sheets" in tables
        else ""
    )
    sheet_role = "COALESCE(s.sheet_role, 'worksheet')" if sheet_join else "'worksheet'"
    rows = conn.execute(
        f"""
        SELECT f.*, {sheet_role} AS sheet_role
        FROM metric_facts f
        {sheet_join}
        WHERE f.doc_id=? AND COALESCE(f.quality_status,'review_required')<>'rejected'
        ORDER BY f.sheet_name, f.cell_ref, f.fact_id
        """,
        (document["doc_id"],),
    ).fetchall()
    selected: dict[str, dict[str, Any]] = {}
    for row in rows:
        profile = _metric_profile(str(row["metric_name"] or ""))
        if profile is None:
            continue
        metric_key, node_kind = profile
        sheet_role_value = str(row["sheet_role"] or "worksheet")
        if sheet_role_value == "sensitivity":
            node_kind = "sensitivity"
        scope = (
            sheet_role_value
            if sheet_role_value not in {"worksheet", "output_table", "table"}
            else _key_part(row["sheet_name"], fallback="worksheet")
        )
        period = _normalize(row["period"] or "current") or "current"
        scenario = _scenario(str(row["metric_name"] or ""), str(row["sheet_name"] or ""))
        canonical_key = "/".join(
            (
                node_kind,
                _key_part(scope),
                metric_key,
                _key_part(period, fallback="current"),
                scenario,
            )
        )
        metadata = _decode(row["metadata_json"], {})
        candidate = {
            "canonical_key": canonical_key,
            "node_kind": node_kind,
            "metric_key": metric_key,
            "display_name": str(row["metric_name"] or metric_key)[:240],
            "scope": scope,
            "period": period,
            "scenario": scenario,
            "value_numeric": _safe_float(row["value_numeric"]),
            "value_text": str(row["value_text"] or "")[:500],
            "unit": str(row["unit"] or "")[:80],
            "formula": str(row["formula"] or "")[:4000],
            "formula_fingerprint": _formula_fingerprint(row["formula"]),
            "sheet_name": str(row["sheet_name"] or ""),
            "cell_ref": str(row["cell_ref"] or ""),
            "evidence_id": f"fact:{row['fact_id']}",
            "quality_status": str(row["quality_status"] or "review_required"),
            "confidence": float(row["confidence"] or 0.5),
            "metadata": {
                "source_range": row["source_range"],
                "fact_status": row["fact_status"],
                "quality_issues": _decode(row["quality_issues_json"], []),
                "sheet_role": sheet_role_value,
                "formula_cache_status": metadata.get("formula_cache_status"),
            },
        }
        current = selected.get(canonical_key)
        if current is None or _candidate_score(candidate) > _candidate_score(current):
            selected[canonical_key] = candidate
    return [selected[key] for key in sorted(selected)]


def _snapshot_hash(nodes: list[dict[str, Any]]) -> str:
    payload = [
        {
            "key": node["canonical_key"],
            "value_numeric": node["value_numeric"],
            "value_text": node["value_text"],
            "unit": node["unit"],
            "formula": node["formula_fingerprint"],
        }
        for node in nodes
    ]
    return hashlib.sha256(_json(payload).encode("utf-8")).hexdigest()


def _value_payload(row: sqlite3.Row | dict[str, Any] | None) -> dict[str, Any]:
    if row is None:
        return {}
    payload = dict(row)
    payload["metadata"] = _decode(payload.pop("metadata_json", None), {})
    return payload


def _version_values(conn: sqlite3.Connection, model_version_id: str) -> dict[str, dict[str, Any]]:
    rows = conn.execute(
        """
        SELECT n.canonical_key, n.node_kind, n.metric_key, n.display_name,
               n.scope, n.period, n.scenario, v.*
        FROM valuation_model_node_values v
        JOIN valuation_model_nodes n ON n.node_id=v.node_id
        WHERE v.model_version_id=?
        ORDER BY n.canonical_key
        """,
        (model_version_id,),
    ).fetchall()
    return {str(row["canonical_key"]): _value_payload(row) for row in rows}


def _numeric_change(
    old: dict[str, Any], new: dict[str, Any]
) -> tuple[bool, float | None, float | None]:
    old_number = _safe_float(old.get("value_numeric"))
    new_number = _safe_float(new.get("value_numeric"))
    if old_number is not None and new_number is not None:
        absolute = new_number - old_number
        relative = absolute / abs(old_number) if abs(old_number) > 1e-12 else None
        tolerance = max(1e-9, abs(old_number) * 1e-9)
        return abs(absolute) > tolerance, absolute, relative
    changed = _normalize(old.get("value_text")) != _normalize(new.get("value_text"))
    return changed, None, None


def _materiality(
    *,
    node_kind: str,
    metric_key: str,
    change_type: str,
    absolute_change: float | None,
    relative_change: float | None,
    old: dict[str, Any],
    new: dict[str, Any],
) -> str:
    if change_type == "removed" and node_kind in {"assumption", "output"}:
        return "high"
    if change_type in {"formula_changed", "value_and_formula_changed"}:
        return "high" if node_kind in {"assumption", "output"} else "medium"
    relative = abs(relative_change or 0.0)
    if metric_key == "target_price":
        return "high" if relative >= 0.10 else "medium" if relative >= 0.05 else "low"
    if metric_key in {"wacc", "terminal_growth", "risk_free_rate", "cost_of_debt"}:
        old_number = abs(_safe_float(old.get("value_numeric")) or 0.0)
        new_number = abs(_safe_float(new.get("value_numeric")) or 0.0)
        scale = 1.0 if max(old_number, new_number) <= 1.0 else 100.0
        normalized_absolute = abs(absolute_change or 0.0) / scale
        if normalized_absolute >= 0.005:
            return "high"
        return "medium" if normalized_absolute >= 0.0025 else "low"
    if node_kind in {"forecast", "output"}:
        return "high" if relative >= 0.10 else "medium" if relative >= 0.05 else "low"
    if change_type == "added" and node_kind == "output":
        return "medium"
    return "medium" if relative >= 0.10 else "low"


def _diff_value_maps(
    old_values: dict[str, dict[str, Any]], new_values: dict[str, dict[str, Any]]
) -> list[dict[str, Any]]:
    changes: list[dict[str, Any]] = []
    for canonical_key in sorted(set(old_values) | set(new_values)):
        old = old_values.get(canonical_key, {})
        new = new_values.get(canonical_key, {})
        current = new or old
        if not old:
            change_type = "added"
            value_changed, absolute_change, relative_change = True, None, None
            formula_changed = bool(new.get("formula_fingerprint"))
        elif not new:
            change_type = "removed"
            value_changed, absolute_change, relative_change = True, None, None
            formula_changed = bool(old.get("formula_fingerprint"))
        else:
            value_changed, absolute_change, relative_change = _numeric_change(old, new)
            formula_changed = str(old.get("formula_fingerprint") or "") != str(
                new.get("formula_fingerprint") or ""
            )
            if not value_changed and not formula_changed:
                continue
            if value_changed and formula_changed:
                change_type = "value_and_formula_changed"
            elif formula_changed:
                change_type = "formula_changed"
            else:
                change_type = "value_changed"
        materiality = _materiality(
            node_kind=str(current.get("node_kind") or "forecast"),
            metric_key=str(current.get("metric_key") or "unknown"),
            change_type=change_type,
            absolute_change=absolute_change,
            relative_change=relative_change,
            old=old,
            new=new,
        )
        old_display = old.get("value_text") or old.get("value_numeric") or "—"
        new_display = new.get("value_text") or new.get("value_numeric") or "—"
        title = str(current.get("display_name") or current.get("metric_key") or canonical_key)
        changes.append(
            {
                "canonical_key": canonical_key,
                "node_id": current.get("node_id"),
                "node_kind": current.get("node_kind"),
                "metric_key": current.get("metric_key"),
                "display_name": title,
                "scope": current.get("scope"),
                "period": current.get("period"),
                "scenario": current.get("scenario"),
                "change_type": change_type,
                "materiality": materiality,
                "summary": f"{title}：{old_display} → {new_display}",
                "old_value": old,
                "new_value": new,
                "absolute_change": absolute_change,
                "relative_change": relative_change,
                "evidence_ids": list(
                    dict.fromkeys(
                        value
                        for value in (old.get("evidence_id"), new.get("evidence_id"))
                        if value
                    )
                ),
            }
        )
    return sorted(
        changes,
        key=lambda item: (
            -MATERIALITY_RANK.get(str(item["materiality"]), 0),
            str(item["node_kind"]),
            str(item["display_name"]),
        ),
    )


def _matching_rules(
    conn: sqlite3.Connection,
    dataset_id: str,
    series_id: str,
    change: dict[str, Any],
) -> list[sqlite3.Row]:
    rules = conn.execute(
        """
        SELECT * FROM valuation_watch_rules
        WHERE dataset_id=? AND active=1 AND (series_id IS NULL OR series_id='' OR series_id=?)
        ORDER BY created_at
        """,
        (dataset_id, series_id),
    ).fetchall()
    matched = []
    for rule in rules:
        if MATERIALITY_RANK.get(str(change["materiality"]), 0) < MATERIALITY_RANK.get(
            str(rule["min_materiality"]), 1
        ):
            continue
        change_types = _decode(rule["change_types_json"], [])
        if change_types and change["change_type"] not in change_types:
            continue
        matched.append(rule)
    return matched


def _persist_changes_and_alerts(
    conn: sqlite3.Connection,
    *,
    dataset_id: str,
    series_id: str,
    from_model_version_id: str,
    to_model_version_id: str,
    changes: list[dict[str, Any]],
) -> tuple[int, int]:
    now = _now_iso()
    changes_created = 0
    alerts_created = 0
    for change in changes:
        node_id = str(change.get("node_id") or "")
        if not node_id:
            continue
        change_digest = _digest(
            from_model_version_id,
            to_model_version_id,
            node_id,
            change["change_type"],
        )
        change_id = f"vmc_{change_digest}"
        cursor = conn.execute(
            """
            INSERT OR IGNORE INTO valuation_model_changes
                (change_id, dataset_id, series_id, from_model_version_id,
                 to_model_version_id, node_id, change_type, materiality, summary,
                 old_value_json, new_value_json, absolute_change, relative_change,
                 evidence_ids_json, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                change_id,
                dataset_id,
                series_id,
                from_model_version_id,
                to_model_version_id,
                node_id,
                change["change_type"],
                change["materiality"],
                change["summary"],
                _json(change["old_value"]),
                _json(change["new_value"]),
                change["absolute_change"],
                change["relative_change"],
                _json(change["evidence_ids"]),
                now,
            ),
        )
        changes_created += int(cursor.rowcount > 0)
        for rule in _matching_rules(conn, dataset_id, series_id, change):
            dedupe_key = _digest(rule["rule_id"], change_id, length=40)
            alert_cursor = conn.execute(
                """
                INSERT OR IGNORE INTO valuation_alerts
                    (alert_id, dataset_id, series_id, rule_id, change_id,
                     alert_type, priority, title, summary, evidence_ids_json,
                     status, dedupe_key, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?, ?, ?)
                """,
                (
                    f"val_{_digest(dataset_id, dedupe_key)}",
                    dataset_id,
                    series_id,
                    rule["rule_id"],
                    change_id,
                    change["change_type"],
                    change["materiality"],
                    change["display_name"],
                    change["summary"],
                    _json(change["evidence_ids"]),
                    dedupe_key,
                    now,
                    now,
                ),
            )
            alerts_created += int(alert_cursor.rowcount > 0)
    return changes_created, alerts_created


def _analysis_markdown(
    series: sqlite3.Row,
    version: dict[str, Any],
    changes: list[dict[str, Any]],
    *,
    reverted_to_version_id: str,
) -> tuple[str, dict[str, Any]]:
    counts: dict[str, int] = {}
    for change in changes:
        materiality = str(change["materiality"])
        counts[materiality] = counts.get(materiality, 0) + 1
    highlights = changes[:20]
    lines = [
        f"# {series['name']} 估值模型分析 v{version['document_version_no']}",
        "",
        f"- 模型文件：`{version['original_filename']}`",
        f"- 结构化节点：{version['node_count']} 个",
        f"- 需要复核：{version['review_required_count']} 个",
    ]
    if reverted_to_version_id:
        lines.append(f"- 版本判断：当前快照恢复为历史版本 `{reverted_to_version_id}` 的内容")
    if not changes:
        lines.extend(["", "## 变化摘要", "", "这是该模型的基线版本，或没有识别到实质变化。"])
    else:
        lines.extend(["", "## 变化摘要", ""])
        for change in highlights:
            lines.append(
                f"- **{str(change['materiality']).upper()}** {change['summary']} "
                f"（{change['change_type']}）"
            )
    analysis = {
        "series_id": series["series_id"],
        "model_version_id": version["model_version_id"],
        "model_version_no": version["document_version_no"],
        "node_count": version["node_count"],
        "formula_node_count": version["formula_node_count"],
        "review_required_count": version["review_required_count"],
        "change_counts": counts,
        "reverted_to_version_id": reverted_to_version_id or None,
        "highlights": [
            {
                key: change.get(key)
                for key in (
                    "change_type",
                    "materiality",
                    "summary",
                    "metric_key",
                    "period",
                    "relative_change",
                    "evidence_ids",
                )
            }
            for change in highlights
        ],
    }
    return "\n".join(lines), analysis


def build_model_version(collection_db: Path, dataset_id: str, doc_id: str) -> dict[str, Any]:
    """Build one immutable valuation snapshot and compare it with its predecessor."""

    with _connect(collection_db) as conn:
        ensure_valuation_schema(conn, dataset_id)
        documents = _model_documents(conn, dataset_id, document_ids=[doc_id])
        if not documents:
            raise KeyError(doc_id)
        document = documents[0]
        series = _ensure_series(conn, dataset_id, document)
        existing = conn.execute(
            "SELECT * FROM valuation_model_versions WHERE doc_id=? AND analyzer_version=?",
            (doc_id, VALUATION_ANALYZER_VERSION),
        ).fetchone()
        if existing:
            overview = private_fund_valuation_overview.ensure_model_overview(
                conn,
                dataset_id=dataset_id,
                series=dict(series),
                version=dict(existing),
            )
            conn.commit()
            return {
                "model_version_id": existing["model_version_id"],
                "series_id": existing["series_id"],
                "node_count": existing["node_count"],
                "changes_created": 0,
                "alerts_created": 0,
                "overview_id": overview["overview_id"],
                "already_processed": True,
            }

        nodes = _extract_snapshot_nodes(conn, document)
        snapshot_hash = _snapshot_hash(nodes)
        previous = conn.execute(
            """
            SELECT * FROM valuation_model_versions
            WHERE series_id=? AND document_version_no<?
            ORDER BY document_version_no DESC, created_at DESC LIMIT 1
            """,
            (series["series_id"], int(document.get("version_no") or 1)),
        ).fetchone()
        reverted = conn.execute(
            """
            SELECT * FROM valuation_model_versions
            WHERE series_id=? AND snapshot_hash=?
            ORDER BY document_version_no LIMIT 1
            """,
            (series["series_id"], snapshot_hash),
        ).fetchone()
        model_version_id = (
            f"vmv_{_digest(series['series_id'], doc_id, VALUATION_ANALYZER_VERSION)}"
        )
        now = _now_iso()
        review_required_count = sum(
            1 for node in nodes if node["quality_status"] != "candidate_complete"
        )
        version_payload = {
            "model_version_id": model_version_id,
            "document_version_no": int(document.get("version_no") or 1),
            "original_filename": str(document.get("original_filename") or ""),
            "node_count": len(nodes),
            "formula_node_count": sum(1 for node in nodes if node["formula"]),
            "review_required_count": review_required_count,
        }
        conn.execute(
            """
            INSERT INTO valuation_model_versions
                (model_version_id, series_id, dataset_id, doc_id, logical_doc_id,
                 document_version_no, parent_model_version_id, reverted_to_version_id,
                 checksum, snapshot_hash, original_filename, document_date, model_type,
                 node_count, formula_node_count, review_required_count,
                 analyzer_version, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                model_version_id,
                series["series_id"],
                dataset_id,
                doc_id,
                document.get("logical_doc_id"),
                version_payload["document_version_no"],
                previous["model_version_id"] if previous else None,
                reverted["model_version_id"] if reverted else None,
                str(document.get("checksum") or ""),
                snapshot_hash,
                version_payload["original_filename"],
                document.get("document_date"),
                document.get("doc_subtype"),
                version_payload["node_count"],
                version_payload["formula_node_count"],
                review_required_count,
                VALUATION_ANALYZER_VERSION,
                now,
            ),
        )
        for node in nodes:
            node_id = f"vmn_{_digest(series['series_id'], node['canonical_key'])}"
            conn.execute(
                """
                INSERT INTO valuation_model_nodes
                    (node_id, series_id, canonical_key, node_kind, metric_key,
                     display_name, scope, period, scenario, first_seen_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(series_id, canonical_key) DO UPDATE SET
                    display_name=excluded.display_name, updated_at=excluded.updated_at
                """,
                (
                    node_id,
                    series["series_id"],
                    node["canonical_key"],
                    node["node_kind"],
                    node["metric_key"],
                    node["display_name"],
                    node["scope"],
                    node["period"],
                    node["scenario"],
                    now,
                    now,
                ),
            )

            conn.execute(
                """
                INSERT INTO valuation_model_node_values
                    (node_value_id, model_version_id, node_id, value_numeric,
                     value_text, unit, formula, formula_fingerprint, sheet_name,
                     cell_ref, evidence_id, quality_status, confidence,
                     metadata_json, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    f"vmnv_{_digest(model_version_id, node_id)}",
                    model_version_id,
                    node_id,
                    node["value_numeric"],
                    node["value_text"],
                    node["unit"],
                    node["formula"],
                    node["formula_fingerprint"],
                    node["sheet_name"],
                    node["cell_ref"],
                    node["evidence_id"],
                    node["quality_status"],
                    node["confidence"],
                    _json(node["metadata"]),
                    now,
                ),
            )

        overview_payload = private_fund_valuation_overview.ensure_model_overview(
            conn,
            dataset_id=dataset_id,
            series=dict(series),
            version={**dict(document), **version_payload, "doc_id": doc_id},
        )

        changes: list[dict[str, Any]] = []
        changes_created = alerts_created = 0
        if previous:
            changes = _diff_value_maps(
                _version_values(conn, str(previous["model_version_id"])),
                _version_values(conn, model_version_id),
            )
            changes_created, alerts_created = _persist_changes_and_alerts(
                conn,
                dataset_id=dataset_id,
                series_id=str(series["series_id"]),
                from_model_version_id=str(previous["model_version_id"]),
                to_model_version_id=model_version_id,
                changes=changes,
            )
        analysis_markdown, analysis = _analysis_markdown(
            series,
            version_payload,
            changes,
            reverted_to_version_id=str(reverted["model_version_id"]) if reverted else "",
        )
        previous_analysis = (
            conn.execute(
                """
                SELECT analysis_version_id FROM valuation_analysis_versions
                WHERE series_id=? ORDER BY created_at DESC LIMIT 1
                """,
                (series["series_id"],),
            ).fetchone()
            if previous
            else None
        )
        conn.execute(
            """
            INSERT INTO valuation_analysis_versions
                (analysis_version_id, dataset_id, series_id, model_version_id,
                 previous_analysis_version_id, status, summary_markdown,
                 analysis_json, analyzer_version, created_at)
            VALUES (?, ?, ?, ?, ?, 'completed', ?, ?, ?, ?)
            """,
            (
                f"vma_{_digest(model_version_id, VALUATION_ANALYZER_VERSION)}",
                dataset_id,
                series["series_id"],
                model_version_id,
                previous_analysis["analysis_version_id"] if previous_analysis else None,
                analysis_markdown,
                _json(analysis),
                VALUATION_ANALYZER_VERSION,
                now,
            ),
        )
        current_version_no = int(series["current_version_no"] or 0)
        if version_payload["document_version_no"] >= current_version_no:
            conn.execute(
                """
                UPDATE valuation_model_series
                SET current_model_version_id=?, current_version_no=?, updated_at=?
                WHERE series_id=?
                """,
                (
                    model_version_id,
                    version_payload["document_version_no"],
                    now,
                    series["series_id"],
                ),
            )
        conn.commit()
        return {
            "model_version_id": model_version_id,
            "series_id": series["series_id"],
            "node_count": len(nodes),
            "changes_created": changes_created,
            "alerts_created": alerts_created,
            "overview_id": overview_payload["overview_id"],
            "reverted_to_version_id": reverted["model_version_id"] if reverted else None,
            "already_processed": False,
        }


def _job_payload(row: sqlite3.Row | None) -> dict[str, Any]:
    if row is None:
        return {}
    payload = dict(row)
    payload["payload"] = _decode(payload.pop("payload_json"), {})
    payload["result"] = _decode(payload.pop("result_json"), None)
    return payload


def enqueue_job(
    collection_db: Path,
    dataset_id: str,
    *,
    job_type: str,
    source_id: str,
    payload: dict[str, Any] | None = None,
    priority: int = 100,
    max_attempts: int = 4,
    requeue_failed: bool = False,
) -> dict[str, Any]:
    now = _now_iso()
    job_id = f"vtj_{_digest(dataset_id, job_type, source_id, VALUATION_ANALYZER_VERSION)}"
    with _connect(collection_db) as conn:
        ensure_valuation_schema(conn, dataset_id)
        conn.execute(
            """
            INSERT OR IGNORE INTO valuation_tracking_jobs
                (job_id, dataset_id, job_type, source_id, payload_json,
                 analyzer_version, status, priority, max_attempts,
                 available_at, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?)
            """,
            (
                job_id,
                dataset_id,
                job_type,
                source_id,
                _json(payload or {}),
                VALUATION_ANALYZER_VERSION,
                int(priority),
                max(1, int(max_attempts)),
                now,
                now,
                now,
            ),
        )
        if requeue_failed:
            conn.execute(
                """
                UPDATE valuation_tracking_jobs
                SET status='queued', attempt_count=0, available_at=?, locked_at=NULL,
                    finished_at=NULL, last_error=NULL, updated_at=?
                WHERE job_id=? AND status='failed'
                """,
                (now, now, job_id),
            )
        conn.commit()
        row = conn.execute(
            "SELECT * FROM valuation_tracking_jobs WHERE job_id=?", (job_id,)
        ).fetchone()
        return _job_payload(row)


def enqueue_model_documents(
    collection_db: Path,
    dataset_id: str,
    *,
    document_ids: list[str] | None = None,
    include_history: bool = True,
    requeue_failed: bool = False,
) -> list[dict[str, Any]]:
    """Discover valuation models and enqueue one idempotent snapshot job per document version."""

    with _connect(collection_db) as conn:
        ensure_valuation_schema(conn, dataset_id)
        documents = _model_documents(
            conn,
            dataset_id,
            document_ids=document_ids,
            current_only=not include_history,
        )
        conn.commit()
    return [
        enqueue_job(
            collection_db,
            dataset_id,
            job_type="model_version_ingested",
            source_id=str(document["doc_id"]),
            payload={
                "doc_id": document["doc_id"],
                "logical_doc_id": document.get("logical_doc_id"),
                "document_version_no": document.get("version_no"),
            },
            priority=40 + int(document.get("version_no") or 1),
            requeue_failed=requeue_failed,
        )
        for document in documents
    ]


def _claim_job(conn: sqlite3.Connection) -> sqlite3.Row | None:
    now = _now_iso()
    conn.execute("BEGIN IMMEDIATE")
    row = conn.execute(
        """
        SELECT * FROM valuation_tracking_jobs
        WHERE status='queued' AND available_at<=?
        ORDER BY priority, created_at LIMIT 1
        """,
        (now,),
    ).fetchone()
    if row is None:
        conn.commit()
        return None
    conn.execute(
        """
        UPDATE valuation_tracking_jobs
        SET status='running', attempt_count=attempt_count+1, locked_at=?,
            started_at=COALESCE(started_at, ?), updated_at=?
        WHERE job_id=? AND status='queued'
        """,
        (now, now, now, row["job_id"]),
    )
    conn.commit()
    return conn.execute(
        "SELECT * FROM valuation_tracking_jobs WHERE job_id=?", (row["job_id"],)
    ).fetchone()


def recover_stale_jobs(
    collection_db: Path, dataset_id: str, *, stale_after_minutes: int = 30
) -> int:
    cutoff = (_now() - timedelta(minutes=stale_after_minutes)).isoformat()
    now = _now_iso()
    with _connect(collection_db) as conn:
        ensure_valuation_schema(conn, dataset_id)
        cursor = conn.execute(
            """
            UPDATE valuation_tracking_jobs
            SET status=CASE WHEN attempt_count>=max_attempts THEN 'failed' ELSE 'queued' END,
                locked_at=NULL, available_at=?,
                finished_at=CASE WHEN attempt_count>=max_attempts THEN ? ELSE NULL END,
                last_error=COALESCE(last_error,'worker lease expired'), updated_at=?
            WHERE dataset_id=? AND status='running' AND locked_at<?
            """,
            (now, now, now, dataset_id, cutoff),
        )
        conn.commit()
        return cursor.rowcount


def process_next_job(
    collection_db: Path,
    dataset_id: str,
    *,
    llm_client: Any | None = None,
) -> dict[str, Any] | None:
    with _connect(collection_db) as conn:
        ensure_valuation_schema(conn, dataset_id)
        conn.commit()
        job = _claim_job(conn)
    if job is None:
        return None
    try:
        if job["job_type"] == "model_version_ingested":
            result = build_model_version(collection_db, dataset_id, str(job["source_id"]))
        elif job["job_type"] == "agent_analysis":
            from omnigent.server import private_fund_valuation_agent

            analysis = private_fund_valuation_agent.run_agent_analysis(
                collection_db,
                dataset_id,
                str(job["source_id"]),
                llm_client=llm_client,
            )
            result = {
                "analysis_id": analysis["analysis_id"],
                "status": analysis["status"],
                "evidence_count": len(analysis.get("evidence_ids") or []),
                "recommendation_count": len(
                    (analysis.get("analysis") or {}).get("recommended_changes") or []
                ),
            }
        else:
            raise ValueError(f"unsupported valuation job type: {job['job_type']}")
        now = _now_iso()
        with _connect(collection_db) as conn:
            conn.execute(
                """
                UPDATE valuation_tracking_jobs
                SET status='completed', result_json=?, finished_at=?, locked_at=NULL,
                    last_error=NULL, updated_at=? WHERE job_id=?
                """,
                (_json(result), now, now, job["job_id"]),
            )
            conn.commit()
            return _job_payload(
                conn.execute(
                    "SELECT * FROM valuation_tracking_jobs WHERE job_id=?", (job["job_id"],)
                ).fetchone()
            )
    except Exception as exc:  # noqa: BLE001
        attempt_count = int(job["attempt_count"] or 0)
        max_attempts = int(job["max_attempts"] or 4)
        status = "failed" if attempt_count >= max_attempts else "queued"
        retry_index = min(max(0, attempt_count - 1), len(_RETRY_DELAYS_SECONDS) - 1)
        available_at = (_now() + timedelta(seconds=_RETRY_DELAYS_SECONDS[retry_index])).isoformat()
        now = _now_iso()
        with _connect(collection_db) as conn:
            conn.execute(
                """
                UPDATE valuation_tracking_jobs
                SET status=?, available_at=?, locked_at=NULL, finished_at=?,
                    last_error=?, updated_at=? WHERE job_id=?
                """,
                (
                    status,
                    available_at,
                    now if status == "failed" else None,
                    str(exc)[:2000],
                    now,
                    job["job_id"],
                ),
            )
            conn.commit()
            return _job_payload(
                conn.execute(
                    "SELECT * FROM valuation_tracking_jobs WHERE job_id=?", (job["job_id"],)
                ).fetchone()
            )


def _version_payload(conn: sqlite3.Connection, row: sqlite3.Row) -> dict[str, Any]:
    payload = dict(row)
    analysis = conn.execute(
        "SELECT * FROM valuation_analysis_versions WHERE model_version_id=?",
        (row["model_version_id"],),
    ).fetchone()
    if analysis:
        payload["analysis"] = {
            **dict(analysis),
            "analysis": _decode(analysis["analysis_json"], {}),
        }
        payload["analysis"].pop("analysis_json", None)
    else:
        payload["analysis"] = None
    return payload


def list_series(collection_db: Path, dataset_id: str) -> list[dict[str, Any]]:
    with _connect(collection_db) as conn:
        ensure_valuation_schema(conn, dataset_id)
        conn.commit()
        payloads = []
        for row in conn.execute(
            "SELECT * FROM valuation_model_series WHERE dataset_id=? ORDER BY updated_at DESC",
            (dataset_id,),
        ):
            payload = dict(row)
            versions = [
                _version_payload(conn, version)
                for version in conn.execute(
                    """
                    SELECT * FROM valuation_model_versions
                    WHERE series_id=? ORDER BY document_version_no DESC, created_at DESC
                    """,
                    (row["series_id"],),
                )
            ]
            payload["versions"] = versions
            payload["version_count"] = len(versions)
            latest_id = payload.get("current_model_version_id")
            latest = next(
                (version for version in versions if version["model_version_id"] == latest_id),
                versions[0] if versions else None,
            )
            payload["current_version"] = latest
            payloads.append(payload)
        return payloads


def get_model_version(
    collection_db: Path,
    dataset_id: str,
    model_version_id: str,
) -> dict[str, Any]:
    with _connect(collection_db) as conn:
        ensure_valuation_schema(conn, dataset_id)
        row = conn.execute(
            """
            SELECT * FROM valuation_model_versions
            WHERE dataset_id=? AND model_version_id=?
            """,
            (dataset_id, model_version_id),
        ).fetchone()
        if row is None:
            raise KeyError(model_version_id)
        return _version_payload(conn, row)


def get_model_overview(
    collection_db: Path,
    dataset_id: str,
    series_id: str,
    model_version_id: str,
) -> dict[str, Any]:
    """Return or idempotently backfill the structured and HTML model overview."""

    with _connect(collection_db) as conn:
        ensure_valuation_schema(conn, dataset_id)
        series = conn.execute(
            "SELECT * FROM valuation_model_series WHERE dataset_id=? AND series_id=?",
            (dataset_id, series_id),
        ).fetchone()
        version = conn.execute(
            """
            SELECT * FROM valuation_model_versions
            WHERE dataset_id=? AND series_id=? AND model_version_id=?
            """,
            (dataset_id, series_id, model_version_id),
        ).fetchone()
        if series is None or version is None:
            raise KeyError(model_version_id)
        overview = private_fund_valuation_overview.ensure_model_overview(
            conn,
            dataset_id=dataset_id,
            series=dict(series),
            version=dict(version),
        )
        conn.commit()
        return overview


def compare_versions(
    collection_db: Path,
    dataset_id: str,
    series_id: str,
    from_model_version_id: str,
    to_model_version_id: str,
) -> dict[str, Any]:
    with _connect(collection_db) as conn:
        ensure_valuation_schema(conn, dataset_id)
        series = conn.execute(
            "SELECT * FROM valuation_model_series WHERE dataset_id=? AND series_id=?",
            (dataset_id, series_id),
        ).fetchone()
        if series is None:
            raise KeyError(series_id)
        versions = {
            str(row["model_version_id"]): row
            for row in conn.execute(
                """
                SELECT * FROM valuation_model_versions
                WHERE series_id=? AND model_version_id IN (?, ?)
                """,
                (series_id, from_model_version_id, to_model_version_id),
            )
        }
        if from_model_version_id not in versions or to_model_version_id not in versions:
            raise KeyError("valuation model version")
        changes = _diff_value_maps(
            _version_values(conn, from_model_version_id),
            _version_values(conn, to_model_version_id),
        )
        return {
            "series": dict(series),
            "from_version": _version_payload(conn, versions[from_model_version_id]),
            "to_version": _version_payload(conn, versions[to_model_version_id]),
            "changes": changes,
        }


def list_jobs(collection_db: Path, dataset_id: str, *, limit: int = 50) -> list[dict[str, Any]]:
    with _connect(collection_db) as conn:
        ensure_valuation_schema(conn, dataset_id)
        rows = conn.execute(
            """
            SELECT * FROM valuation_tracking_jobs WHERE dataset_id=?
            ORDER BY created_at DESC LIMIT ?
            """,
            (dataset_id, max(1, min(limit, 200))),
        ).fetchall()
        return [_job_payload(row) for row in rows]


def list_rules(collection_db: Path, dataset_id: str) -> list[dict[str, Any]]:
    with _connect(collection_db) as conn:
        ensure_valuation_schema(conn, dataset_id)
        conn.commit()
        payloads = []
        for row in conn.execute(
            "SELECT * FROM valuation_watch_rules WHERE dataset_id=? ORDER BY created_at",
            (dataset_id,),
        ):
            payload = dict(row)
            payload["change_types"] = _decode(payload.pop("change_types_json"), [])
            payloads.append(payload)
        return payloads


def update_rule(
    collection_db: Path,
    dataset_id: str,
    rule_id: str,
    *,
    active: bool | None = None,
    min_materiality: str | None = None,
) -> dict[str, Any]:
    if min_materiality is not None and min_materiality not in MATERIALITY_RANK:
        raise ValueError("unsupported minimum materiality")
    with _connect(collection_db) as conn:
        ensure_valuation_schema(conn, dataset_id)
        current = conn.execute(
            "SELECT * FROM valuation_watch_rules WHERE dataset_id=? AND rule_id=?",
            (dataset_id, rule_id),
        ).fetchone()
        if current is None:
            raise KeyError(rule_id)
        conn.execute(
            """
            UPDATE valuation_watch_rules SET active=?, min_materiality=?, updated_at=?
            WHERE dataset_id=? AND rule_id=?
            """,
            (
                int(active) if active is not None else current["active"],
                min_materiality or current["min_materiality"],
                _now_iso(),
                dataset_id,
                rule_id,
            ),
        )
        conn.commit()
        payload = dict(
            conn.execute(
                "SELECT * FROM valuation_watch_rules WHERE rule_id=?", (rule_id,)
            ).fetchone()
        )
        payload["change_types"] = _decode(payload.pop("change_types_json"), [])
        return payload


def list_alerts(
    collection_db: Path,
    dataset_id: str,
    *,
    status: str | None = None,
    limit: int = 200,
) -> list[dict[str, Any]]:
    with _connect(collection_db) as conn:
        ensure_valuation_schema(conn, dataset_id)
        sql = "SELECT * FROM valuation_alerts WHERE dataset_id=?"
        params: list[Any] = [dataset_id]
        if status:
            sql += " AND status=?"
            params.append(status)
        sql += (
            " ORDER BY CASE priority WHEN 'critical' THEN 3 WHEN 'high' THEN 2 "
            "WHEN 'medium' THEN 1 ELSE 0 END DESC, created_at DESC LIMIT ?"
        )
        params.append(max(1, min(limit, 500)))
        payloads = []
        for row in conn.execute(sql, params):
            payload = dict(row)
            payload["evidence_ids"] = _decode(payload.pop("evidence_ids_json"), [])
            payloads.append(payload)
        return payloads


def update_alert_status(
    collection_db: Path,
    dataset_id: str,
    alert_id: str,
    *,
    status: str,
    snoozed_until: str = "",
) -> dict[str, Any]:
    if status not in ALERT_STATUSES:
        raise ValueError("unsupported alert status")
    normalized_snooze = ""
    if status == "snoozed":
        if not str(snoozed_until or "").strip():
            raise ValueError("snoozed_until is required when status is snoozed")
        parsed = datetime.fromisoformat(str(snoozed_until).replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        normalized_snooze = parsed.astimezone(timezone.utc).isoformat()
    with _connect(collection_db) as conn:
        ensure_valuation_schema(conn, dataset_id)
        cursor = conn.execute(
            """
            UPDATE valuation_alerts
            SET status=?, snoozed_until=?, updated_at=?
            WHERE dataset_id=? AND alert_id=?
            """,
            (status, normalized_snooze or None, _now_iso(), dataset_id, alert_id),
        )
        if cursor.rowcount == 0:
            raise KeyError(alert_id)
        conn.commit()
        payload = dict(
            conn.execute("SELECT * FROM valuation_alerts WHERE alert_id=?", (alert_id,)).fetchone()
        )
        payload["evidence_ids"] = _decode(payload.pop("evidence_ids_json"), [])
        return payload


def tracking_overview(collection_db: Path, dataset_id: str) -> dict[str, Any]:
    from omnigent.server import private_fund_valuation_agent

    with _connect(collection_db) as conn:
        ensure_valuation_schema(conn, dataset_id)
        now = _now_iso()
        conn.execute(
            """
            UPDATE valuation_alerts SET status='new', snoozed_until=NULL, updated_at=?
            WHERE dataset_id=? AND status='snoozed' AND snoozed_until IS NOT NULL
              AND snoozed_until<=?
            """,
            (now, dataset_id, now),
        )
        conn.commit()
        unread = int(
            conn.execute(
                "SELECT COUNT(*) FROM valuation_alerts WHERE dataset_id=? AND status='new'",
                (dataset_id,),
            ).fetchone()[0]
        )
        change_counts = {
            str(row["materiality"]): int(row["count"])
            for row in conn.execute(
                """
                SELECT materiality, COUNT(*) AS count FROM valuation_model_changes
                WHERE dataset_id=? GROUP BY materiality
                """,
                (dataset_id,),
            )
        }
    return {
        "dataset_id": dataset_id,
        "series": list_series(collection_db, dataset_id),
        "alerts": list_alerts(collection_db, dataset_id, limit=100),
        "watch_rules": list_rules(collection_db, dataset_id),
        "jobs": list_jobs(collection_db, dataset_id, limit=50),
        "agent_analyses": private_fund_valuation_agent.list_analyses(
            collection_db, dataset_id, limit=50
        ),
        "derived_models": private_fund_valuation_agent.list_derived_models(
            collection_db, dataset_id, limit=50
        ),
        "unread_alert_count": unread,
        "change_counts": change_counts,
        "analyzer_version": VALUATION_ANALYZER_VERSION,
    }
