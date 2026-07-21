"""Project durable private-fund versions into an Obsidian knowledge vault.

The collection database remains authoritative.  This module materializes a
read-only, rebuildable research view with mutable series home notes,
append-only version/diff notes, Obsidian Bases, preserved analyst sections,
and a durable outbox/registry for recovery and conflict detection.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import sqlite3
import unicodedata
from datetime import datetime, timedelta, timezone
from difflib import SequenceMatcher
from itertools import pairwise
from pathlib import Path
from typing import Any

import yaml

OBSIDIAN_SCHEMA_VERSION = 1
PROJECTOR_VERSION = "private-fund-obsidian-v3.1"
KNOWLEDGE_ROOT_NAME = "投研知识库"
AUTO_BEGIN = "<!-- AUTO:BEGIN -->"
AUTO_END = "<!-- AUTO:END -->"
USER_BEGIN = "<!-- USER:BEGIN -->"
USER_END = "<!-- USER:END -->"
_RETRY_DELAYS_SECONDS = (30, 120, 600)
_MATERIALITY_RANK = {"none": 0, "low": 1, "medium": 2, "high": 3, "critical": 4}


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


def _hash(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _slug(value: Any, *, fallback: str = "item", max_length: int = 80) -> str:
    text = unicodedata.normalize("NFKC", str(value or "")).strip()
    text = re.sub(r"[\\/:*?\"<>|#^[\]]+", "-", text)
    text = re.sub(r"\s+", "-", text)
    text = re.sub(r"-+", "-", text).strip("-. ")
    return (text or fallback)[:max_length]


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


def ensure_obsidian_schema(conn: sqlite3.Connection) -> None:
    """Create the additive outbox and projection registry schema."""

    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS obsidian_sync_outbox (
            event_id TEXT PRIMARY KEY,
            dataset_id TEXT NOT NULL,
            entity_type TEXT NOT NULL,
            entity_id TEXT NOT NULL,
            source_version TEXT NOT NULL,
            event_type TEXT NOT NULL,
            payload_json TEXT NOT NULL DEFAULT '{}',
            projector_version TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'queued',
            attempt_count INTEGER NOT NULL DEFAULT 0,
            max_attempts INTEGER NOT NULL DEFAULT 4,
            available_at TEXT NOT NULL,
            locked_at TEXT,
            finished_at TEXT,
            result_json TEXT,
            last_error TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            UNIQUE(
                dataset_id, entity_type, entity_id, source_version,
                event_type, projector_version
            )
        );

        CREATE TABLE IF NOT EXISTS obsidian_note_registry (
            dataset_id TEXT NOT NULL,
            entity_type TEXT NOT NULL,
            entity_id TEXT NOT NULL,
            source_version TEXT NOT NULL,
            note_path TEXT NOT NULL,
            content_hash TEXT NOT NULL,
            managed_hash TEXT NOT NULL,
            sync_status TEXT NOT NULL,
            last_synced_at TEXT,
            last_error TEXT,
            PRIMARY KEY(dataset_id, entity_type, entity_id, source_version),
            UNIQUE(note_path)
        );

        CREATE INDEX IF NOT EXISTS ix_obsidian_outbox_claim
            ON obsidian_sync_outbox(status, available_at, created_at);
        CREATE INDEX IF NOT EXISTS ix_obsidian_registry_dataset
            ON obsidian_note_registry(dataset_id, entity_type, entity_id);
        """
    )


def enqueue_projection_event(
    conn: sqlite3.Connection,
    *,
    dataset_id: str,
    entity_type: str,
    entity_id: str,
    source_version: str,
    event_type: str = "upsert",
    payload: dict[str, Any] | None = None,
) -> str:
    """Insert one idempotent projection event into an existing transaction."""

    ensure_obsidian_schema(conn)
    now = _now_iso()
    event_id = "ose_" + _digest(
        dataset_id,
        entity_type,
        entity_id,
        source_version,
        event_type,
        PROJECTOR_VERSION,
    )
    conn.execute(
        """
        INSERT OR IGNORE INTO obsidian_sync_outbox
            (event_id, dataset_id, entity_type, entity_id, source_version,
             event_type, payload_json, projector_version, status,
             available_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)
        """,
        (
            event_id,
            dataset_id,
            entity_type,
            entity_id,
            source_version,
            event_type,
            _json(payload or {}),
            PROJECTOR_VERSION,
            now,
            now,
            now,
        ),
    )
    return event_id


def reconcile_outbox(collection_db: Path, dataset_id: str) -> int:
    """Backfill projection events from durable source objects."""

    created = 0
    with _connect(collection_db) as conn:
        ensure_obsidian_schema(conn)
        tables = _tables(conn)
        if "research_memo_series" in tables:
            for row in conn.execute(
                """
                SELECT series_id, current_version_no FROM research_memo_series
                WHERE dataset_id=? AND current_version_no>0
                """,
                (dataset_id,),
            ):
                before = conn.total_changes
                enqueue_projection_event(
                    conn,
                    dataset_id=dataset_id,
                    entity_type="memo-series",
                    entity_id=str(row["series_id"]),
                    source_version=str(row["current_version_no"]),
                )
                created += int(conn.total_changes > before)
        if "valuation_model_series" in tables:
            for row in conn.execute(
                """
                SELECT series_id, current_version_no FROM valuation_model_series
                WHERE dataset_id=? AND current_version_no>0
                """,
                (dataset_id,),
            ):
                before = conn.total_changes
                enqueue_projection_event(
                    conn,
                    dataset_id=dataset_id,
                    entity_type="valuation-series",
                    entity_id=str(row["series_id"]),
                    source_version=str(row["current_version_no"]),
                )
                created += int(conn.total_changes > before)
        if "valuation_agent_analyses" in tables:
            for row in conn.execute(
                """
                SELECT analysis_id, series_id, updated_at FROM valuation_agent_analyses
                WHERE dataset_id=? AND status IN ('completed', 'failed')
                """,
                (dataset_id,),
            ):
                before = conn.total_changes
                enqueue_projection_event(
                    conn,
                    dataset_id=dataset_id,
                    entity_type="valuation-analysis",
                    entity_id=str(row["analysis_id"]),
                    source_version=str(row["updated_at"] or "completed"),
                    payload={"series_id": str(row["series_id"])},
                )
                created += int(conn.total_changes > before)
        if "valuation_derived_models" in tables:
            for row in conn.execute(
                """
                SELECT derived_model_id, series_id, checksum, resource_status,
                       resource_doc_id, resource_error FROM valuation_derived_models
                WHERE dataset_id=?
                """,
                (dataset_id,),
            ):
                before = conn.total_changes
                enqueue_projection_event(
                    conn,
                    dataset_id=dataset_id,
                    entity_type="valuation-derived",
                    entity_id=str(row["derived_model_id"]),
                    source_version=_digest(
                        row["checksum"],
                        row["resource_status"],
                        row["resource_doc_id"],
                        row["resource_error"],
                    ),
                    payload={"series_id": str(row["series_id"])},
                )
                created += int(conn.total_changes > before)
        conn.commit()
    return created


def _safe_target(root: Path, relative_path: Path) -> Path:
    root = root.expanduser().resolve()
    target = (root / relative_path).resolve()
    if target != root and root not in target.parents:
        raise ValueError(f"Obsidian target escapes configured vault: {relative_path}")
    return target


