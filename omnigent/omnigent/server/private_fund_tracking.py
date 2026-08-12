"""Durable private-fund research history, tracking jobs, and alerts.

The interactive Claude/cc-haha session remains the research UI.  This module
owns the unattended path: document and memo events are written to SQLite,
claimed by a separate worker, converted into evidence-backed research items,
and reconciled into immutable versions and deduplicated alerts.
"""

from __future__ import annotations

import hashlib
import json
import re
import sqlite3
import unicodedata
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from difflib import SequenceMatcher
from pathlib import Path
from typing import Any, Protocol
from urllib.parse import urlencode

TRACKING_SCHEMA_VERSION = 2
EXTRACTOR_VERSION = "risk-catalyst-skill-v9-locale"

_TRACKING_SKILL_PATH = (
    Path(__file__).resolve().parents[1]
    / "resources"
    / "private_fund_skills"
    / "private-fund-risk-catalyst-tracking"
    / "SKILL.md"
)

ITEM_TYPES = frozenset({"thesis", "assumption", "risk", "catalyst", "metric", "question"})
FINAL_ITEM_STATES = frozenset({"resolved", "dismissed", "achieved", "missed", "cancelled"})
ALERT_STATUSES = frozenset({"new", "acknowledged", "dismissed", "snoozed"})
JOB_STATUSES = frozenset({"queued", "running", "completed", "failed"})

_RISK_TERMS = (
    "风险",
    "下滑",
    "恶化",
    "竞争",
    "减值",
    "违约",
    "延迟",
    "不及预期",
    "监管",
    "关税",
    "波动",
    "短缺",
    "流失",
    "成本冲击",
    "risk",
    "decline",
    "delay",
    "shortage",
    "regulatory",
    "competition",
)
_CATALYST_TERMS = (
    "催化",
    "发布",
    "投产",
    "并网",
    "订单",
    "获批",
    "认证",
    "扩产",
    "交付",
    "回购",
    "降息",
    "政策落地",
    "launch",
    "approval",
    "production",
    "order",
    "certification",
    "buyback",
)
_ASSUMPTION_TERMS = (
    "假设",
    "预计",
    "预期",
    "目标",
    "指引",
    "毛利率",
    "增长率",
    "折现率",
    "永续增长",
    "无风险利率",
    "wacc",
    "terminal growth",
    "gross margin",
    "guidance",
    "target price",
    "risk free rate",
)
_DATE_PATTERN = re.compile(r"(?<!\d)(20\d{2}(?:[-/.年]\d{1,2}(?:[-/.月]\d{1,2}日?)?)?)(?!\d)")
_NUMBER_PATTERN = re.compile(r"(?<![A-Za-z0-9])(-?\d+(?:\.\d+)?)\s*(%|pct|bps|倍|亿元|万元|元)?")


def _current_user_locale() -> str:
    from omnigent.server.private_fund_locale import read_user_locale
    from omnigent.server.private_fund_tenant import current_tenant

    tenant = current_tenant()
    if tenant is None:
        return "zh-CN"
    try:
        return read_user_locale(tenant.data_namespace)
    except ValueError:
        return "zh-CN"
_FENCE_PATTERN = re.compile(r"```(?:json)?\s*([\s\S]*?)```", flags=re.IGNORECASE)
_RETRY_DELAYS_SECONDS = (30, 120, 600)


class TrackingChatClient(Protocol):
    """Small protocol implemented by the existing OpenAI-compatible client."""

    def chat(
        self,
        messages: list[dict[str, str]],
        *,
        max_tokens: int | None = None,
        temperature: float | None = None,
    ) -> str: ...


@dataclass
class ResearchCandidate:
    item_type: str
    canonical_key: str
    title: str
    content: str
    evidence_ids: list[str]
    as_of_date: str = ""
    source_published_at: str = ""
    stance: str = "neutral"
    state: str = "active"
    value_numeric: float | None = None
    value_text: str = ""
    unit: str = ""
    period: str = ""
    scenario: str = ""
    probability: str = ""
    impact: str = "medium"
    confidence: float = 0.65
    expected_start: str = ""
    expected_end: str = ""
    metadata: dict[str, Any] = field(default_factory=dict)


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
        decoded = json.loads(str(value))
    except (TypeError, ValueError, json.JSONDecodeError):
        return default
    return decoded


def _digest(*parts: Any, length: int = 24) -> str:
    payload = "\0".join(str(part or "") for part in parts)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:length]


def _normalize(value: Any) -> str:
    text = unicodedata.normalize("NFKC", str(value or "")).strip().lower()
    return re.sub(r"\s+", " ", text)


