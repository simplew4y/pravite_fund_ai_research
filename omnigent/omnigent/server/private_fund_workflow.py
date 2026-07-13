"""Persistent research workflows for private-fund datasets."""

from __future__ import annotations

import hashlib
import json
import re
import sqlite3
from collections import deque
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urlencode

WORKFLOW_TYPE = "agentic_research_graph_v2"

_NODE_DEFINITIONS = (
    {
        "node_id": "source-review",
        "node_type": "source",
        "title": "资料审阅",
        "objective": "确认资料范围、版本、解析质量与缺失项",
        "summary": "资料版本、解析质量与覆盖范围",
        "position_no": 10,
        "x": 0,
        "y": 280,
        "tone": "sage",
        "kind": "source",
    },
    {
        "node_id": "business-analysis",
        "node_type": "analysis",
        "title": "经营分析",
        "objective": "分析增长质量、盈利能力、现金流和竞争格局",
        "summary": "增长、盈利、现金流与竞争格局",
        "position_no": 20,
        "x": 240,
        "y": 280,
        "tone": "mist",
        "kind": "analysis",
    },
    {
        "node_id": "core-assumptions",
        "node_type": "assumption",
        "title": "核心假设",
        "objective": "固化关键经营假设、证据、不确定性和待验证项",
        "summary": "关键变量、证据与待验证项",
        "position_no": 30,
        "x": 480,
        "y": 280,
        "tone": "sand",
        "kind": "assumption",
    },
    {
        "node_id": "scenario-analysis",
        "node_type": "scenario_group",
        "title": "情景分析",
        "objective": "定义防守、基准和进取情景的共同变量",
        "summary": "统一情景变量与边界条件",
        "position_no": 40,
        "x": 720,
        "y": 280,
        "tone": "blue",
        "kind": "scenario",
    },
    {
        "node_id": "defensive-scenario",
        "node_type": "scenario",
        "title": "防守情景",
        "objective": "评估需求、价格或利润率低于预期时的结果",
        "summary": "下行情景及风险暴露",
        "position_no": 50,
        "x": 960,
        "y": 100,
        "tone": "coral",
        "kind": "defensive",
    },
    {
        "node_id": "base-scenario",
        "node_type": "scenario",
        "title": "基准情景",
        "objective": "形成当前证据支持度最高的经营与估值情景",
        "summary": "最可能情景与关键变量",
        "position_no": 60,
        "x": 960,
        "y": 280,
        "tone": "blue",
        "kind": "base",
    },
    {
        "node_id": "growth-scenario",
        "node_type": "scenario",
        "title": "进取情景",
        "objective": "评估需求、份额或盈利能力超预期时的结果",
        "summary": "上行情景与兑现条件",
        "position_no": 70,
        "x": 960,
        "y": 460,
        "tone": "coral",
        "kind": "growth",
    },
    {
        "node_id": "valuation",
        "node_type": "valuation",
        "title": "估值",
        "objective": "基于三个情景形成估值区间和敏感性分析",
        "summary": "多情景估值与敏感性",
        "position_no": 80,
        "x": 1200,
        "y": 280,
        "tone": "lilac",
        "kind": "valuation",
    },
    {
        "node_id": "investment-conclusion",
        "node_type": "conclusion",
        "title": "投资结论",
        "objective": "形成结论、风险、催化剂和待跟踪事项",
        "summary": "结论、风险、催化剂与跟踪项",
        "position_no": 90,
        "x": 1440,
        "y": 280,
        "tone": "lilac",
        "kind": "conclusion",
    },
)

_DEPENDENCIES = (
    ("business-analysis", "source-review"),
    ("core-assumptions", "business-analysis"),
    ("scenario-analysis", "core-assumptions"),
    ("defensive-scenario", "scenario-analysis"),
    ("base-scenario", "scenario-analysis"),
    ("growth-scenario", "scenario-analysis"),
    ("valuation", "defensive-scenario"),
    ("valuation", "base-scenario"),
    ("valuation", "growth-scenario"),
    ("investment-conclusion", "valuation"),
)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True)


_RICH_CONTENT_BLOCK_TYPES = frozenset({"markdown", "metrics", "table", "chart", "html"})
_EVIDENCE_ID_PATTERN = re.compile(r"^(?:chunk|fact|cell):[A-Za-z0-9_.-]+$")


def _normalize_evidence_ids(value: Any) -> list[str]:
    """Accept only resolvable evidence IDs and never iterate a JSON string by character."""
    if isinstance(value, str):
        candidate = value.strip()
        try:
            decoded = json.loads(candidate)
        except (TypeError, ValueError):
            decoded = candidate
        value = decoded if isinstance(decoded, list) else [decoded]
    if not isinstance(value, list | tuple | set):
        return []
    normalized: list[str] = []
    for raw in value:
        evidence_id = str(raw or "").strip()
        if _EVIDENCE_ID_PATTERN.fullmatch(evidence_id) and evidence_id not in normalized:
            normalized.append(evidence_id)
    return normalized


def _normalize_content_blocks(value: Any) -> list[dict[str, Any]]:
    """Validate and bound agent-authored node presentation blocks.

    Blocks remain JSON data. In particular, HTML is stored but never executed
    by the server; the web client renders it in a scriptless sandbox.
    """
    if not isinstance(value, list):
        return []
    normalized: list[dict[str, Any]] = []
    for raw in value[:12]:
        if not isinstance(raw, dict) or raw.get("type") not in _RICH_CONTENT_BLOCK_TYPES:
            continue
        block_type = str(raw["type"])
        title = str(raw.get("title") or "")[:160]
        block: dict[str, Any] = {"type": block_type}
        evidence_ids = _normalize_evidence_ids(raw.get("evidence_ids"))
        if evidence_ids:
            block["evidence_ids"] = evidence_ids
        if title:
            block["title"] = title
        if block_type == "markdown":
            markdown = str(raw.get("markdown") or "")[:50_000]
            if not markdown.strip():
                continue
            block["markdown"] = markdown
        elif block_type == "metrics":
            items = []
            for item in (raw.get("items") if isinstance(raw.get("items"), list) else [])[:8]:
                if not isinstance(item, dict) or not str(item.get("label") or "").strip():
                    continue
                items.append(
                    {
                        "label": str(item.get("label") or "")[:80],
                        "value": str(item.get("value") or "")[:80],
                        "unit": str(item.get("unit") or "")[:24],
                        "delta": str(item.get("delta") or "")[:40],
                        "sentiment": str(item.get("sentiment") or "neutral")
                        if item.get("sentiment") in {"positive", "negative", "neutral"}
                        else "neutral",
                    }
                )
            if not items:
                continue
            block["items"] = items
        elif block_type == "table":
            columns = []
            for column in (raw.get("columns") if isinstance(raw.get("columns"), list) else [])[
                :12
            ]:
                if not isinstance(column, dict) or not str(column.get("key") or "").strip():
                    continue
                columns.append(
                    {
                        "key": str(column.get("key") or "")[:80],
                        "label": str(column.get("label") or column.get("key") or "")[:80],
                        "align": "right" if column.get("align") == "right" else "left",
                    }
                )
            raw_rows = raw.get("rows") if isinstance(raw.get("rows"), list) else []
            rows = [row for row in raw_rows[:100] if isinstance(row, dict)]
            if not columns or not rows:
                continue
            block["columns"] = columns
            block["rows"] = [
                {column["key"]: str(row.get(column["key"], ""))[:500] for column in columns}
                for row in rows
            ]
        elif block_type == "chart":
            x_key = str(raw.get("x_key") or "")[:80]
            series = []
            for item in (raw.get("series") if isinstance(raw.get("series"), list) else [])[:6]:
                if not isinstance(item, dict) or not str(item.get("key") or "").strip():
                    continue
                series.append(
                    {
                        "key": str(item.get("key") or "")[:80],
                        "label": str(item.get("label") or item.get("key") or "")[:80],
                    }
                )
            raw_data = raw.get("data") if isinstance(raw.get("data"), list) else []
            data = [row for row in raw_data[:120] if isinstance(row, dict)]
            if not x_key or not series or not data:
                continue
            keys = [x_key, *(item["key"] for item in series)]
            block.update(
                {
                    "chart_type": "bar" if raw.get("chart_type") == "bar" else "line",
                    "x_key": x_key,
                    "series": series,
                    "data": [{key: row.get(key) for key in keys} for row in data],
                    "y_unit": str(raw.get("y_unit") or "")[:24],
                    "source_note": str(raw.get("source_note") or "")[:300],
                }
            )
        else:
            html = str(raw.get("html") or "")[:50_000]
            if not html.strip():
                continue
            height = raw.get("height")
            block["html"] = html
            block["height"] = min(
                max(int(height) if isinstance(height, int | float) else 320, 160), 720
            )
        normalized.append(block)
    return normalized