def _atomic_write(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    with temporary.open("w", encoding="utf-8", newline="\n") as handle:
        handle.write(content)
        handle.flush()
        os.fsync(handle.fileno())
    temporary.replace(path)
    try:
        directory_fd = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    except OSError:
        pass


def _frontmatter(properties: dict[str, Any]) -> str:
    clean = {key: value for key, value in properties.items() if value not in (None, "")}
    return "---\n" + yaml.safe_dump(
        clean,
        allow_unicode=True,
        sort_keys=False,
        default_flow_style=False,
    ).strip() + "\n---"


def _default_user_block() -> str:
    return "\n".join(
        (
            USER_BEGIN,
            "",
            "## 研究员批注",
            "",
            "> [!note] 手写区",
            "> 本区域由研究员维护，后台同步不得覆盖。",
            "",
            USER_END,
        )
    )


def _legacy_default_user_block() -> str:
    return "\n".join(
        (
            USER_BEGIN,
            "",
            "## 📝 研究员批注",
            "",
            "> [!note] 📝 手写区",
            "> 本区域由研究员维护，后台同步不得覆盖。",
            "",
            USER_END,
        )
    )


def _note_projector_version(content: str) -> str:
    if not content.startswith("---\n"):
        return ""
    finish = content.find("\n---", 4)
    if finish < 0:
        return ""
    try:
        properties = yaml.safe_load(content[4:finish]) or {}
    except yaml.YAMLError:
        return ""
    return str(properties.get("projector_version") or "")


def _extract_region(content: str, begin: str, end: str) -> str | None:
    start = content.find(begin)
    finish = content.find(end, start + len(begin)) if start >= 0 else -1
    if start < 0 or finish < 0:
        return None
    return content[start : finish + len(end)]


def _compose_note(properties: dict[str, Any], auto_body: str, user_block: str) -> str:
    return (
        f"{_frontmatter(properties)}\n\n{AUTO_BEGIN}\n\n"
        f"{auto_body.strip()}\n\n{AUTO_END}\n\n{user_block.strip()}\n"
    )


def _registry_row(
    conn: sqlite3.Connection,
    *,
    dataset_id: str,
    entity_type: str,
    entity_id: str,
    source_version: str,
) -> sqlite3.Row | None:
    return conn.execute(
        """
        SELECT * FROM obsidian_note_registry
        WHERE dataset_id=? AND entity_type=? AND entity_id=? AND source_version=?
        """,
        (dataset_id, entity_type, entity_id, source_version),
    ).fetchone()


def _record_registry(
    conn: sqlite3.Connection,
    *,
    dataset_id: str,
    entity_type: str,
    entity_id: str,
    source_version: str,
    note_path: str,
    content_hash: str,
    managed_hash: str,
    sync_status: str,
    last_error: str = "",
) -> None:
    conn.execute(
        """
        DELETE FROM obsidian_note_registry
        WHERE dataset_id=? AND entity_type=? AND entity_id=? AND source_version<>?
        """,
        (dataset_id, entity_type, entity_id, source_version),
    )
    conn.execute(
        """
        INSERT INTO obsidian_note_registry
            (dataset_id, entity_type, entity_id, source_version, note_path,
             content_hash, managed_hash, sync_status, last_synced_at, last_error)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(dataset_id, entity_type, entity_id, source_version) DO UPDATE SET
            note_path=excluded.note_path,
            content_hash=excluded.content_hash,
            managed_hash=excluded.managed_hash,
            sync_status=excluded.sync_status,
            last_synced_at=excluded.last_synced_at,
            last_error=excluded.last_error
        """,
        (
            dataset_id,
            entity_type,
            entity_id,
            source_version,
            note_path,
            content_hash,
            managed_hash,
            sync_status,
            _now_iso(),
            last_error or None,
        ),
    )


def _write_conflict_note(
    vault_root: Path,
    *,
    dataset_id: str,
    note_path: str,
    expected_hash: str,
    actual_hash: str,
) -> str:
    stamp = _now().strftime("%Y%m%dT%H%M%SZ")
    relative = Path(KNOWLEDGE_ROOT_NAME) / "99-系统" / "冲突" / (
        f"{stamp}-{_slug(Path(note_path).stem)}.md"
    )
    target = _safe_target(vault_root, relative)
    body = "\n".join(
        (
            f"# 📝 Obsidian 受管区冲突：{Path(note_path).name}",
            "",
            "> [!warning] 📝 未自动覆盖",
            "> 后台检测到受管 AUTO 区被人工修改。原笔记保持不变，请人工合并后重新同步。",
            "",
            f"- 📝 数据集：`{dataset_id}`",
            f"- 📝 笔记：`{note_path}`",
            f"- 📝 预期受管哈希：`{expected_hash}`",
            f"- 📝 当前受管哈希：`{actual_hash}`",
            f"- 📝 检测时间：`{_now_iso()}`",
        )
    )
    _atomic_write(target, body + "\n")
    return relative.as_posix()


def _write_managed_note(
    conn: sqlite3.Connection,
    vault_root: Path,
    *,
    dataset_id: str,
    entity_type: str,
    entity_id: str,
    source_version: str,
    relative_path: Path,
    properties: dict[str, Any],
    auto_body: str,
    immutable: bool,
) -> dict[str, Any]:
    target = _safe_target(vault_root, relative_path)
    auto_region = f"{AUTO_BEGIN}\n\n{auto_body.strip()}\n\n{AUTO_END}"
    expected_managed_hash = _hash(auto_region)
    registry = _registry_row(
        conn,
        dataset_id=dataset_id,
        entity_type=entity_type,
        entity_id=entity_id,
        source_version=source_version,
    )
    user_block = _default_user_block()
    if target.is_file():
        existing = target.read_text(encoding="utf-8")
        existing_projector_version = _note_projector_version(existing)
        existing_auto = _extract_region(existing, AUTO_BEGIN, AUTO_END)
        existing_user = _extract_region(existing, USER_BEGIN, USER_END)
        if existing_user:
            user_block = (
                _default_user_block()
                if existing_user.strip() == _legacy_default_user_block().strip()
                else existing_user
            )
        actual_managed_hash = _hash(existing_auto or "")
        trusted_hash = str(registry["managed_hash"]) if registry else expected_managed_hash
        if existing_auto is None or actual_managed_hash != trusted_hash:
            conflict_path = _write_conflict_note(
                vault_root,
                dataset_id=dataset_id,
                note_path=relative_path.as_posix(),
                expected_hash=trusted_hash,
                actual_hash=actual_managed_hash,
            )
            _record_registry(
                conn,
                dataset_id=dataset_id,
                entity_type=entity_type,
                entity_id=entity_id,
                source_version=source_version,
                note_path=relative_path.as_posix(),
                content_hash=_hash(existing),
                managed_hash=trusted_hash,
                sync_status="conflict",
                last_error=f"managed region changed; see {conflict_path}",
            )
            return {"status": "conflict", "path": relative_path.as_posix()}
        if (
            immutable
            and actual_managed_hash != expected_managed_hash
            and existing_projector_version == PROJECTOR_VERSION
        ):
            conflict_path = _write_conflict_note(
                vault_root,
                dataset_id=dataset_id,
                note_path=relative_path.as_posix(),
                expected_hash=expected_managed_hash,
                actual_hash=actual_managed_hash,
            )
            _record_registry(
                conn,
                dataset_id=dataset_id,
                entity_type=entity_type,
                entity_id=entity_id,
                source_version=source_version,
                note_path=relative_path.as_posix(),
                content_hash=_hash(existing),
                managed_hash=actual_managed_hash,
                sync_status="conflict",
                last_error=f"immutable projection changed; see {conflict_path}",
            )
            return {"status": "conflict", "path": relative_path.as_posix()}
    content = _compose_note(properties, auto_body, user_block)
    if not target.is_file() or target.read_text(encoding="utf-8") != content:
        _atomic_write(target, content)
        status = "written"
    else:
        status = "unchanged"
    _record_registry(
        conn,
        dataset_id=dataset_id,
        entity_type=entity_type,
        entity_id=entity_id,
        source_version=source_version,
        note_path=relative_path.as_posix(),
        content_hash=_hash(content),
        managed_hash=expected_managed_hash,
        sync_status="synced",
    )
    return {"status": status, "path": relative_path.as_posix()}


def _vault_link(relative_path: Path, *, label: str = "") -> str:
    path = relative_path.as_posix()
    if path.endswith(".md"):
        path = path[:-3]
    return f"[[{path}|{label}]]" if label else f"[[{path}]]"


def _vault_embed(relative_path: Path, heading: str) -> str:
    path = relative_path.as_posix()
    if path.endswith(".md"):
        path = path[:-3]
    return f"![[{path}#{heading}]]"


def _table_cell(value: Any) -> str:
    return str(value if value not in (None, "") else "—").replace("|", "\\|").replace("\n", "<br>")


def _plain_summary(value: Any, *, limit: int = 120) -> str:
    text = re.sub(r"[`*_>#\[\]]", "", str(value or ""))
    text = re.sub(r"\s+", " ", text).strip()
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


def _friendly_source_name(value: Any) -> str:
    name = Path(str(value or "")).name
    name = re.sub(r"^\d{10,}[_-]?", "", name)
    name = re.sub(r"\.(xlsx?|xlsm|pdf|md|html)$", "", name, flags=re.IGNORECASE)
    return re.sub(r"[+_]", " ", name).strip() or "未命名资料"


def _friendly_model_title(identity: dict[str, str]) -> str:
    company = identity["company_name"]
    ticker = identity.get("company_ticker") or ""
    return f"{company}（{ticker}）估值模型" if ticker else f"{company}估值模型"


def _quality_label(value: dict[str, Any]) -> str:
    status = str(value.get("quality_status") or "")
    confidence = float(value.get("confidence") or 0)
    if status in {"verified", "accepted"}:
        return "已核验"
    if status == "candidate_complete" and confidence >= 0.75:
        return "候选"
    return "待复核"


def _quality_issues(value: dict[str, Any]) -> list[str]:
    metadata = value.get("metadata") or {}
    issues = metadata.get("quality_issues") or value.get("quality_issues") or []
    if isinstance(issues, str):
        issues = _decode(issues, [])
    return [str(item) for item in issues]


def _is_year_like(value: Any) -> bool:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return False
    return number.is_integer() and 1900 <= number <= 2100


def _valuation_quality_gate(value: dict[str, Any]) -> tuple[bool, str]:
    numeric = value.get("value_numeric")
    formula = str(value.get("formula") or "").strip()
    unit = str(value.get("unit") or "").strip()
    status = str(value.get("quality_status") or "")
    issues = set(_quality_issues(value))
    raw = str(value.get("value_text") or numeric or "").strip()
    column_label = str(value.get("source_col_label") or "").strip()
    if (
        _is_year_like(numeric)
        and not formula
        and (
            raw == column_label
            or (
                status == "review_required"
                and not unit
                and "metric_name_inferred_from_nearest_left_label" in issues
            )
        )
    ):
        return False, "疑似把期间表头识别成指标值"
    if status in {"invalid", "rejected"}:
        return False, "上游质量状态无效"
    return True, _quality_label(value)


def _display_value(value: dict[str, Any]) -> str:
    numeric = value.get("value_numeric")
    raw = value.get("value_text")
    unit = str(value.get("unit") or "").strip()
    number_format = str(value.get("source_number_format") or "")
    if numeric is not None:
        number = float(numeric)
        if unit == "%":
            percent = number * 100 if abs(number) <= 1 else number
            return f"{percent:,.2f}%"
        currency = next(
            (
                code
                for code in ("HKD", "USD", "CNY", "RMB", "EUR", "GBP")
                if code in number_format.upper() or unit.upper() == code
            ),
            "",
        )
        rendered = f"{number:,.2f}".rstrip("0").rstrip(".")
        if currency:
            return f"{currency} {rendered}"
        return f"{rendered}{(' ' + unit) if unit else ''}"
    return f"{raw if raw not in (None, '') else '—'}{(' ' + unit) if unit else ''}"


def _artifact_links(version: dict[str, Any]) -> list[str]:
    links = []
    for key, label in (
        ("markdown_path", "Markdown"),
        ("html_path", "HTML"),
        ("pdf_path", "PDF"),
    ):
        path = str(version.get(key) or "").strip()
        if path:
            links.append(f"[{label}](<{path}>)")
    return links


def _evidence_record(conn: sqlite3.Connection, evidence_id: str) -> dict[str, Any]:
    tables = _tables(conn)
    prefix, _, raw_id = evidence_id.partition(":")
    raw_id = raw_id or prefix
    record: dict[str, Any] = {
        "evidence_id": evidence_id,
        "kind": prefix if raw_id != prefix else "unknown",
        "resolved": False,
    }
    if prefix == "fact" and "metric_facts" in tables:
        row = conn.execute(
            "SELECT * FROM metric_facts WHERE fact_id=?", (raw_id,)
        ).fetchone()
        if row:
            record.update(dict(row))
            record["kind"] = "fact"
            record["resolved"] = True
            record["quality_issues"] = _decode(
                record.get("quality_issues_json"), []
            )
    elif prefix == "chunk" and "chunks" in tables:
        row = conn.execute("SELECT * FROM chunks WHERE chunk_id=?", (raw_id,)).fetchone()
        if row:
            record.update(dict(row))
            record["kind"] = "chunk"
            record["resolved"] = True
            if "chunk_locations" in tables:
                location = conn.execute(
                    """
                    SELECT * FROM chunk_locations
                    WHERE chunk_id=? ORDER BY location_index LIMIT 1
                    """,
                    (raw_id,),
                ).fetchone()
                if location:
                    record["location"] = dict(location)
    elif prefix == "cell" and "excel_cells" in tables:
        row = conn.execute("SELECT * FROM excel_cells WHERE cell_id=?", (raw_id,)).fetchone()
        if row:
            record.update(dict(row))
            record["kind"] = "cell"
            record["resolved"] = True

    doc_id = str(record.get("doc_id") or "")
    if doc_id and "documents" in tables:
        document = conn.execute("SELECT * FROM documents WHERE doc_id=?", (doc_id,)).fetchone()
        if document:
            record["document"] = dict(document)
    if record.get("kind") == "fact" and "excel_cells" in tables:
        cell = conn.execute(
            """
            SELECT * FROM excel_cells
            WHERE doc_id=? AND sheet_name=? AND cell_ref=? LIMIT 1
            """,
            (doc_id, record.get("sheet_name"), record.get("cell_ref")),
        ).fetchone()
        if cell:
            record["cell"] = dict(cell)
    return record


_ISSUE_LABELS = {
    "metric_name_inferred_from_nearest_left_label": "指标名称由邻近标签推断",
    "unit_missing": "单位缺失",
    "formula_cache_missing": "公式缓存值缺失",
    "period_inferred": "期间由表头推断",
}


def _evidence_label(record: dict[str, Any]) -> str:
    metric = str(
        record.get("metric_name")
        or record.get("row_label")
        or record.get("title_path")
        or "证据"
    )
    sheet = str(record.get("sheet_name") or "")
    cell = str(record.get("cell_ref") or "")
    location = f"{sheet}!{cell}" if sheet and cell else ""
    return f"{metric} · {location}" if location else metric


def _evidence_path(series_base: Path, record: dict[str, Any]) -> Path:
    label = _evidence_label(record)
    short_id = _digest(record["evidence_id"], length=8)
    return series_base / "evidence" / f"{_slug(label, fallback='证据')}-{short_id}.md"


def _render_evidence_card(record: dict[str, Any]) -> str:
    label = _evidence_label(record)
    if not record.get("resolved"):
        return "\n".join(
            (
                f"# 📝 {label}",
                "",
                "> [!danger] 无法核验",
                "> 数据库中找不到该证据对象。正文不得把它当作有效来源使用。",
                "",
                "> [!info]- 审计信息",
                f"> Evidence ID：`{record['evidence_id']}`",
            )
        )

    document = record.get("document") or {}
    cell = record.get("cell") or {}
    location = record.get("location") or {}
    quality = str(record.get("quality_status") or "review_required")
    confidence = float(record.get("confidence") or 0)
    verified = quality in {"verified", "accepted"}
    callout = "success" if verified else "warning"
    state = "已核验" if verified else "待复核"
    value = _display_value(
        {
            **record,
            "source_number_format": cell.get("number_format"),
        }
    )
    original_filename = str(
        document.get("original_filename") or document.get("title") or "未命名资料"
    )
    stored_path = str(document.get("stored_path") or "")
    source_link = (
        f"[{_friendly_source_name(original_filename)}](<{stored_path}>)"
        if stored_path
        else _friendly_source_name(original_filename)
    )
    lines = [
        f"# 📝 {label}",
        "",
        f"> [!{callout}] {state}",
        f"> 置信度 {confidence:.0%}；该卡片用于回答“这条结论来自哪里”。",
        "",
        "## 证据值",
        "",
        f"**{value}**",
        "",
        "## 来源定位",
        "",
        f"- 资料：{source_link}",
        f"- 文件版本：v{document.get('version_no') or '—'}",
        f"- 文档日期：{document.get('document_date') or '—'}",
    ]
    if record.get("sheet_name") and record.get("cell_ref"):
        source_range = record.get("source_range") or (
            f"{record['sheet_name']}!{record['cell_ref']}"
        )
        lines.extend(
            [
                f"- Sheet：`{record['sheet_name']}`",
                f"- 单元格：`{record['cell_ref']}`",
                f"- 来源范围：`{source_range}`",
            ]
        )
    elif location:
        lines.append(f"- 位置：{location.get('display_text') or '—'}")
    if cell:
        lines.extend(
            [
                "",
                "## 单元格上下文",
                "",
                "| 行标签 | 列标签 | 原始值 | 公式 | 数字格式 |",
                "|---|---|---:|---|---|",
                (
                    f"| {_table_cell(cell.get('row_label'))} | "
                    f"{_table_cell(cell.get('col_label'))} | "
                    f"{_table_cell(cell.get('display_value') or cell.get('raw_value'))} | "
                    f"`{_table_cell(cell.get('formula'))}` | "
                    f"`{_table_cell(cell.get('number_format'))}` |"
                ),
            ]
        )
    issues = record.get("quality_issues") or []
    lines.extend(["", "## 质量说明", ""])
    if issues:
        lines.extend(f"- {_ISSUE_LABELS.get(str(item), str(item))}" for item in issues)
    else:
        lines.append("- 未记录额外质量问题。")
    lines.extend(
        [
            "",
            "> [!info]- 审计信息",
            f"> Evidence ID：`{record['evidence_id']}`  ",
            f"> 文档 ID：`{record.get('doc_id') or '—'}`  ",
            f"> 质量状态：`{quality}`",
        ]
    )
    return "\n".join(lines)


def _project_evidence_cards(
    conn: sqlite3.Connection,
    vault_root: Path,
    *,
    dataset_id: str,
    series_base: Path,
    identity: dict[str, str],
    evidence_ids: set[str],
) -> tuple[dict[str, tuple[Path, str]], list[dict[str, Any]]]:
    links: dict[str, tuple[Path, str]] = {}
    results: list[dict[str, Any]] = []
    for evidence_id in sorted(item for item in evidence_ids if item):
        record = _evidence_record(conn, evidence_id)
        path = _evidence_path(series_base, record)
        label = _evidence_label(record)
        links[evidence_id] = (path, label)
        entity_id = _digest(series_base.as_posix(), evidence_id)
        document = record.get("document") or {}
        results.append(
            _write_managed_note(
                conn,
                vault_root,
                dataset_id=dataset_id,
                entity_type="evidence-card",
                entity_id=entity_id,
                source_version=evidence_id,
                relative_path=path,
                properties=_managed_properties(
                    title=label,
                    entity_type="evidence-card",
                    entity_id=entity_id,
                    dataset_id=dataset_id,
                    source_version=evidence_id,
                    updated_at=str(
                        record.get("created_at")
                        or document.get("updated_at")
                        or document.get("created_at")
                        or "1970-01-01T00:00:00+00:00"
                    ),
                    extra={
                        "company": identity["company_name"],
                        "company_ticker": identity.get("company_ticker") or "",
                        "evidence_id": evidence_id,
                        "evidence_kind": record.get("kind"),
                        "evidence_status": (
                            "resolved" if record.get("resolved") else "unresolved"
                        ),
                        "review_state": (
                            "verified"
                            if str(record.get("quality_status") or "")
                            in {"verified", "accepted"}
                            else "needs-review"
                        ),
                        "source_file": _friendly_source_name(
                            document.get("original_filename") or document.get("title")
                        ),
                        "sheet_name": record.get("sheet_name"),
                        "cell_ref": record.get("cell_ref"),
                    },
                ),
                auto_body=_render_evidence_card(record),
                immutable=True,
            )
        )
    return links, results


def _evidence_link(
    evidence_id: str, evidence_links: dict[str, tuple[Path, str]]
) -> str:
    item = evidence_links.get(evidence_id)
    if not item:
        return f"⚠️ 无法解析来源（{_digest(evidence_id, length=8)}）"
    path, label = item
    return _vault_link(path, label=label)


def _project_identity(conn: sqlite3.Connection, dataset_id: str) -> dict[str, str]:
    tables = _tables(conn)
    company_name = ""
    company_ticker = ""
    if "documents" in tables:
        columns = {
            str(row[1]) for row in conn.execute("PRAGMA table_info(documents)")
        }
        selected = ["original_filename"]
        selected.extend(
            name for name in ("company_name", "company_ticker") if name in columns
        )
        row = conn.execute(
            f"SELECT {', '.join(selected)} FROM documents WHERE dataset_id=? "
            + ("ORDER BY is_current DESC, version_no DESC " if "is_current" in columns else "")
            + "LIMIT 1",
            (dataset_id,),
        ).fetchone()
        if row:
            company_name = str(row["company_name"] or "") if "company_name" in row else ""
            company_ticker = (
                str(row["company_ticker"] or "") if "company_ticker" in row else ""
            )
    if not company_name and "valuation_model_series" in tables:
        series = conn.execute(
            """
            SELECT name FROM valuation_model_series
            WHERE dataset_id=?
            ORDER BY current_version_no DESC, updated_at DESC LIMIT 1
            """,
            (dataset_id,),
        ).fetchone()
        if series:
            parts = [part.strip() for part in str(series["name"] or "").split("_")]
            company_name = parts[0].replace("-", " ") if parts else ""
            if len(parts) > 1 and re.fullmatch(r"[A-Za-z0-9.\-]{2,20}", parts[1]):
                company_ticker = parts[1]
    return {
        "dataset_id": dataset_id,
        "company_name": company_name or dataset_id,
        "company_ticker": company_ticker,
        "project_folder": _slug(dataset_id, fallback="dataset"),
    }


def _managed_properties(
    *,
    title: str,
    entity_type: str,
    entity_id: str,
    dataset_id: str,
    source_version: str,
    updated_at: str,
    extra: dict[str, Any] | None = None,
) -> dict[str, Any]:
    properties: dict[str, Any] = {
        "title": title,
        "aliases": [],
        "tags": ["private-fund", "managed", entity_type],
        "entity_type": entity_type,
        "entity_id": entity_id,
        "dataset_id": dataset_id,
        "source_system": "omnigent",
        "source_version": str(source_version),
        "sync_key": f"dataset:{dataset_id}:{entity_type}:{entity_id}:{source_version}",
        "managed_by": "omnigent",
        "projector_version": PROJECTOR_VERSION,
        "sensitivity": "internal",
        "updated_at": updated_at,
    }
    properties.update(extra or {})
    return properties


def _memo_sections(conn: sqlite3.Connection, memo_version_id: str) -> list[dict[str, Any]]:
    return [
        {
            **dict(row),
            "evidence_ids": _decode(row["evidence_ids_json"], []),
        }
        for row in conn.execute(
            """
            SELECT * FROM research_memo_sections
            WHERE memo_version_id=? ORDER BY sort_order
            """,
            (memo_version_id,),
        )
    ]


def _memo_version_path(base: Path, version: dict[str, Any]) -> Path:
    return base / "versions" / (
        f"v{int(version['version_no']):03d}-{version['as_of_date'] or 'undated'!s}.md"
    )


def _memo_diff(
    old_sections: list[dict[str, Any]], new_sections: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    old = {str(item["section_key"]): item for item in old_sections}
    new = {str(item["section_key"]): item for item in new_sections}
    changes = []
    for key in sorted(set(old) | set(new)):
        left = old.get(key)
        right = new.get(key)
        if left is None:
            change_type = "added"
            similarity = 0.0
        elif right is None:
            change_type = "not_mentioned"
            similarity = 0.0
        else:
            similarity = SequenceMatcher(None, left["content"], right["content"]).ratio()
            change_type = "unchanged" if similarity >= 0.985 else "changed"
        changes.append(
            {
                "section_key": key,
                "title": str((right or left or {}).get("title") or key),
                "change_type": change_type,
                "similarity": round(similarity, 4),
                "old_content": str(left["content"] if left else ""),
                "new_content": str(right["content"] if right else ""),
                "old_evidence_ids": left["evidence_ids"] if left else [],
                "new_evidence_ids": right["evidence_ids"] if right else [],
            }
        )
    return changes


def _memo_diff_level(changes: list[dict[str, Any]]) -> str:
    material = [
        item
        for item in changes
        if item["change_type"] != "unchanged"
        or set(item["old_evidence_ids"]) != set(item["new_evidence_ids"])
    ]
    if not material:
        return "none"
    if (
        any(item["change_type"] == "not_mentioned" for item in material)
        or any(
            item["old_evidence_ids"] and not item["new_evidence_ids"]
            for item in material
        )
        or len(material) >= 3
    ):
        return "high"
    return "medium"


def _memo_change_summary(changes: list[dict[str, Any]]) -> str:
    content_changes = sum(item["change_type"] != "unchanged" for item in changes)
    evidence_losses = sum(
        bool(item["old_evidence_ids"]) and not bool(item["new_evidence_ids"])
        for item in changes
    )
    evidence_changes = sum(
        set(item["old_evidence_ids"]) != set(item["new_evidence_ids"])
        for item in changes
    )
    parts = []
    if content_changes:
        parts.append(f"{content_changes} 个章节正文变化")
    if evidence_losses:
        parts.append(f"{evidence_losses} 个章节失去来源")
    elif evidence_changes:
        parts.append(f"{evidence_changes} 个章节来源变化")
    return "；".join(parts) or "正文与来源均无实质变化"


def _memo_section_is_raw_index(content: str) -> bool:
    lines = [line.strip() for line in content.splitlines() if line.strip()]
    technical = sum(
        line.lstrip("- ").startswith(("Excel workbook:", "Excel sheet:", "Excel region:"))
        for line in lines
    )
    return technical >= 2 and technical >= max(1, len(lines) // 2)


def _collapsed_callout(title: str, content: str) -> list[str]:
    lines = [f"> [!abstract]- {title}"]
    lines.extend(f"> {line}" if line else ">" for line in content.splitlines())
    return lines


def _memo_readability(sections: list[dict[str, Any]]) -> dict[str, Any]:
    section_count = len(sections)
    evidence_count = sum(len(item.get("evidence_ids") or []) for item in sections)
    raw_count = sum(
        _memo_section_is_raw_index(str(item.get("content") or "")) for item in sections
    )
    review_count = sum(int(item.get("needs_review") or 0) for item in sections)
    if not sections or (evidence_count == 0 and review_count == section_count):
        decision_status = "不可用于投资判断"
        state = "blocked"
    elif review_count or raw_count:
        decision_status = "部分可读，仍需复核"
        state = "review"
    else:
        decision_status = "可供研究阅读"
        state = "ready"
    summary = "尚未形成有证据支持的研究结论。"
    if state != "blocked":
        summary = next(
            (
                _plain_summary(item.get("content"))
                for item in sections
                if not _memo_section_is_raw_index(str(item.get("content") or ""))
                and str(item.get("content") or "").strip()
            ),
            summary,
        )
    return {
        "section_count": section_count,
        "evidence_count": evidence_count,
        "raw_count": raw_count,
        "review_count": review_count,
        "evidence_coverage": f"{evidence_count} 条证据 / {section_count} 个章节",
        "decision_status": decision_status,
        "readability_state": state,
        "summary": summary,
    }


def _render_memo_version(
    version: dict[str, Any],
    sections: list[dict[str, Any]],
    previous_link: str,
    evidence_links: dict[str, tuple[Path, str]],
) -> str:
    artifacts = _artifact_links(version)
    readability = _memo_readability(sections)
    callout = "warning" if readability["readability_state"] == "blocked" else "info"
    lines = [
        f"# 📝 {version['series_title']} v{int(version['version_no']):03d}",
        "",
        f"> [!{callout}] {readability['decision_status']}",
        f"> {readability['evidence_coverage']}。最新版本以系列首页为准。",
        "",
        f"- 生效日期：{version['as_of_date']}",
        f"- 上一版本：{previous_link or '—'}",
        f"- 证据覆盖：{readability['evidence_coverage']}",
        "",
        "## 研究结论",
        "",
    ]
    if not sections:
        lines.append("> [!warning] 当前版本没有可投影的结构化章节。")
    if readability["readability_state"] == "blocked" and sections:
        lines.extend(
            [
                "> [!danger] 本版本没有任何可核验研究结论",
                "> 为避免误导，索引结果和未绑定草稿不在正文逐条展开。",
                "",
                "| 章节 | 状态 |",
                "|---|---|",
            ]
        )
        for section in sections:
            lines.append(f"| {_table_cell(section['title'])} | 无可核验来源 |")
        raw_sections = "\n\n".join(
            f"### {section['title']}\n\n{section['content']}" for section in sections
        )
        lines.extend(["", *_collapsed_callout("查看全部技术底稿", raw_sections)])
        if artifacts:
            lines.extend(["", *_collapsed_callout("原始产物", " · ".join(artifacts))])
        lines.extend(
            [
                "",
                "> [!info]- 审计信息",
                f"> Memo version ID：`{version['memo_version_id']}`",
            ]
        )
        return "\n".join(lines)
    for section in sections:
        content = str(section["content"] or "_空章节_")
        evidence_ids = [str(item) for item in section.get("evidence_ids") or []]
        lines.extend(
            [
                f"### {section['title']}",
                "",
            ]
        )
        if _memo_section_is_raw_index(content) or (
            int(section.get("needs_review") or 0) and not evidence_ids
        ):
            lines.extend(
                [
                    "> [!danger] 尚未形成研究结论",
                    "> 当前内容没有绑定可核验来源，已从阅读层隔离；不能作为投资判断依据。",
                    "",
                ]
            )
            lines.extend(_collapsed_callout("查看技术底稿", content))
            lines.append("")
        else:
            lines.extend([content, ""])
        if evidence_ids:
            lines.append(
                "来源："
                + "；".join(_evidence_link(item, evidence_links) for item in evidence_ids)
            )
            lines.append("")
        elif int(section.get("needs_review") or 0):
            lines.extend(
                [
                    "> [!warning] 来源未绑定",
                    "> 本章节没有可点击、可核验的证据；内容仅作为待复核草稿。",
                    "",
                ]
            )
    if artifacts:
        lines.extend(["", *_collapsed_callout("原始产物", " · ".join(artifacts))])
    lines.extend(
        [
            "",
            "> [!info]- 审计信息",
            f"> Memo version ID：`{version['memo_version_id']}`",
        ]
    )
    return "\n".join(lines)


def _render_memo_change(
    old: dict[str, Any],
    new: dict[str, Any],
    changes: list[dict[str, Any]],
    old_path: Path,
    new_path: Path,
) -> str:
    labels = {
        "added": "新增",
        "changed": "变化",
        "not_mentioned": "本版未提及",
        "unchanged": "未变化",
    }
    material = [
        item
        for item in changes
        if item["change_type"] != "unchanged"
        or set(item["old_evidence_ids"]) != set(item["new_evidence_ids"])
    ]
    old_label = f"v{int(old['version_no']):03d}"
    new_label = f"v{int(new['version_no']):03d}"
    lines = [
        f"# 📝 Memo v{int(old['version_no']):03d} → v{int(new['version_no']):03d}",
        "",
        "> [!important] 语义边界",
        (
            "> `本版未提及（not_mentioned）`不等于结论失效、被证伪或被撤回；"
            "只有明确证据才能标记为失效或撤回。"
        ),
        "",
        f"- 上一版本：{_vault_link(old_path, label=old_label)}",
        f"- 当前版本：{_vault_link(new_path, label=new_label)}",
        f"- 需要关注的变化：{len(material)} 项",
        "",
        "## 版本结论",
        "",
    ]
    if not material:
        lines.append("正文和证据覆盖均未识别到实质变化。")
    else:
        for change in material:
            old_count = len(set(change["old_evidence_ids"]))
            new_count = len(set(change["new_evidence_ids"]))
            if old_count and not new_count:
                lines.append(
                    f"- **来源覆盖下降**：{change['title']}，{old_count} 条 → 0 条；"
                    "当前内容不可继续视为已溯源。"
                )
            elif old_count != new_count and change["change_type"] == "unchanged":
                lines.append(
                    f"- **来源发生变化**：{change['title']}，"
                    f"{old_count} 条 → {new_count} 条。"
                )
            else:
                lines.append(f"- **{labels[change['change_type']]}**：{change['title']}")
    lines.extend(
        [
            "",
            "## 章节变化总览",
            "",
            "| 章节 | 正文状态 | 来源变化 | 当前可核验性 |",
            "|---|---|---|---|",
        ]
    )
    for change in changes:
        old_evidence = set(change["old_evidence_ids"])
        new_evidence = set(change["new_evidence_ids"])
        added = len(new_evidence - old_evidence)
        removed = len(old_evidence - new_evidence)
        evidence_delta = f"新增 {added} / 移除 {removed}"
        verifiability = "有来源" if new_evidence else "无可核验来源"
        lines.append(
            f"| {_table_cell(change['title'])} | {labels[change['change_type']]} | "
            f"{evidence_delta} | {verifiability} |"
        )
    for change in [item for item in material if item["change_type"] != "unchanged"]:
        lines.extend(
            [
                "",
                f"## {labels[change['change_type']]}：{change['title']}",
                "",
                "### 上一版本",
                "",
                change["old_content"] or "_上一版本没有该章节_",
                "",
                "### 当前版本",
                "",
                change["new_content"] or "_当前版本未提及该章节_",
            ]
        )
    lines.extend(
        [
            "",
            "> [!info]- 审计指标",
            "> 正文相似度只用于机器比较，不代表证据仍然有效。",
        ]
    )
    for change in changes:
        lines.append(f"> {change['title']}：{change['similarity']:.1%}")
    return "\n".join(lines)


def _project_memo_series(
    conn: sqlite3.Connection,
    vault_root: Path,
    dataset_id: str,
    series_id: str,
) -> list[dict[str, Any]]:
    series = conn.execute(
        "SELECT * FROM research_memo_series WHERE dataset_id=? AND series_id=?",
        (dataset_id, series_id),
    ).fetchone()
    if series is None:
        raise KeyError(series_id)
    identity = _project_identity(conn, dataset_id)
    project_base = (
        Path(KNOWLEDGE_ROOT_NAME) / "10-项目" / identity["project_folder"]
    )
    series_base = project_base / "05-Memo" / (
        f"{_slug(series['title'], fallback='Memo')}-{str(series_id)[-8:]}"
    )
    versions = [
        {**dict(row), "series_title": str(series["title"])}
        for row in conn.execute(
            """
            SELECT * FROM research_memo_versions
            WHERE series_id=? ORDER BY version_no, created_at
            """,
            (series_id,),
        )
    ]
    results: list[dict[str, Any]] = []
    version_paths: dict[str, Path] = {}
    sections_by_id: dict[str, list[dict[str, Any]]] = {}
    evidence_links: dict[str, tuple[Path, str]] = {}
    projected_evidence_ids: set[str] = set()
    for index, version in enumerate(versions):
        version_id = str(version["memo_version_id"])
        path = _memo_version_path(series_base, version)
        version_paths[version_id] = path
        sections = _memo_sections(conn, version_id)
        sections_by_id[version_id] = sections
        section_evidence = {
            str(evidence_id)
            for section in sections
            for evidence_id in section.get("evidence_ids") or []
            if evidence_id
        }
        pending_evidence = section_evidence - projected_evidence_ids
        if pending_evidence:
            new_links, evidence_results = _project_evidence_cards(
                conn,
                vault_root,
                dataset_id=dataset_id,
                series_base=series_base,
                identity=identity,
                evidence_ids=pending_evidence,
            )
            evidence_links.update(new_links)
            results.extend(evidence_results)
            projected_evidence_ids.update(pending_evidence)
        previous = versions[index - 1] if index else None
        previous_link = (
            _vault_link(_memo_version_path(series_base, previous)) if previous else ""
        )
        evidence_count = sum(len(item["evidence_ids"]) for item in sections)
        needs_review = any(int(item.get("needs_review") or 0) for item in sections)
        readability = _memo_readability(sections)
        properties = _managed_properties(
            title=f"{series['title']} v{int(version['version_no']):03d}",
            entity_type="memo-version",
            entity_id=version_id,
            dataset_id=dataset_id,
            source_version=str(version["version_no"]),
            updated_at=str(version["created_at"]),
            extra={
                "company": identity["company_name"],
                "company_ticker": identity["company_ticker"],
                "series_id": series_id,
                "memo_version_id": version_id,
                "version_no": int(version["version_no"]),
                "revision_of": str(version["revision_of_version_id"] or ""),
                "as_of_date": str(version["as_of_date"]),
                "version_state": "immutable",
                "review_state": "needs-review" if needs_review else "verified",
                "evidence_state": (
                    "verified" if evidence_count and not needs_review else "partial"
                ),
                "evidence_coverage": readability["evidence_coverage"],
                "decision_status": readability["decision_status"],
                "readability_state": readability["readability_state"],
                "current_summary": readability["summary"],
                "created_at": str(version["created_at"]),
            },
        )
        results.append(
            _write_managed_note(
                conn,
                vault_root,
                dataset_id=dataset_id,
                entity_type="memo-version",
                entity_id=version_id,
                source_version=str(version["version_no"]),
                relative_path=path,
                properties=properties,
                auto_body=_render_memo_version(
                    version,
                    sections,
                    previous_link,
                    evidence_links,
                ),
                immutable=True,
            )
        )
    diff_paths: list[Path] = []
    for old, new in pairwise(versions):
        old_id = str(old["memo_version_id"])
        new_id = str(new["memo_version_id"])
        changes = _memo_diff(sections_by_id[old_id], sections_by_id[new_id])
        path = series_base / "changes" / (
            f"v{int(old['version_no']):03d}-to-v{int(new['version_no']):03d}.md"
        )
        diff_paths.append(path)
        properties = _managed_properties(
            title=(
                f"{series['title']} v{int(old['version_no']):03d} "
                f"→ v{int(new['version_no']):03d}"
            ),
            entity_type="memo-change",
            entity_id=f"{old_id}:{new_id}",
            dataset_id=dataset_id,
            source_version=new_id,
            updated_at=str(new["created_at"]),
            extra={
                "company": identity["company_name"],
                "series_id": series_id,
                "from_version_id": old_id,
                "to_version_id": new_id,
                "from_version_no": int(old["version_no"]),
                "to_version_no": int(new["version_no"]),
                "change_level": _memo_diff_level(changes),
                "change_summary": _memo_change_summary(changes),
                "review_state": "needs-review",
                "version_state": "immutable",
                "created_at": str(new["created_at"]),
            },
        )
        results.append(
            _write_managed_note(
                conn,
                vault_root,
                dataset_id=dataset_id,
                entity_type="memo-change",
                entity_id=f"{old_id}:{new_id}",
                source_version=new_id,
                relative_path=path,
                properties=properties,
                auto_body=_render_memo_change(
                    old,
                    new,
                    changes,
                    version_paths[old_id],
                    version_paths[new_id],
                ),
                immutable=True,
            )
        )
    if versions:
        latest = versions[-1]
        latest_path = version_paths[str(latest["memo_version_id"])]
        latest_sections = sections_by_id[str(latest["memo_version_id"])]
        readability = _memo_readability(latest_sections)
        callout = "warning" if readability["readability_state"] == "blocked" else "important"
        lines = [
            f"# 📝 {series['title']}",
            "",
            f"> [!{callout}] {readability['decision_status']}",
            f"> 当前 v{int(latest['version_no']):03d} · {latest['as_of_date']} · "
            f"{readability['evidence_coverage']} · "
            f"{_vault_link(latest_path, label='阅读当前版本')}",
            "",
            "## 当前研究结论",
            "",
            _vault_embed(latest_path, "研究结论"),
        ]
        if diff_paths:
            lines.extend(
                [
                    "",
                    "## 相比上一版",
                    "",
                    _vault_embed(diff_paths[-1], "版本结论"),
                ]
            )
        lines.extend(["", "## 版本时间线", ""])
        for version in reversed(versions):
            path = version_paths[str(version["memo_version_id"])]
            current = " · 当前" if version is latest else ""
            version_label = f"v{int(version['version_no']):03d}"
            lines.append(
                f"- {_vault_link(path, label=version_label)}"
                f" · {version['as_of_date']}{current}"
            )
        home_path = series_base / "Memo首页.md"
        properties = _managed_properties(
            title=f"{series['title']} · Memo 系列",
            entity_type="memo-series",
            entity_id=series_id,
            dataset_id=dataset_id,
            source_version="current",
            updated_at=str(series["updated_at"]),
            extra={
                "company": identity["company_name"],
                "company_ticker": identity["company_ticker"],
                "series_id": series_id,
                "current_version_id": str(latest["memo_version_id"]),
                "current_version_no": int(latest["version_no"]),
                "latest_note": _vault_link(latest_path),
                "version_count": len(versions),
                "status": "active",
                "review_state": "needs-review",
                "current_version_label": f"v{int(latest['version_no']):03d}",
                "evidence_coverage": readability["evidence_coverage"],
                "decision_status": readability["decision_status"],
                "readability_state": readability["readability_state"],
                "current_summary": readability["summary"],
                "created_at": str(series["created_at"]),
            },
        )
        results.append(
            _write_managed_note(
                conn,
                vault_root,
                dataset_id=dataset_id,
                entity_type="memo-series",
                entity_id=series_id,
                source_version="current",
                relative_path=home_path,
                properties=properties,
                auto_body="\n".join(lines),
                immutable=False,
            )
        )
    _write_project_scaffold(conn, vault_root, dataset_id, identity)
    return results


def _valuation_values(
    conn: sqlite3.Connection, model_version_id: str
) -> list[dict[str, Any]]:
    if "excel_cells" in _tables(conn):
        cell_columns = """
            c.row_label AS source_row_label,
            c.col_label AS source_col_label,
            c.display_value AS source_display_value,
            c.raw_value AS source_raw_value,
            c.number_format AS source_number_format,
            c.cached_value AS source_cached_value,
        """
        cell_join = """
            JOIN valuation_model_versions mv ON mv.model_version_id=v.model_version_id
            LEFT JOIN excel_cells c
              ON c.doc_id=mv.doc_id
             AND c.sheet_name=v.sheet_name
             AND c.cell_ref=v.cell_ref
        """
    else:
        cell_columns = """
            '' AS source_row_label,
            '' AS source_col_label,
            '' AS source_display_value,
            '' AS source_raw_value,
            '' AS source_number_format,
            '' AS source_cached_value,
        """
        cell_join = ""
    return [
        {**dict(row), "metadata": _decode(row["metadata_json"], {})}
        for row in conn.execute(
            f"""
            SELECT n.canonical_key, n.node_kind, n.metric_key, n.display_name,
                   n.scope, n.period, n.scenario,
                   {cell_columns}
                   v.*
            FROM valuation_model_node_values v
            JOIN valuation_model_nodes n ON n.node_id=v.node_id
            {cell_join}
            WHERE v.model_version_id=?
            ORDER BY n.node_kind, n.metric_key, n.period, n.canonical_key
            """,
            (model_version_id,),
        )
    ]


def _valuation_version_path(base: Path, version: dict[str, Any]) -> Path:
    date = str(version.get("document_date") or "undated")
    return base / "versions" / (
        f"v{int(version['document_version_no']):03d}-{date}.md"
    )


def _valuation_summary_fields(values: list[dict[str, Any]]) -> dict[str, Any]:
    by_metric: dict[str, dict[str, Any]] = {}
    for value in values:
        usable, _reason = _valuation_quality_gate(value)
        if not usable:
            continue
        by_metric.setdefault(str(value["metric_key"]), value)
    return {
        key: by_metric[key].get("value_numeric")
        for key in ("target_price", "wacc", "terminal_growth")
        if key in by_metric and by_metric[key].get("value_numeric") is not None
    }


_VALUATION_GROUP_LIMITS = {
    "output": 6,
    "assumption": 8,
    "forecast": 10,
    "sensitivity": 6,
}


def _visible_valuation_values(values: list[dict[str, Any]]) -> list[dict[str, Any]]:
    visible: list[dict[str, Any]] = []
    for group, limit in _VALUATION_GROUP_LIMITS.items():
        selected = [
            value
            for value in values
            if value["node_kind"] == group and _valuation_quality_gate(value)[0]
        ]
        visible.extend(selected[:limit])
    return visible


def _valuation_identity(series: dict[str, Any], fallback: dict[str, str]) -> dict[str, str]:
    identity = dict(fallback)
    name = str(series.get("name") or "")
    parts = [part.strip() for part in name.split("_") if part.strip()]
    inferred_company = parts[0].replace("-", " ") if parts else ""
    inferred_ticker = (
        parts[1]
        if len(parts) > 1 and re.fullmatch(r"[A-Za-z0-9.\-]{2,20}", parts[1])
        else ""
    )
    identity["company_name"] = str(
        series.get("company_name") or inferred_company or fallback["company_name"]
    )
    identity["company_ticker"] = str(
        series.get("company_ticker") or inferred_ticker or fallback["company_ticker"]
    )
    return identity


def _render_valuation_version(
    display_title: str,
    version: dict[str, Any],
    values: list[dict[str, Any]],
    previous_link: str,
    evidence_links: dict[str, tuple[Path, str]],
) -> str:
    usable_values: list[tuple[dict[str, Any], str]] = []
    quarantined: list[tuple[dict[str, Any], str]] = []
    for value in values:
        usable, state = _valuation_quality_gate(value)
        (usable_values if usable else quarantined).append((value, state))
    visible_ids = {
        str(value["node_value_id"]) for value in _visible_valuation_values(values)
    }
    review_count = sum(state != "已核验" for _value, state in usable_values)
    callout = "warning" if review_count or quarantined else "success"
    state = "存在待复核项" if review_count or quarantined else "结构化数据已核验"
    lines = [
        f"# 📝 {display_title} · v{int(version['document_version_no']):03d}",
        "",
        f"> [!{callout}] {state}",
        f"> 正文展示 {len(usable_values)} 个可解释节点；"
        f"隔离 {len(quarantined)} 个低质量候选。",
        "",
        f"- 模型日期：{version['document_date'] or '—'}",
        f"- 原始文件：{_friendly_source_name(version['original_filename'])}",
        f"- 上一版本：{previous_link or '—'}",
        f"- 阅读状态：{state}",
    ]
    if version.get("reverted_to_version_id"):
        lines.extend(
            [
                "",
                "> [!warning] 回滚版本",
                "> 当前快照与一个历史版本一致；具体版本关系见下方审计信息。",
            ]
        )
    for group, title in (
        ("output", "核心输出"),
        ("assumption", "关键假设"),
        ("forecast", "经营预测"),
        ("sensitivity", "敏感性"),
    ):
        selected = [
            item
            for item in usable_values
            if item[0]["node_kind"] == group
            and str(item[0]["node_value_id"]) in visible_ids
        ]
        if not selected:
            continue
        lines.extend(
            [
                "",
                f"## {title}",
                "",
                "| 指标 | 期间/情景 | 数值 | 来源 | 状态 |",
                "|---|---|---:|---|---|",
            ]
        )
        for item, quality in selected:
            evidence_id = str(item.get("evidence_id") or "")
            lines.append(
                f"| {_table_cell(item['display_name'])} | "
                f"{_table_cell(item['period'])} / {_table_cell(item['scenario'])} | "
                f"{_table_cell(_display_value(item))} | "
                f"{_evidence_link(evidence_id, evidence_links)} | {quality} |"
            )
        total_group = sum(item[0]["node_kind"] == group for item in usable_values)
        if total_group > len(selected):
            lines.append(
                f"| … | — | 另有 {total_group - len(selected)} 个通过门禁的节点 | "
                "见原始模型 | — |"
            )
    formula_values = [
        item
        for item, _quality in usable_values
        if str(item["node_value_id"]) in visible_ids
        and str(item.get("formula") or "").strip()
    ]
    if formula_values:
        formula_lines = ["| 指标 | 单元格 | 公式 |", "|---|---|---|"]
        for item in formula_values:
            formula_lines.append(
                f"| {_table_cell(item['display_name'])} | "
                f"`{_table_cell(item['sheet_name'])}!{_table_cell(item['cell_ref'])}` | "
                f"`{_table_cell(item['formula'])}` |"
            )
        lines.extend(["", *_collapsed_callout("公式审计", "\n".join(formula_lines))])
    if quarantined:
        reason_counts: dict[str, int] = {}
        for _value, reason in quarantined:
            reason_counts[reason] = reason_counts.get(reason, 0) + 1
        reason_text = "\n".join(
            f"- {reason}：{count} 个" for reason, count in sorted(reason_counts.items())
        )
        lines.extend(
            [
                "",
                "> [!danger] 已隔离低质量节点",
                "> 这些候选不进入经营预测、估值变化或投资结论。",
                "",
                *_collapsed_callout("查看隔离原因", reason_text),
            ]
        )
    lines.extend(
        [
            "",
            "> [!info]- 审计信息",
            f"> Model version ID：`{version['model_version_id']}`  ",
            f"> 原始节点：{version['node_count']}；公式节点：{version['formula_node_count']}  ",
            f"> 上游待复核节点：{version['review_required_count']}",
        ]
    )
    return "\n".join(lines)


def _valuation_changes(
    conn: sqlite3.Connection, from_id: str, to_id: str
) -> list[dict[str, Any]]:
    changes = []
    for row in conn.execute(
        """
        SELECT c.*, n.node_kind, n.metric_key, n.display_name,
               n.period, n.scenario
        FROM valuation_model_changes c
        JOIN valuation_model_nodes n ON n.node_id=c.node_id
        WHERE c.from_model_version_id=? AND c.to_model_version_id=?
        ORDER BY CASE c.materiality
            WHEN 'critical' THEN 4 WHEN 'high' THEN 3
            WHEN 'medium' THEN 2 WHEN 'low' THEN 1 ELSE 0 END DESC,
            n.node_kind, n.display_name
        """,
        (from_id, to_id),
    ):
        payload = dict(row)
        payload["old_value"] = _decode(payload.pop("old_value_json"), {})
        payload["new_value"] = _decode(payload.pop("new_value_json"), {})
        payload["evidence_ids"] = _decode(payload.pop("evidence_ids_json"), [])
        changes.append(payload)
    return changes


def _valuation_change_level(changes: list[dict[str, Any]]) -> str:
    if not changes:
        return "none"
    return max(
        (str(item["materiality"]) for item in changes),
        key=lambda value: _MATERIALITY_RANK.get(value, 0),
    )


def _valuation_change_is_readable(change: dict[str, Any]) -> tuple[bool, str]:
    old_value = change.get("old_value") or {}
    new_value = change.get("new_value") or {}
    if not old_value or not new_value:
        return False, "节点新增/消失，无法区分模型变化与抽取覆盖变化"
    old_usable, old_reason = _valuation_quality_gate(old_value)
    new_usable, new_reason = _valuation_quality_gate(new_value)
    if not old_usable:
        return False, f"上一版：{old_reason}"
    if not new_usable:
        return False, f"当前版：{new_reason}"
    if str(old_value.get("quality_status") or "") == "review_required":
        return False, "上一版节点仍待复核"
    if str(new_value.get("quality_status") or "") == "review_required":
        return False, "当前版节点仍待复核"
    return True, "可解释"


_MATERIALITY_LABELS = {
    "critical": "极高",
    "high": "高",
    "medium": "中",
    "low": "低",
    "none": "无",
}


def _render_valuation_change(
    old: dict[str, Any],
    new: dict[str, Any],
    changes: list[dict[str, Any]],
    old_path: Path,
    new_path: Path,
    evidence_links: dict[str, tuple[Path, str]],
) -> str:
    readable: list[dict[str, Any]] = []
    quarantined: list[tuple[dict[str, Any], str]] = []
    for change in changes:
        usable, reason = _valuation_change_is_readable(change)
        (readable if usable else quarantined).append(change if usable else (change, reason))
    level = _valuation_change_level(readable)
    old_label = f"v{int(old['document_version_no']):03d}"
    new_label = f"v{int(new['document_version_no']):03d}"
    lines = [
        f"# 📝 估值 v{int(old['document_version_no']):03d} → "
        f"v{int(new['document_version_no']):03d}",
        "",
        f"- 上一版本：{_vault_link(old_path, label=old_label)}",
        f"- 当前版本：{_vault_link(new_path, label=new_label)}",
        f"- 可解释变化：{len(readable)} 项",
        f"- 已隔离原始变化：{len(quarantined)} 项",
        "",
        "## 版本结论",
        "",
    ]
    material = [
        item for item in readable if _MATERIALITY_RANK.get(str(item["materiality"]), 0) >= 2
    ]
    if not material:
        if quarantined:
            lines.append(
                "没有可安全解释的中等及以上估值变化。上游虽检测到原始差异，"
                "但主要属于抽取覆盖变化或低质量节点，不能直接解释为模型假设改变。"
            )
        else:
            lines.append("没有识别到中等及以上估值变化。")
    else:
        for item in material:
            old_value = _display_value(item["old_value"])
            new_value = _display_value(item["new_value"])
            lines.append(
                f"- **{item['display_name']}**：{old_value} → {new_value} "
                f"（{_MATERIALITY_LABELS.get(str(item['materiality']), item['materiality'])}）"
            )
    lines.extend(
        [
            "",
            "## 可解释差异",
            "",
            "| 指标 | 期间/情景 | 上一版 | 当前版 | 变化 | 重要性 | 来源 |",
            "|---|---|---:|---:|---:|---|---|",
        ]
    )
    for item in readable:
        relative = item.get("relative_change")
        delta = f"{float(relative):+.1%}" if relative is not None else "结构变化"
        old_value = _display_value(item["old_value"])
        new_value = _display_value(item["new_value"])
        evidence = "；".join(
            _evidence_link(str(value), evidence_links) for value in item["evidence_ids"]
        )
        lines.append(
            f"| {_table_cell(item['display_name'])} | "
            f"{_table_cell(item['period'])}/{_table_cell(item['scenario'])} | "
            f"{_table_cell(old_value)} | {_table_cell(new_value)} | {_table_cell(delta)} | "
            f"{_MATERIALITY_LABELS.get(str(item['materiality']), item['materiality'])} | "
            f"{evidence or '—'} |"
        )
    if not readable:
        lines.append("| — | — | — | — | 无实质变化 | none | — |")
    if quarantined:
        reasons: dict[str, int] = {}
        for _item, reason in quarantined:
            reasons[reason] = reasons.get(reason, 0) + 1
        lines.extend(
            [
                "",
                "> [!danger] 原始差异已隔离",
                "> 隔离项不会进入重大变化、首页摘要或投资结论。",
                "",
                *_collapsed_callout(
                    "查看隔离原因",
                    "\n".join(
                        f"- {reason}：{count} 项" for reason, count in sorted(reasons.items())
                    ),
                ),
            ]
        )
    lines.extend(
        [
            "",
            "> [!info]- 审计信息",
            f"> 原始差异：{len(changes)} 项；可解释：{len(readable)} 项；"
            f"最高重要性：`{level}`",
        ]
    )
    return "\n".join(lines)


def _render_analysis_note(
    display_title: str,
    version: dict[str, Any],
    analysis: dict[str, Any],
    *,
    values: list[dict[str, Any]],
    version_path: Path,
    changes: list[dict[str, Any]],
    change_path: Path | None,
) -> str:
    payload = _decode(analysis.get("analysis_json"), {})
    readable_values = [value for value in values if _valuation_quality_gate(value)[0]]
    readable_changes = [
        change for change in changes if _valuation_change_is_readable(change)[0]
    ]
    raw_summary = str(analysis.get("summary_markdown") or "_无上游机器摘要_")
    version_label = f"v{int(version['document_version_no']):03d}"
    lines = [
        f"# 📝 {display_title} · {version_label} 确定性分析",
        "",
        "> [!warning] 机器分析需要复核",
        "> 上游摘要含未经质量门验证的候选，已从正文结论区隔离；"
        "本页不替代研究员判断。",
        "",
        "## 可读性审查",
        "",
        "| 检查项 | 结果 |",
        "|---|---|",
        f"| 当前模型 | {_vault_link(version_path, label=version_label)} |",
        f"| 估值节点 | {len(readable_values)} 个可读 / {len(values)} 个原始节点 |",
        f"| 上游待复核 | {int(payload.get('review_required_count') or 0)} 个节点 |",
        f"| 版本差异 | {len(readable_changes)} 项可解释 / {len(changes)} 项原始变化 |",
        "",
        "## 可用结论",
        "",
    ]
    if changes and not readable_changes:
        lines.append(
            "本次没有产生可安全解释的版本变化；不能把节点新增或消失直接解释为"
            "模型假设改变。"
        )
    elif readable_changes:
        lines.append(
            f"本次识别出 {len(readable_changes)} 项通过质量门的变化，"
            "具体数值、重要性和来源以版本差异页为准。"
        )
    else:
        lines.append("这是该系列的首个版本，没有可比较的上一版。")
    if change_path is not None:
        lines.extend(
            [
                "",
                f"- 阅读版本差异：{_vault_link(change_path, label='逐项查看变化与隔离原因')}",
            ]
        )
    lines.extend(
        [
            "",
            *_collapsed_callout("查看上游原始机器摘要", raw_summary),
            "",
            "> [!info]- 审计信息",
            f"> 分析状态：`{analysis['status']}`  ",
            f"> Analysis version ID：`{analysis['analysis_version_id']}`  ",
            f"> Model version ID：`{version['model_version_id']}`",
        ]
    )
    return "\n".join(lines)


def _analysis_evidence_ids(analysis: dict[str, Any]) -> set[str]:
    payload = _decode(analysis.get("analysis_json"), {})
    return {
        str(evidence_id)
        for finding in payload.get("key_findings") or []
        for evidence_id in finding.get("evidence_ids") or []
        if evidence_id
    }


def _analysis_version_link(
    model_version_id: str,
    versions_by_id: dict[str, dict[str, Any]],
    version_paths: dict[str, Path],
) -> str:
    version = versions_by_id.get(model_version_id)
    path = version_paths.get(model_version_id)
    if not version or not path:
        return "未找到版本"
    label = f"v{int(version['document_version_no']):03d}"
    return _vault_link(path, label=label)


def _render_agent_analysis_note(
    display_title: str,
    analysis: dict[str, Any],
    *,
    versions_by_id: dict[str, dict[str, Any]],
    version_paths: dict[str, Path],
    evidence_links: dict[str, tuple[Path, str]],
    latest_version_id: str,
) -> str:
    payload = _decode(analysis.get("analysis_json"), {})
    base_id = str(analysis["base_model_version_id"])
    comparison_id = str(analysis["comparison_model_version_id"] or "")
    lines = [
        f"# 📝 {display_title} · Agent 分析",
        "",
        f"> [!important] {analysis['focus'] or '全面分析'}",
        f"> 基础版本 {_analysis_version_link(base_id, versions_by_id, version_paths)}；"
        f"状态：{analysis['status']}。",
        "",
        "## 执行摘要",
        "",
        str(analysis.get("executive_summary") or payload.get("executive_summary") or "_待生成_"),
        "",
        "## 投资含义",
        "",
        str(
            analysis.get("investment_conclusion")
            or payload.get("investment_conclusion")
            or "_待生成_"
        ),
    ]
    if base_id != latest_version_id:
        latest_link = _analysis_version_link(latest_version_id, versions_by_id, version_paths)
        lines.extend(
            [
                "",
                "> [!warning] 不是当前模型分析",
                f"> 本分析基于 {_analysis_version_link(base_id, versions_by_id, version_paths)}；"
                f"当前版本为 {latest_link}。使用结论前必须重新核对。",
            ]
        )
    if payload.get("version_change_summary"):
        lines.extend(
            [
                "",
                "## 版本变化解释",
                "",
                str(payload["version_change_summary"]),
            ]
        )
    findings = payload.get("key_findings") or []
    if findings:
        lines.extend(["", "## 关键发现", ""])
        for finding in findings:
            evidence = "；".join(
                _evidence_link(str(item), evidence_links)
                for item in finding.get("evidence_ids") or []
            )
            lines.append(
                f"- **{finding.get('title') or '发现'}**：{finding.get('detail') or ''}"
            )
            lines.append(f"  - 来源：{evidence or '⚠️ 未绑定可核验证据'}")
    risks = payload.get("risks") or []
    if risks:
        lines.extend(["", "## 风险", ""])
        for risk in risks:
            lines.append(f"- **{risk.get('title') or '风险'}**：{risk.get('detail') or ''}")
    questions = payload.get("open_questions") or []
    if questions:
        lines.extend(["", "## 待验证问题", ""])
        lines.extend(f"- [ ] {item}" for item in questions)
    if analysis.get("error_message"):
        lines.extend(
            [
                "",
                "> [!warning] 分析失败",
                f"> {analysis['error_message']}",
            ]
        )
    lines.extend(
        [
            "",
            "> [!info]- 审计信息",
            f"> Analysis ID：`{analysis['analysis_id']}`  ",
            f"> Base model ID：`{base_id}`  ",
            f"> Comparison model ID：`{comparison_id or '—'}`",
        ]
    )
    return "\n".join(lines)


def _render_derived_note(series: dict[str, Any], derived: dict[str, Any]) -> str:
    applied = _decode(derived.get("applied_changes_json"), [])
    skipped = _decode(derived.get("skipped_changes_json"), [])
    output_label = _friendly_source_name(derived["output_filename"])
    lines = [
        f"# 📝 {series['name']} · 派生模型 v{int(derived['derived_version_no']):03d}",
        "",
        "> [!warning] 派生版本",
        "> 这是 Agent 建议形成的新文件，不会覆盖基础估值模型。",
        "",
        f"- 文件：[{output_label}](<{derived['output_path']}>)",
        f"- 已应用变化：{len(applied)}",
        f"- 跳过变化：{len(skipped)}",
        f"- 入库状态：`{derived.get('resource_status') or 'not_added'}`",
        "",
        "## 已应用变化",
        "",
    ]
    if applied:
        for item in applied:
            lines.append(
                f"- `{item.get('sheet_name')}!{item.get('cell_ref')}`："
                f"{item.get('old_value')} → {item.get('new_value')}"
            )
    else:
        lines.append("没有自动应用的单元格变化。")
    if skipped:
        lines.extend(["", "## 未应用建议", ""])
        for item in skipped:
            lines.append(f"- `{item.get('node_id')}`：{item.get('reason') or '需人工复核'}")
    lines.extend(
        [
            "",
            "> [!info]- 审计信息",
            f"> Derived model ID：`{derived['derived_model_id']}`  ",
            f"> Base model ID：`{derived['base_model_version_id']}`  ",
            f"> Analysis ID：`{derived['analysis_id']}`",
        ]
    )
    return "\n".join(lines)


def _project_valuation_series(
    conn: sqlite3.Connection,
    vault_root: Path,
    dataset_id: str,
    series_id: str,
) -> list[dict[str, Any]]:
    row = conn.execute(
        "SELECT * FROM valuation_model_series WHERE dataset_id=? AND series_id=?",
        (dataset_id, series_id),
    ).fetchone()
    if row is None:
        raise KeyError(series_id)
    series = dict(row)
    identity = _valuation_identity(series, _project_identity(conn, dataset_id))
    display_title = _friendly_model_title(identity)
    project_base = (
        Path(KNOWLEDGE_ROOT_NAME) / "10-项目" / identity["project_folder"]
    )
    series_base = project_base / "04-估值" / (
        f"{_slug(series['name'], fallback='估值模型')}-{str(series_id)[-8:]}"
    )
    versions = [
        dict(item)
        for item in conn.execute(
            """
            SELECT * FROM valuation_model_versions
            WHERE series_id=? ORDER BY document_version_no, created_at
            """,
            (series_id,),
        )
    ]
    versions_by_id = {str(item["model_version_id"]): item for item in versions}
    values_by_version = {
        version_id: _valuation_values(conn, version_id) for version_id in versions_by_id
    }
    changes_by_pair = {
        (str(old["model_version_id"]), str(new["model_version_id"])): _valuation_changes(
            conn,
            str(old["model_version_id"]),
            str(new["model_version_id"]),
        )
        for old, new in pairwise(versions)
    }
    tables = _tables(conn)
    agent_analyses = (
        [
            dict(item)
            for item in conn.execute(
                """
                SELECT * FROM valuation_agent_analyses
                WHERE dataset_id=? AND series_id=? ORDER BY created_at
                """,
                (dataset_id, series_id),
            )
        ]
        if "valuation_agent_analyses" in tables
        else []
    )
    evidence_ids = {
        str(value.get("evidence_id") or "")
        for values in values_by_version.values()
        for value in _visible_valuation_values(values)
        if value.get("evidence_id")
    }
    for changes in changes_by_pair.values():
        for change in changes:
            if not _valuation_change_is_readable(change)[0]:
                continue
            evidence_ids.update(str(item) for item in change["evidence_ids"] if item)
    for analysis in agent_analyses:
        evidence_ids.update(_analysis_evidence_ids(analysis))
    results: list[dict[str, Any]] = []
    evidence_links, evidence_results = _project_evidence_cards(
        conn,
        vault_root,
        dataset_id=dataset_id,
        series_base=series_base,
        identity=identity,
        evidence_ids=evidence_ids,
    )
    results.extend(evidence_results)
    version_paths: dict[str, Path] = {}
    diff_paths: list[Path] = []
    for index, version in enumerate(versions):
        version_id = str(version["model_version_id"])
        values = values_by_version[version_id]
        path = _valuation_version_path(series_base, version)
        version_paths[version_id] = path
        previous = versions[index - 1] if index else None
        previous_link = (
            _vault_link(_valuation_version_path(series_base, previous)) if previous else ""
        )
        summary_fields = _valuation_summary_fields(values)
        quality_results = [_valuation_quality_gate(value) for value in values]
        usable_count = sum(usable for usable, _reason in quality_results)
        quarantined_count = len(values) - usable_count
        evidence_coverage = f"{usable_count} 可读 / {len(values)} 原始节点"
        properties = _managed_properties(
            title=f"{display_title} · v{int(version['document_version_no']):03d}",
            entity_type="valuation-version",
            entity_id=version_id,
            dataset_id=dataset_id,
            source_version=str(version["document_version_no"]),
            updated_at=str(version["created_at"]),
            extra={
                "company": identity["company_name"],
                "company_ticker": identity["company_ticker"],
                "valuation_series_id": series_id,
                "model_version_id": version_id,
                "version_no": int(version["document_version_no"]),
                "parent_model_version_id": str(version["parent_model_version_id"] or ""),
                "reverted_to_version_id": str(version["reverted_to_version_id"] or ""),
                "valuation_date": str(version["document_date"] or ""),
                "model_type": str(version["model_type"] or series.get("model_type") or ""),
                "version_state": "immutable",
                "review_state": (
                    "needs-review" if int(version["review_required_count"] or 0) else "verified"
                ),
                "evidence_state": "partial",
                "evidence_coverage": evidence_coverage,
                "usable_node_count": usable_count,
                "quarantined_node_count": quarantined_count,
                "decision_status": (
                    "存在待复核项" if quarantined_count else "结构化数据可读"
                ),
                "created_at": str(version["created_at"]),
                **summary_fields,
            },
        )
        results.append(
            _write_managed_note(
                conn,
                vault_root,
                dataset_id=dataset_id,
                entity_type="valuation-version",
                entity_id=version_id,
                source_version=str(version["document_version_no"]),
                relative_path=path,
                properties=properties,
                auto_body=_render_valuation_version(
                    display_title,
                    version,
                    values,
                    previous_link,
                    evidence_links,
                ),
                immutable=True,
            )
        )
        analysis = conn.execute(
            """
            SELECT * FROM valuation_analysis_versions
            WHERE model_version_id=? ORDER BY created_at DESC LIMIT 1
            """,
            (version_id,),
        ).fetchone()
        if analysis:
            analysis_path = series_base / "analyses" / (
                f"v{int(version['document_version_no']):03d}-确定性分析.md"
            )
            previous_id = str(previous["model_version_id"]) if previous else ""
            analysis_changes = (
                changes_by_pair.get((previous_id, version_id), []) if previous else []
            )
            analysis_change_path = (
                series_base
                / "changes"
                / (
                    f"v{int(previous['document_version_no']):03d}-to-"
                    f"v{int(version['document_version_no']):03d}.md"
                )
                if previous
                else None
            )
            results.append(
                _write_managed_note(
                    conn,
                    vault_root,
                    dataset_id=dataset_id,
                    entity_type="valuation-analysis-version",
                    entity_id=str(analysis["analysis_version_id"]),
                    source_version=str(analysis["analyzer_version"]),
                    relative_path=analysis_path,
                    properties=_managed_properties(
                        title=(
                            f"{display_title} · v{int(version['document_version_no']):03d} "
                            "确定性分析"
                        ),
                        entity_type="valuation-analysis-version",
                        entity_id=str(analysis["analysis_version_id"]),
                        dataset_id=dataset_id,
                        source_version=str(analysis["analyzer_version"]),
                        updated_at=str(analysis["created_at"]),
                        extra={
                            "company": identity["company_name"],
                            "valuation_series_id": series_id,
                            "model_version_id": version_id,
                            "version_no": int(version["document_version_no"]),
                            "review_state": "needs-review",
                            "version_state": "immutable",
                            "created_at": str(analysis["created_at"]),
                        },
                    ),
                    auto_body=_render_analysis_note(
                        display_title,
                        version,
                        dict(analysis),
                        values=values,
                        version_path=path,
                        changes=analysis_changes,
                        change_path=analysis_change_path,
                    ),
                    immutable=True,
                )
            )
    for old, new in pairwise(versions):
        old_id = str(old["model_version_id"])
        new_id = str(new["model_version_id"])
        changes = changes_by_pair[(old_id, new_id)]
        readable_changes = [
            change
            for change in changes
            if _valuation_change_is_readable(change)[0]
        ]
        path = series_base / "changes" / (
            f"v{int(old['document_version_no']):03d}-to-"
            f"v{int(new['document_version_no']):03d}.md"
        )
        diff_paths.append(path)
        properties = _managed_properties(
            title=(
                f"{display_title} · v{int(old['document_version_no']):03d} "
                f"→ v{int(new['document_version_no']):03d}"
            ),
            entity_type="valuation-change",
            entity_id=f"{old_id}:{new_id}",
            dataset_id=dataset_id,
            source_version=new_id,
            updated_at=str(new["created_at"]),
            extra={
                "company": identity["company_name"],
                "valuation_series_id": series_id,
                "from_model_version_id": old_id,
                "to_model_version_id": new_id,
                "from_version_no": int(old["document_version_no"]),
                "to_version_no": int(new["document_version_no"]),
                "change_level": _valuation_change_level(readable_changes),
                "change_count": len(readable_changes),
                "raw_change_count": len(changes),
                "quarantined_change_count": len(changes) - len(readable_changes),
                "change_summary": (
                    f"{len(readable_changes)} 项可解释变化；"
                    f"{len(changes) - len(readable_changes)} 项已隔离"
                ),
                "review_state": "needs-review",
                "version_state": "immutable",
                "created_at": str(new["created_at"]),
            },
        )
        results.append(
            _write_managed_note(
                conn,
                vault_root,
                dataset_id=dataset_id,
                entity_type="valuation-change",
                entity_id=f"{old_id}:{new_id}",
                source_version=new_id,
                relative_path=path,
                properties=properties,
                auto_body=_render_valuation_change(
                    old,
                    new,
                    changes,
                    version_paths[old_id],
                    version_paths[new_id],
                    evidence_links,
                ),
                immutable=True,
            )
        )
    analysis_paths: dict[str, Path] = {}
    if agent_analyses:
        for analysis in agent_analyses:
            analysis_id = str(analysis["analysis_id"])
            analysis_path = series_base / "analyses" / (
                f"Agent-{_slug(analysis.get('focus') or '全面分析', max_length=36)}-"
                f"{analysis_id[-8:]}.md"
            )
            analysis_paths[analysis_id] = analysis_path
            analysis_summary = _plain_summary(
                analysis.get("executive_summary")
                or _decode(analysis.get("analysis_json"), {}).get("executive_summary")
            )
            results.append(
                _write_managed_note(
                    conn,
                    vault_root,
                    dataset_id=dataset_id,
                    entity_type="valuation-agent-analysis",
                    entity_id=analysis_id,
                    source_version="current",
                    relative_path=analysis_path,
                    properties=_managed_properties(
                        title=f"{display_title} · Agent 分析",
                        entity_type="valuation-agent-analysis",
                        entity_id=analysis_id,
                        dataset_id=dataset_id,
                        source_version="current",
                        updated_at=str(analysis.get("updated_at") or analysis["created_at"]),
                        extra={
                            "company": identity["company_name"],
                            "valuation_series_id": series_id,
                            "base_model_version_id": str(analysis["base_model_version_id"]),
                            "comparison_model_version_id": str(
                                analysis["comparison_model_version_id"] or ""
                            ),
                            "status": str(analysis["status"]),
                            "focus": str(analysis["focus"] or ""),
                            "analysis_summary": analysis_summary,
                            "evidence_count": len(_analysis_evidence_ids(analysis)),
                            "review_state": "needs-review",
                            "created_at": str(analysis["created_at"]),
                        },
                    ),
                    auto_body=_render_agent_analysis_note(
                        display_title,
                        analysis,
                        versions_by_id=versions_by_id,
                        version_paths=version_paths,
                        evidence_links=evidence_links,
                        latest_version_id=str(versions[-1]["model_version_id"]),
                    ),
                    immutable=False,
                )
            )
    if "valuation_derived_models" in tables:
        for derived_row in conn.execute(
            """
            SELECT * FROM valuation_derived_models
            WHERE dataset_id=? AND series_id=? ORDER BY derived_version_no, created_at
            """,
            (dataset_id, series_id),
        ):
            derived = dict(derived_row)
            derived_id = str(derived["derived_model_id"])
            derived_path = series_base / "derived" / (
                f"v{int(derived['derived_version_no']):03d}-{derived_id[-8:]}.md"
            )
            results.append(
                _write_managed_note(
                    conn,
                    vault_root,
                    dataset_id=dataset_id,
                    entity_type="valuation-derived",
                    entity_id=derived_id,
                    source_version="current",
                    relative_path=derived_path,
                    properties=_managed_properties(
                        title=(
                            f"{display_title} · 派生模型 "
                            f"v{int(derived['derived_version_no']):03d}"
                        ),
                        entity_type="valuation-derived",
                        entity_id=derived_id,
                        dataset_id=dataset_id,
                        source_version="current",
                        updated_at=str(derived["created_at"]),
                        extra={
                            "company": identity["company_name"],
                            "valuation_series_id": series_id,
                            "base_model_version_id": str(derived["base_model_version_id"]),
                            "analysis_id": str(derived["analysis_id"]),
                            "derived_version_no": int(derived["derived_version_no"]),
                            "resource_status": str(derived.get("resource_status") or "not_added"),
                            "version_state": "immutable",
                            "review_state": "needs-review",
                            "created_at": str(derived["created_at"]),
                        },
                    ),
                    auto_body=_render_derived_note(
                        {**series, "name": display_title}, derived
                    ),
                    immutable=False,
                )
            )
    if versions:
        latest = versions[-1]
        latest_id = str(latest["model_version_id"])
        latest_path = version_paths[latest_id]
        latest_values = values_by_version[latest_id]
        latest_usable = [
            value for value in latest_values if _valuation_quality_gate(value)[0]
        ]
        latest_quarantined_count = len(latest_values) - len(latest_usable)
        latest_summary_fields = _valuation_summary_fields(latest_values)
        target_price = latest_summary_fields.get("target_price")
        target_value = next(
            (value for value in latest_usable if value["metric_key"] == "target_price"),
            None,
        )
        current_summary = (
            f"目标价 {_display_value(target_value)}"
            if target_price is not None and target_value is not None
            else "当前版本尚无通过质量门禁的核心目标价。"
        )
        decision_status = (
            "存在待复核项" if latest_quarantined_count else "结构化数据可读"
        )
        lines = [
            f"# 📝 {display_title}",
            "",
            f"> [!{'warning' if latest_quarantined_count else 'important'}] {decision_status}",
            f"> 当前 v{int(latest['document_version_no']):03d} · "
            f"{latest['document_date'] or '未标日期'} · {current_summary} · "
            f"{_vault_link(latest_path, label='阅读当前模型')}",
            "",
            "## 当前模型摘要",
            "",
            _vault_embed(latest_path, "核心输出"),
        ]
        if diff_paths:
            lines.extend(
                [
                    "",
                    "## 相比上一版",
                    "",
                    _vault_embed(diff_paths[-1], "版本结论"),
                ]
            )
        if analysis_paths:
            lines.extend(["", "## Agent 分析", ""])
            for analysis in reversed(agent_analyses):
                analysis_id = str(analysis["analysis_id"])
                base_id = str(analysis["base_model_version_id"])
                base_version = versions_by_id.get(base_id)
                base_label = (
                    f"v{int(base_version['document_version_no']):03d}"
                    if base_version
                    else "未知版本"
                )
                stale = " · 非当前模型" if base_id != latest_id else ""
                analysis_label = _plain_summary(
                    analysis.get("focus") or "全面分析", limit=32
                )
                lines.append(
                    f"- {_vault_link(analysis_paths[analysis_id], label=analysis_label)}"
                    f" · 基于 {base_label}{stale}"
                )
        lines.extend(["", "## 版本时间线", ""])
        for version in reversed(versions):
            path = version_paths[str(version["model_version_id"])]
            revert = " · 回滚" if version.get("reverted_to_version_id") else ""
            current = " · 当前" if version is latest else ""
            version_label = f"v{int(version['document_version_no']):03d}"
            lines.append(
                f"- {_vault_link(path, label=version_label)}"
                f" · {version['document_date'] or '未标日期'}{revert}{current}"
            )
        home_path = series_base / "估值模型首页.md"
        results.append(
            _write_managed_note(
                conn,
                vault_root,
                dataset_id=dataset_id,
                entity_type="valuation-series",
                entity_id=series_id,
                source_version="current",
                relative_path=home_path,
                properties=_managed_properties(
                    title=display_title,
                    entity_type="valuation-series",
                    entity_id=series_id,
                    dataset_id=dataset_id,
                    source_version="current",
                    updated_at=str(series["updated_at"]),
                    extra={
                        "company": identity["company_name"],
                        "company_ticker": identity["company_ticker"],
                        "valuation_series_id": series_id,
                        "model_type": str(series.get("model_type") or ""),
                        "current_model_version_id": latest_id,
                        "current_version_no": int(latest["document_version_no"]),
                        "latest_note": _vault_link(latest_path),
                        "version_count": len(versions),
                        "status": str(series.get("status") or "active"),
                        "review_state": "needs-review",
                        "current_version_label": (
                            f"v{int(latest['document_version_no']):03d}"
                        ),
                        "evidence_coverage": (
                            f"{len(latest_usable)} 可读 / {len(latest_values)} 原始节点"
                        ),
                        "decision_status": decision_status,
                        "current_summary": current_summary,
                        "quarantined_node_count": latest_quarantined_count,
                        **latest_summary_fields,
                        "created_at": str(series["created_at"]),
                    },
                ),
                auto_body="\n".join(lines),
                immutable=False,
            )
        )
    _write_project_scaffold(conn, vault_root, dataset_id, identity)
    return results


def _base_content(dataset_id: str = "") -> tuple[str, str]:
    common_filters: list[Any] = [
        'file.hasTag("private-fund")',
        'managed_by == "omnigent"',
    ]
    if dataset_id:
        common_filters.append(f'dataset_id == "{dataset_id}"')
    common_properties = {
        "formula.entry": {"displayName": "条目"},
        "company": {"displayName": "公司"},
        "current_version_label": {"displayName": "当前版本"},
        "version_no": {"displayName": "版本"},
        "decision_status": {"displayName": "阅读状态"},
        "evidence_coverage": {"displayName": "证据覆盖"},
        "current_summary": {"displayName": "当前结论"},
        "change_level": {"displayName": "变化级别"},
        "change_summary": {"displayName": "变化摘要"},
        "review_state": {"displayName": "复核"},
        "updated_at": {"displayName": "更新时间"},
    }
    memo = {
        "filters": {
            "and": [
                *common_filters,
                {
                    "or": [
                        'entity_type == "memo-series"',
                        'entity_type == "memo-version"',
                        'entity_type == "memo-change"',
                    ]
                },
            ]
        },
        "formulas": {"entry": "link(file.path, title)"},
        "properties": common_properties,
        "views": [
            {
                "type": "table",
                "name": "当前 Memo",
                "filters": {"and": ['entity_type == "memo-series"']},
                "order": [
                    "formula.entry",
                    "company",
                    "current_version_label",
                    "decision_status",
                    "evidence_coverage",
                    "current_summary",
                    "updated_at",
                ],
            },
            {
                "type": "table",
                "name": "历史版本",
                "filters": {"and": ['entity_type == "memo-version"']},
                "groupBy": {"property": "series_id", "direction": "ASC"},
                "order": [
                    "formula.entry",
                    "version_no",
                    "as_of_date",
                    "decision_status",
                    "evidence_coverage",
                    "current_summary",
                ],
            },
            {
                "type": "table",
                "name": "需要关注的变化",
                "filters": {
                    "and": [
                        'entity_type == "memo-change"',
                        'change_level != "none"',
                    ]
                },
                "order": [
                    "formula.entry",
                    "company",
                    "change_level",
                    "change_summary",
                    "review_state",
                ],
            },
        ],
    }
    valuation_properties = {
        **common_properties,
        "target_price": {"displayName": "目标价"},
        "analysis_summary": {"displayName": "分析摘要"},
        "quarantined_node_count": {"displayName": "隔离节点"},
        "quarantined_change_count": {"displayName": "隔离变化"},
        "focus": {"displayName": "分析重点"},
    }
    valuation = {
        "filters": {
            "and": [
                *common_filters,
                {
                    "or": [
                        'entity_type == "valuation-series"',
                        'entity_type == "valuation-version"',
                        'entity_type == "valuation-change"',
                        'entity_type == "valuation-agent-analysis"',
                        'entity_type == "valuation-derived"',
                    ]
                },
            ]
        },
        "formulas": {"entry": "link(file.path, title)"},
        "properties": valuation_properties,
        "views": [
            {
                "type": "table",
                "name": "当前模型",
                "filters": {"and": ['entity_type == "valuation-series"']},
                "order": [
                    "formula.entry",
                    "company",
                    "current_version_label",
                    "current_summary",
                    "decision_status",
                    "evidence_coverage",
                    "quarantined_node_count",
                ],
            },
            {
                "type": "table",
                "name": "模型版本",
                "filters": {"and": ['entity_type == "valuation-version"']},
                "groupBy": {"property": "valuation_series_id", "direction": "ASC"},
                "order": [
                    "formula.entry",
                    "version_no",
                    "valuation_date",
                    "target_price",
                    "decision_status",
                    "evidence_coverage",
                ],
            },
            {
                "type": "table",
                "name": "可解释变化",
                "filters": {
                    "and": [
                        'entity_type == "valuation-change"',
                        'change_level != "none"',
                    ]
                },
                "order": [
                    "formula.entry",
                    "company",
                    "change_level",
                    "change_summary",
                    "quarantined_change_count",
                ],
            },
            {
                "type": "table",
                "name": "Agent 分析",
                "filters": {"and": ['entity_type == "valuation-agent-analysis"']},
                "order": [
                    "formula.entry",
                    "company",
                    "focus",
                    "analysis_summary",
                    "evidence_count",
                    "review_state",
                ],
            },
        ],
    }
    options = {
        "allow_unicode": True,
        "sort_keys": False,
        "default_flow_style": False,
    }
    return yaml.safe_dump(memo, **options), yaml.safe_dump(valuation, **options)


def _write_project_scaffold(
    conn: sqlite3.Connection,
    vault_root: Path,
    dataset_id: str,
    identity: dict[str, str],
) -> None:
    project_base = (
        Path(KNOWLEDGE_ROOT_NAME) / "10-项目" / identity["project_folder"]
    )
    memo_base, valuation_base = _base_content(dataset_id)
    _atomic_write(_safe_target(vault_root, project_base / "_views" / "Memo版本.base"), memo_base)
    _atomic_write(
        _safe_target(vault_root, project_base / "_views" / "估值版本.base"), valuation_base
    )
    project_body = "\n".join(
        (
            f"# 📝 {identity['company_name']} · 投研项目",
            "",
            "> [!important] 阅读顺序",
            "> 先看当前结论与证据覆盖，再看版本变化；待复核内容不能直接作为投资判断。",
            "",
            f"- 公司代码：`{identity['company_ticker'] or '—'}`",
            f"- 数据集：`{dataset_id}`",
            "",
            "## 当前 Memo",
            "",
            "![[_views/Memo版本.base#当前 Memo]]",
            "",
            "## 当前估值",
            "",
            "![[_views/估值版本.base#当前模型]]",
            "",
            "## 需要关注的变化",
            "",
            "![[_views/Memo版本.base#需要关注的变化]]",
            "",
            "![[_views/估值版本.base#可解释变化]]",
            "",
            "## Agent 分析",
            "",
            "![[_views/估值版本.base#Agent 分析]]",
        )
    )
    _write_managed_note(
        conn,
        vault_root,
        dataset_id=dataset_id,
        entity_type="project",
        entity_id=dataset_id,
        source_version="current",
        relative_path=project_base / "项目首页.md",
        properties=_managed_properties(
            title=f"{identity['company_name']} · 投研项目",
            entity_type="project",
            entity_id=dataset_id,
            dataset_id=dataset_id,
            source_version="current",
            updated_at=_now_iso(),
            extra={
                "company": identity["company_name"],
                "company_ticker": identity["company_ticker"],
                "status": "active",
                "review_state": "needs-review",
            },
        ),
        auto_body=project_body,
        immutable=False,
    )


def _write_global_scaffold(vault_root: Path) -> None:
    root = Path(KNOWLEDGE_ROOT_NAME)
    memo_base, valuation_base = _base_content()
    _atomic_write(_safe_target(vault_root, root / "00-总览" / "Memo版本.base"), memo_base)
    _atomic_write(_safe_target(vault_root, root / "00-总览" / "估值版本.base"), valuation_base)
    home = "\n".join(
        (
            "# 📝 投研知识库首页",
            "",
            "> [!important] 阅读提示",
            (
                "> 优先阅读“当前结论、证据覆盖、变化摘要”。"
                "标记为待复核或已隔离的内容不能直接用于投资决策。"
            ),
            "",
            "## 当前 Memo",
            "",
            "![[Memo版本.base#当前 Memo]]",
            "",
            "## Memo 需要关注的变化",
            "",
            "![[Memo版本.base#需要关注的变化]]",
            "",
            "## 当前估值模型",
            "",
            "![[估值版本.base#当前模型]]",
            "",
            "## 可解释的估值变化",
            "",
            "![[估值版本.base#可解释变化]]",
            "",
            "## Agent 分析",
            "",
            "![[估值版本.base#Agent 分析]]",
            "",
            "> [!info]- 数据边界",
            "> 本知识库是 Omnigent 数据库的可重建投影；版本真值和原始文件仍以项目数据库为准。",
        )
    )
    _atomic_write(_safe_target(vault_root, root / "00-总览" / "投研首页.md"), home + "\n")


def _claim_event(conn: sqlite3.Connection, dataset_id: str) -> sqlite3.Row | None:
    now = _now_iso()
    conn.execute("BEGIN IMMEDIATE")
    row = conn.execute(
        """
        SELECT * FROM obsidian_sync_outbox
        WHERE dataset_id=? AND status='queued' AND available_at<=?
        ORDER BY created_at LIMIT 1
        """,
        (dataset_id, now),
    ).fetchone()
    if row is None:
        conn.commit()
        return None
    conn.execute(
        """
        UPDATE obsidian_sync_outbox
        SET status='running', attempt_count=attempt_count+1,
            locked_at=?, updated_at=?
        WHERE event_id=? AND status='queued'
        """,
        (now, now, row["event_id"]),
    )
    conn.commit()
    return conn.execute(
        "SELECT * FROM obsidian_sync_outbox WHERE event_id=?", (row["event_id"],)
    ).fetchone()


def recover_stale_events(
    collection_db: Path, dataset_id: str, *, stale_after_minutes: int = 30
) -> int:
    cutoff = (_now() - timedelta(minutes=stale_after_minutes)).isoformat()
    now = _now_iso()
    with _connect(collection_db) as conn:
        ensure_obsidian_schema(conn)
        cursor = conn.execute(
            """
            UPDATE obsidian_sync_outbox
            SET status=CASE WHEN attempt_count>=max_attempts THEN 'failed' ELSE 'queued' END,
                locked_at=NULL, available_at=?,
                finished_at=CASE WHEN attempt_count>=max_attempts THEN ? ELSE NULL END,
                last_error=COALESCE(last_error, 'worker lease expired'), updated_at=?
            WHERE dataset_id=? AND status='running' AND locked_at<?
            """,
            (now, now, now, dataset_id, cutoff),
        )
        conn.commit()
        return cursor.rowcount


def process_next_event(
    collection_db: Path,
    dataset_id: str,
    vault_root: Path,
) -> dict[str, Any] | None:
    vault_root = vault_root.expanduser().resolve()
    vault_root.mkdir(parents=True, exist_ok=True)
    _write_global_scaffold(vault_root)
    with _connect(collection_db) as conn:
        ensure_obsidian_schema(conn)
        conn.commit()
        event = _claim_event(conn, dataset_id)
    if event is None:
        return None
    try:
        payload = _decode(event["payload_json"], {})
        with _connect(collection_db) as conn:
            ensure_obsidian_schema(conn)
            entity_type = str(event["entity_type"])
            if entity_type == "memo-series":
                writes = _project_memo_series(
                    conn,
                    vault_root,
                    dataset_id,
                    str(event["entity_id"]),
                )
            elif entity_type == "valuation-series":
                writes = _project_valuation_series(
                    conn,
                    vault_root,
                    dataset_id,
                    str(event["entity_id"]),
                )
            elif entity_type in {"valuation-analysis", "valuation-derived"}:
                series_id = str(payload.get("series_id") or "")
                if not series_id:
                    raise ValueError(f"{entity_type} event omitted series_id")
                writes = _project_valuation_series(
                    conn,
                    vault_root,
                    dataset_id,
                    series_id,
                )
            else:
                raise ValueError(f"unsupported Obsidian entity type: {entity_type}")
            result = {
                "written": sum(item["status"] == "written" for item in writes),
                "unchanged": sum(item["status"] == "unchanged" for item in writes),
                "conflicts": sum(item["status"] == "conflict" for item in writes),
                "paths": [item["path"] for item in writes],
            }
            now = _now_iso()
            conn.execute(
                """
                UPDATE obsidian_sync_outbox
                SET status='completed', result_json=?, finished_at=?,
                    locked_at=NULL, last_error=NULL, updated_at=?
                WHERE event_id=?
                """,
                (_json(result), now, now, event["event_id"]),
            )
            conn.commit()
            return {"event_id": event["event_id"], "status": "completed", **result}
    except Exception as exc:  # noqa: BLE001
        attempt_count = int(event["attempt_count"] or 0)
        max_attempts = int(event["max_attempts"] or 4)
        status = "failed" if attempt_count >= max_attempts else "queued"
        retry_index = min(max(0, attempt_count - 1), len(_RETRY_DELAYS_SECONDS) - 1)
        available_at = (_now() + timedelta(seconds=_RETRY_DELAYS_SECONDS[retry_index])).isoformat()
        now = _now_iso()
        with _connect(collection_db) as conn:
            conn.execute(
                """
                UPDATE obsidian_sync_outbox
                SET status=?, available_at=?, locked_at=NULL, finished_at=?,
                    last_error=?, updated_at=? WHERE event_id=?
                """,
                (
                    status,
                    available_at,
                    now if status == "failed" else None,
                    str(exc)[:2000],
                    now,
                    event["event_id"],
                ),
            )
            conn.commit()
        return {
            "event_id": event["event_id"],
            "status": status,
            "error": str(exc),
        }


def sync_dataset(
    collection_db: Path,
    dataset_id: str,
    vault_root: Path,
    *,
    max_events: int = 100,
) -> dict[str, Any]:
    """Reconcile and drain one dataset's Obsidian projection queue."""

    created = reconcile_outbox(collection_db, dataset_id)
    processed = []
    for _ in range(max(1, max_events)):
        result = process_next_event(collection_db, dataset_id, vault_root)
        if result is None:
            break
        processed.append(result)
    return {
        "dataset_id": dataset_id,
        "events_created": created,
        "events_processed": len(processed),
        "written": sum(int(item.get("written") or 0) for item in processed),
        "unchanged": sum(int(item.get("unchanged") or 0) for item in processed),
        "conflicts": sum(int(item.get("conflicts") or 0) for item in processed),
        "failed": sum(item["status"] == "failed" for item in processed),
    }


def projection_status(collection_db: Path, dataset_id: str) -> dict[str, Any]:
    with _connect(collection_db) as conn:
        ensure_obsidian_schema(conn)
        event_counts = {
            str(row["status"]): int(row["count"])
            for row in conn.execute(
                """
                SELECT status, COUNT(*) AS count FROM obsidian_sync_outbox
                WHERE dataset_id=? GROUP BY status
                """,
                (dataset_id,),
            )
        }
        registry_counts = {
            str(row["sync_status"]): int(row["count"])
            for row in conn.execute(
                """
                SELECT sync_status, COUNT(*) AS count FROM obsidian_note_registry
                WHERE dataset_id=? GROUP BY sync_status
                """,
                (dataset_id,),
            )
        }
    return {
        "dataset_id": dataset_id,
        "projector_version": PROJECTOR_VERSION,
        "events": event_counts,
        "notes": registry_counts,
    }