def _canonical_text(value: Any) -> str:
    text = _normalize(value)
    text = re.sub(r"20\d{2}(?:[-/.年]\d{1,2}(?:[-/.月]\d{1,2}日?)?)?", " ", text)
    text = re.sub(r"-?\d+(?:\.\d+)?\s*(?:%|pct|bps|倍|亿元|万元|元)?", " ", text)
    text = re.sub(r"[^\w\u3400-\u9fff]+", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def _safe_float(value: Any) -> float | None:
    if value in (None, ""):
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _safe_date(value: Any) -> str:
    text = str(value or "").strip()
    if not text:
        return ""
    match = _DATE_PATTERN.search(text)
    if not match:
        return ""
    normalized = match.group(1).replace("年", "-").replace("月", "-").replace("日", "")
    normalized = normalized.replace("/", "-").replace(".", "-").strip("-")
    parts = normalized.split("-")
    if len(parts) == 1:
        return parts[0]
    if len(parts) == 2:
        return f"{parts[0]}-{int(parts[1]):02d}"
    return f"{parts[0]}-{int(parts[1]):02d}-{int(parts[2]):02d}"


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


def _columns(conn: sqlite3.Connection, table: str) -> set[str]:
    return {str(row[1]) for row in conn.execute(f"PRAGMA table_info({table})")}


def ensure_tracking_schema(conn: sqlite3.Connection, dataset_id: str | None = None) -> None:
    """Create the additive tracking schema in one dataset collection DB."""

    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS research_memo_series (
            series_id TEXT PRIMARY KEY,
            dataset_id TEXT NOT NULL,
            series_key TEXT NOT NULL,
            topic TEXT NOT NULL,
            title TEXT NOT NULL,
            current_version_no INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            UNIQUE(dataset_id, series_key)
        );

        CREATE TABLE IF NOT EXISTS research_memo_versions (
            memo_version_id TEXT PRIMARY KEY,
            series_id TEXT NOT NULL,
            version_no INTEGER NOT NULL,
            revision_of_version_id TEXT,
            as_of_date TEXT NOT NULL,
            source_type TEXT NOT NULL,
            status TEXT NOT NULL,
            markdown_path TEXT,
            html_path TEXT,
            pdf_path TEXT,
            source_response_id TEXT,
            document_versions_json TEXT NOT NULL DEFAULT '[]',
            input_json TEXT NOT NULL DEFAULT '{}',
            content_hash TEXT NOT NULL,
            created_at TEXT NOT NULL,
            UNIQUE(series_id, version_no),
            UNIQUE(series_id, content_hash, source_type)
        );

        CREATE TABLE IF NOT EXISTS research_memo_sections (
            section_id TEXT PRIMARY KEY,
            memo_version_id TEXT NOT NULL,
            section_key TEXT NOT NULL,
            title TEXT NOT NULL,
            sort_order INTEGER NOT NULL,
            content TEXT NOT NULL,
            evidence_ids_json TEXT NOT NULL DEFAULT '[]',
            needs_review INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            UNIQUE(memo_version_id, section_key)
        );

        CREATE TABLE IF NOT EXISTS research_items (
            item_id TEXT PRIMARY KEY,
            dataset_id TEXT NOT NULL,
            item_type TEXT NOT NULL,
            canonical_key TEXT NOT NULL,
            title TEXT NOT NULL,
            status TEXT NOT NULL,
            current_version_no INTEGER NOT NULL DEFAULT 0,
            current_version_id TEXT,
            first_seen_at TEXT NOT NULL,
            last_seen_at TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            archived_at TEXT,
            archive_reason TEXT,
            UNIQUE(dataset_id, item_type, canonical_key)
        );

        CREATE TABLE IF NOT EXISTS research_item_versions (
            item_version_id TEXT PRIMARY KEY,
            item_id TEXT NOT NULL,
            version_no INTEGER NOT NULL,
            as_of_date TEXT,
            source_published_at TEXT,
            observed_at TEXT NOT NULL,
            source_type TEXT NOT NULL,
            source_id TEXT NOT NULL,
            content TEXT NOT NULL,
            stance TEXT NOT NULL DEFAULT 'neutral',
            state TEXT NOT NULL DEFAULT 'active',
            value_numeric REAL,
            value_text TEXT,
            unit TEXT,
            period TEXT,
            scenario TEXT,
            probability TEXT,
            impact TEXT NOT NULL DEFAULT 'medium',
            confidence REAL NOT NULL DEFAULT 0.5,
            expected_start TEXT,
            expected_end TEXT,
            metadata_json TEXT NOT NULL DEFAULT '{}',
            created_at TEXT NOT NULL,
            UNIQUE(item_id, version_no)
        );

        CREATE TABLE IF NOT EXISTS research_item_evidence (
            item_version_id TEXT NOT NULL,
            evidence_id TEXT NOT NULL,
            relation_type TEXT NOT NULL DEFAULT 'supports',
            PRIMARY KEY(item_version_id, evidence_id, relation_type)
        );

        CREATE TABLE IF NOT EXISTS research_item_relations (
            from_item_id TEXT NOT NULL,
            to_item_id TEXT NOT NULL,
            relation_type TEXT NOT NULL,
            created_at TEXT NOT NULL,
            PRIMARY KEY(from_item_id, to_item_id, relation_type)
        );

        CREATE TABLE IF NOT EXISTS research_tracking_observations (
            observation_id TEXT PRIMARY KEY,
            item_id TEXT NOT NULL,
            item_version_id TEXT,
            source_type TEXT NOT NULL,
            source_id TEXT NOT NULL,
            content TEXT NOT NULL,
            evidence_ids_json TEXT NOT NULL DEFAULT '[]',
            extracted_json TEXT NOT NULL DEFAULT '{}',
            observed_at TEXT NOT NULL,
            UNIQUE(item_id, source_type, source_id, content)
        );

        CREATE TABLE IF NOT EXISTS research_change_events (
            change_event_id TEXT PRIMARY KEY,
            dataset_id TEXT NOT NULL,
            item_id TEXT NOT NULL,
            old_version_id TEXT,
            new_version_id TEXT NOT NULL,
            change_type TEXT NOT NULL,
            materiality TEXT NOT NULL,
            summary TEXT NOT NULL,
            details_json TEXT NOT NULL DEFAULT '{}',
            created_at TEXT NOT NULL,
            UNIQUE(item_id, new_version_id, change_type)
        );

        CREATE TABLE IF NOT EXISTS research_watch_rules (
            rule_id TEXT PRIMARY KEY,
            dataset_id TEXT NOT NULL,
            name TEXT NOT NULL,
            target_type TEXT NOT NULL,
            target_item_id TEXT,
            query_json TEXT NOT NULL DEFAULT '{}',
            min_priority TEXT NOT NULL DEFAULT 'medium',
            frequency TEXT NOT NULL DEFAULT 'on_ingest',
            active INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS research_alerts (
            alert_id TEXT PRIMARY KEY,
            dataset_id TEXT NOT NULL,
            rule_id TEXT,
            item_id TEXT NOT NULL,
            change_event_id TEXT,
            alert_type TEXT NOT NULL,
            priority TEXT NOT NULL,
            title TEXT NOT NULL,
            summary TEXT NOT NULL,
            why_it_matters TEXT NOT NULL DEFAULT '',
            evidence_ids_json TEXT NOT NULL DEFAULT '[]',
            status TEXT NOT NULL DEFAULT 'new',
            due_at TEXT,
            snoozed_until TEXT,
            dedupe_key TEXT NOT NULL UNIQUE,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS research_tracking_jobs (
            job_id TEXT PRIMARY KEY,
            dataset_id TEXT NOT NULL,
            job_type TEXT NOT NULL,
            source_id TEXT NOT NULL,
            payload_json TEXT NOT NULL DEFAULT '{}',
            extractor_version TEXT NOT NULL,
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
            UNIQUE(dataset_id, job_type, source_id, extractor_version)
        );

        CREATE INDEX IF NOT EXISTS ix_research_items_type_updated
            ON research_items(dataset_id, item_type, updated_at DESC);
        CREATE INDEX IF NOT EXISTS ix_research_item_versions_item
            ON research_item_versions(item_id, version_no DESC);
        CREATE INDEX IF NOT EXISTS ix_research_change_events_dataset
            ON research_change_events(dataset_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS ix_research_alerts_dataset_status
            ON research_alerts(dataset_id, status, created_at DESC);
        CREATE INDEX IF NOT EXISTS ix_research_tracking_jobs_claim
            ON research_tracking_jobs(status, available_at, priority, created_at);
        """
    )
    item_columns = _columns(conn, "research_items")
    if "archived_at" not in item_columns:
        conn.execute("ALTER TABLE research_items ADD COLUMN archived_at TEXT")
    if "archive_reason" not in item_columns:
        conn.execute("ALTER TABLE research_items ADD COLUMN archive_reason TEXT")
    if dataset_id:
        _ensure_default_watch_rules(conn, dataset_id)


def _ensure_default_watch_rules(conn: sqlite3.Connection, dataset_id: str) -> None:
    now = _now_iso()
    for target_type, label in (("risk", "自动追踪重大风险"), ("catalyst", "自动追踪重要催化剂")):
        rule_id = f"wr_{_digest(dataset_id, target_type, 'default')}"
        conn.execute(
            """
            INSERT OR IGNORE INTO research_watch_rules
                (rule_id, dataset_id, name, target_type, query_json, min_priority,
                 frequency, active, created_at, updated_at)
            VALUES (?, ?, ?, ?, '{}', 'medium', 'on_ingest', 1, ?, ?)
            """,
            (rule_id, dataset_id, label, target_type, now, now),
        )


def _current_document_snapshot(conn: sqlite3.Connection) -> list[dict[str, Any]]:
    if "documents" not in _tables(conn):
        return []
    columns = _columns(conn, "documents")
    projection = ["doc_id"]
    for name in (
        "logical_doc_id",
        "version_no",
        "original_filename",
        "document_date",
        "checksum",
        "doc_type",
    ):
        if name in columns:
            projection.append(name)
    predicates: list[str] = []
    if "is_current" in columns:
        predicates.append("COALESCE(is_current, 1)=1")
    if "lifecycle_state" in columns:
        predicates.append("COALESCE(lifecycle_state, 'active')='active'")
    if "deleted_at" in columns:
        predicates.append("deleted_at IS NULL")
    if "status" in columns:
        predicates.append("status='indexed'")
    sql = f"SELECT {', '.join(projection)} FROM documents"
    if predicates:
        sql += " WHERE " + " AND ".join(predicates)
    sql += " ORDER BY doc_id"
    return [dict(row) for row in conn.execute(sql)]


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
    """Persist one idempotent background job and return its durable state."""

    now = _now_iso()
    job_id = f"rtj_{_digest(dataset_id, job_type, source_id, EXTRACTOR_VERSION)}"
    with _connect(collection_db) as conn:
        ensure_tracking_schema(conn, dataset_id)
        conn.execute(
            """
            INSERT OR IGNORE INTO research_tracking_jobs
                (job_id, dataset_id, job_type, source_id, payload_json,
                 extractor_version, status, priority, max_attempts,
                 available_at, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?)
            """,
            (
                job_id,
                dataset_id,
                job_type,
                source_id,
                _json(payload or {}),
                EXTRACTOR_VERSION,
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
                UPDATE research_tracking_jobs
                SET status='queued', attempt_count=0, available_at=?, locked_at=NULL,
                    finished_at=NULL, last_error=NULL, updated_at=?
                WHERE job_id=? AND status='failed'
                """,
                (now, now, job_id),
            )
        conn.commit()
        row = conn.execute(
            "SELECT * FROM research_tracking_jobs WHERE job_id=?", (job_id,)
        ).fetchone()
        return _job_payload(row)


def enqueue_current_documents(
    collection_db: Path,
    dataset_id: str,
    *,
    parent_ingest_job_id: str = "",
) -> list[dict[str, Any]]:
    """Enqueue each current document version after an incremental ingest commit."""

    with _connect(collection_db) as conn:
        ensure_tracking_schema(conn, dataset_id)
        documents = _current_document_snapshot(conn)
        conn.commit()
    jobs = []
    for document in documents:
        doc_id = str(document["doc_id"])
        jobs.append(
            enqueue_job(
                collection_db,
                dataset_id,
                job_type="document_ingested",
                source_id=doc_id,
                payload={
                    "document_ids": [doc_id],
                    "parent_ingest_job_id": parent_ingest_job_id,
                },
                priority=50,
            )
        )
    return jobs


def enqueue_current_memo_versions(
    collection_db: Path,
    dataset_id: str,
) -> list[dict[str, Any]]:
    """Enqueue the current version of every Memo series for this extractor version."""

    with _connect(collection_db) as conn:
        ensure_tracking_schema(conn, dataset_id)
        rows = conn.execute(
            """
            SELECT v.memo_version_id
            FROM research_memo_series s
            JOIN research_memo_versions v
              ON v.series_id=s.series_id AND v.version_no=s.current_version_no
            WHERE s.dataset_id=? AND v.status NOT IN ('failed', 'cancelled')
            ORDER BY v.created_at
            """,
            (dataset_id,),
        ).fetchall()
        conn.commit()
    return [
        enqueue_job(
            collection_db,
            dataset_id,
            job_type="memo_version_created",
            source_id=str(row["memo_version_id"]),
            payload={"memo_version_id": str(row["memo_version_id"])},
            priority=60,
        )
        for row in rows
    ]


def enqueue_manual_scan(collection_db: Path, dataset_id: str) -> dict[str, Any]:
    token = _now().strftime("%Y%m%dT%H%M%S.%fZ")
    with _connect(collection_db) as conn:
        ensure_tracking_schema(conn, dataset_id)
        document_ids = [str(item["doc_id"]) for item in _current_document_snapshot(conn)]
        conn.commit()
    return enqueue_job(
        collection_db,
        dataset_id,
        job_type="manual_scan",
        source_id=token,
        payload={"document_ids": document_ids},
        priority=20,
    )


def enqueue_legacy_rebuild(collection_db: Path, dataset_id: str) -> dict[str, Any]:
    """Queue an explicit model-backed rebuild of migrated tracking records."""

    token = _now().strftime("%Y%m%dT%H%M%S.%fZ")
    with _connect(collection_db) as conn:
        ensure_tracking_schema(conn, dataset_id)
        document_ids = [str(item["doc_id"]) for item in _current_document_snapshot(conn)]
        memo_rows = conn.execute(
            """
            SELECT v.memo_version_id
            FROM research_memo_series s
            JOIN research_memo_versions v
              ON v.series_id=s.series_id AND v.version_no=s.current_version_no
            WHERE s.dataset_id=? AND v.status NOT IN ('failed', 'cancelled')
            ORDER BY v.created_at
            """,
            (dataset_id,),
        ).fetchall()
        memo_version_ids = [str(row["memo_version_id"]) for row in memo_rows]
        conn.commit()
    return enqueue_job(
        collection_db,
        dataset_id,
        job_type="legacy_rebuild",
        source_id=token,
        payload={
            "document_ids": document_ids,
            "memo_version_ids": memo_version_ids,
            "explicit_user_action": True,
        },
        priority=10,
        max_attempts=1,
    )


def enqueue_scheduled_scan(
    collection_db: Path,
    dataset_id: str,
    *,
    now: datetime | None = None,
) -> dict[str, Any]:
    active_now = now or _now()
    source_id = active_now.strftime("%Y%m%dT%H")
    return enqueue_job(
        collection_db,
        dataset_id,
        job_type="scheduled_scan",
        source_id=source_id,
        payload={"scheduled_for": active_now.isoformat()},
        priority=200,
    )


def _parse_markdown_sections(markdown: str) -> list[tuple[str, str]]:
    matches = list(re.finditer(r"^##\s+(.+?)\s*$", markdown, flags=re.MULTILINE))
    if not matches:
        return [("正文", markdown.strip())] if markdown.strip() else []
    sections: list[tuple[str, str]] = []
    for index, match in enumerate(matches):
        start = match.end()
        end = matches[index + 1].start() if index + 1 < len(matches) else len(markdown)
        sections.append((match.group(1).strip(), markdown[start:end].strip()))
    return sections


def _series_key(topic: str) -> str:
    normalized = _canonical_text(topic) or "综合投研"
    return normalized[:180]


def _resolve_revision(conn: sqlite3.Connection, series_id: str, revision_of: str) -> str | None:
    explicit = str(revision_of or "").strip()
    if explicit:
        row = conn.execute(
            """
            SELECT memo_version_id FROM research_memo_versions
            WHERE memo_version_id=? OR markdown_path=? OR html_path=? OR pdf_path=?
            ORDER BY version_no DESC LIMIT 1
            """,
            (explicit, explicit, explicit, explicit),
        ).fetchone()
        if row:
            return str(row["memo_version_id"])
    row = conn.execute(
        """
        SELECT memo_version_id FROM research_memo_versions
        WHERE series_id=? ORDER BY version_no DESC LIMIT 1
        """,
        (series_id,),
    ).fetchone()
    return str(row["memo_version_id"]) if row else None


def resolve_memo_revision_target(
    collection_db: Path, dataset_id: str, revision_of: str
) -> dict[str, Any]:
    """Resolve an explicit Memo revision target before rendering artifacts."""

    explicit = str(revision_of or "").strip()
    if not explicit:
        raise ValueError("revision_of is required")
    with _connect(collection_db) as conn:
        ensure_tracking_schema(conn, dataset_id)
        row = conn.execute(
            """
            SELECT v.*, s.dataset_id, s.topic, s.title AS series_title
            FROM research_memo_versions v
            JOIN research_memo_series s ON s.series_id=v.series_id
            WHERE s.dataset_id=? AND (
                v.memo_version_id=? OR v.markdown_path=?
                OR v.html_path=? OR v.pdf_path=?
            )
            ORDER BY v.version_no DESC LIMIT 1
            """,
            (dataset_id, explicit, explicit, explicit, explicit),
        ).fetchone()
        if row is None:
            raise ValueError(f"Unknown memo revision target: {explicit}")
        return _memo_version_payload(conn, row)


def current_memo_version_for_topic(
    collection_db: Path, dataset_id: str, topic: str
) -> dict[str, Any] | None:
    """Return the current version for an exact canonical Memo topic."""

    key = _series_key(topic)
    with _connect(collection_db) as conn:
        ensure_tracking_schema(conn, dataset_id)
        row = conn.execute(
            """
            SELECT v.*, s.dataset_id, s.topic, s.title AS series_title
            FROM research_memo_series s
            JOIN research_memo_versions v ON v.series_id=s.series_id
            WHERE s.dataset_id=? AND s.series_key=?
            ORDER BY v.version_no DESC LIMIT 1
            """,
            (dataset_id, key),
        ).fetchone()
        return _memo_version_payload(conn, row) if row is not None else None


def register_memo_version(
    collection_db: Path,
    dataset_id: str,
    *,
    topic: str,
    markdown_path: Path,
    html_path: Path | None = None,
    pdf_path: Path | None = None,
    revision_of: str = "",
    source_type: str = "agent_generated",
    source_response_id: str = "",
    input_payload: dict[str, Any] | None = None,
    section_evidence: list[dict[str, Any]] | None = None,
    created_at: str | None = None,
    enqueue: bool = True,
) -> dict[str, Any]:
    """Register one logical memo version and group all rendered formats."""

    markdown = markdown_path.read_text(encoding="utf-8") if markdown_path.is_file() else ""
    content_hash = hashlib.sha256(markdown.encode("utf-8")).hexdigest()
    clean_topic = str(topic or "").strip() or "综合投研"
    now = created_at or _now_iso()
    with _connect(collection_db) as conn:
        ensure_tracking_schema(conn, dataset_id)
        explicit_revision = str(revision_of or "").strip()
        revision_row = None
        if explicit_revision:
            revision_row = conn.execute(
                """
                SELECT v.memo_version_id, v.series_id, s.topic
                FROM research_memo_versions v
                JOIN research_memo_series s ON s.series_id=v.series_id
                WHERE s.dataset_id=? AND (
                    v.memo_version_id=? OR v.markdown_path=?
                    OR v.html_path=? OR v.pdf_path=?
                )
                ORDER BY v.version_no DESC LIMIT 1
                """,
                (
                    dataset_id,
                    explicit_revision,
                    explicit_revision,
                    explicit_revision,
                    explicit_revision,
                ),
            ).fetchone()
            if revision_row is None:
                raise ValueError(f"Unknown memo revision target: {explicit_revision}")
            clean_topic = str(revision_row["topic"])
        key = _series_key(clean_topic)
        series_id = (
            str(revision_row["series_id"])
            if revision_row is not None
            else f"ms_{_digest(dataset_id, key)}"
        )
        conn.execute(
            """
            INSERT OR IGNORE INTO research_memo_series
                (series_id, dataset_id, series_key, topic, title,
                 current_version_no, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, 0, ?, ?)
            """,
            (series_id, dataset_id, key, clean_topic, clean_topic, now, now),
        )
        existing = conn.execute(
            """
            SELECT * FROM research_memo_versions
            WHERE series_id=? AND content_hash=? AND source_type=?
            """,
            (series_id, content_hash, source_type),
        ).fetchone()
        if existing:
            payload = _memo_version_payload(conn, existing)
            conn.commit()
            if enqueue:
                payload["tracking_job"] = enqueue_job(
                    collection_db,
                    dataset_id,
                    job_type="memo_version_created",
                    source_id=str(payload["memo_version_id"]),
                    payload={"memo_version_id": str(payload["memo_version_id"])},
                    priority=40,
                    requeue_failed=True,
                )
            return payload
        version_no = int(
            conn.execute(
                """
                SELECT COALESCE(MAX(version_no), 0) + 1
                FROM research_memo_versions WHERE series_id=?
                """,
                (series_id,),
            ).fetchone()[0]
        )
        revision_id = (
            str(revision_row["memo_version_id"])
            if revision_row is not None
            else _resolve_revision(conn, series_id, revision_of)
        )
        memo_version_id = f"mv_{_digest(series_id, version_no, content_hash)}"
        documents = _current_document_snapshot(conn)
        conn.execute(
            """
            INSERT INTO research_memo_versions
                (memo_version_id, series_id, version_no, revision_of_version_id,
                 as_of_date, source_type, status, markdown_path, html_path, pdf_path,
                 source_response_id, document_versions_json, input_json, content_hash, created_at)
            VALUES (?, ?, ?, ?, ?, ?, 'completed', ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                memo_version_id,
                series_id,
                version_no,
                revision_id,
                now[:10],
                source_type,
                str(markdown_path),
                str(html_path) if html_path else None,
                str(pdf_path) if pdf_path else None,
                source_response_id or None,
                _json(documents),
                _json(input_payload or {}),
                content_hash,
                now,
            ),
        )
        evidence_by_section: dict[str, list[str]] = {}
        for item in section_evidence or []:
            section_name = str(item.get("section") or "").strip()
            evidence_ids = [
                str(ev.get("evidence_id") or "")
                for ev in item.get("evidence") or []
                if isinstance(ev, dict) and str(ev.get("evidence_id") or "").strip()
            ]
            evidence_by_section[_normalize(section_name)] = list(dict.fromkeys(evidence_ids))
        section_key_counts: dict[str, int] = {}
        for index, (title, content) in enumerate(_parse_markdown_sections(markdown), start=1):
            base_section_key = _canonical_text(title).replace(" ", "-")[:72] or f"section-{index}"
            occurrence = section_key_counts.get(base_section_key, 0) + 1
            section_key_counts[base_section_key] = occurrence
            section_key = (
                base_section_key if occurrence == 1 else f"{base_section_key}-{occurrence}"
            )
            evidence_ids = evidence_by_section.get(_normalize(title), [])
            conn.execute(
                """
                INSERT INTO research_memo_sections
                    (section_id, memo_version_id, section_key, title, sort_order,
                     content, evidence_ids_json, needs_review, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    f"msec_{_digest(memo_version_id, section_key)}",
                    memo_version_id,
                    section_key,
                    title,
                    index,
                    content,
                    _json(evidence_ids),
                    0 if evidence_ids else 1,
                    now,
                ),
            )
        conn.execute(
            """
            UPDATE research_memo_series
            SET current_version_no=?, title=?, updated_at=? WHERE series_id=?
            """,
            (version_no, clean_topic, now, series_id),
        )
        conn.commit()
        version_row = conn.execute(
            "SELECT * FROM research_memo_versions WHERE memo_version_id=?",
            (memo_version_id,),
        ).fetchone()
        payload = _memo_version_payload(conn, version_row)
    if enqueue:
        payload["tracking_job"] = enqueue_job(
            collection_db,
            dataset_id,
            job_type="memo_version_created",
            source_id=memo_version_id,
            payload={"memo_version_id": memo_version_id},
            priority=40,
        )
    return payload


def backfill_memo_artifacts(collection_db: Path, dataset_id: str, memo_dir: Path) -> int:
    """Group legacy timestamped Markdown/HTML/PDF files without emitting alerts."""

    if not memo_dir.is_dir():
        return 0
    _remove_duplicate_legacy_memo_versions(collection_db, dataset_id)
    registered_paths = _registered_memo_artifact_paths(collection_db, dataset_id)
    groups: dict[str, dict[str, Path]] = {}
    for path in memo_dir.iterdir():
        if path.is_file() and path.suffix.lower() in {".md", ".html", ".pdf"}:
            groups.setdefault(path.stem, {})[path.suffix.lower()] = path
    count = 0
    for stem, artifacts in sorted(groups.items()):
        markdown_path = artifacts.get(".md")
        if markdown_path is None:
            continue
        artifact_paths = {str(path) for path in artifacts.values()}
        if artifact_paths & registered_paths:
            continue
        timestamp_match = re.search(r"_(20\d{6}_\d{6})$", stem)
        created_at = None
        if timestamp_match:
            try:
                parsed = datetime.strptime(timestamp_match.group(1), "%Y%m%d_%H%M%S").replace(
                    tzinfo=timezone.utc
                )
                created_at = parsed.isoformat()
            except ValueError:
                created_at = None
        before = len(list_memo_versions(collection_db, dataset_id))
        topic = _memo_topic_from_artifact(markdown_path)
        register_memo_version(
            collection_db,
            dataset_id,
            topic=topic,
            markdown_path=markdown_path,
            html_path=artifacts.get(".html"),
            pdf_path=artifacts.get(".pdf"),
            source_type="legacy_backfill",
            created_at=created_at,
            enqueue=False,
        )
        after = len(list_memo_versions(collection_db, dataset_id))
        count += int(after > before)
        registered_paths.update(artifact_paths)
    return count


def _memo_topic_from_artifact(markdown_path: Path) -> str:
    """Recover a useful legacy Memo topic without inventing ``综合投研``."""

    try:
        markdown = markdown_path.read_text(encoding="utf-8")
    except OSError:
        return "历史 Memo"
    topic_match = re.search(r"^\s*-\s*主题\s*[:：]\s*(.+?)\s*$", markdown, flags=re.MULTILINE)
    if topic_match:
        return topic_match.group(1).strip()
    heading_match = re.search(r"^#\s+(.+?)\s*$", markdown, flags=re.MULTILINE)
    if heading_match:
        return heading_match.group(1).strip()
    return "历史 Memo"


def _registered_memo_artifact_paths(collection_db: Path, dataset_id: str) -> set[str]:
    with _connect(collection_db) as conn:
        ensure_tracking_schema(conn, dataset_id)
        rows = conn.execute(
            """
            SELECT v.markdown_path, v.html_path, v.pdf_path
            FROM research_memo_versions v
            JOIN research_memo_series s ON s.series_id=v.series_id
            WHERE s.dataset_id=?
            """,
            (dataset_id,),
        ).fetchall()
    return {
        str(path)
        for row in rows
        for path in (row["markdown_path"], row["html_path"], row["pdf_path"])
        if path
    }


def _remove_duplicate_legacy_memo_versions(collection_db: Path, dataset_id: str) -> int:
    """Remove legacy catalog rows that point at an already registered memo artifact."""

    with _connect(collection_db) as conn:
        ensure_tracking_schema(conn, dataset_id)
        rows = conn.execute(
            """
            SELECT DISTINCT legacy.memo_version_id
            FROM research_memo_versions legacy
            JOIN research_memo_series legacy_series
              ON legacy_series.series_id=legacy.series_id
            JOIN research_memo_versions current
              ON current.memo_version_id<>legacy.memo_version_id
             AND current.source_type<>'legacy_backfill'
             AND (
                  (legacy.markdown_path IS NOT NULL
                   AND legacy.markdown_path=current.markdown_path)
               OR (legacy.html_path IS NOT NULL
                   AND legacy.html_path=current.html_path)
               OR (legacy.pdf_path IS NOT NULL
                   AND legacy.pdf_path=current.pdf_path)
             )
            JOIN research_memo_series current_series
              ON current_series.series_id=current.series_id
             AND current_series.dataset_id=legacy_series.dataset_id
            WHERE legacy_series.dataset_id=?
              AND legacy.source_type='legacy_backfill'
            """,
            (dataset_id,),
        ).fetchall()
    removed = 0
    for row in rows:
        removed += int(delete_memo_version(collection_db, dataset_id, str(row["memo_version_id"])))
    return removed


def _memo_version_payload(conn: sqlite3.Connection, row: sqlite3.Row) -> dict[str, Any]:
    sections = conn.execute(
        """
        SELECT * FROM research_memo_sections
        WHERE memo_version_id=? ORDER BY sort_order
        """,
        (row["memo_version_id"],),
    ).fetchall()
    payload = dict(row)
    payload["document_versions"] = _decode(payload.pop("document_versions_json"), [])
    payload["inputs"] = _decode(payload.pop("input_json"), {})
    payload["sections"] = [
        {
            **dict(section),
            "evidence_ids": _decode(section["evidence_ids_json"], []),
        }
        for section in sections
    ]
    for section in payload["sections"]:
        section.pop("evidence_ids_json", None)
    return payload


def list_memo_versions(
    collection_db: Path, dataset_id: str, series_id: str | None = None
) -> list[dict[str, Any]]:
    with _connect(collection_db) as conn:
        ensure_tracking_schema(conn, dataset_id)
        sql = """
            SELECT v.*, s.dataset_id, s.topic, s.title AS series_title
            FROM research_memo_versions v
            JOIN research_memo_series s ON s.series_id=v.series_id
            WHERE s.dataset_id=?
        """
        params: list[Any] = [dataset_id]
        if series_id:
            sql += " AND v.series_id=?"
            params.append(series_id)
        sql += " ORDER BY v.created_at DESC, v.version_no DESC"
        rows = conn.execute(sql, params).fetchall()
        return [_memo_version_payload(conn, row) for row in rows]


def list_memo_series(collection_db: Path, dataset_id: str) -> list[dict[str, Any]]:
    with _connect(collection_db) as conn:
        ensure_tracking_schema(conn, dataset_id)
        rows = conn.execute(
            """
            SELECT s.*,
                   (SELECT COUNT(*) FROM research_memo_versions v WHERE v.series_id=s.series_id)
                       AS version_count,
                   (SELECT memo_version_id FROM research_memo_versions v
                    WHERE v.series_id=s.series_id ORDER BY version_no DESC LIMIT 1)
                       AS current_memo_version_id
            FROM research_memo_series s
            WHERE s.dataset_id=? ORDER BY s.updated_at DESC
            """,
            (dataset_id,),
        ).fetchall()
        return [dict(row) for row in rows]


def delete_memo_version(collection_db: Path, dataset_id: str, memo_version_id: str) -> bool:
    """Delete one memo catalog version after its artifacts are explicitly removed."""

    with _connect(collection_db) as conn:
        ensure_tracking_schema(conn, dataset_id)
        row = conn.execute(
            """
            SELECT v.series_id FROM research_memo_versions v
            JOIN research_memo_series s ON s.series_id=v.series_id
            WHERE s.dataset_id=? AND v.memo_version_id=?
            """,
            (dataset_id, memo_version_id),
        ).fetchone()
        if row is None:
            return False
        series_id = str(row["series_id"])
        conn.execute(
            "DELETE FROM research_memo_sections WHERE memo_version_id=?",
            (memo_version_id,),
        )
        conn.execute(
            "DELETE FROM research_memo_versions WHERE memo_version_id=?",
            (memo_version_id,),
        )
        conn.execute(
            """
            DELETE FROM research_tracking_jobs
            WHERE job_type='memo_version_created' AND source_id=?
            """,
            (memo_version_id,),
        )
        current = conn.execute(
            """
            SELECT COALESCE(MAX(version_no), 0) FROM research_memo_versions
            WHERE series_id=?
            """,
            (series_id,),
        ).fetchone()[0]
        if int(current or 0) == 0:
            conn.execute("DELETE FROM research_memo_series WHERE series_id=?", (series_id,))
        else:
            conn.execute(
                """
                UPDATE research_memo_series SET current_version_no=?, updated_at=?
                WHERE series_id=?
                """,
                (int(current), _now_iso(), series_id),
            )
        conn.commit()
        return True


def compare_memo_versions(
    collection_db: Path, dataset_id: str, from_version_id: str, to_version_id: str
) -> dict[str, Any]:
    with _connect(collection_db) as conn:
        ensure_tracking_schema(conn, dataset_id)
        rows = conn.execute(
            """
            SELECT v.* FROM research_memo_versions v
            JOIN research_memo_series s ON s.series_id=v.series_id
            WHERE s.dataset_id=? AND v.memo_version_id IN (?, ?)
            """,
            (dataset_id, from_version_id, to_version_id),
        ).fetchall()
        by_id = {str(row["memo_version_id"]): row for row in rows}
        if from_version_id not in by_id or to_version_id not in by_id:
            raise KeyError("memo version not found")
        old = _memo_version_payload(conn, by_id[from_version_id])
        new = _memo_version_payload(conn, by_id[to_version_id])
        old_sections = {section["section_key"]: section for section in old["sections"]}
        new_sections = {section["section_key"]: section for section in new["sections"]}
        section_changes = []
        for key in sorted(set(old_sections) | set(new_sections)):
            left = old_sections.get(key)
            right = new_sections.get(key)
            if left is None:
                change_type = "added"
                similarity = 0.0
            elif right is None:
                change_type = "not_mentioned"
                similarity = 0.0
            else:
                similarity = SequenceMatcher(None, left["content"], right["content"]).ratio()
                change_type = "unchanged" if similarity >= 0.985 else "changed"
            section_changes.append(
                {
                    "section_key": key,
                    "title": (right or left or {}).get("title", key),
                    "change_type": change_type,
                    "similarity": round(similarity, 4),
                    "old_content": left["content"] if left else "",
                    "new_content": right["content"] if right else "",
                    "old_evidence_ids": left["evidence_ids"] if left else [],
                    "new_evidence_ids": right["evidence_ids"] if right else [],
                }
            )
        item_changes = [
            _change_event_payload(row)
            for row in conn.execute(
                """
                SELECT ce.* FROM research_change_events ce
                JOIN research_item_versions iv ON iv.item_version_id=ce.new_version_id
                WHERE ce.dataset_id=? AND iv.source_type='memo'
                  AND iv.source_id=? ORDER BY ce.created_at
                """,
                (dataset_id, to_version_id),
            )
        ]
        return {
            "from_version": old,
            "to_version": new,
            "section_changes": section_changes,
            "item_changes": item_changes,
        }


def _candidate_key(raw: dict[str, Any]) -> str:
    item_type = str(raw.get("item_type") or "").strip().lower()
    explicit = _canonical_text(raw.get("canonical_key"))
    if item_type == "assumption":
        metric = _canonical_text(raw.get("metric") or raw.get("title"))
        period = _canonical_text(raw.get("period"))
        scenario = _canonical_text(raw.get("scenario") or "base")
        return "/".join(part for part in (metric, scenario, period) if part)[:240]
    if item_type in {"risk", "catalyst"}:
        event_parts = (
            raw.get("entity"),
            raw.get("event_type"),
            raw.get("subject"),
            raw.get("expected_start") or raw.get("expected_end"),
        )
        event_key = "/".join(
            part for part in (_canonical_text(value) for value in event_parts) if part
        )
        if len(event_key.split("/")) >= 3:
            return event_key[:240]
    return (explicit or _canonical_text(raw.get("title") or raw.get("content")))[:240]


def _tracking_skill_text() -> str:
    try:
        parts = [_TRACKING_SKILL_PATH.read_text(encoding="utf-8")]
        reference_dir = _TRACKING_SKILL_PATH.parent / "references"
        for reference_path in sorted(reference_dir.glob("*.md")):
            parts.append(
                f"\n\n## Reference: {reference_path.name}\n\n"
                f"{reference_path.read_text(encoding='utf-8')}"
            )
        return "".join(parts)
    except OSError:
        return ""


def _tracking_metadata(raw: dict[str, Any], item_type: str, confidence: float) -> dict[str, Any]:
    metadata = dict(raw.get("metadata") or {}) if isinstance(raw.get("metadata"), dict) else {}
    for field_name in (
        "entity",
        "event_type",
        "subject",
        "direction",
        "trigger",
        "transmission_path",
        "classification_reason",
        "extraction_method",
    ):
        value = str(raw.get(field_name) or metadata.get(field_name) or "").strip()
        if value:
            metadata[field_name] = value[:500]
    evidence_quotes = raw.get("evidence_quotes")
    if isinstance(evidence_quotes, list):
        metadata["evidence_quotes"] = [
            {
                "evidence_id": str(item.get("evidence_id") or "")[:160],
                "quote": str(item.get("quote") or "")[:500],
            }
            for item in evidence_quotes
            if isinstance(item, dict) and item.get("evidence_id") and item.get("quote")
        ]
    for field_name in ("evidence_grounded", "evidence_reassigned"):
        if field_name in raw:
            metadata[field_name] = bool(raw[field_name])
    if raw.get("evidence_grounding_method"):
        metadata["evidence_grounding_method"] = str(raw["evidence_grounding_method"])[:80]

    requested_quality = (
        str(raw.get("quality_status") or metadata.get("quality_status") or "").strip().lower()
    )
    if item_type not in {"risk", "catalyst"}:
        quality_status = "verified" if confidence >= 0.7 else "needs_review"
    else:
        has_identity = bool(
            metadata.get("entity") and metadata.get("event_type") and metadata.get("subject")
        )
        has_reason = bool(metadata.get("classification_reason"))
        if item_type == "risk":
            has_structure = bool(metadata.get("trigger") and metadata.get("transmission_path"))
        else:
            has_structure = bool(
                metadata.get("trigger") or raw.get("expected_start") or raw.get("expected_end")
            )
        quality_status = (
            "verified"
            if requested_quality == "verified"
            and confidence >= 0.78
            and has_identity
            and has_reason
            and has_structure
            else "needs_review"
        )
    metadata["quality_status"] = quality_status
    metadata["content_kind"] = (
        "evidence_lead"
        if metadata.get("extraction_method") == "keyword_fallback"
        else "analytical_judgement"
    )
    metadata["extractor_version"] = EXTRACTOR_VERSION
    return metadata


def _has_minimum_event_structure(
    metadata: dict[str, Any], item_type: str, raw: dict[str, Any]
) -> bool:
    if item_type not in {"risk", "catalyst"}:
        return True
    if not all(metadata.get(field) for field in ("entity", "event_type", "subject")):
        return False
    if not metadata.get("classification_reason"):
        return False
    if item_type == "risk":
        return bool(metadata.get("trigger") and metadata.get("transmission_path"))
    return bool(metadata.get("trigger") or raw.get("expected_start") or raw.get("expected_end"))


_EVENT_TITLE_LABELS = {
    "capacity_expansion": "产能扩张",
    "local_factory": "本地建厂",
    "order_growth": "订单增长",
    "order_win": "订单获取",
    "order_award": "订单落地",
    "order_delay": "订单延期",
    "order_pipeline": "订单储备",
    "product_launch": "产品发布",
    "market_demand_shift": "市场需求变化",
    "cost_pressure": "成本压力",
    "demand_decline": "需求走弱",
    "demand_growth": "需求增长",
    "cost_increase": "成本上升",
    "margin_pressure": "利润率承压",
    "regulatory_change": "监管变化",
    "project_delay": "项目延期",
}


def _clean_tracking_title(value: Any) -> str:
    title = re.sub(r"[*_#`]+", "", str(value or ""))
    title = re.sub(r"\s+", "", title)
    title = re.sub(r"(?:啊|呢|这个|那个|就是说|同时呢|我们)", "", title)
    return title.strip(" ，。；：、!?！？-—")


def _tracking_title(
    raw: dict[str, Any],
    item_type: str,
    content: str,
    metadata: dict[str, Any],
    locale: str = "zh-CN",
) -> str:
    if locale == "en-US":
        generated = re.sub(r"[*_#`]+", "", str(raw.get("title") or ""))
        generated = re.sub(r"\s+", " ", generated).strip(" ,.;:!?-—")
        if generated:
            return generated[:80]
        entity = re.sub(r"\s+", " ", str(metadata.get("entity") or "")).strip()
        subject = re.sub(r"\s+", " ", str(metadata.get("subject") or "")).strip()
        fallback = f"{entity}: {subject}" if entity and subject else entity or subject
        return fallback[:80] or ("Risk pending review" if item_type == "risk" else "Catalyst pending review")
    entity = _clean_tracking_title(metadata.get("entity"))
    subject = _clean_tracking_title(metadata.get("subject"))
    event_type = str(metadata.get("event_type") or "").strip().lower()
    direction = _clean_tracking_title(metadata.get("direction"))
    event_label = _EVENT_TITLE_LABELS.get(event_type, "")
    if entity and subject:
        subject_label = subject if subject not in entity else ""
        overlap_terms = ("订单", "产品", "需求", "成本", "利润率", "项目", "产能", "监管")
        event_is_implied = not event_label or any(
            term in subject_label and term in event_label for term in overlap_terms
        )
        core = subject_label if event_is_implied else f"{subject_label}{event_label or direction}"
        title = f"{entity}：{core}" if core else entity
    else:
        source = _clean_tracking_title(raw.get("title") or content)
        if "建厂" in source and "订单" in source:
            title = "本地建厂有望提升订单获取能力"
        elif ("扩产" in source or "产能" in source) and "订单" in source:
            title = "产能扩张有望支撑订单增长"
        else:
            clause = re.split(r"[，。；！？]", source, maxsplit=1)[0]
            title = clause
    title = _clean_tracking_title(title)[:48]
    return title or ("待复核风险" if item_type == "risk" else "待复核催化剂")


def _candidate_from_raw(
    raw: dict[str, Any],
    *,
    valid_evidence_ids: set[str],
    default_date: str,
    locale: str = "zh-CN",
) -> ResearchCandidate | None:
    item_type = str(raw.get("item_type") or "").strip().lower()
    if item_type not in ITEM_TYPES:
        return None
    content = str(raw.get("content") or "").strip()
    evidence_ids = [
        str(item).strip()
        for item in raw.get("evidence_ids") or []
        if str(item).strip() in valid_evidence_ids
    ]
    if not content or not evidence_ids:
        return None
    canonical_key = _candidate_key(raw)
    if not canonical_key:
        return None
    default_state = (
        "emerging" if item_type == "risk" else "announced" if item_type == "catalyst" else "active"
    )
    impact = str(raw.get("impact") or "medium").lower()
    if impact not in {"low", "medium", "high", "critical"}:
        impact = "medium"
    confidence_value = _safe_float(raw.get("confidence"))
    confidence = max(0.0, min(confidence_value if confidence_value is not None else 0.65, 1.0))
    metadata = _tracking_metadata(raw, item_type, confidence)
    if not _has_minimum_event_structure(metadata, item_type, raw):
        return None
    title = _tracking_title(raw, item_type, content, metadata, locale)
    if item_type in {"risk", "catalyst"}:
        title_text = _canonical_text(title)
        content_text = _canonical_text(content)
        if title_text == content_text:
            return None
        if (
            min(len(title_text), len(content_text)) >= 10
            and SequenceMatcher(None, title_text, content_text).ratio() >= 0.9
        ):
            return None
    return ResearchCandidate(
        item_type=item_type,
        canonical_key=canonical_key,
        title=title,
        content=content,
        evidence_ids=list(dict.fromkeys(evidence_ids)),
        as_of_date=_safe_date(raw.get("as_of_date")) or default_date,
        source_published_at=_safe_date(raw.get("source_published_at")) or default_date,
        stance=str(raw.get("stance") or "neutral")[:24],
        state=str(raw.get("state") or default_state)[:40],
        value_numeric=_safe_float(raw.get("value_numeric")),
        value_text=str(raw.get("value_text") or "")[:160],
        unit=str(raw.get("unit") or "")[:40],
        period=str(raw.get("period") or "")[:80],
        scenario=str(raw.get("scenario") or "")[:80],
        probability=str(raw.get("probability") or "")[:40],
        impact=impact,
        confidence=confidence,
        expected_start=_safe_date(raw.get("expected_start")),
        expected_end=_safe_date(raw.get("expected_end")),
        metadata=metadata,
    )


def _parse_llm_json(text: str) -> list[dict[str, Any]]:
    candidate = text.strip()
    fenced = _FENCE_PATTERN.search(candidate)
    if fenced:
        candidate = fenced.group(1).strip()
    try:
        decoded = json.loads(candidate)
    except (TypeError, ValueError, json.JSONDecodeError):
        start = candidate.find("[")
        end = candidate.rfind("]")
        if start < 0 or end <= start:
            return []
        try:
            decoded = json.loads(candidate[start : end + 1])
        except (TypeError, ValueError, json.JSONDecodeError):
            return []
    if isinstance(decoded, dict):
        decoded = decoded.get("items") or []
    return (
        [item for item in decoded if isinstance(item, dict)] if isinstance(decoded, list) else []
    )


def _quote_fingerprint(value: Any) -> str:
    """Normalize layout noise while retaining the lexical content of a quote."""

    text = unicodedata.normalize("NFKC", str(value or "")).lower()
    return re.sub(r"[^a-z0-9\u3400-\u9fff]+", "", text)


def _is_boilerplate_evidence(value: Any) -> bool:
    """Identify moderator transitions that cannot support an event claim."""

    text = _normalize(value)
    if not text:
        return True
    moderator_markers = (
        "下面有请",
        "进行提问",
        "请您优先提供",
        "姓名和机构",
        "请发言",
        "感谢您的提问",
    )
    marker_count = sum(marker in text for marker in moderator_markers)
    return marker_count >= 2 and len(_quote_fingerprint(text)) <= 180


def _raw_evidence_quotes(raw: dict[str, Any]) -> list[tuple[str, str]]:
    value = raw.get("evidence_quotes")
    if isinstance(value, dict):
        return [
            (str(evidence_id).strip(), str(quote).strip())
            for evidence_id, quote in value.items()
            if str(evidence_id).strip() and str(quote).strip()
        ]
    if isinstance(value, list):
        return [
            (
                str(item.get("evidence_id") or "").strip(),
                str(item.get("quote") or "").strip(),
            )
            for item in value
            if isinstance(item, dict)
            and str(item.get("evidence_id") or "").strip()
            and str(item.get("quote") or "").strip()
        ]
    return []


def _ground_llm_evidence(
    raw: dict[str, Any], units: list[dict[str, Any]]
) -> dict[str, Any] | None:
    """Verify exact quotes and repair adjacent/combined-chunk ID mistakes conservatively."""

    item_type = str(raw.get("item_type") or "").strip().lower()
    if item_type not in {"risk", "catalyst"}:
        return raw
    quotes = _raw_evidence_quotes(raw)
    if not quotes:
        return None

    units_by_id = {
        str(unit.get("evidence_id") or ""): unit
        for unit in units
        if str(unit.get("evidence_id") or "")
    }
    grounded_quotes: list[dict[str, str]] = []
    reassigned = False
    for requested_id, quote in quotes:
        quote_key = _quote_fingerprint(quote)
        if len(quote_key) < 8:
            return None
        matching_units = [
            unit
            for unit in units
            if quote_key in _quote_fingerprint(unit.get("content"))
            and not _is_boilerplate_evidence(unit.get("content"))
        ]
        if not matching_units:
            return None
        requested_unit = units_by_id.get(requested_id)
        if requested_unit in matching_units:
            selected = requested_unit
        else:
            # Parent and atomic chunks may contain the same passage. The shortest
            # exact container produces the most focused evidence preview.
            selected = min(
                matching_units,
                key=lambda unit: len(_quote_fingerprint(unit.get("content"))),
            )
            reassigned = True
        grounded_quotes.append({"evidence_id": str(selected["evidence_id"]), "quote": quote[:500]})

    grounded = dict(raw)
    grounded["evidence_ids"] = list(dict.fromkeys(item["evidence_id"] for item in grounded_quotes))
    grounded["evidence_quotes"] = grounded_quotes
    grounded["evidence_grounded"] = True
    grounded["evidence_reassigned"] = reassigned
    grounded["evidence_grounding_method"] = "verbatim_quote"
    return grounded


def _heuristic_candidates(
    units: list[dict[str, Any]], valid_evidence_ids: set[str], default_date: str
) -> list[ResearchCandidate]:
    candidates: list[ResearchCandidate] = []
    seen: set[tuple[str, str]] = set()
    counts: dict[str, int] = {}
    for unit in units:
        evidence_id = str(unit["evidence_id"])
        text = str(unit.get("content") or "")
        sentences = re.split(r"(?<=[。！？!?；;])|\n+", text)
        for sentence in sentences:
            content = sentence.strip(" -•\t")
            if len(content) < 12 or len(content) > 480:
                continue
            lower = content.lower()
            assumption_match = any(term in lower for term in _ASSUMPTION_TERMS)
            if "risk free rate" in lower or "无风险利率" in lower:
                item_type = "assumption"
            elif any(term in lower for term in _RISK_TERMS):
                item_type = "risk"
            elif any(term in lower for term in _CATALYST_TERMS):
                item_type = "catalyst"
            elif assumption_match:
                item_type = "assumption"
            else:
                continue
            if item_type in {"risk", "catalyst"}:
                continue
            if counts.get(item_type, 0) >= 40:
                continue
            number = _NUMBER_PATTERN.search(content)
            date = _safe_date(content)
            raw = {
                "item_type": item_type,
                "title": content[:80],
                "content": content,
                "canonical_key": _canonical_text(content),
                "evidence_ids": [evidence_id],
                "value_numeric": _safe_float(number.group(1)) if number else None,
                "unit": number.group(2) if number and number.group(2) else "",
                "expected_start": date if item_type == "catalyst" else "",
                "impact": "medium",
                "confidence": 0.45,
                "quality_status": "needs_review",
                "extraction_method": "keyword_fallback",
            }
            candidate = _candidate_from_raw(
                raw, valid_evidence_ids=valid_evidence_ids, default_date=default_date
            )
            if candidate is None:
                continue
            signature = (candidate.item_type, candidate.canonical_key)
            if signature in seen:
                continue
            seen.add(signature)
            counts[item_type] = counts.get(item_type, 0) + 1
            candidates.append(candidate)
    return candidates


def _llm_candidates(
    llm_client: TrackingChatClient,
    units: list[dict[str, Any]],
    valid_evidence_ids: set[str],
    default_date: str,
    locale: str = "zh-CN",
) -> list[ResearchCandidate]:
    from omnigent.server.private_fund_memory import read_current_user_memory

    skill = _tracking_skill_text()
    evidence_text = "\n\n".join(
        f"[{unit['evidence_id']}] {str(unit.get('content') or '')[:1400]}" for unit in units[:80]
    )[:80_000]
    prompt = f"""
Apply the tracking skill below exactly. Extract atomic private-fund research items and return
one JSON array with no prose. Use only the supplied evidence IDs. Keep uncertain candidates as
quality_status=needs_review; omit unsupported candidates. For every risk/catalyst include entity,
event_type, subject, direction, trigger, transmission_path, classification_reason, and
quality_status. Also include evidence_quotes as a list of objects with evidence_id and an exact
verbatim quote of 8-160 characters copied from that evidence block. Never cite moderator prompts,
speaker hand-offs, or an adjacent block that does not contain the quote. Add
extraction_method=llm_skill. The title must be an analytical event label of at
at most 80 characters, without Markdown, speech fillers, or copied source sentences. Content
must be a concise analytical judgement in your own words and must not equal the title or copy a
source passage verbatim. Default source date: {default_date}.

{read_current_user_memory(fallback_locale=locale)}

Tracking skill:
{skill}

Evidence:
{evidence_text}
""".strip()
    text = llm_client.chat(
        [
            {
                "role": "system",
                "content": (
                    "You are a conservative investment-research event verifier. "
                    "Evidence fidelity and abstention are more important than recall. "
                    "Output valid JSON only."
                ),
            },
            {"role": "user", "content": prompt},
        ],
        max_tokens=5000,
        temperature=0.0,
    )
    candidates = []
    for raw in _parse_llm_json(text):
        raw = _ground_llm_evidence(raw, units)
        if raw is None:
            continue
        candidate = _candidate_from_raw(
            raw,
            valid_evidence_ids=valid_evidence_ids,
            default_date=default_date,
            locale=locale,
        )
        if candidate:
            candidates.append(candidate)
    return candidates


def _load_document_units(
    conn: sqlite3.Connection, document_ids: list[str]
) -> tuple[list[dict[str, Any]], str]:
    tables = _tables(conn)
    if "documents" not in tables or "chunks" not in tables:
        return [], _now().date().isoformat()
    if not document_ids:
        documents = _current_document_snapshot(conn)
        document_ids = [str(item["doc_id"]) for item in documents]
    if not document_ids:
        return [], _now().date().isoformat()
    placeholders = ",".join("?" for _ in document_ids)
    document_columns = _columns(conn, "documents")
    chunk_columns = _columns(conn, "chunks")
    date_projection = "d.document_date" if "document_date" in document_columns else "NULL"
    chunk_order = "c.chunk_index" if "chunk_index" in chunk_columns else "c.chunk_id"
    rows = conn.execute(
        f"""
        SELECT c.chunk_id, c.content, c.doc_id, d.original_filename,
               {date_projection} AS document_date
        FROM chunks c JOIN documents d ON d.doc_id=c.doc_id
        WHERE c.doc_id IN ({placeholders})
        ORDER BY c.doc_id, {chunk_order} LIMIT 600
        """,
        document_ids,
    ).fetchall()
    units = [
        {
            "evidence_id": f"chunk:{row['chunk_id']}",
            "content": row["content"],
            "doc_id": row["doc_id"],
            "document_name": row["original_filename"],
            "document_date": row["document_date"],
        }
        for row in rows
    ]
    if "metric_facts" in tables:
        fact_columns = _columns(conn, "metric_facts")
        quality_clause = (
            "AND COALESCE(f.quality_status, 'review_required') <> 'rejected'"
            if "quality_status" in fact_columns
            else ""
        )
        fact_rows = conn.execute(
            f"""
            SELECT f.*, d.original_filename, {date_projection} AS document_date
            FROM metric_facts f JOIN documents d ON d.doc_id=f.doc_id
            WHERE f.doc_id IN ({placeholders}) {quality_clause}
            ORDER BY f.doc_id LIMIT 400
            """,
            document_ids,
        ).fetchall()
        for row in fact_rows:
            metric = str(row["metric_name"] or "")
            if not any(term in metric.lower() for term in _ASSUMPTION_TERMS):
                continue
            content = " | ".join(
                part
                for part in (
                    metric,
                    str(row["period"] or ""),
                    str(row["value_text"] or row["value_numeric"] or ""),
                    str(row["unit"] or ""),
                )
                if part
            )
            units.append(
                {
                    "evidence_id": f"fact:{row['fact_id']}",
                    "content": content,
                    "doc_id": row["doc_id"],
                    "document_name": row["original_filename"],
                    "document_date": row["document_date"],
                }
            )
    dates = [str(unit.get("document_date") or "") for unit in units if unit.get("document_date")]
    return units, max(dates) if dates else _now().date().isoformat()


def _load_memo_units(
    conn: sqlite3.Connection, memo_version_id: str
) -> tuple[list[dict[str, Any]], str]:
    row = conn.execute(
        "SELECT * FROM research_memo_versions WHERE memo_version_id=?", (memo_version_id,)
    ).fetchone()
    if row is None:
        raise KeyError(memo_version_id)
    units = []
    for section in conn.execute(
        "SELECT * FROM research_memo_sections WHERE memo_version_id=? ORDER BY sort_order",
        (memo_version_id,),
    ):
        evidence_ids = _decode(section["evidence_ids_json"], [])
        if not evidence_ids:
            continue
        units.append(
            {
                "evidence_id": evidence_ids[0],
                "additional_evidence_ids": evidence_ids[1:],
                "content": f"{section['title']}\n{section['content']}",
                "memo_section_id": section["section_id"],
                "document_date": row["as_of_date"],
            }
        )
    return units, str(row["as_of_date"])


def _item_similarity(candidate: ResearchCandidate, row: sqlite3.Row) -> float:
    candidate_text = _canonical_text(f"{candidate.title} {candidate.content}")
    existing_text = _canonical_text(f"{row['title']} {row['content'] or ''}")
    if not candidate_text or not existing_text:
        return 0.0
    sequence = SequenceMatcher(None, candidate_text, existing_text).ratio()
    left = set(candidate_text)
    right = set(existing_text)
    jaccard = len(left & right) / max(1, len(left | right))
    return max(sequence, jaccard)


def _find_item(
    conn: sqlite3.Connection, dataset_id: str, candidate: ResearchCandidate
) -> sqlite3.Row | None:
    exact = conn.execute(
        """
        SELECT i.*, v.content, v.value_numeric, v.value_text, v.unit, v.period,
               v.scenario, v.probability, v.impact, v.state, v.expected_start, v.expected_end,
               v.stance, v.confidence, v.metadata_json
        FROM research_items i
        LEFT JOIN research_item_versions v ON v.item_version_id=i.current_version_id
        WHERE i.dataset_id=? AND i.item_type=? AND i.canonical_key=?
        """,
        (dataset_id, candidate.item_type, candidate.canonical_key),
    ).fetchone()
    if exact:
        return exact
    if candidate.evidence_ids:
        placeholders = ",".join("?" for _ in candidate.evidence_ids)
        evidence_match = conn.execute(
            f"""
            SELECT i.*, v.content, v.value_numeric, v.value_text, v.unit, v.period,
                   v.scenario, v.probability, v.impact, v.state, v.expected_start,
                   v.expected_end, v.stance, v.confidence, v.metadata_json,
                   COUNT(*) AS evidence_overlap
            FROM research_items i
            JOIN research_item_versions v ON v.item_version_id=i.current_version_id
            JOIN research_item_evidence e ON e.item_version_id=v.item_version_id
            WHERE i.dataset_id=? AND i.item_type=?
              AND e.evidence_id IN ({placeholders})
            GROUP BY i.item_id
            ORDER BY evidence_overlap DESC, i.last_seen_at DESC
            LIMIT 1
            """,
            [dataset_id, candidate.item_type, *candidate.evidence_ids],
        ).fetchone()
        if evidence_match and _item_similarity(candidate, evidence_match) >= 0.45:
            return evidence_match
    rows = conn.execute(
        """
        SELECT i.*, v.content, v.value_numeric, v.value_text, v.unit, v.period,
               v.scenario, v.probability, v.impact, v.state, v.expected_start, v.expected_end,
               v.stance, v.confidence, v.metadata_json
        FROM research_items i
        LEFT JOIN research_item_versions v ON v.item_version_id=i.current_version_id
        WHERE i.dataset_id=? AND i.item_type=?
        ORDER BY i.last_seen_at DESC LIMIT 200
        """,
        (dataset_id, candidate.item_type),
    ).fetchall()
    threshold = 0.92 if candidate.item_type == "assumption" else 0.84
    scored = [(row, _item_similarity(candidate, row)) for row in rows]
    if not scored:
        return None
    best, score = max(scored, key=lambda item: item[1])
    return best if score >= threshold else None


def _meaningful_change(candidate: ResearchCandidate, current: sqlite3.Row) -> bool:
    if _canonical_text(candidate.title) != _canonical_text(current["title"]):
        return True
    current_metadata = _decode(current["metadata_json"], {})
    tracked_metadata_fields = (
        "quality_status",
        "entity",
        "event_type",
        "subject",
        "direction",
        "trigger",
        "transmission_path",
        "classification_reason",
        "extraction_method",
        "content_kind",
        "extractor_version",
    )
    if any(
        _normalize(candidate.metadata.get(field_name))
        != _normalize(current_metadata.get(field_name))
        for field_name in tracked_metadata_fields
    ):
        return True
    if abs(candidate.confidence - float(current["confidence"] or 0)) > 1e-9:
        return True
    fields = (
        (candidate.value_numeric, current["value_numeric"]),
        (candidate.value_text, current["value_text"]),
        (candidate.unit, current["unit"]),
        (candidate.period, current["period"]),
        (candidate.scenario, current["scenario"]),
        (candidate.probability, current["probability"]),
        (candidate.impact, current["impact"]),
        (candidate.state, current["state"]),
        (candidate.expected_start, current["expected_start"]),
        (candidate.expected_end, current["expected_end"]),
        (candidate.stance, current["stance"]),
    )
    for left, right in fields:
        if left is None and right is None:
            continue
        if isinstance(left, float) or isinstance(right, float):
            if left is None or right is None or abs(float(left) - float(right)) > 1e-9:
                return True
        elif _normalize(left) != _normalize(right):
            return True
    return (
        SequenceMatcher(
            None, _canonical_text(candidate.content), _canonical_text(current["content"])
        ).ratio()
        < 0.98
    )


def _change_type(candidate: ResearchCandidate, current: sqlite3.Row | None) -> str:
    if current is None or not current["current_version_id"]:
        return "new"
    if candidate.state != str(current["state"] or ""):
        return "status_changed"
    if candidate.value_numeric is not None and current["value_numeric"] is not None:
        if abs(candidate.value_numeric - float(current["value_numeric"])) > 1e-9:
            return "value_changed"
    if candidate.expected_start != str(
        current["expected_start"] or ""
    ) or candidate.expected_end != str(current["expected_end"] or ""):
        return "timing_changed"
    if candidate.probability != str(current["probability"] or ""):
        return "probability_changed"
    if candidate.stance != str(current["stance"] or ""):
        return "stance_changed"
    return "content_changed"


def _materiality(candidate: ResearchCandidate, change_type: str) -> str:
    if candidate.impact == "critical" or candidate.state in {"realized", "missed", "cancelled"}:
        return "critical"
    if candidate.impact == "high" or change_type in {"status_changed", "stance_changed"}:
        return "high"
    if candidate.impact == "low":
        return "low"
    return "medium"


def _candidate_payload(candidate: ResearchCandidate) -> dict[str, Any]:
    return {
        field_name: getattr(candidate, field_name) for field_name in candidate.__dataclass_fields__
    }


def _active_watch_rules(
    conn: sqlite3.Connection, dataset_id: str, item_type: str, item_id: str
) -> list[sqlite3.Row]:
    return conn.execute(
        """
        SELECT * FROM research_watch_rules
        WHERE dataset_id=? AND active=1
          AND (target_type=? OR target_type='all')
          AND (target_item_id IS NULL OR target_item_id=''
               OR target_item_id=?)
        ORDER BY created_at
        """,
        (dataset_id, item_type, item_id),
    ).fetchall()


def _watch_rule_matches(
    rule: sqlite3.Row,
    *,
    title: str,
    content: str,
    state: str,
    impact: str,
    change_type: str,
    event_type: str,
) -> bool:
    query = _decode(rule["query_json"], {})
    if not isinstance(query, dict):
        return True
    raw_keywords = query.get("keywords") or query.get("keyword") or []
    if isinstance(raw_keywords, str):
        keywords = [raw_keywords]
    elif isinstance(raw_keywords, list):
        keywords = [str(item) for item in raw_keywords if str(item).strip()]
    else:
        keywords = []
    haystack = _canonical_text(f"{title} {content}")
    if keywords and not any(_canonical_text(keyword) in haystack for keyword in keywords):
        return False
    filters = {
        "states": state,
        "impacts": impact,
        "change_types": change_type,
        "event_types": event_type,
    }
    for key, actual in filters.items():
        expected = query.get(key)
        if isinstance(expected, str):
            accepted = {expected}
        elif isinstance(expected, list):
            accepted = {str(item) for item in expected}
        else:
            continue
        if accepted and actual not in accepted:
            return False
    return True


_PRIORITY_RANK = {"low": 0, "medium": 1, "high": 2, "critical": 3}
_WATCH_FREQUENCIES = frozenset({"on_ingest", "daily", "weekly"})
_WATCH_CHANGE_TYPES = frozenset(
    {
        "new",
        "status_changed",
        "value_changed",
        "timing_changed",
        "probability_changed",
        "stance_changed",
        "content_changed",
    }
)


def _create_alerts(
    conn: sqlite3.Connection,
    dataset_id: str,
    candidate: ResearchCandidate,
    item_id: str,
    change_event_id: str,
    change_type: str,
    materiality: str,
) -> int:
    if candidate.item_type not in {"risk", "catalyst"}:
        return 0
    quality_status = str(candidate.metadata.get("quality_status") or "needs_review")
    if quality_status != "verified":
        return 0
    if change_type == "new" and (
        candidate.confidence < 0.8 or materiality not in {"high", "critical"}
    ):
        return 0
    if change_type != "new" and candidate.confidence < 0.72:
        return 0
    created = 0
    now = _now_iso()
    for rule in _active_watch_rules(conn, dataset_id, candidate.item_type, item_id):
        if not _watch_rule_matches(
            rule,
            title=candidate.title,
            content=candidate.content,
            state=candidate.state,
            impact=candidate.impact,
            change_type=change_type,
            event_type=str(candidate.metadata.get("event_type") or ""),
        ):
            continue
        if _PRIORITY_RANK.get(materiality, 1) < _PRIORITY_RANK.get(str(rule["min_priority"]), 1):
            continue
        frequency = str(rule["frequency"] or "on_ingest")
        if frequency in {"daily", "weekly"}:
            interval = timedelta(days=1 if frequency == "daily" else 7)
            cutoff = (datetime.now(timezone.utc) - interval).isoformat()
            recent = conn.execute(
                """
                SELECT 1 FROM research_alerts
                WHERE dataset_id=? AND rule_id=? AND item_id=? AND created_at>=?
                LIMIT 1
                """,
                (dataset_id, rule["rule_id"], item_id, cutoff),
            ).fetchone()
            if recent is not None:
                continue
        dedupe_key = _digest(rule["rule_id"], item_id, change_event_id, change_type, length=40)
        alert_id = f"al_{_digest(dataset_id, dedupe_key)}"
        summary = f"{candidate.title}：{change_type.replace('_', ' ')}"
        cursor = conn.execute(
            """
            INSERT OR IGNORE INTO research_alerts
                (alert_id, dataset_id, rule_id, item_id, change_event_id,
                 alert_type, priority, title, summary, why_it_matters,
                 evidence_ids_json, status, due_at, dedupe_key, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?, ?, ?, ?)
            """,
            (
                alert_id,
                dataset_id,
                rule["rule_id"],
                item_id,
                change_event_id,
                change_type,
                materiality,
                candidate.title,
                summary,
                candidate.content[:500],
                _json(candidate.evidence_ids),
                candidate.expected_start or candidate.expected_end or None,
                dedupe_key,
                now,
                now,
            ),
        )
        created += int(cursor.rowcount > 0)
    return created


def _reconcile_candidates(
    conn: sqlite3.Connection,
    dataset_id: str,
    candidates: list[ResearchCandidate],
    *,
    source_type: str,
    source_id: str,
) -> dict[str, int]:
    stats = {
        "items_created": 0,
        "versions_created": 0,
        "observations_created": 0,
        "alerts_created": 0,
    }
    now = _now_iso()
    for candidate in candidates:
        current = _find_item(conn, dataset_id, candidate)
        if current is None:
            item_id = f"ri_{_digest(dataset_id, candidate.item_type, candidate.canonical_key)}"
            conn.execute(
                """
                INSERT INTO research_items
                    (item_id, dataset_id, item_type, canonical_key, title, status,
                     current_version_no, first_seen_at, last_seen_at, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)
                """,
                (
                    item_id,
                    dataset_id,
                    candidate.item_type,
                    candidate.canonical_key,
                    candidate.title,
                    candidate.state,
                    now,
                    now,
                    now,
                    now,
                ),
            )
            stats["items_created"] += 1
            current = None
        else:
            item_id = str(current["item_id"])
            conn.execute(
                "UPDATE research_items SET last_seen_at=?, updated_at=? WHERE item_id=?",
                (now, now, item_id),
            )
        create_version = current is None or _meaningful_change(candidate, current)
        item_version_id: str | None = (
            str(current["current_version_id"])
            if current and current["current_version_id"]
            else None
        )
        change_event_id = ""
        if create_version:
            version_no = int(current["current_version_no"] if current else 0) + 1
            item_version_id = (
                f"riv_{_digest(item_id, version_no, source_type, source_id, candidate.content)}"
            )
            conn.execute(
                """
                INSERT INTO research_item_versions
                    (item_version_id, item_id, version_no, as_of_date, source_published_at,
                     observed_at, source_type, source_id, content, stance, state,
                     value_numeric, value_text, unit, period, scenario, probability,
                     impact, confidence, expected_start, expected_end, metadata_json, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    item_version_id,
                    item_id,
                    version_no,
                    candidate.as_of_date or None,
                    candidate.source_published_at or None,
                    now,
                    source_type,
                    source_id,
                    candidate.content,
                    candidate.stance,
                    candidate.state,
                    candidate.value_numeric,
                    candidate.value_text or None,
                    candidate.unit or None,
                    candidate.period or None,
                    candidate.scenario or None,
                    candidate.probability or None,
                    candidate.impact,
                    candidate.confidence,
                    candidate.expected_start or None,
                    candidate.expected_end or None,
                    _json(candidate.metadata),
                    now,
                ),
            )
            for evidence_id in candidate.evidence_ids:
                conn.execute(
                    """
                    INSERT OR IGNORE INTO research_item_evidence
                        (item_version_id, evidence_id, relation_type)
                    VALUES (?, ?, 'supports')
                    """,
                    (item_version_id, evidence_id),
                )
            conn.execute(
                """
                UPDATE research_items
                SET title=?, status=?, current_version_no=?, current_version_id=?,
                    last_seen_at=?, updated_at=?,
                    archived_at=CASE WHEN ?='verified' THEN NULL ELSE archived_at END,
                    archive_reason=CASE WHEN ?='verified' THEN NULL ELSE archive_reason END
                WHERE item_id=?
                """,
                (
                    candidate.title,
                    candidate.state,
                    version_no,
                    item_version_id,
                    now,
                    now,
                    str(candidate.metadata.get("quality_status") or "needs_review"),
                    str(candidate.metadata.get("quality_status") or "needs_review"),
                    item_id,
                ),
            )
            change_type = _change_type(candidate, current)
            materiality = _materiality(candidate, change_type)
            change_event_id = f"ce_{_digest(item_id, item_version_id, change_type)}"
            details = {
                "old": {
                    "version_id": current["current_version_id"] if current else None,
                    "content": current["content"] if current else "",
                    "state": current["state"] if current else None,
                    "value_numeric": current["value_numeric"] if current else None,
                },
                "new": _candidate_payload(candidate),
            }
            conn.execute(
                """
                INSERT OR IGNORE INTO research_change_events
                    (change_event_id, dataset_id, item_id, old_version_id, new_version_id,
                     change_type, materiality, summary, details_json, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    change_event_id,
                    dataset_id,
                    item_id,
                    current["current_version_id"] if current else None,
                    item_version_id,
                    change_type,
                    materiality,
                    f"{candidate.title}: {change_type}",
                    _json(details),
                    now,
                ),
            )
            stats["versions_created"] += 1
            stats["alerts_created"] += _create_alerts(
                conn,
                dataset_id,
                candidate,
                item_id,
                change_event_id,
                change_type,
                materiality,
            )
        observation_id = f"obs_{_digest(item_id, source_type, source_id, candidate.content)}"
        cursor = conn.execute(
            """
            INSERT OR IGNORE INTO research_tracking_observations
                (observation_id, item_id, item_version_id, source_type, source_id,
                 content, evidence_ids_json, extracted_json, observed_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                observation_id,
                item_id,
                item_version_id,
                source_type,
                source_id,
                candidate.content,
                _json(candidate.evidence_ids),
                _json(_candidate_payload(candidate)),
                now,
            ),
        )
        stats["observations_created"] += int(cursor.rowcount > 0)
    return stats


def _scan_due_items(conn: sqlite3.Connection, dataset_id: str) -> dict[str, int]:
    now = _now()
    reopened = conn.execute(
        """
        UPDATE research_alerts
        SET status='new', snoozed_until=NULL, updated_at=?
        WHERE dataset_id=? AND status='snoozed'
          AND snoozed_until IS NOT NULL AND snoozed_until<=?
        """,
        (now.isoformat(), dataset_id, now.isoformat()),
    ).rowcount
    rows = conn.execute(
        """
        SELECT i.*, v.* FROM research_items i
        JOIN research_item_versions v ON v.item_version_id=i.current_version_id
        WHERE i.dataset_id=? AND i.item_type IN ('risk', 'catalyst')
          AND v.state NOT IN ('resolved', 'dismissed', 'achieved', 'missed', 'cancelled')
          AND COALESCE(v.expected_start, v.expected_end) IS NOT NULL
        """,
        (dataset_id,),
    ).fetchall()
    created = 0
    for row in rows:
        metadata = _decode(row["metadata_json"], {})
        if str(metadata.get("quality_status") or "needs_review") != "verified":
            continue
        if float(row["confidence"] or 0) < 0.72:
            continue
        raw_due = str(row["expected_start"] or row["expected_end"] or "")
        try:
            due_date = datetime.fromisoformat(raw_due[:10]).replace(tzinfo=timezone.utc)
        except ValueError:
            continue
        days = (due_date.date() - now.date()).days
        threshold = next((value for value in (7, 3, 1, 0) if days == value), None)
        if days < 0:
            threshold = -1
        if threshold is None:
            continue
        alert_type = "overdue" if threshold == -1 else "due_soon"
        priority = "high" if threshold in {-1, 0, 1} else "medium"
        for rule in _active_watch_rules(conn, dataset_id, row["item_type"], row["item_id"]):
            if _PRIORITY_RANK.get(priority, 1) < _PRIORITY_RANK.get(str(rule["min_priority"]), 1):
                continue
            if not _watch_rule_matches(
                rule,
                title=str(row["title"]),
                content=str(row["content"]),
                state=str(row["state"]),
                impact=str(row["impact"]),
                change_type=alert_type,
            ):
                continue
            evidence_ids = [
                str(item["evidence_id"])
                for item in conn.execute(
                    """
                    SELECT evidence_id FROM research_item_evidence
                    WHERE item_version_id=?
                    """,
                    (row["item_version_id"],),
                )
            ]
            dedupe_key = _digest(
                rule["rule_id"], row["item_id"], alert_type, raw_due, threshold, length=40
            )
            cursor = conn.execute(
                """
                INSERT OR IGNORE INTO research_alerts
                    (alert_id, dataset_id, rule_id, item_id, alert_type, priority,
                     title, summary, why_it_matters, evidence_ids_json, status,
                     due_at, dedupe_key, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?, ?, ?, ?)
                """,
                (
                    f"al_{_digest(dataset_id, dedupe_key)}",
                    dataset_id,
                    rule["rule_id"],
                    row["item_id"],
                    alert_type,
                    priority,
                    row["title"],
                    f"{row['title']} {'已逾期' if threshold == -1 else f'{days} 天后到期'}",
                    row["content"][:500],
                    _json(evidence_ids),
                    raw_due,
                    dedupe_key,
                    _now_iso(),
                    _now_iso(),
                ),
            )
            created += int(cursor.rowcount > 0)
    return {
        "alerts_created": created,
        "alerts_reopened": int(reopened),
        "items_checked": len(rows),
    }


def _claim_job(conn: sqlite3.Connection) -> sqlite3.Row | None:
    now = _now_iso()
    conn.execute("BEGIN IMMEDIATE")
    row = conn.execute(
        """
        SELECT * FROM research_tracking_jobs
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
        UPDATE research_tracking_jobs
        SET status='running', attempt_count=attempt_count+1, locked_at=?,
            started_at=COALESCE(started_at, ?), updated_at=?
        WHERE job_id=? AND status='queued'
        """,
        (now, now, now, row["job_id"]),
    )
    conn.commit()
    return conn.execute(
        "SELECT * FROM research_tracking_jobs WHERE job_id=?", (row["job_id"],)
    ).fetchone()


def recover_stale_jobs(
    collection_db: Path, dataset_id: str, *, stale_after_minutes: int = 20
) -> int:
    cutoff = (_now() - timedelta(minutes=stale_after_minutes)).isoformat()
    now = _now_iso()
    with _connect(collection_db) as conn:
        ensure_tracking_schema(conn, dataset_id)
        cursor = conn.execute(
            """
            UPDATE research_tracking_jobs
            SET status=CASE
                    WHEN attempt_count >= max_attempts THEN 'failed'
                    ELSE 'queued'
                END,
                locked_at=NULL,
                available_at=?,
                finished_at=CASE
                    WHEN attempt_count >= max_attempts THEN ?
                    ELSE NULL
                END,
                last_error=COALESCE(last_error, 'worker lease expired'),
                updated_at=?
            WHERE dataset_id=? AND status='running' AND locked_at<?
            """,
            (now, now, now, dataset_id, cutoff),
        )
        conn.commit()
        return cursor.rowcount


def _archive_legacy_automatic_items(conn: sqlite3.Connection, dataset_id: str) -> int:
    """Archive legacy automatic rows left unmatched by a successful rebuild."""

    rows = conn.execute(
        """
        SELECT i.item_id, v.source_type, v.metadata_json
        FROM research_items i
        JOIN research_item_versions v ON v.item_version_id=i.current_version_id
        WHERE i.dataset_id=? AND i.archived_at IS NULL
          AND i.item_type IN ('risk', 'catalyst')
        """,
        (dataset_id,),
    ).fetchall()
    item_ids: list[str] = []
    for row in rows:
        metadata = _decode(row["metadata_json"], {})
        if metadata.get("requires_rebuild") and str(row["source_type"]) in {"document", "memo"}:
            item_ids.append(str(row["item_id"]))
    if not item_ids:
        return 0
    now = _now_iso()
    placeholders = ",".join("?" for _ in item_ids)
    cursor = conn.execute(
        f"""
        UPDATE research_items
        SET archived_at=?, archive_reason='legacy_rebuilt', updated_at=?
        WHERE item_id IN ({placeholders})
        """,
        [now, now, *item_ids],
    )
    return int(cursor.rowcount)


def process_next_job(
    collection_db: Path,
    dataset_id: str,
    *,
    llm_client: TrackingChatClient | None = None,
) -> dict[str, Any] | None:
    """Claim and execute one job. Failures are retried with durable backoff."""

    with _connect(collection_db) as conn:
        ensure_tracking_schema(conn, dataset_id)
        conn.commit()
        job = _claim_job(conn)
        if job is None:
            return None
        payload = _decode(job["payload_json"], {})
        try:
            if job["job_type"] == "scheduled_scan":
                result = _scan_due_items(conn, dataset_id)
            else:
                if job["job_type"] == "legacy_rebuild":
                    if llm_client is None:
                        raise RuntimeError("当前模型不可用，旧版数据未重新分析")
                    document_ids = [str(item) for item in payload.get("document_ids") or []]
                    units, default_date = _load_document_units(conn, document_ids)
                    for memo_version_id in payload.get("memo_version_ids") or []:
                        memo_units, memo_date = _load_memo_units(conn, str(memo_version_id))
                        units.extend(memo_units)
                        default_date = max(default_date, memo_date)
                    source_type = "document"
                    source_id = str(job["source_id"])
                elif job["job_type"] == "memo_version_created":
                    source_type = "memo"
                    source_id = str(payload.get("memo_version_id") or job["source_id"])
                    units, default_date = _load_memo_units(conn, source_id)
                else:
                    source_type = "document"
                    document_ids = [str(item) for item in payload.get("document_ids") or []]
                    units, default_date = _load_document_units(conn, document_ids)
                    source_id = str(job["source_id"])
                valid_evidence_ids = {
                    str(unit["evidence_id"])
                    for unit in units
                    if str(unit.get("evidence_id") or "")
                }
                candidates = _heuristic_candidates(units, valid_evidence_ids, default_date)
                llm_error = ""
                if llm_client is not None and units:
                    try:
                        llm_extracted = _llm_candidates(
                            llm_client,
                            units,
                            valid_evidence_ids,
                            default_date,
                            _current_user_locale(),
                        )
                        llm_evidence_ids = {
                            evidence_id
                            for candidate in llm_extracted
                            for evidence_id in candidate.evidence_ids
                        }
                        merged = {
                            (candidate.item_type, candidate.canonical_key): candidate
                            for candidate in candidates
                            if not llm_evidence_ids.intersection(candidate.evidence_ids)
                        }
                        for candidate in llm_extracted:
                            merged[(candidate.item_type, candidate.canonical_key)] = candidate
                        candidates = list(merged.values())
                    except Exception as exc:  # noqa: BLE001
                        llm_error = str(exc)
                result = {
                    "source_type": source_type,
                    "source_id": source_id,
                    "unit_count": len(units),
                    "candidate_count": len(candidates),
                    "verified_candidate_count": sum(
                        candidate.metadata.get("quality_status") == "verified"
                        for candidate in candidates
                    ),
                    "review_candidate_count": sum(
                        candidate.metadata.get("quality_status") != "verified"
                        for candidate in candidates
                    ),
                    "llm_used": llm_client is not None,
                    "skill_name": "private-fund-risk-catalyst-tracking",
                    "skill_loaded": bool(_tracking_skill_text()),
                    "llm_error": llm_error,
                    **_reconcile_candidates(
                        conn,
                        dataset_id,
                        candidates,
                        source_type=source_type,
                        source_id=source_id,
                    ),
                }
                if job["job_type"] == "legacy_rebuild":
                    if llm_error:
                        raise RuntimeError(f"旧版数据重新分析失败：{llm_error}")
                    result["legacy_items_archived"] = _archive_legacy_automatic_items(
                        conn, dataset_id
                    )
            now = _now_iso()
            conn.execute(
                """
                UPDATE research_tracking_jobs
                SET status='completed', result_json=?, finished_at=?, locked_at=NULL,
                    last_error=NULL, updated_at=? WHERE job_id=?
                """,
                (_json(result), now, now, job["job_id"]),
            )
            conn.commit()
            completed = conn.execute(
                "SELECT * FROM research_tracking_jobs WHERE job_id=?", (job["job_id"],)
            ).fetchone()
            return _job_payload(completed)
        except Exception as exc:  # noqa: BLE001
            attempt_count = int(job["attempt_count"] or 0)
            max_attempts = int(job["max_attempts"] or 4)
            status = "failed" if attempt_count >= max_attempts else "queued"
            retry_index = min(max(0, attempt_count - 1), len(_RETRY_DELAYS_SECONDS) - 1)
            available_at = (
                _now() + timedelta(seconds=_RETRY_DELAYS_SECONDS[retry_index])
            ).isoformat()
            now = _now_iso()
            conn.execute(
                """
                UPDATE research_tracking_jobs
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
            failed = conn.execute(
                "SELECT * FROM research_tracking_jobs WHERE job_id=?", (job["job_id"],)
            ).fetchone()
            return _job_payload(failed)


def _job_payload(row: sqlite3.Row | None) -> dict[str, Any]:
    if row is None:
        return {}
    payload = dict(row)
    payload["payload"] = _decode(payload.pop("payload_json"), {})
    payload["result"] = _decode(payload.pop("result_json"), None)
    return payload


def list_jobs(collection_db: Path, dataset_id: str, *, limit: int = 50) -> list[dict[str, Any]]:
    with _connect(collection_db) as conn:
        ensure_tracking_schema(conn, dataset_id)
        rows = conn.execute(
            """
            SELECT * FROM research_tracking_jobs WHERE dataset_id=?
            ORDER BY created_at DESC LIMIT ?
            """,
            (dataset_id, max(1, min(limit, 200))),
        ).fetchall()
        return [_job_payload(row) for row in rows]


def get_job(collection_db: Path, dataset_id: str, job_id: str) -> dict[str, Any]:
    with _connect(collection_db) as conn:
        ensure_tracking_schema(conn, dataset_id)
        row = conn.execute(
            "SELECT * FROM research_tracking_jobs WHERE dataset_id=? AND job_id=?",
            (dataset_id, job_id),
        ).fetchone()
        if row is None:
            raise KeyError(job_id)
        return _job_payload(row)


def _change_event_payload(row: sqlite3.Row) -> dict[str, Any]:
    payload = dict(row)
    payload["details"] = _decode(payload.pop("details_json"), {})
    return payload


def _evidence_source_payload(conn: sqlite3.Connection, evidence_id: str) -> dict[str, Any] | None:
    kind, _, raw_id = evidence_id.partition(":")
    if kind not in {"chunk", "fact"} or not raw_id:
        return None
    record: dict[str, Any] = {}
    location: dict[str, Any] = {}
    if kind == "chunk":
        row = conn.execute("SELECT * FROM chunks WHERE chunk_id=?", (raw_id,)).fetchone()
        if row is None:
            return None
        record = dict(row)
        if "chunk_locations" in _tables(conn):
            location_row = conn.execute(
                "SELECT * FROM chunk_locations WHERE chunk_id=? ORDER BY rowid LIMIT 1",
                (raw_id,),
            ).fetchone()
            if location_row:
                location = dict(location_row)
        excerpt = str(record.get("content") or record.get("summary") or "")
    else:
        row = conn.execute("SELECT * FROM metric_facts WHERE fact_id=?", (raw_id,)).fetchone()
        if row is None:
            return None
        record = dict(row)
        excerpt = " ".join(
            str(record.get(key) or "")
            for key in ("metric_name", "period", "value_text", "unit")
            if record.get(key) not in (None, "")
        )
        location = {
            "sheet_name": record.get("sheet_name"),
            "cell_range": record.get("cell_ref"),
        }
    doc_id = str(record.get("doc_id") or "")
    document_row = conn.execute("SELECT * FROM documents WHERE doc_id=?", (doc_id,)).fetchone()
    if document_row is None:
        return None
    document = dict(document_row)
    document_name = str(document.get("original_filename") or doc_id)
    page_start = location.get("page_start")
    page_end = location.get("page_end")
    sheet_name = location.get("sheet_name")
    cell_range = location.get("cell_range") or location.get("cell_ref")
    heading_path = location.get("heading_path")
    if page_start:
        position = f"第 {page_start} 页"
        if page_end and page_end != page_start:
            position = f"第 {page_start}–{page_end} 页"
    elif sheet_name:
        position = f"{sheet_name}!{cell_range}" if cell_range else str(sheet_name)
    elif heading_path:
        position = str(heading_path)
    else:
        position = "文档片段"
    source_url = None
    suffix = Path(document_name).suffix.lower()
    if page_start and suffix == ".pdf":
        source_url = "#private-fund-pdf-source?" + urlencode(
            {
                "page": str(page_start),
                "label": position,
                "pdf_name": document_name,
                "evidence_id": evidence_id,
            }
        )
    elif sheet_name and suffix in {".xlsx", ".xlsm", ".xls", ".csv"}:
        params = {
            "workbook_name": document_name,
            "sheet_name": str(sheet_name),
            "label": f"{document_name} {position}",
        }
        if cell_range:
            params["range_ref"] = str(cell_range)
        source_url = "#private-fund-excel-source?" + urlencode(params)
    full_content = re.sub(r"\s+", " ", excerpt).strip()[:20_000]
    return {
        "evidence_id": evidence_id,
        "citation": f"{document_name} · {position}",
        "document_name": document_name,
        "excerpt": full_content[:800],
        "full_content": full_content,
        "source_url": source_url,
        "page_start": page_start,
        "page_end": page_end,
        "sheet_name": sheet_name,
        "cell_range": cell_range,
    }


def _item_payload(conn: sqlite3.Connection, row: sqlite3.Row) -> dict[str, Any]:
    payload = dict(row)
    version_id = payload.get("current_version_id")
    version = None
    evidence_ids: list[str] = []
    if version_id:
        version_row = conn.execute(
            "SELECT * FROM research_item_versions WHERE item_version_id=?", (version_id,)
        ).fetchone()
        if version_row:
            version = dict(version_row)
            version["metadata"] = _decode(version.pop("metadata_json"), {})
            evidence_rows = conn.execute(
                """
                SELECT e.evidence_id, c.content
                FROM research_item_evidence e
                LEFT JOIN chunks c ON e.evidence_id=('chunk:' || c.chunk_id)
                WHERE e.item_version_id=?
                """,
                (version_id,),
            ).fetchall()
            evidence_ids = [str(item["evidence_id"]) for item in evidence_rows]
            version["evidence_ids"] = evidence_ids
            evidence_contents = [
                str(item["content"])
                for item in evidence_rows
                if item["content"] is not None and str(item["content"]).strip()
            ]
            version["evidence_grounding_failure"] = bool(evidence_contents) and all(
                _is_boilerplate_evidence(content) for content in evidence_contents
            )
    payload["current_version"] = version
    return payload


def _is_displayable_tracking_item(item: dict[str, Any]) -> bool:
    if item.get("item_type") not in {"risk", "catalyst"}:
        return True
    version = item.get("current_version") or {}
    metadata = version.get("metadata") or {}
    if metadata.get("requires_rebuild"):
        return bool(_canonical_text(item.get("title")) and _canonical_text(version.get("content")))
    if version.get("evidence_grounding_failure"):
        return False
    if metadata.get("extraction_method") == "keyword_fallback":
        return False
    if not _has_minimum_event_structure(metadata, str(item.get("item_type")), version):
        return False
    title = _canonical_text(item.get("title"))
    content = _canonical_text(version.get("content"))
    if not title or not content or title == content:
        return False
    return not (
        min(len(title), len(content)) >= 10
        and SequenceMatcher(None, title, content).ratio() >= 0.9
    )


def _tracking_item_quality_issue(item: dict[str, Any]) -> str:
    """Return a user-facing reason when a risk/catalyst record fails the quality gate."""

    if item.get("item_type") not in {"risk", "catalyst"}:
        return ""
    version = item.get("current_version") or {}
    metadata = version.get("metadata") or {}
    if metadata.get("requires_rebuild"):
        return "旧版数据，尚未使用当前规则重新分析"
    if version.get("evidence_grounding_failure"):
        return "证据仅包含主持人转场或提问提示，无法支持当前判断"
    if metadata.get("extraction_method") == "keyword_fallback":
        return "旧版关键词降级记录，未形成完整事件结构"
    if not _has_minimum_event_structure(metadata, str(item.get("item_type")), version):
        return "缺少主体、事件类型或影响对象等关键结构"
    title = _canonical_text(item.get("title"))
    content = _canonical_text(version.get("content"))
    if not title:
        return "标题为空"
    if not content:
        return "当前判断为空"
    if title == content:
        return "标题与原文判断完全重复"
    if (
        min(len(title), len(content)) >= 10
        and SequenceMatcher(None, title, content).ratio() >= 0.9
    ):
        return "标题与原文判断高度重复"
    return ""


def list_items(
    collection_db: Path,
    dataset_id: str,
    *,
    item_type: str | None = None,
    status: str | None = None,
    limit: int = 200,
    include_unqualified: bool = False,
    archive_status: str = "active",
) -> list[dict[str, Any]]:
    if archive_status not in {"active", "archived", "all"}:
        raise ValueError("unsupported archive status")
    with _connect(collection_db) as conn:
        ensure_tracking_schema(conn, dataset_id)
        sql = "SELECT * FROM research_items WHERE dataset_id=?"
        params: list[Any] = [dataset_id]
        if item_type:
            sql += " AND item_type=?"
            params.append(item_type)
        if status:
            sql += " AND status=?"
            params.append(status)
        if archive_status == "active":
            sql += " AND archived_at IS NULL"
        elif archive_status == "archived":
            sql += " AND archived_at IS NOT NULL"
        sql += " ORDER BY updated_at DESC LIMIT ?"
        requested_limit = max(1, min(limit, 500))
        params.append(500 if not include_unqualified else requested_limit)
        items = [_item_payload(conn, row) for row in conn.execute(sql, params)]
        if not include_unqualified:
            items = [item for item in items if _is_displayable_tracking_item(item)]
        return items[:requested_limit]


def list_low_quality_items(
    collection_db: Path,
    dataset_id: str,
    *,
    archive_status: str = "active",
    limit: int = 500,
) -> list[dict[str, Any]]:
    """List records rejected by the current quality gate for auditable governance."""

    items = list_items(
        collection_db,
        dataset_id,
        limit=limit,
        include_unqualified=True,
        archive_status=archive_status,
    )
    governed = []
    for item in items:
        issue = _tracking_item_quality_issue(item)
        if issue:
            item["quality_issue"] = issue
            governed.append(item)
    return governed


def archive_low_quality_items(
    collection_db: Path,
    dataset_id: str,
    item_ids: list[str],
) -> dict[str, Any]:
    selected = {str(item_id).strip() for item_id in item_ids if str(item_id).strip()}
    if not selected:
        raise ValueError("at least one item is required")
    eligible = {
        str(item["item_id"]): item
        for item in list_low_quality_items(
            collection_db, dataset_id, archive_status="active", limit=500
        )
    }
    invalid = sorted(selected - set(eligible))
    if invalid:
        raise ValueError("only active records rejected by the quality gate can be archived")
    now = _now_iso()
    with _connect(collection_db) as conn:
        ensure_tracking_schema(conn, dataset_id)
        for item_id in sorted(selected):
            conn.execute(
                """
                UPDATE research_items
                SET archived_at=?, archive_reason=?, updated_at=?
                WHERE dataset_id=? AND item_id=? AND archived_at IS NULL
                """,
                (now, str(eligible[item_id]["quality_issue"]), now, dataset_id, item_id),
            )
        conn.commit()
    return {"archived_count": len(selected), "item_ids": sorted(selected)}


def restore_archived_items(
    collection_db: Path,
    dataset_id: str,
    item_ids: list[str],
) -> dict[str, Any]:
    selected = sorted({str(item_id).strip() for item_id in item_ids if str(item_id).strip()})
    if not selected:
        raise ValueError("at least one item is required")
    now = _now_iso()
    with _connect(collection_db) as conn:
        ensure_tracking_schema(conn, dataset_id)
        restored = 0
        for item_id in selected:
            cursor = conn.execute(
                """
                UPDATE research_items
                SET archived_at=NULL, archive_reason=NULL, updated_at=?
                WHERE dataset_id=? AND item_id=? AND archived_at IS NOT NULL
                """,
                (now, dataset_id, item_id),
            )
            restored += cursor.rowcount
        conn.commit()
    return {"restored_count": restored, "item_ids": selected}


def purge_archived_items(
    collection_db: Path,
    dataset_id: str,
    item_ids: list[str],
) -> dict[str, Any]:
    """Permanently delete selected archived records and their dependent tracking data."""

    selected = sorted({str(item_id).strip() for item_id in item_ids if str(item_id).strip()})
    if not selected:
        raise ValueError("at least one item is required")
    with _connect(collection_db) as conn:
        ensure_tracking_schema(conn, dataset_id)
        archived = {
            str(row["item_id"])
            for row in conn.execute(
                """
                SELECT item_id FROM research_items
                WHERE dataset_id=? AND archived_at IS NOT NULL
                """,
                (dataset_id,),
            )
        }
        if set(selected) - archived:
            raise ValueError("only archived records can be permanently deleted")
        placeholders = ",".join("?" for _ in selected)
        version_ids = [
            str(row["item_version_id"])
            for row in conn.execute(
                f"""
                SELECT item_version_id FROM research_item_versions
                WHERE item_id IN ({placeholders})
                """,
                selected,
            )
        ]
        if version_ids:
            version_placeholders = ",".join("?" for _ in version_ids)
            conn.execute(
                f"""
                DELETE FROM research_item_evidence
                WHERE item_version_id IN ({version_placeholders})
                """,
                version_ids,
            )
        for table in (
            "research_alerts",
            "research_change_events",
            "research_tracking_observations",
            "research_item_versions",
        ):
            conn.execute(f"DELETE FROM {table} WHERE item_id IN ({placeholders})", selected)
        conn.execute(
            f"""
            DELETE FROM research_item_relations
            WHERE from_item_id IN ({placeholders}) OR to_item_id IN ({placeholders})
            """,
            [*selected, *selected],
        )
        conn.execute(
            f"""
            DELETE FROM research_watch_rules
            WHERE dataset_id=? AND target_item_id IN ({placeholders})
            """,
            [dataset_id, *selected],
        )
        conn.execute(
            f"DELETE FROM research_items WHERE dataset_id=? AND item_id IN ({placeholders})",
            [dataset_id, *selected],
        )
        conn.commit()
    return {"purged_count": len(selected), "item_ids": selected}


_VERSION_DIFF_FIELDS = (
    ("title", "标题"),
    ("content", "当前判断"),
    ("stance", "判断倾向"),
    ("state", "状态"),
    ("value_numeric", "数值"),
    ("value_text", "文本值"),
    ("unit", "单位"),
    ("period", "期间"),
    ("scenario", "情景"),
    ("probability", "发生概率"),
    ("impact", "影响程度"),
    ("confidence", "置信度"),
    ("expected_start", "预计开始"),
    ("expected_end", "预计结束"),
    ("entity", "主体"),
    ("event_type", "事件类型"),
    ("subject", "影响对象"),
    ("direction", "影响方向"),
    ("trigger", "触发因素"),
    ("transmission_path", "传导路径"),
    ("classification_reason", "分类依据"),
    ("quality_status", "质量状态"),
    ("evidence_ids", "证据"),
)


def _version_diff_value(version: dict[str, Any], field: str) -> Any:
    if field == "title":
        return version.get("title")
    if field in {
        "entity",
        "event_type",
        "subject",
        "direction",
        "trigger",
        "transmission_path",
        "classification_reason",
        "quality_status",
    }:
        return (version.get("metadata") or {}).get(field)
    return version.get(field)


def _version_field_changes(
    previous: dict[str, Any] | None, current: dict[str, Any]
) -> list[dict[str, Any]]:
    changes: list[dict[str, Any]] = []
    for field_name, label in _VERSION_DIFF_FIELDS:
        before = _version_diff_value(previous or {}, field_name)
        after = _version_diff_value(current, field_name)
        if before == after or (before in (None, "", []) and after in (None, "", [])):
            continue
        change_kind = "changed"
        if before in (None, "", []):
            change_kind = "added"
        elif after in (None, "", []):
            change_kind = "removed"
        changes.append(
            {
                "field": field_name,
                "label": label,
                "before": before,
                "after": after,
                "change_kind": change_kind,
            }
        )
    return changes


def get_item_timeline(collection_db: Path, dataset_id: str, item_id: str) -> dict[str, Any]:
    with _connect(collection_db) as conn:
        ensure_tracking_schema(conn, dataset_id)
        item = conn.execute(
            "SELECT * FROM research_items WHERE dataset_id=? AND item_id=?",
            (dataset_id, item_id),
        ).fetchone()
        if item is None:
            raise KeyError(item_id)
        changes = [
            _change_event_payload(row)
            for row in conn.execute(
                "SELECT * FROM research_change_events WHERE item_id=? ORDER BY created_at",
                (item_id,),
            )
        ]
        titles_by_version = {
            str(change.get("new_version_id") or ""): str(
                (change.get("details") or {}).get("new", {}).get("title") or ""
            )
            for change in changes
        }
        versions = []
        for row in conn.execute(
            "SELECT * FROM research_item_versions WHERE item_id=? ORDER BY version_no",
            (item_id,),
        ):
            version = dict(row)
            version["metadata"] = _decode(version.pop("metadata_json"), {})
            version["evidence_ids"] = [
                evidence["evidence_id"]
                for evidence in conn.execute(
                    "SELECT evidence_id FROM research_item_evidence WHERE item_version_id=?",
                    (row["item_version_id"],),
                )
            ]
            version["evidence_sources"] = [
                source
                for evidence_id in version["evidence_ids"]
                if (source := _evidence_source_payload(conn, str(evidence_id))) is not None
            ]
            version["title"] = titles_by_version.get(str(row["item_version_id"])) or (
                str(item["title"]) if row["item_version_id"] == item["current_version_id"] else ""
            )
            version["field_changes"] = _version_field_changes(
                versions[-1] if versions else None, version
            )
            versions.append(version)
        observations = []
        for row in conn.execute(
            """
            SELECT * FROM research_tracking_observations
            WHERE item_id=? ORDER BY observed_at
            """,
            (item_id,),
        ):
            observation = dict(row)
            observation["evidence_ids"] = _decode(observation.pop("evidence_ids_json"), [])
            observation["extracted"] = _decode(observation.pop("extracted_json"), {})
            observations.append(observation)
        return {
            "item": dict(item),
            "versions": versions,
            "changes": changes,
            "observations": observations,
        }


def list_watch_rules(collection_db: Path, dataset_id: str) -> list[dict[str, Any]]:
    with _connect(collection_db) as conn:
        ensure_tracking_schema(conn, dataset_id)
        conn.commit()
        rows = conn.execute(
            "SELECT * FROM research_watch_rules WHERE dataset_id=? ORDER BY created_at",
            (dataset_id,),
        ).fetchall()
        payloads = []
        for row in rows:
            payload = dict(row)
            payload["query"] = _decode(payload.pop("query_json"), {})
            payloads.append(payload)
        return payloads


def _normalize_watch_query(query: dict[str, Any] | None) -> dict[str, list[str]]:
    if query is None:
        return {}
    if not isinstance(query, dict):
        raise ValueError("watch rule query must be an object")
    normalized: dict[str, list[str]] = {}
    limits = {
        "keywords": 30,
        "event_types": 30,
        "states": 20,
        "impacts": 4,
        "change_types": 10,
    }
    for key, maximum in limits.items():
        raw = query.get(key, [])
        if isinstance(raw, str):
            values = [raw]
        elif isinstance(raw, list):
            values = raw
        else:
            raise ValueError(f"watch rule {key} must be a list")
        cleaned = list(dict.fromkeys(str(value).strip() for value in values if str(value).strip()))
        if len(cleaned) > maximum:
            raise ValueError(f"watch rule {key} contains too many values")
        if any(len(value) > 80 for value in cleaned):
            raise ValueError(f"watch rule {key} contains an overlong value")
        if key == "impacts" and any(value not in _PRIORITY_RANK for value in cleaned):
            raise ValueError("unsupported impact filter")
        if key == "change_types" and any(value not in _WATCH_CHANGE_TYPES for value in cleaned):
            raise ValueError("unsupported change type filter")
        if cleaned:
            normalized[key] = cleaned
    return normalized


def upsert_watch_rule(
    collection_db: Path,
    dataset_id: str,
    *,
    name: str,
    target_type: str,
    target_item_id: str = "",
    query: dict[str, Any] | None = None,
    min_priority: str = "medium",
    frequency: str = "on_ingest",
    active: bool = True,
    rule_id: str = "",
) -> dict[str, Any]:
    if target_type not in ITEM_TYPES | {"all"}:
        raise ValueError("unsupported watch target type")
    if min_priority not in _PRIORITY_RANK:
        raise ValueError("unsupported minimum priority")
    if frequency not in _WATCH_FREQUENCIES:
        raise ValueError("unsupported watch frequency")
    clean_name = str(name or "").strip()
    if not clean_name:
        raise ValueError("watch rule name is required")
    if len(clean_name) > 80:
        raise ValueError("watch rule name is too long")
    normalized_query = _normalize_watch_query(query)
    now = _now_iso()
    selected_id = rule_id or f"wr_{_digest(dataset_id, clean_name, target_type, target_item_id)}"
    with _connect(collection_db) as conn:
        ensure_tracking_schema(conn, dataset_id)
        conn.execute(
            """
            INSERT INTO research_watch_rules
                (rule_id, dataset_id, name, target_type, target_item_id,
                 query_json, min_priority, frequency, active, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(rule_id) DO UPDATE SET
                name=excluded.name, target_type=excluded.target_type,
                target_item_id=excluded.target_item_id, query_json=excluded.query_json,
                min_priority=excluded.min_priority, frequency=excluded.frequency,
                active=excluded.active, updated_at=excluded.updated_at
            """,
            (
                selected_id,
                dataset_id,
                clean_name,
                target_type,
                target_item_id or None,
                _json(normalized_query),
                min_priority,
                frequency,
                int(active),
                now,
                now,
            ),
        )
        conn.commit()
        row = conn.execute(
            "SELECT * FROM research_watch_rules WHERE rule_id=?", (selected_id,)
        ).fetchone()
        payload = dict(row)
        payload["query"] = _decode(payload.pop("query_json"), {})
        return payload


def list_alerts(
    collection_db: Path,
    dataset_id: str,
    *,
    status: str | None = None,
    limit: int = 200,
) -> list[dict[str, Any]]:
    with _connect(collection_db) as conn:
        ensure_tracking_schema(conn, dataset_id)
        sql = "SELECT * FROM research_alerts WHERE dataset_id=?"
        params: list[Any] = [dataset_id]
        if status:
            sql += " AND status=?"
            params.append(status)
        sql += (
            " ORDER BY CASE priority WHEN 'critical' THEN 3 WHEN 'high' THEN 2 "
            "WHEN 'medium' THEN 1 ELSE 0 END DESC, created_at DESC LIMIT ?"
        )
        params.append(max(1, min(limit, 500)))
        alerts = []
        for row in conn.execute(sql, params):
            payload = dict(row)
            payload["evidence_ids"] = _decode(payload.pop("evidence_ids_json"), [])
            alerts.append(payload)
        return alerts


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
        try:
            parsed_snooze = datetime.fromisoformat(str(snoozed_until).replace("Z", "+00:00"))
        except ValueError as exc:
            raise ValueError("snoozed_until must be an ISO-8601 timestamp") from exc
        if parsed_snooze.tzinfo is None:
            parsed_snooze = parsed_snooze.replace(tzinfo=timezone.utc)
        normalized_snooze = parsed_snooze.astimezone(timezone.utc).isoformat()
    now = _now_iso()
    with _connect(collection_db) as conn:
        ensure_tracking_schema(conn, dataset_id)
        cursor = conn.execute(
            """
            UPDATE research_alerts SET status=?, snoozed_until=?, updated_at=?
            WHERE dataset_id=? AND alert_id=?
            """,
            (status, normalized_snooze or None, now, dataset_id, alert_id),
        )
        if cursor.rowcount == 0:
            raise KeyError(alert_id)
        conn.commit()
        row = conn.execute(
            "SELECT * FROM research_alerts WHERE alert_id=?", (alert_id,)
        ).fetchone()
        payload = dict(row)
        payload["evidence_ids"] = _decode(payload.pop("evidence_ids_json"), [])
        return payload


def tracking_overview(collection_db: Path, dataset_id: str) -> dict[str, Any]:
    items = list_items(collection_db, dataset_id, limit=500)
    counts: dict[str, int] = {}
    quality_counts: dict[str, int] = {"verified": 0, "needs_review": 0}
    visible_item_ids = set()
    legacy_item_count = 0
    for item in items:
        item_type = str(item.get("item_type") or "")
        counts[item_type] = counts.get(item_type, 0) + 1
        visible_item_ids.add(str(item.get("item_id") or ""))
        if item_type in {"risk", "catalyst"}:
            metadata = (item.get("current_version") or {}).get("metadata") or {}
            if metadata.get("requires_rebuild"):
                legacy_item_count += 1
            quality = str(metadata.get("quality_status") or "needs_review")
            quality_counts[quality] = quality_counts.get(quality, 0) + 1
    alerts = [
        alert
        for alert in list_alerts(collection_db, dataset_id, limit=500)
        if str(alert.get("item_id") or "") in visible_item_ids
    ]
    unread = sum(alert.get("status") == "new" for alert in alerts)
    active_unqualified = list_low_quality_items(
        collection_db, dataset_id, archive_status="active", limit=500
    )
    archived_unqualified = list_low_quality_items(
        collection_db, dataset_id, archive_status="archived", limit=500
    )
    return {
        "dataset_id": dataset_id,
        "schema_version": TRACKING_SCHEMA_VERSION,
        "rebuild_required": legacy_item_count > 0,
        "legacy_item_count": legacy_item_count,
        "counts": counts,
        "unread_alert_count": unread,
        "quality_counts": quality_counts,
        "governance_counts": {
            "active_unqualified": len(active_unqualified),
            "archived": len(archived_unqualified),
        },
        "items": items[:100],
        "alerts": alerts[:100],
        "watch_rules": list_watch_rules(collection_db, dataset_id),
        "jobs": list_jobs(collection_db, dataset_id, limit=25),
        "memo_series": list_memo_series(collection_db, dataset_id),
        "memo_versions": list_memo_versions(collection_db, dataset_id),
    }