def _workflow_id(dataset_id: str) -> str:
    digest = hashlib.sha256(f"{dataset_id}:{WORKFLOW_TYPE}".encode()).hexdigest()[:16]
    return f"wf_{digest}"


def _connect(collection_db: Path) -> sqlite3.Connection:
    collection_db.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(collection_db), timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=10000")
    return conn


def ensure_workflow_schema(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS research_workflows (
            workflow_id TEXT PRIMARY KEY,
            dataset_id TEXT NOT NULL,
            workflow_type TEXT NOT NULL,
            status TEXT NOT NULL,
            current_node_id TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS uq_research_workflows_dataset_type
            ON research_workflows(dataset_id, workflow_type);

        CREATE TABLE IF NOT EXISTS research_nodes (
            workflow_id TEXT NOT NULL,
            node_id TEXT NOT NULL,
            node_type TEXT NOT NULL,
            title TEXT NOT NULL,
            objective TEXT NOT NULL,
            summary TEXT NOT NULL,
            status TEXT NOT NULL,
            current_version_no INTEGER NOT NULL DEFAULT 0,
            position_no INTEGER NOT NULL,
            x REAL NOT NULL,
            y REAL NOT NULL,
            tone TEXT NOT NULL,
            kind TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            PRIMARY KEY (workflow_id, node_id)
        );

        CREATE TABLE IF NOT EXISTS research_node_dependencies (
            workflow_id TEXT NOT NULL,
            node_id TEXT NOT NULL,
            depends_on_node_id TEXT NOT NULL,
            dependency_type TEXT NOT NULL DEFAULT 'completion',
            PRIMARY KEY (workflow_id, node_id, depends_on_node_id)
        );

        CREATE TABLE IF NOT EXISTS research_node_versions (
            node_version_id TEXT PRIMARY KEY,
            workflow_id TEXT NOT NULL,
            node_id TEXT NOT NULL,
            version_no INTEGER NOT NULL,
            status TEXT NOT NULL,
            input_manifest_json TEXT NOT NULL,
            output_markdown TEXT,
            structured_output_json TEXT,
            prompt_snapshot TEXT,
            model_name TEXT,
            source_response_id TEXT,
            created_at TEXT NOT NULL,
            completed_at TEXT,
            UNIQUE (workflow_id, node_id, version_no)
        );

        CREATE TABLE IF NOT EXISTS research_node_evidence (
            node_version_id TEXT NOT NULL,
            evidence_id TEXT NOT NULL,
            relation_type TEXT NOT NULL DEFAULT 'supports',
            PRIMARY KEY (node_version_id, evidence_id)
        );

        CREATE TABLE IF NOT EXISTS research_assumptions (
            assumption_id TEXT PRIMARY KEY,
            workflow_id TEXT NOT NULL,
            node_id TEXT NOT NULL,
            content TEXT NOT NULL,
            source_response_id TEXT,
            status TEXT NOT NULL DEFAULT 'active',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS research_workflow_context (
            workflow_id TEXT NOT NULL,
            node_id TEXT NOT NULL,
            selected_at TEXT NOT NULL,
            PRIMARY KEY (workflow_id, node_id)
        );

        CREATE TABLE IF NOT EXISTS research_saved_assets (
            asset_id TEXT PRIMARY KEY,
            workflow_id TEXT NOT NULL,
            asset_type TEXT NOT NULL,
            title TEXT NOT NULL,
            summary TEXT NOT NULL,
            content_markdown TEXT NOT NULL,
            source_response_id TEXT,
            metadata_json TEXT NOT NULL DEFAULT '{}',
            tags_json TEXT NOT NULL DEFAULT '[]',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS ix_research_saved_assets_workflow
            ON research_saved_assets(workflow_id, updated_at DESC);

        CREATE TABLE IF NOT EXISTS research_asset_context (
            workflow_id TEXT NOT NULL,
            asset_id TEXT NOT NULL,
            selected_at TEXT NOT NULL,
            PRIMARY KEY (workflow_id, asset_id)
        );

        CREATE TABLE IF NOT EXISTS research_reports (
            report_id TEXT PRIMARY KEY,
            workflow_id TEXT NOT NULL,
            report_type TEXT NOT NULL,
            title TEXT NOT NULL,
            current_version_no INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS research_report_versions (
            report_version_id TEXT PRIMARY KEY,
            report_id TEXT NOT NULL,
            version_no INTEGER NOT NULL,
            node_versions_json TEXT NOT NULL,
            document_versions_json TEXT NOT NULL,
            markdown TEXT NOT NULL,
            created_at TEXT NOT NULL,
            UNIQUE (report_id, version_no)
        );

        CREATE TABLE IF NOT EXISTS research_equity_report_runs (
            run_id TEXT PRIMARY KEY,
            workflow_id TEXT NOT NULL,
            dataset_id TEXT NOT NULL,
            report_id TEXT NOT NULL,
            report_version_id TEXT NOT NULL,
            version_no INTEGER NOT NULL,
            status TEXT NOT NULL,
            title TEXT NOT NULL,
            request_json TEXT NOT NULL,
            report_package_json TEXT,
            artifact_manifest_json TEXT,
            render_engine TEXT,
            error TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            completed_at TEXT,
            UNIQUE (report_id, version_no)
        );
        CREATE INDEX IF NOT EXISTS ix_research_equity_report_runs_dataset
            ON research_equity_report_runs(dataset_id, created_at DESC);
        """
    )
    # Older tool payloads could accidentally persist every character of a JSON
    # string as an evidence ID. Those rows are not resolvable provenance.
    conn.execute(
        """
        DELETE FROM research_node_evidence
        WHERE evidence_id NOT LIKE 'chunk:%'
          AND evidence_id NOT LIKE 'fact:%'
          AND evidence_id NOT LIKE 'cell:%'
        """
    )


def _row_value(row: sqlite3.Row | None, key: str) -> Any:
    if row is None:
        return None
    try:
        return row[key]
    except (IndexError, KeyError):
        return None


def _document_evidence_payload(
    conn: sqlite3.Connection, evidence_id: str
) -> dict[str, Any] | None:
    kind, _, raw_id = evidence_id.partition(":")
    record: sqlite3.Row | None = None
    location: sqlite3.Row | None = None
    excerpt = ""
    doc_id = ""
    sheet_name = None
    cell_range = None
    if kind == "chunk":
        try:
            record = conn.execute("SELECT * FROM chunks WHERE chunk_id=?", (raw_id,)).fetchone()
        except sqlite3.Error:
            return None
        try:
            location = conn.execute(
                "SELECT * FROM chunk_locations WHERE chunk_id=? ORDER BY location_index LIMIT 1",
                (raw_id,),
            ).fetchone()
        except sqlite3.Error:
            location = None
        if record is not None:
            doc_id = str(_row_value(record, "doc_id") or "")
            excerpt = str(_row_value(record, "content") or _row_value(record, "summary") or "")
            sheet_name = _row_value(location, "sheet_name")
            cell_range = _row_value(location, "cell_range")
    elif kind == "fact":
        try:
            record = conn.execute(
                "SELECT * FROM metric_facts WHERE fact_id=?", (raw_id,)
            ).fetchone()
        except sqlite3.Error:
            return None
        if record is not None:
            doc_id = str(_row_value(record, "doc_id") or "")
            sheet_name = _row_value(record, "sheet_name")
            cell_range = _row_value(record, "cell_ref")
            excerpt = " ".join(
                str(value)
                for value in (
                    _row_value(record, "metric_name"),
                    _row_value(record, "period"),
                    _row_value(record, "value_text"),
                    _row_value(record, "unit"),
                )
                if value not in (None, "")
            )
    elif kind == "cell":
        try:
            record = conn.execute(
                "SELECT * FROM excel_cells WHERE cell_id=?", (raw_id,)
            ).fetchone()
        except sqlite3.Error:
            return None
        if record is not None:
            doc_id = str(_row_value(record, "doc_id") or "")
            sheet_name = _row_value(record, "sheet_name")
            cell_range = _row_value(record, "cell_ref")
            excerpt = str(
                _row_value(record, "display_value") or _row_value(record, "raw_value") or ""
            )
    if record is None or not doc_id:
        return None
    try:
        document = conn.execute("SELECT * FROM documents WHERE doc_id=?", (doc_id,)).fetchone()
    except sqlite3.Error:
        return None
    if document is None:
        return None
    document_name = str(_row_value(document, "original_filename") or doc_id)
    page_start = _row_value(location, "page_start")
    page_end = _row_value(location, "page_end")
    slide_start = _row_value(location, "slide_start")
    slide_end = _row_value(location, "slide_end")
    heading_path = _row_value(location, "heading_path")
    if page_start:
        suffix = (
            f"p.{page_start}-{page_end}"
            if page_end and page_end != page_start
            else f"p.{page_start}"
        )
    elif sheet_name:
        suffix = f"{sheet_name}!{cell_range}" if cell_range else str(sheet_name)
    elif slide_start:
        suffix = (
            f"slides {slide_start}-{slide_end}"
            if slide_end and slide_end != slide_start
            else f"slide {slide_start}"
        )
    elif heading_path:
        suffix = str(heading_path)
    else:
        suffix = "文档"
    source_root = _row_value(document, "source_root")
    source_relpath = _row_value(document, "source_relpath")
    source_path = (
        str(Path(str(source_root)) / str(source_relpath))
        if source_root and source_relpath
        else str(_row_value(document, "stored_path") or source_relpath or "")
    )
    source_url = None
    suffix_lower = Path(document_name).suffix.lower()
    if page_start and suffix_lower == ".pdf":
        params = {
            "page": str(page_start),
            "label": suffix,
            "pdf_name": document_name,
            "evidence_id": evidence_id,
        }
        if page_end and page_end != page_start:
            params["page_end"] = str(page_end)
        source_url = f"#private-fund-pdf-source?{urlencode(params)}"
    elif sheet_name and suffix_lower in {".xlsx", ".xlsm", ".xls", ".csv"}:
        params = {
            "workbook_name": document_name,
            "sheet_name": str(sheet_name),
            "label": f"{document_name} {suffix}",
        }
        if cell_range:
            params["range_ref"] = str(cell_range)
        source_url = f"#private-fund-excel-source?{urlencode(params)}"
    citation = f"{document_name} {suffix}"
    return {
        "evidence_id": evidence_id,
        "citation": citation,
        "source_url": source_url,
        "markdown_citation": f"[{citation}]({source_url})" if source_url else citation,
        "document_name": document_name,
        "source_path": source_path or None,
        "stored_path": _row_value(document, "stored_path"),
        "page_start": page_start,
        "page_end": page_end,
        "slide_start": slide_start,
        "slide_end": slide_end,
        "sheet_name": sheet_name,
        "cell_range": cell_range,
        "heading_path": heading_path,
        "excerpt": re.sub(r"\s+", " ", excerpt).strip()[:600],
    }


def _node_evidence_payloads(
    conn: sqlite3.Connection, node_version_id: str | None
) -> list[dict[str, Any]]:
    if not node_version_id:
        return []
    rows = conn.execute(
        """
        SELECT evidence_id, relation_type FROM research_node_evidence
        WHERE node_version_id=? ORDER BY rowid
        """,
        (node_version_id,),
    ).fetchall()
    payloads = []
    for row in rows:
        evidence_id = str(row["evidence_id"] or "").strip()
        if not _EVIDENCE_ID_PATTERN.fullmatch(evidence_id):
            continue
        payload = _document_evidence_payload(conn, evidence_id)
        if payload:
            payload["relation_type"] = row["relation_type"]
            payloads.append(payload)
    return payloads


def _document_manifest(conn: sqlite3.Connection) -> list[dict[str, Any]]:
    tables = {row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    if "documents" not in tables:
        return []
    columns = {row[1] for row in conn.execute("PRAGMA table_info(documents)")}
    selected = ["doc_id", "original_filename", "status"]
    for optional in ("logical_doc_id", "version_no", "source_relpath", "file_sha256"):
        if optional in columns:
            selected.append(optional)
    predicates = ["deleted_at IS NULL"] if "deleted_at" in columns else []
    if "is_current" in columns:
        predicates.append("COALESCE(is_current, 1) = 1")
    sql = f"SELECT {', '.join(selected)} FROM documents"
    if predicates:
        sql += " WHERE " + " AND ".join(predicates)
    sql += " ORDER BY original_filename, doc_id"
    return [dict(row) for row in conn.execute(sql)]


def _chunk_count(conn: sqlite3.Connection) -> int:
    try:
        return int(conn.execute("SELECT COUNT(*) FROM chunks").fetchone()[0] or 0)
    except sqlite3.Error:
        return 0


def _manifest_signature(documents: list[dict[str, Any]]) -> str:
    return hashlib.sha256(_json(documents).encode("utf-8")).hexdigest()


def _node_version_id(workflow_id: str, node_id: str, version_no: int) -> str:
    digest = hashlib.sha256(f"{workflow_id}\0{node_id}\0{version_no}".encode()).hexdigest()[:20]
    return f"nv_{digest}"


def _report_version_id(report_id: str, version_no: int) -> str:
    digest = hashlib.sha256(f"{report_id}\0{version_no}".encode()).hexdigest()[:20]
    return f"rv_{digest}"


def _ensure_workflow(conn: sqlite3.Connection, dataset_id: str) -> str:
    ensure_workflow_schema(conn)
    workflow_id = _workflow_id(dataset_id)
    now = _now_iso()
    conn.execute(
        """
        INSERT OR IGNORE INTO research_workflows
            (workflow_id, dataset_id, workflow_type, status, current_node_id,
             created_at, updated_at)
        VALUES (?, ?, ?, 'active', NULL, ?, ?)
        """,
        (workflow_id, dataset_id, WORKFLOW_TYPE, now, now),
    )
    conn.commit()
    return workflow_id


def _synchronize_source_version(conn: sqlite3.Connection, workflow_id: str) -> None:
    documents = _document_manifest(conn)
    chunks = _chunk_count(conn)
    if not documents or chunks <= 0:
        conn.execute(
            """
            UPDATE research_nodes SET status='pending', updated_at=?
            WHERE workflow_id=? AND node_id='source-review'
            """,
            (_now_iso(), workflow_id),
        )
        return
    signature = _manifest_signature(documents)
    current = conn.execute(
        """
        SELECT version_no, input_manifest_json
        FROM research_node_versions
        WHERE workflow_id=? AND node_id='source-review' AND status='completed'
        ORDER BY version_no DESC LIMIT 1
        """,
        (workflow_id,),
    ).fetchone()
    if current:
        previous = json.loads(current["input_manifest_json"] or "{}")
        if previous.get("document_signature") == signature:
            conn.execute(
                """
                UPDATE research_nodes SET status='completed', updated_at=?
                WHERE workflow_id=? AND node_id='source-review'
                """,
                (_now_iso(), workflow_id),
            )
            return
    version_no = int(current["version_no"] if current else 0) + 1
    now = _now_iso()
    node_version_id = _node_version_id(workflow_id, "source-review", version_no)
    manifest = {
        "document_signature": signature,
        "documents": documents,
        "chunk_count": chunks,
    }
    conn.execute(
        """
        INSERT INTO research_node_versions
            (node_version_id, workflow_id, node_id, version_no, status,
             input_manifest_json, output_markdown, structured_output_json,
             created_at, completed_at)
        VALUES (?, ?, 'source-review', ?, 'completed', ?, ?, ?, ?, ?)
        """,
        (
            node_version_id,
            workflow_id,
            version_no,
            _json(manifest),
            f"已纳入 {len(documents)} 份当前资料，共 {chunks} 个可检索片段。",
            _json({"document_count": len(documents), "chunk_count": chunks}),
            now,
            now,
        ),
    )
    conn.execute(
        """
        UPDATE research_nodes
        SET status='completed', current_version_no=?, updated_at=?
        WHERE workflow_id=? AND node_id='source-review'
        """,
        (version_no, now, workflow_id),
    )
    if current:
        _mark_downstream_stale(conn, workflow_id, "source-review")


def _dependencies_completed(conn: sqlite3.Connection, workflow_id: str, node_id: str) -> bool:
    rows = conn.execute(
        """
        SELECT n.status
        FROM research_node_dependencies d
        JOIN research_nodes n
          ON n.workflow_id=d.workflow_id AND n.node_id=d.depends_on_node_id
        WHERE d.workflow_id=? AND d.node_id=?
        """,
        (workflow_id, node_id),
    ).fetchall()
    return bool(rows) and all(row["status"] == "completed" for row in rows)


def _refresh_ready_nodes(conn: sqlite3.Connection, workflow_id: str) -> None:
    rows = conn.execute(
        "SELECT node_id, status FROM research_nodes WHERE workflow_id=?",
        (workflow_id,),
    ).fetchall()
    now = _now_iso()
    for row in rows:
        if row["node_id"] == "source-review" or row["status"] not in {"pending", "ready"}:
            continue
        next_status = (
            "ready" if _dependencies_completed(conn, workflow_id, row["node_id"]) else "pending"
        )
        conn.execute(
            "UPDATE research_nodes SET status=?, updated_at=? WHERE workflow_id=? AND node_id=?",
            (next_status, now, workflow_id, row["node_id"]),
        )


def _mark_downstream_stale(conn: sqlite3.Connection, workflow_id: str, node_id: str) -> None:
    queue = deque([node_id])
    seen = {node_id}
    now = _now_iso()
    while queue:
        parent = queue.popleft()
        children = conn.execute(
            """
            SELECT node_id FROM research_node_dependencies
            WHERE workflow_id=? AND depends_on_node_id=?
            """,
            (workflow_id, parent),
        ).fetchall()
        for child in children:
            child_id = str(child["node_id"])
            if child_id in seen:
                continue
            seen.add(child_id)
            queue.append(child_id)
            conn.execute(
                """
                UPDATE research_nodes
                SET status=CASE WHEN current_version_no > 0 THEN 'stale' ELSE 'pending' END,
                    updated_at=?
                WHERE workflow_id=? AND node_id=?
                """,
                (now, workflow_id, child_id),
            )


def _input_manifest(conn: sqlite3.Connection, workflow_id: str, node_id: str) -> dict[str, Any]:
    documents = _document_manifest(conn)
    upstream = conn.execute(
        """
        SELECT d.depends_on_node_id AS node_id, n.current_version_no
        FROM research_node_dependencies d
        JOIN research_nodes n
          ON n.workflow_id=d.workflow_id AND n.node_id=d.depends_on_node_id
        WHERE d.workflow_id=? AND d.node_id=?
        ORDER BY d.depends_on_node_id
        """,
        (workflow_id, node_id),
    ).fetchall()
    assumptions = conn.execute(
        """
        SELECT assumption_id, node_id, content, created_at
        FROM research_assumptions
        WHERE workflow_id=? AND status='active'
        ORDER BY created_at
        """,
        (workflow_id,),
    ).fetchall()
    return {
        "document_signature": _manifest_signature(documents),
        "documents": documents,
        "upstream_node_versions": [dict(row) for row in upstream],
        "assumptions": [dict(row) for row in assumptions],
    }


def _workflow_payload(conn: sqlite3.Connection, workflow_id: str) -> dict[str, Any]:
    workflow = conn.execute(
        "SELECT * FROM research_workflows WHERE workflow_id=?", (workflow_id,)
    ).fetchone()
    nodes = conn.execute(
        """
        SELECT n.*,
               (SELECT COUNT(*) FROM research_assumptions a
                WHERE a.workflow_id=n.workflow_id AND a.node_id=n.node_id AND a.status='active')
                   AS assumption_count,
               (SELECT output_markdown FROM research_node_versions v
                WHERE v.workflow_id=n.workflow_id AND v.node_id=n.node_id
                  AND v.version_no=n.current_version_no) AS latest_output,
               (SELECT structured_output_json FROM research_node_versions v
                WHERE v.workflow_id=n.workflow_id AND v.node_id=n.node_id
                  AND v.version_no=n.current_version_no) AS latest_structured_output
               ,(SELECT node_version_id FROM research_node_versions v
                WHERE v.workflow_id=n.workflow_id AND v.node_id=n.node_id
                  AND v.version_no=n.current_version_no) AS latest_node_version_id
        FROM research_nodes n
        WHERE n.workflow_id=?
        ORDER BY n.position_no
        """,
        (workflow_id,),
    ).fetchall()
    edges = conn.execute(
        """
        SELECT node_id, depends_on_node_id, dependency_type
        FROM research_node_dependencies
        WHERE workflow_id=?
        ORDER BY node_id, depends_on_node_id
        """,
        (workflow_id,),
    ).fetchall()
    node_payloads = []
    for node in nodes:
        payload = dict(node)
        try:
            structured = json.loads(payload.pop("latest_structured_output") or "{}")
        except (TypeError, ValueError):
            structured = {}
        payload["content_blocks"] = _normalize_content_blocks(structured.get("content_blocks"))
        payload["evidence_sources"] = _node_evidence_payloads(
            conn, payload.pop("latest_node_version_id", None)
        )
        node_payloads.append(payload)
    return {
        "workflow": dict(workflow),
        "nodes": node_payloads,
        "edges": [
            {
                "edge_id": f"{edge['depends_on_node_id']}-to-{edge['node_id']}",
                "source": edge["depends_on_node_id"],
                "target": edge["node_id"],
                "dependency_type": edge["dependency_type"],
            }
            for edge in edges
        ],
        "context_node_ids": [
            row["node_id"]
            for row in conn.execute(
                """
                SELECT node_id FROM research_workflow_context
                WHERE workflow_id=? ORDER BY selected_at, rowid
                """,
                (workflow_id,),
            )
        ],
    }


def get_or_create_workflow(collection_db: Path, dataset_id: str) -> dict[str, Any]:
    with _connect(collection_db) as conn:
        workflow_id = _ensure_workflow(conn, dataset_id)
        return _workflow_payload(conn, workflow_id)


def list_saved_assets(collection_db: Path, dataset_id: str) -> dict[str, Any]:
    """Return durable user-created assets and the unified context selection."""
    with _connect(collection_db) as conn:
        workflow_id = _ensure_workflow(conn, dataset_id)
        rows = conn.execute(
            """
            SELECT * FROM research_saved_assets
            WHERE workflow_id=? ORDER BY updated_at DESC, asset_id
            """,
            (workflow_id,),
        ).fetchall()
        assets = []
        for row in rows:
            payload = dict(row)
            try:
                payload["metadata"] = json.loads(payload.pop("metadata_json") or "{}")
            except (TypeError, ValueError):
                payload["metadata"] = {}
            try:
                payload["tags"] = json.loads(payload.pop("tags_json") or "[]")
            except (TypeError, ValueError):
                payload["tags"] = []
            assets.append(payload)
        context_asset_ids = [
            row["asset_id"]
            for row in conn.execute(
                """
                SELECT asset_id FROM research_asset_context
                WHERE workflow_id=? ORDER BY selected_at, rowid
                """,
                (workflow_id,),
            )
        ]
        return {"assets": assets, "context_asset_ids": context_asset_ids}


def save_asset(
    collection_db: Path,
    dataset_id: str,
    *,
    asset_type: str,
    title: str,
    summary: str,
    content_markdown: str,
    source_response_id: str | None = None,
    metadata: dict[str, Any] | None = None,
    tags: list[str] | None = None,
) -> dict[str, Any]:
    if not title.strip() or not content_markdown.strip():
        raise ValueError("title and content_markdown are required")
    with _connect(collection_db) as conn:
        workflow_id = _ensure_workflow(conn, dataset_id)
        digest = hashlib.sha256(
            (
                f"{workflow_id}\0{asset_type}\0{source_response_id or ''}\0"
                f"{content_markdown.strip()}"
            ).encode()
        ).hexdigest()[:20]
        asset_id = f"asset_{digest}"
        now = _now_iso()
        conn.execute(
            """
            INSERT INTO research_saved_assets
                (asset_id, workflow_id, asset_type, title, summary, content_markdown,
                 source_response_id, metadata_json, tags_json, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(asset_id) DO UPDATE SET
                title=excluded.title, summary=excluded.summary,
                metadata_json=excluded.metadata_json, tags_json=excluded.tags_json,
                updated_at=excluded.updated_at
            """,
            (
                asset_id,
                workflow_id,
                (asset_type.strip() or "information")[:40],
                title.strip()[:240],
                (summary.strip() or content_markdown.strip())[:600],
                content_markdown.strip()[:100_000],
                (source_response_id or "")[:240] or None,
                _json(metadata or {}),
                _json([str(tag)[:80] for tag in (tags or [])[:20]]),
                now,
                now,
            ),
        )
        conn.commit()
        return {"asset_id": asset_id, **list_saved_assets(collection_db, dataset_id)}


def set_asset_context(
    collection_db: Path, dataset_id: str, asset_ids: list[str]
) -> dict[str, Any]:
    """Persist one context basket while keeping legacy node context compatible."""
    with _connect(collection_db) as conn:
        workflow_id = _ensure_workflow(conn, dataset_id)
        unique_ids = [
            str(value).strip() for value in dict.fromkeys(asset_ids) if str(value).strip()
        ]
        now = _now_iso()
        conn.execute("DELETE FROM research_asset_context WHERE workflow_id=?", (workflow_id,))
        conn.executemany(
            """
            INSERT INTO research_asset_context (workflow_id, asset_id, selected_at)
            VALUES (?, ?, ?)
            """,
            [(workflow_id, asset_id, now) for asset_id in unique_ids],
        )
        node_ids = [
            asset_id.removeprefix("node:")
            for asset_id in unique_ids
            if asset_id.startswith("node:")
        ]
        conn.execute("DELETE FROM research_workflow_context WHERE workflow_id=?", (workflow_id,))
        conn.executemany(
            """
            INSERT OR IGNORE INTO research_workflow_context (workflow_id, node_id, selected_at)
            SELECT ?, node_id, ? FROM research_nodes WHERE workflow_id=? AND node_id=?
            """,
            [(workflow_id, now, workflow_id, node_id) for node_id in node_ids],
        )
        conn.commit()
    return list_saved_assets(collection_db, dataset_id)


def delete_assets(collection_db: Path, dataset_id: str, asset_ids: list[str]) -> list[str]:
    """Delete workflow-backed assets and remove stale context references.

    Documents and rendered memo/report files live outside the workflow database
    and are deleted by the HTTP route. This helper owns saved information,
    research nodes, and individual rich-content blocks.
    """
    requested = [str(value).strip() for value in dict.fromkeys(asset_ids) if str(value).strip()]
    if not requested:
        return []

    with _connect(collection_db) as conn:
        workflow_id = _ensure_workflow(conn, dataset_id)
        saved_ids = {
            row["asset_id"]
            for row in conn.execute(
                "SELECT asset_id FROM research_saved_assets WHERE workflow_id=?",
                (workflow_id,),
            )
        }
        existing_nodes = {
            row["node_id"]
            for row in conn.execute(
                "SELECT node_id FROM research_nodes WHERE workflow_id=?",
                (workflow_id,),
            )
        }
        node_ids = {
            asset_id.removeprefix("node:")
            for asset_id in requested
            if asset_id.startswith("node:") and asset_id.removeprefix("node:") in existing_nodes
        }
        block_indexes: dict[str, set[int]] = {}
        for asset_id in requested:
            if not asset_id.startswith("block:"):
                continue
            node_id, separator, index_text = asset_id.removeprefix("block:").rpartition(":")
            if not separator or node_id not in existing_nodes or node_id in node_ids:
                continue
            try:
                index = int(index_text)
            except ValueError:
                continue
            if index >= 0:
                block_indexes.setdefault(node_id, set()).add(index)

        deleted: list[str] = []
        selected_saved_ids = [asset_id for asset_id in requested if asset_id in saved_ids]
        if selected_saved_ids:
            conn.executemany(
                "DELETE FROM research_saved_assets WHERE workflow_id=? AND asset_id=?",
                [(workflow_id, asset_id) for asset_id in selected_saved_ids],
            )
            deleted.extend(selected_saved_ids)

        for node_id, indexes in block_indexes.items():
            row = conn.execute(
                """
                SELECT v.node_version_id, v.structured_output_json
                FROM research_nodes n
                JOIN research_node_versions v
                  ON v.workflow_id=n.workflow_id
                 AND v.node_id=n.node_id
                 AND v.version_no=n.current_version_no
                WHERE n.workflow_id=? AND n.node_id=?
                """,
                (workflow_id, node_id),
            ).fetchone()
            if row is None:
                continue
            try:
                structured = json.loads(row["structured_output_json"] or "{}")
            except (TypeError, ValueError):
                structured = {}
            blocks = structured.get("content_blocks")
            if not isinstance(blocks, list):
                continue
            valid_indexes = {index for index in indexes if index < len(blocks)}
            if not valid_indexes:
                continue
            structured["content_blocks"] = [
                block for index, block in enumerate(blocks) if index not in valid_indexes
            ]
            conn.execute(
                """
                UPDATE research_node_versions
                SET structured_output_json=?
                WHERE node_version_id=?
                """,
                (_json(structured), row["node_version_id"]),
            )
            conn.execute(
                "UPDATE research_nodes SET updated_at=? WHERE workflow_id=? AND node_id=?",
                (_now_iso(), workflow_id, node_id),
            )
            # Block indexes are positional. Clear every block selection for the
            # edited node so a shifted index can never select the wrong block.
            conn.execute(
                "DELETE FROM research_asset_context WHERE workflow_id=? AND asset_id LIKE ?",
                (workflow_id, f"block:{node_id}:%"),
            )
            deleted.extend(f"block:{node_id}:{index}" for index in sorted(valid_indexes))

        for node_id in node_ids:
            conn.execute(
                """
                DELETE FROM research_node_evidence
                WHERE node_version_id IN (
                    SELECT node_version_id FROM research_node_versions
                    WHERE workflow_id=? AND node_id=?
                )
                """,
                (workflow_id, node_id),
            )
            conn.execute(
                "DELETE FROM research_node_versions WHERE workflow_id=? AND node_id=?",
                (workflow_id, node_id),
            )
            conn.execute(
                """
                DELETE FROM research_node_dependencies
                WHERE workflow_id=? AND (node_id=? OR depends_on_node_id=?)
                """,
                (workflow_id, node_id, node_id),
            )
            conn.execute(
                "DELETE FROM research_assumptions WHERE workflow_id=? AND node_id=?",
                (workflow_id, node_id),
            )
            conn.execute(
                "DELETE FROM research_workflow_context WHERE workflow_id=? AND node_id=?",
                (workflow_id, node_id),
            )
            conn.execute(
                """
                DELETE FROM research_asset_context
                WHERE workflow_id=? AND (asset_id=? OR asset_id LIKE ?)
                """,
                (workflow_id, f"node:{node_id}", f"block:{node_id}:%"),
            )
            conn.execute(
                "DELETE FROM research_nodes WHERE workflow_id=? AND node_id=?",
                (workflow_id, node_id),
            )
            deleted.append(f"node:{node_id}")

        if node_ids:
            conn.execute(
                """
                UPDATE research_workflows
                SET current_node_id = CASE
                        WHEN current_node_id IN ({}) THEN NULL
                        ELSE current_node_id
                    END,
                    updated_at = ?
                WHERE workflow_id = ?
                """.format(",".join("?" for _ in node_ids)),
                (*sorted(node_ids), _now_iso(), workflow_id),
            )

        conn.executemany(
            "DELETE FROM research_asset_context WHERE workflow_id=? AND asset_id=?",
            [(workflow_id, asset_id) for asset_id in requested],
        )
        conn.commit()
    requested_order = {asset_id: index for index, asset_id in enumerate(requested)}
    return sorted(set(deleted), key=lambda asset_id: requested_order.get(asset_id, len(requested)))


def save_agent_node(
    collection_db: Path,
    dataset_id: str,
    *,
    title: str,
    summary: str,
    content_markdown: str,
    node_type: str = "insight",
    parent_node_ids: list[str] | None = None,
    evidence_ids: list[str] | None = None,
    tags: list[str] | None = None,
    confidence: str | None = None,
    source_response_ids: list[str] | None = None,
    content_blocks: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    if not title.strip() or not summary.strip() or not content_markdown.strip():
        raise ValueError("title, summary, and content_markdown are required")
    with _connect(collection_db) as conn:
        workflow_id = _ensure_workflow(conn, dataset_id)
        parents = list(dict.fromkeys(parent_node_ids or []))
        for parent_id in parents:
            exists = conn.execute(
                "SELECT 1 FROM research_nodes WHERE workflow_id=? AND node_id=?",
                (workflow_id, parent_id),
            ).fetchone()
            if not exists:
                raise KeyError(parent_id)
        digest = hashlib.sha256(
            f"{workflow_id}\0{title}\0{content_markdown}\0{_now_iso()}".encode()
        ).hexdigest()[:16]
        node_id = f"node_{digest}"
        count = int(
            conn.execute(
                "SELECT COUNT(*) FROM research_nodes WHERE workflow_id=?", (workflow_id,)
            ).fetchone()[0]
        )
        depth = 0
        if parents:
            placeholders = ",".join("?" for _ in parents)
            rows = conn.execute(
                "SELECT x FROM research_nodes "
                f"WHERE workflow_id=? AND node_id IN ({placeholders})",
                (workflow_id, *parents),
            ).fetchall()
            depth = int(max((float(row["x"]) for row in rows), default=-240) // 240 + 1)
        siblings = int(
            conn.execute(
                "SELECT COUNT(*) FROM research_nodes WHERE workflow_id=? AND x=?",
                (workflow_id, depth * 240),
            ).fetchone()[0]
        )
        kind_map = {
            "insight": ("analysis", "mist"),
            "hypothesis": ("assumption", "sand"),
            "question": ("scenario", "blue"),
            "risk": ("defensive", "coral"),
            "catalyst": ("growth", "coral"),
            "comparison": ("valuation", "lilac"),
            "decision": ("conclusion", "lilac"),
        }
        kind, tone = kind_map.get(node_type, kind_map["insight"])
        now = _now_iso()
        structured = {
            "node_type": node_type,
            "tags": tags or [],
            "confidence": confidence,
            "source_response_ids": source_response_ids or [],
            "content_blocks": _normalize_content_blocks(content_blocks),
        }
        conn.execute(
            """
            INSERT INTO research_nodes
                (workflow_id, node_id, node_type, title, objective, summary, status,
                 current_version_no, position_no, x, y, tone, kind, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, 'completed', 1, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                workflow_id,
                node_id,
                node_type,
                title.strip(),
                summary.strip(),
                summary.strip(),
                (count + 1) * 10,
                depth * 240,
                100 + siblings * 160,
                tone,
                kind,
                now,
                now,
            ),
        )
        for parent_id in parents:
            conn.execute(
                """
                INSERT INTO research_node_dependencies
                    (workflow_id, node_id, depends_on_node_id, dependency_type)
                VALUES (?, ?, ?, 'context')
                """,
                (workflow_id, node_id, parent_id),
            )
        node_version_id = _node_version_id(workflow_id, node_id, 1)
        conn.execute(
            """
            INSERT INTO research_node_versions
                (node_version_id, workflow_id, node_id, version_no, status,
                 input_manifest_json, output_markdown, structured_output_json,
                 source_response_id, created_at, completed_at)
            VALUES (?, ?, ?, 1, 'completed', ?, ?, ?, ?, ?, ?)
            """,
            (
                node_version_id,
                workflow_id,
                node_id,
                _json(_input_manifest(conn, workflow_id, node_id)),
                content_markdown.strip(),
                _json(structured),
                ",".join(source_response_ids or []),
                now,
                now,
            ),
        )
        for evidence_id in _normalize_evidence_ids(evidence_ids):
            conn.execute(
                """
                INSERT INTO research_node_evidence
                    (node_version_id, evidence_id, relation_type)
                VALUES (?, ?, 'supports')
                """,
                (node_version_id, evidence_id),
            )
        conn.execute(
            """
            UPDATE research_workflows SET current_node_id=?, updated_at=?
            WHERE workflow_id=?
            """,
            (node_id, now, workflow_id),
        )
        conn.commit()
        return {
            "node_id": node_id,
            "node_version_id": node_version_id,
            **_workflow_payload(conn, workflow_id),
        }


def set_context_nodes(collection_db: Path, dataset_id: str, node_ids: list[str]) -> dict[str, Any]:
    with _connect(collection_db) as conn:
        workflow_id = _ensure_workflow(conn, dataset_id)
        unique_ids = list(dict.fromkeys(node_ids))
        for node_id in unique_ids:
            exists = conn.execute(
                "SELECT 1 FROM research_nodes WHERE workflow_id=? AND node_id=?",
                (workflow_id, node_id),
            ).fetchone()
            if not exists:
                raise KeyError(node_id)
        conn.execute("DELETE FROM research_workflow_context WHERE workflow_id=?", (workflow_id,))
        now = _now_iso()
        conn.executemany(
            """
            INSERT INTO research_workflow_context (workflow_id, node_id, selected_at)
            VALUES (?, ?, ?)
            """,
            [(workflow_id, node_id, now) for node_id in unique_ids],
        )
        conn.commit()
        return _workflow_payload(conn, workflow_id)


def select_current_node(collection_db: Path, dataset_id: str, node_id: str) -> dict[str, Any]:
    with _connect(collection_db) as conn:
        workflow_id = _ensure_workflow(conn, dataset_id)
        exists = conn.execute(
            "SELECT 1 FROM research_nodes WHERE workflow_id=? AND node_id=?",
            (workflow_id, node_id),
        ).fetchone()
        if not exists:
            raise KeyError(node_id)
        now = _now_iso()
        conn.execute(
            "UPDATE research_workflows SET current_node_id=?, updated_at=? WHERE workflow_id=?",
            (node_id, now, workflow_id),
        )
        conn.commit()
        return _workflow_payload(conn, workflow_id)


def start_node(
    collection_db: Path,
    dataset_id: str,
    node_id: str,
    *,
    prompt_snapshot: str | None = None,
    model_name: str | None = None,
) -> dict[str, Any]:
    with _connect(collection_db) as conn:
        workflow_id = _ensure_workflow(conn, dataset_id)
        node = conn.execute(
            "SELECT * FROM research_nodes WHERE workflow_id=? AND node_id=?",
            (workflow_id, node_id),
        ).fetchone()
        if not node:
            raise KeyError(node_id)
        if node["status"] not in {"ready", "completed", "stale", "running"}:
            raise ValueError("Upstream research nodes are not complete.")
        if node["status"] == "running":
            version = conn.execute(
                """
                SELECT * FROM research_node_versions
                WHERE workflow_id=? AND node_id=? AND status='running'
                ORDER BY version_no DESC LIMIT 1
                """,
                (workflow_id, node_id),
            ).fetchone()
            return {"node_version": dict(version), **_workflow_payload(conn, workflow_id)}
        version_no = int(node["current_version_no"] or 0) + 1
        node_version_id = _node_version_id(workflow_id, node_id, version_no)
        now = _now_iso()
        conn.execute(
            """
            INSERT INTO research_node_versions
                (node_version_id, workflow_id, node_id, version_no, status,
                 input_manifest_json, prompt_snapshot, model_name, created_at)
            VALUES (?, ?, ?, ?, 'running', ?, ?, ?, ?)
            """,
            (
                node_version_id,
                workflow_id,
                node_id,
                version_no,
                _json(_input_manifest(conn, workflow_id, node_id)),
                prompt_snapshot,
                model_name,
                now,
            ),
        )
        conn.execute(
            """
            UPDATE research_nodes SET status='running', updated_at=?
            WHERE workflow_id=? AND node_id=?
            """,
            (now, workflow_id, node_id),
        )
        conn.execute(
            "UPDATE research_workflows SET current_node_id=?, updated_at=? WHERE workflow_id=?",
            (node_id, now, workflow_id),
        )
        conn.commit()
        version = conn.execute(
            "SELECT * FROM research_node_versions WHERE node_version_id=?", (node_version_id,)
        ).fetchone()
        return {"node_version": dict(version), **_workflow_payload(conn, workflow_id)}


def complete_node(
    collection_db: Path,
    dataset_id: str,
    node_id: str,
    *,
    output_markdown: str,
    structured_output: dict[str, Any] | None = None,
    evidence_ids: list[str] | None = None,
    source_response_id: str | None = None,
    model_name: str | None = None,
) -> dict[str, Any]:
    if not output_markdown.strip():
        raise ValueError("Node output cannot be empty.")
    with _connect(collection_db) as conn:
        workflow_id = _ensure_workflow(conn, dataset_id)
        node = conn.execute(
            "SELECT * FROM research_nodes WHERE workflow_id=? AND node_id=?",
            (workflow_id, node_id),
        ).fetchone()
        if not node:
            raise KeyError(node_id)
        running = conn.execute(
            """
            SELECT * FROM research_node_versions
            WHERE workflow_id=? AND node_id=? AND status='running'
            ORDER BY version_no DESC LIMIT 1
            """,
            (workflow_id, node_id),
        ).fetchone()
        if running:
            version_no = int(running["version_no"])
            node_version_id = str(running["node_version_id"])
        else:
            version_no = int(node["current_version_no"] or 0) + 1
            node_version_id = _node_version_id(workflow_id, node_id, version_no)
            conn.execute(
                """
                INSERT INTO research_node_versions
                    (node_version_id, workflow_id, node_id, version_no, status,
                     input_manifest_json, created_at)
                VALUES (?, ?, ?, ?, 'running', ?, ?)
                """,
                (
                    node_version_id,
                    workflow_id,
                    node_id,
                    version_no,
                    _json(_input_manifest(conn, workflow_id, node_id)),
                    _now_iso(),
                ),
            )
        now = _now_iso()
        conn.execute(
            """
            UPDATE research_node_versions
            SET status='completed', output_markdown=?, structured_output_json=?,
                source_response_id=?, model_name=COALESCE(?, model_name), completed_at=?
            WHERE node_version_id=?
            """,
            (
                output_markdown.strip(),
                _json(structured_output or {}),
                source_response_id,
                model_name,
                now,
                node_version_id,
            ),
        )
        for evidence_id in _normalize_evidence_ids(evidence_ids):
            conn.execute(
                """
                INSERT OR IGNORE INTO research_node_evidence
                    (node_version_id, evidence_id, relation_type)
                VALUES (?, ?, 'supports')
                """,
                (node_version_id, evidence_id),
            )
        conn.execute(
            """
            UPDATE research_nodes
            SET status='completed', current_version_no=?, updated_at=?
            WHERE workflow_id=? AND node_id=?
            """,
            (version_no, now, workflow_id, node_id),
        )
        _mark_downstream_stale(conn, workflow_id, node_id)
        _refresh_ready_nodes(conn, workflow_id)
        conn.commit()
        return {
            "node_version_id": node_version_id,
            **_workflow_payload(conn, workflow_id),
        }


def add_assumption(
    collection_db: Path,
    dataset_id: str,
    node_id: str,
    *,
    content: str,
    source_response_id: str | None = None,
) -> dict[str, Any]:
    if not content.strip():
        raise ValueError("Assumption content cannot be empty.")
    with _connect(collection_db) as conn:
        workflow_id = _ensure_workflow(conn, dataset_id)
        exists = conn.execute(
            "SELECT 1 FROM research_nodes WHERE workflow_id=? AND node_id=?",
            (workflow_id, node_id),
        ).fetchone()
        if not exists:
            raise KeyError(node_id)
        now = _now_iso()
        digest = hashlib.sha256(
            f"{workflow_id}\0{node_id}\0{source_response_id or ''}\0{content}".encode()
        ).hexdigest()[:20]
        assumption_id = f"asm_{digest}"
        conn.execute(
            """
            INSERT OR IGNORE INTO research_assumptions
                (assumption_id, workflow_id, node_id, content, source_response_id,
                 status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, 'active', ?, ?)
            """,
            (assumption_id, workflow_id, node_id, content.strip(), source_response_id, now, now),
        )
        _mark_downstream_stale(conn, workflow_id, node_id)
        conn.commit()
        return {"assumption_id": assumption_id, **_workflow_payload(conn, workflow_id)}


def list_node_versions(collection_db: Path, dataset_id: str, node_id: str) -> list[dict[str, Any]]:
    with _connect(collection_db) as conn:
        workflow_id = _ensure_workflow(conn, dataset_id)
        rows = conn.execute(
            """
            SELECT * FROM research_node_versions
            WHERE workflow_id=? AND node_id=?
            ORDER BY version_no DESC
            """,
            (workflow_id, node_id),
        ).fetchall()
        return [dict(row) for row in rows]


def create_report_version(
    collection_db: Path,
    dataset_id: str,
    *,
    title: str,
    report_type: str = "investment_memo",
) -> dict[str, Any]:
    with _connect(collection_db) as conn:
        workflow_id = _ensure_workflow(conn, dataset_id)
        report_digest = hashlib.sha256(f"{workflow_id}:{report_type}".encode()).hexdigest()[:16]
        report_id = f"report_{report_digest}"
        now = _now_iso()
        conn.execute(
            """
            INSERT OR IGNORE INTO research_reports
                (report_id, workflow_id, report_type, title, current_version_no,
                 created_at, updated_at)
            VALUES (?, ?, ?, ?, 0, ?, ?)
            """,
            (report_id, workflow_id, report_type, title, now, now),
        )
        report = conn.execute(
            "SELECT * FROM research_reports WHERE report_id=?", (report_id,)
        ).fetchone()
        version_no = int(report["current_version_no"] or 0) + 1
        completed = conn.execute(
            """
            SELECT n.node_id, n.title, n.current_version_no, v.node_version_id,
                   v.output_markdown
            FROM research_nodes n
            JOIN research_node_versions v
              ON v.workflow_id=n.workflow_id AND v.node_id=n.node_id
             AND v.version_no=n.current_version_no
            WHERE n.workflow_id=? AND n.status IN ('completed', 'stale')
            ORDER BY n.position_no
            """,
            (workflow_id,),
        ).fetchall()
        sections = [f"# {title}"]
        for row in completed:
            sections.extend(["", f"## {row['title']}", "", row["output_markdown"] or ""])
        markdown = "\n".join(sections).strip() + "\n"
        node_versions = {row["node_id"]: row["node_version_id"] for row in completed}
        documents = _document_manifest(conn)
        report_version_id = _report_version_id(report_id, version_no)
        conn.execute(
            """
            INSERT INTO research_report_versions
                (report_version_id, report_id, version_no, node_versions_json,
                 document_versions_json, markdown, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                report_version_id,
                report_id,
                version_no,
                _json(node_versions),
                _json(documents),
                markdown,
                now,
            ),
        )
        conn.execute(
            """
            UPDATE research_reports
            SET title=?, current_version_no=?, updated_at=? WHERE report_id=?
            """,
            (title, version_no, now, report_id),
        )
        conn.commit()
        return {
            "report_id": report_id,
            "report_version_id": report_version_id,
            "version_no": version_no,
            "title": title,
            "markdown": markdown,
            "node_versions": node_versions,
            "document_versions": documents,
            "created_at": now,
        }


def reserve_equity_report_run(
    collection_db: Path,
    dataset_id: str,
    *,
    run_id: str,
    title: str,
    request: dict[str, Any],
) -> dict[str, Any]:
    """Reserve one durable FinRobot-aligned report version before rendering."""

    with _connect(collection_db) as conn:
        workflow_id = _ensure_workflow(conn, dataset_id)
        conn.execute("BEGIN IMMEDIATE")
        report_type = "finrobot_equity_report"
        report_digest = hashlib.sha256(f"{workflow_id}:{report_type}".encode()).hexdigest()[:16]
        report_id = f"report_{report_digest}"
        now = _now_iso()
        conn.execute(
            """
            INSERT OR IGNORE INTO research_reports
                (report_id, workflow_id, report_type, title, current_version_no,
                 created_at, updated_at)
            VALUES (?, ?, ?, ?, 0, ?, ?)
            """,
            (report_id, workflow_id, report_type, title, now, now),
        )
        row = conn.execute(
            "SELECT COALESCE(MAX(version_no), 0) AS version_no "
            "FROM research_equity_report_runs WHERE report_id=?",
            (report_id,),
        ).fetchone()
        version_no = int(row["version_no"] or 0) + 1
        report_version_id = _report_version_id(report_id, version_no)
        conn.execute(
            """
            INSERT INTO research_equity_report_runs
                (run_id, workflow_id, dataset_id, report_id, report_version_id,
                 version_no, status, title, request_json, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, 'rendering', ?, ?, ?, ?)
            """,
            (
                run_id,
                workflow_id,
                dataset_id,
                report_id,
                report_version_id,
                version_no,
                title,
                _json(request),
                now,
                now,
            ),
        )
        conn.commit()
        return {
            "run_id": run_id,
            "workflow_id": workflow_id,
            "report_id": report_id,
            "report_version_id": report_version_id,
            "version_no": version_no,
            "status": "rendering",
            "created_at": now,
        }


def complete_equity_report_run(
    collection_db: Path,
    *,
    run_id: str,
    markdown: str,
    report_package: dict[str, Any],
    artifact_manifest: dict[str, Any],
    render_engine: str,
) -> dict[str, Any]:
    """Commit rendered artifacts and the canonical report version atomically."""

    with _connect(collection_db) as conn:
        ensure_workflow_schema(conn)
        conn.commit()
        conn.execute("BEGIN IMMEDIATE")
        run = conn.execute(
            "SELECT * FROM research_equity_report_runs WHERE run_id=?", (run_id,)
        ).fetchone()
        if run is None:
            raise KeyError(run_id)
        if run["status"] == "completed":
            return dict(run)
        now = _now_iso()
        documents = _document_manifest(conn)
        node_rows = conn.execute(
            """
            SELECT node_id, current_version_no FROM research_nodes
            WHERE workflow_id=? AND current_version_no > 0
            """,
            (run["workflow_id"],),
        ).fetchall()
        node_versions = {
            row["node_id"]: _node_version_id(
                run["workflow_id"], row["node_id"], int(row["current_version_no"])
            )
            for row in node_rows
        }
        conn.execute(
            """
            INSERT INTO research_report_versions
                (report_version_id, report_id, version_no, node_versions_json,
                 document_versions_json, markdown, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                run["report_version_id"],
                run["report_id"],
                run["version_no"],
                _json(node_versions),
                _json(documents),
                markdown,
                now,
            ),
        )
        conn.execute(
            """
            UPDATE research_reports
            SET title=?, current_version_no=?, updated_at=? WHERE report_id=?
            """,
            (run["title"], run["version_no"], now, run["report_id"]),
        )
        conn.execute(
            """
            UPDATE research_equity_report_runs
            SET status='completed', report_package_json=?, artifact_manifest_json=?,
                render_engine=?, error=NULL, updated_at=?, completed_at=?
            WHERE run_id=?
            """,
            (
                _json(report_package),
                _json(artifact_manifest),
                render_engine,
                now,
                now,
                run_id,
            ),
        )
        conn.commit()
        return dict(
            conn.execute(
                "SELECT * FROM research_equity_report_runs WHERE run_id=?", (run_id,)
            ).fetchone()
        )


def fail_equity_report_run(collection_db: Path, *, run_id: str, error: str) -> None:
    with _connect(collection_db) as conn:
        ensure_workflow_schema(conn)
        conn.execute(
            """
            UPDATE research_equity_report_runs
            SET status='failed', error=?, updated_at=? WHERE run_id=?
            """,
            (error[:4000], _now_iso(), run_id),
        )
        conn.commit()


def get_equity_report_run(
    collection_db: Path, dataset_id: str, run_id: str | None = None
) -> dict[str, Any]:
    with _connect(collection_db) as conn:
        _ensure_workflow(conn, dataset_id)
        if run_id:
            row = conn.execute(
                "SELECT * FROM research_equity_report_runs WHERE dataset_id=? AND run_id=?",
                (dataset_id, run_id),
            ).fetchone()
        else:
            row = conn.execute(
                """
                SELECT * FROM research_equity_report_runs WHERE dataset_id=?
                ORDER BY created_at DESC LIMIT 1
                """,
                (dataset_id,),
            ).fetchone()
        if row is None:
            raise KeyError(run_id or "latest")
        payload = dict(row)
        for key in ("request_json", "report_package_json", "artifact_manifest_json"):
            payload[key.removesuffix("_json")] = json.loads(payload.pop(key) or "{}")
        return payload


def list_reports(collection_db: Path, dataset_id: str) -> list[dict[str, Any]]:
    with _connect(collection_db) as conn:
        workflow_id = _ensure_workflow(conn, dataset_id)
        rows = conn.execute(
            """
            SELECT r.*, rv.report_version_id, rv.markdown, rv.node_versions_json,
                   rv.document_versions_json, rv.created_at AS version_created_at
            FROM research_reports r
            LEFT JOIN research_report_versions rv
              ON rv.report_id=r.report_id AND rv.version_no=r.current_version_no
            WHERE r.workflow_id=?
            ORDER BY r.updated_at DESC
            """,
            (workflow_id,),
        ).fetchall()
        return [dict(row) for row in rows]
