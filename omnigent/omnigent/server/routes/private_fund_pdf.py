"""Local private-fund PDF research routes.

These endpoints intentionally run a direct PDF flow: register one local PDF,
extract native page text, answer against temporary page-paragraph evidence, and
generate a memo PDF. They do not build a persistent chunk index.
"""

from __future__ import annotations

import logging
import os
import hashlib
import json
import re
import shutil
import sqlite3
import sys
import threading
import subprocess
import unicodedata
from dataclasses import asdict, dataclass, is_dataclass
from datetime import datetime, timezone
from html.parser import HTMLParser
from pathlib import Path
from typing import Any
from urllib.parse import urlencode

from fastapi import APIRouter, BackgroundTasks, File as FastApiFile, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel

_logger = logging.getLogger(__name__)

_PRIVATE_FUND_ROOT = Path(__file__).resolve().parents[4]
_PRIVATE_FUND_SRC = _PRIVATE_FUND_ROOT / "src"
if str(_PRIVATE_FUND_SRC) not in sys.path:
    sys.path.insert(0, str(_PRIVATE_FUND_SRC))

from pdf_research_demo.demo import ChatClient, MemoDraft, PdfResearchDemo  # noqa: E402
from pdf_research_demo.llm import OpenAICompatibleChatClient, load_llm_config  # noqa: E402
from pdf_research_demo.memo_pdf import render_memo_pdf  # noqa: E402
from pdf_research_demo.models import Citation  # noqa: E402

DEFAULT_PDF_PATH = (
    _PRIVATE_FUND_ROOT
    / "output/private_fund_datasets/ygdy/raw/阳光电源300274近况交流会260701_原文.pdf"
)
SOURCE_RENDER_DIR = _PRIVATE_FUND_ROOT / "output/pdf_sources"
SOURCE_RENDER_DPI = 144
DATASET_WORKSPACE_DIR = _PRIVATE_FUND_ROOT / "output/private_fund_datasets"
EXCEL_FILE_TYPES = {"xlsx", "xls", "xlsm", "csv"}
PROJECT_UPLOADS_DIRNAME = "_uploads"
PRIVATE_FUND_PROJECT_LABEL_ID = "private_fund.dataset_id"
PRIVATE_FUND_PROJECT_LABEL_NAME = "private_fund.dataset_name"
SUPPORTED_PROJECT_UPLOAD_SUFFIXES = {".pdf", ".xlsx", ".xlsm"}
_PRIVATE_FUND_PIPELINE_JOBS_LOCK = threading.Lock()
_PRIVATE_FUND_PIPELINE_JOBS: dict[str, dict[str, Any]] = {}


@dataclass(frozen=True)
class _BboxWord:
    text: str
    x_min: float
    y_min: float
    x_max: float
    y_max: float


@dataclass(frozen=True)
class _BboxLine:
    text: str
    x_min: float
    y_min: float
    x_max: float
    y_max: float


@dataclass(frozen=True)
class _LineBlock:
    start: int
    end: int
    speaker_id: str | None


@dataclass(frozen=True)
class _DatasetPdfChunk:
    evidence_id: str
    doc_id: str
    chunk_id: str
    chunk_index: int
    content_type: str
    content: str
    citation: str
    bbox: Any
    match_score: float


class _PdfBboxParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.page_width = 0.0
        self.page_height = 0.0
        self.words: list[_BboxWord] = []
        self._word_attrs: dict[str, str] | None = None
        self._word_text: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attr_map = {key.lower(): value for key, value in attrs if value is not None}
        if tag.lower() == "page":
            self.page_width = _safe_float(attr_map.get("width"), 0.0)
            self.page_height = _safe_float(attr_map.get("height"), 0.0)
        elif tag.lower() == "word":
            self._word_attrs = attr_map
            self._word_text = []

    def handle_data(self, data: str) -> None:
        if self._word_attrs is not None:
            self._word_text.append(data)

    def handle_endtag(self, tag: str) -> None:
        if tag.lower() != "word" or self._word_attrs is None:
            return
        text = "".join(self._word_text).strip()
        attrs = self._word_attrs
        self._word_attrs = None
        self._word_text = []
        if not text:
            return
        self.words.append(
            _BboxWord(
                text=text,
                x_min=_safe_float(attrs.get("xmin"), 0.0),
                y_min=_safe_float(attrs.get("ymin"), 0.0),
                x_max=_safe_float(attrs.get("xmax"), 0.0),
                y_max=_safe_float(attrs.get("ymax"), 0.0),
            )
        )


class RegisterPdfRequest(BaseModel):
    pdf_path: str
    company_name: str | None = "阳光电源"
    ticker: str | None = "300274"


class AskPdfRequest(BaseModel):
    question: str
    top_k: int = 3


class MemoRequest(BaseModel):
    company_name: str | None = None
    ticker: str | None = None


class CreateProjectRequest(BaseModel):
    name: str
    dataset_id: str | None = None
    company_name: str | None = ""
    company_ticker: str | None = ""


class RunProjectPipelineRequest(BaseModel):
    reset: bool = True
    recursive: bool = True


def _jsonable(value: Any) -> Any:
    if hasattr(value, "to_dict"):
        return _jsonable(value.to_dict())
    if is_dataclass(value):
        return _jsonable(asdict(value))
    if isinstance(value, Path):
        return str(value)
    if isinstance(value, dict):
        return {key: _jsonable(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_jsonable(item) for item in value]
    if isinstance(value, tuple):
        return [_jsonable(item) for item in value]
    return value


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _safe_dataset_id(value: str, fallback: str = "dataset") -> str:
    text = unicodedata.normalize("NFKC", value or "")
    text = re.sub(r"[^\w\u4e00-\u9fff.-]+", "_", text, flags=re.UNICODE)
    text = text.strip("._-")
    return text or fallback


def _safe_upload_name(name: str | None) -> str:
    raw = Path(name or "upload").name.strip() or "upload"
    raw = unicodedata.normalize("NFKC", raw)
    raw = re.sub(r"[/\\:\0]+", "_", raw)
    raw = raw.strip(" .") or "upload"
    suffix = Path(raw).suffix.lower()
    if suffix not in SUPPORTED_PROJECT_UPLOAD_SUFFIXES:
        supported = ", ".join(sorted(SUPPORTED_PROJECT_UPLOAD_SUFFIXES))
        raise HTTPException(status_code=400, detail=f"Unsupported file type. Supported: {supported}")
    return raw


def _project_uploads_root(workspace_root: Path | None = None) -> Path:
    root = workspace_root or _dataset_workspace_root()
    return root / PROJECT_UPLOADS_DIRNAME


def _project_uploads_dir(dataset_id: str, workspace_root: Path | None = None) -> Path:
    return _project_uploads_root(workspace_root) / _safe_dataset_id(dataset_id)


def _project_dataset_root(dataset_id: str, workspace_root: Path | None = None) -> Path:
    root = workspace_root or _dataset_workspace_root()
    return root / _safe_dataset_id(dataset_id)


def _supported_files_in(directory: Path) -> list[Path]:
    if not directory.is_dir():
        return []
    return sorted(
        (
            path
            for path in directory.glob("*")
            if path.is_file()
            and path.suffix.lower() in SUPPORTED_PROJECT_UPLOAD_SUFFIXES
            and not path.name.startswith(".")
        ),
        key=lambda path: path.name.lower(),
    )


def _connect_global_registry(workspace_root: Path | None = None) -> sqlite3.Connection:
    workspace = workspace_root or _dataset_workspace_root()
    ingest = _private_fund_ingest_module()
    conn = ingest.connect_sqlite(workspace / "datasets.sqlite3")
    ingest.ensure_global_schema(conn)
    return conn


def _private_fund_ingest_module() -> Any:
    pipeline_dir = _PRIVATE_FUND_ROOT / "FinSagent" / "data_pipeline"
    if str(pipeline_dir) not in sys.path:
        sys.path.insert(0, str(pipeline_dir))
    import private_fund_directory_ingest  # type: ignore[import-not-found]

    return private_fund_directory_ingest


def _project_row(dataset_id: str) -> sqlite3.Row | None:
    registry = _dataset_workspace_root() / "datasets.sqlite3"
    if not registry.exists():
        return None
    with sqlite3.connect(str(registry), timeout=5) as conn:
        conn.row_factory = sqlite3.Row
        return conn.execute("SELECT * FROM datasets WHERE dataset_id = ?", (dataset_id,)).fetchone()


def _require_project_row(dataset_id: str) -> sqlite3.Row:
    row = _project_row(dataset_id)
    if row is None:
        raise HTTPException(status_code=404, detail=f"Private-fund project not found: {dataset_id}")
    return row


def _collection_db_path(dataset_id: str) -> Path:
    return _project_dataset_root(dataset_id) / "meta" / "collection.sqlite3"


def _latest_project_job(dataset_id: str) -> dict[str, Any] | None:
    with _PRIVATE_FUND_PIPELINE_JOBS_LOCK:
        in_memory = [
            dict(job)
            for job in _PRIVATE_FUND_PIPELINE_JOBS.values()
            if job.get("dataset_id") == dataset_id
        ]
    if in_memory:
        in_memory.sort(key=lambda item: item.get("created_at") or item.get("started_at") or "", reverse=True)
        return in_memory[0]

    collection_db = _collection_db_path(dataset_id)
    if not collection_db.exists():
        return None
    try:
        with sqlite3.connect(str(collection_db), timeout=5) as conn:
            conn.row_factory = sqlite3.Row
            row = conn.execute(
                """
                SELECT job_id, dataset_id, job_type, status, file_count, message,
                       returncode, created_at, started_at, finished_at, metadata_json
                FROM ingest_jobs
                WHERE dataset_id = ?
                ORDER BY COALESCE(started_at, created_at) DESC
                LIMIT 1
                """,
                (dataset_id,),
            ).fetchone()
    except sqlite3.Error:
        return None
    return dict(row) if row else None


def _project_index_stats(dataset_id: str) -> dict[str, Any]:
    collection_db = _collection_db_path(dataset_id)
    stats: dict[str, Any] = {
        "document_count": 0,
        "indexed_document_count": 0,
        "failed_document_count": 0,
        "chunk_count": 0,
        "index_count": 0,
    }
    if not collection_db.exists():
        return stats
    try:
        with sqlite3.connect(str(collection_db), timeout=5) as conn:
            conn.row_factory = sqlite3.Row
            stats["document_count"] = int(
                conn.execute("SELECT COUNT(*) FROM documents WHERE deleted_at IS NULL").fetchone()[0] or 0
            )
            stats["indexed_document_count"] = int(
                conn.execute(
                    "SELECT COUNT(*) FROM documents WHERE deleted_at IS NULL AND status = 'indexed'"
                ).fetchone()[0]
                or 0
            )
            stats["failed_document_count"] = int(
                conn.execute(
                    "SELECT COUNT(*) FROM documents WHERE deleted_at IS NULL AND status = 'failed'"
                ).fetchone()[0]
                or 0
            )
            stats["chunk_count"] = int(conn.execute("SELECT COUNT(*) FROM chunks").fetchone()[0] or 0)
            stats["index_count"] = int(
                conn.execute("SELECT COUNT(*) FROM index_registry WHERE dataset_id = ?", (dataset_id,)).fetchone()[0]
                or 0
            )
    except sqlite3.Error:
        return stats
    return stats


def _project_memo_stats(dataset_id: str) -> dict[str, Any]:
    memos_dir = _project_dataset_root(dataset_id) / "memos"
    files = sorted(
        (path for path in memos_dir.glob("*") if path.is_file() and path.suffix.lower() in {".md", ".html", ".pdf"}),
        key=lambda path: path.stat().st_mtime,
        reverse=True,
    ) if memos_dir.is_dir() else []
    latest = files[0] if files else None
    return {
        "memo_count": len(files),
        "latest_memo_path": str(latest) if latest else None,
        "latest_memo_name": latest.name if latest else None,
    }


def _project_payload(row: sqlite3.Row) -> dict[str, Any]:
    dataset_id = str(row["dataset_id"])
    uploads = _supported_files_in(_project_uploads_dir(dataset_id))
    raw = _supported_files_in(_project_dataset_root(dataset_id) / "raw")
    stats = _project_index_stats(dataset_id)
    memo_stats = _project_memo_stats(dataset_id)
    latest_job = _latest_project_job(dataset_id)
    upload_count = len(uploads) if uploads else len(raw)
    return {
        "dataset_id": dataset_id,
        "name": row["name"],
        "status": row["status"],
        "source_dir": row["source_dir"],
        "dataset_root": row["dataset_root"],
        "uploads_dir": str(_project_uploads_dir(dataset_id)),
        "company_name": row["company_name"],
        "company_ticker": row["company_ticker"],
        "file_count": int(row["file_count"] or upload_count),
        "upload_count": upload_count,
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
        "index_ready": stats["chunk_count"] > 0 and row["status"] == "completed",
        "latest_job": latest_job,
        **stats,
        **memo_stats,
    }


def _list_projects_payload() -> list[dict[str, Any]]:
    workspace = _dataset_workspace_root()
    registry = workspace / "datasets.sqlite3"
    projects: list[dict[str, Any]] = []
    seen: set[str] = set()
    if registry.exists():
        with sqlite3.connect(str(registry), timeout=5) as conn:
            conn.row_factory = sqlite3.Row
            rows = conn.execute("SELECT * FROM datasets ORDER BY updated_at DESC, name ASC").fetchall()
        for row in rows:
            seen.add(str(row["dataset_id"]))
            projects.append(_project_payload(row))

    uploads_root = _project_uploads_root(workspace)
    if uploads_root.is_dir():
        for uploads_dir in sorted(uploads_root.iterdir(), key=lambda path: path.name.lower()):
            if not uploads_dir.is_dir() or uploads_dir.name in seen:
                continue
            files = _supported_files_in(uploads_dir)
            if not files:
                continue
            dataset_id = uploads_dir.name
            stat = max(path.stat().st_mtime for path in files)
            updated = datetime.fromtimestamp(stat, tz=timezone.utc).isoformat()
            projects.append(
                {
                    "dataset_id": dataset_id,
                    "name": dataset_id,
                    "status": "draft",
                    "source_dir": str(uploads_dir),
                    "dataset_root": str(_project_dataset_root(dataset_id, workspace)),
                    "uploads_dir": str(uploads_dir),
                    "company_name": "",
                    "company_ticker": "",
                    "file_count": len(files),
                    "upload_count": len(files),
                    "created_at": updated,
                    "updated_at": updated,
                    "index_ready": False,
                    "latest_job": _latest_project_job(dataset_id),
                    "document_count": 0,
                    "indexed_document_count": 0,
                    "failed_document_count": 0,
                    "chunk_count": 0,
                    "index_count": 0,
                    "memo_count": 0,
                    "latest_memo_path": None,
                    "latest_memo_name": None,
                }
            )
    return projects


def _project_files_payload(dataset_id: str) -> list[dict[str, Any]]:
    uploads = _supported_files_in(_project_uploads_dir(dataset_id))
    raw = _supported_files_in(_project_dataset_root(dataset_id) / "raw")
    source_files = uploads if uploads else raw
    indexed: dict[str, sqlite3.Row] = {}
    collection_db = _collection_db_path(dataset_id)
    if collection_db.exists():
        try:
            with sqlite3.connect(str(collection_db), timeout=5) as conn:
                conn.row_factory = sqlite3.Row
                rows = conn.execute(
                    """
                    SELECT doc_id, title, original_filename, stored_path, file_type, status,
                           chunk_count, error_message, file_size, created_at, updated_at
                    FROM documents
                    WHERE dataset_id = ? AND deleted_at IS NULL
                    ORDER BY updated_at DESC
                    """,
                    (dataset_id,),
                ).fetchall()
            indexed = {str(row["original_filename"]): row for row in rows}
        except sqlite3.Error:
            indexed = {}

    seen: set[str] = set()
    files: list[dict[str, Any]] = []
    for path in source_files:
        row = indexed.get(path.name)
        seen.add(path.name)
        stat = path.stat()
        files.append(
            {
                "name": path.name,
                "file_type": path.suffix.lower().lstrip("."),
                "size": stat.st_size,
                "uploaded_at": datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc).isoformat(),
                "source_path": str(path),
                "status": row["status"] if row else "pending",
                "doc_id": row["doc_id"] if row else None,
                "chunk_count": int(row["chunk_count"] or 0) if row else 0,
                "error_message": row["error_message"] if row else None,
                "stored_path": row["stored_path"] if row else None,
            }
        )
    for name, row in indexed.items():
        if name in seen:
            continue
        files.append(
            {
                "name": name,
                "file_type": row["file_type"],
                "size": int(row["file_size"] or 0),
                "uploaded_at": row["created_at"],
                "source_path": None,
                "status": row["status"],
                "doc_id": row["doc_id"],
                "chunk_count": int(row["chunk_count"] or 0),
                "error_message": row["error_message"],
                "stored_path": row["stored_path"],
            }
        )
    return files


def _create_project_row(request: CreateProjectRequest) -> dict[str, Any]:
    name = request.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Project name is required.")
    dataset_id = _safe_dataset_id(request.dataset_id or name)
    workspace = _dataset_workspace_root()
    dataset_root = _project_dataset_root(dataset_id, workspace)
    uploads_dir = _project_uploads_dir(dataset_id, workspace)
    now = _now_iso()
    with _connect_global_registry(workspace) as conn:
        existing = conn.execute("SELECT dataset_id FROM datasets WHERE dataset_id = ?", (dataset_id,)).fetchone()
        if existing:
            raise HTTPException(status_code=409, detail=f"Project already exists: {dataset_id}")
        dataset_root.mkdir(parents=True, exist_ok=True)
        uploads_dir.mkdir(parents=True, exist_ok=True)
        conn.execute(
            """
            INSERT INTO datasets (
                dataset_id, name, status, source_dir, dataset_root, company_name,
                company_ticker, file_count, created_at, updated_at, metadata_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                dataset_id,
                name,
                "draft",
                str(uploads_dir),
                str(dataset_root),
                request.company_name or "",
                request.company_ticker or "",
                0,
                now,
                now,
                json.dumps({"source": "omnigent_research_project_ui"}, ensure_ascii=False),
            ),
        )
        conn.commit()
        row = conn.execute("SELECT * FROM datasets WHERE dataset_id = ?", (dataset_id,)).fetchone()
    return _project_payload(row)


def _seed_uploads_from_raw(dataset_id: str) -> Path:
    uploads_dir = _project_uploads_dir(dataset_id)
    uploads_dir.mkdir(parents=True, exist_ok=True)
    if _supported_files_in(uploads_dir):
        return uploads_dir
    raw_dir = _project_dataset_root(dataset_id) / "raw"
    for raw_file in _supported_files_in(raw_dir):
        target = uploads_dir / raw_file.name
        if not target.exists():
            shutil.copy2(raw_file, target)
    return uploads_dir


def _save_uploaded_project_files(dataset_id: str, files: list[UploadFile]) -> dict[str, Any]:
    _require_project_row(dataset_id)
    uploads_dir = _seed_uploads_from_raw(dataset_id)
    saved: list[dict[str, Any]] = []
    for uploaded in files:
        filename = _safe_upload_name(uploaded.filename)
        target = uploads_dir / filename
        body = uploaded.file.read()
        if not body:
            raise HTTPException(status_code=400, detail=f"Uploaded file is empty: {filename}")
        if target.exists():
            digest = hashlib.sha256(body).hexdigest()[:8]
            existing = hashlib.sha256(target.read_bytes()).hexdigest()[:8]
            if digest != existing:
                target = uploads_dir / f"{Path(filename).stem}_{digest}{Path(filename).suffix}"
        target.write_bytes(body)
        saved.append(
            {
                "name": target.name,
                "file_type": target.suffix.lower().lstrip("."),
                "size": target.stat().st_size,
                "source_path": str(target),
            }
        )
    with _connect_global_registry() as conn:
        conn.execute(
            "UPDATE datasets SET status = CASE WHEN status = 'completed' THEN status ELSE 'draft' END, source_dir = ?, file_count = ?, updated_at = ? WHERE dataset_id = ?",
            (str(uploads_dir), len(_supported_files_in(uploads_dir)), _now_iso(), dataset_id),
        )
        conn.commit()
    return {"dataset_id": dataset_id, "files": saved, "project": _project_payload(_require_project_row(dataset_id))}


def _set_active_dataset(dataset_id: str) -> dict[str, Any]:
    _require_project_row(dataset_id)
    with _connect_global_registry() as conn:
        conn.execute(
            "INSERT OR REPLACE INTO dataset_state (id, active_dataset_id, updated_at) VALUES (1, ?, ?)",
            (dataset_id, _now_iso()),
        )
        conn.commit()
    return {"active_dataset_id": dataset_id}


def _project_pipeline_worker(job_id: str, payload: dict[str, Any]) -> None:
    dataset_id = payload["dataset_id"]
    with _PRIVATE_FUND_PIPELINE_JOBS_LOCK:
        _PRIVATE_FUND_PIPELINE_JOBS[job_id] = {
            **_PRIVATE_FUND_PIPELINE_JOBS.get(job_id, {}),
            "job_id": job_id,
            "dataset_id": dataset_id,
            "status": "running",
            "started_at": _now_iso(),
        }
    try:
        ingest = _private_fund_ingest_module()
        result = ingest.ingest_directory(
            directory_path=payload["directory_path"],
            workspace_root=payload["workspace_root"],
            dataset_id=dataset_id,
            dataset_name=payload["dataset_name"],
            company_name=payload.get("company_name") or "",
            company_ticker=payload.get("company_ticker") or "",
            recursive=bool(payload.get("recursive", True)),
            reset=bool(payload.get("reset", True)),
            job_id=job_id,
        )
        with _PRIVATE_FUND_PIPELINE_JOBS_LOCK:
            _PRIVATE_FUND_PIPELINE_JOBS[job_id] = {
                "job_id": job_id,
                "dataset_id": dataset_id,
                "status": result.status,
                "started_at": result.started_at,
                "finished_at": result.finished_at,
                "result": ingest.result_to_dict(result),
                "message": result.message,
            }
    except Exception as exc:  # noqa: BLE001
        _logger.exception("private fund project pipeline failed: job_id=%s dataset_id=%s", job_id, dataset_id)
        with _PRIVATE_FUND_PIPELINE_JOBS_LOCK:
            _PRIVATE_FUND_PIPELINE_JOBS[job_id] = {
                **_PRIVATE_FUND_PIPELINE_JOBS.get(job_id, {}),
                "job_id": job_id,
                "dataset_id": dataset_id,
                "status": "failed",
                "finished_at": _now_iso(),
                "message": str(exc),
            }


def _trace_payload(demo: PdfResearchDemo, citations: list[Citation]) -> list[dict[str, Any]]:
    return [_jsonable(demo.trace_citation(citation.citation_id)) for citation in citations]


def _load_chat_client() -> tuple[ChatClient | None, dict[str, Any]]:
    if os.environ.get("PRIVATE_FUND_USE_LLM", "1").strip().lower() in {"0", "false", "no"}:
        return None, {"enabled": False, "reason": "PRIVATE_FUND_USE_LLM disabled"}

    config_path = os.environ.get("PRIVATE_FUND_LLM_CONFIG") or None
    try:
        config = load_llm_config(config_path)
    except Exception as exc:  # noqa: BLE001
        _logger.warning("Could not load private fund LLM config: %s", exc)
        return None, {"enabled": False, "error": str(exc)}
    if config is None:
        return None, {"enabled": False, "reason": "No OpenAI-compatible LLM config found"}
    return OpenAICompatibleChatClient(config), config.safe_summary()


def _safe_float(value: str | None, default: float) -> float:
    try:
        return float(value) if value is not None else default
    except (TypeError, ValueError):
        return default


def _safe_page_no(page_no: int) -> int:
    page = int(page_no)
    if page < 1:
        raise HTTPException(status_code=400, detail="page_no must be >= 1")
    return page


def _require_tool(name: str) -> str:
    tool = shutil.which(name)
    if not tool:
        raise HTTPException(status_code=500, detail=f"Required PDF tool not found: {name}")
    return tool


def _render_cache_key(pdf_path: Path, page_no: int, dpi: int) -> str:
    stat = pdf_path.stat()
    raw = f"{pdf_path}:{stat.st_size}:{stat.st_mtime_ns}:{page_no}:{dpi}"
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:24]


def _png_size(path: Path) -> tuple[int, int]:
    data = path.read_bytes()[:24]
    if len(data) < 24 or data[:8] != b"\x89PNG\r\n\x1a\n":
        raise HTTPException(status_code=500, detail="Rendered PDF page is not a valid PNG.")
    return int.from_bytes(data[16:20], "big"), int.from_bytes(data[20:24], "big")


def _dataset_workspace_root() -> Path:
    override = os.environ.get("PRIVATE_FUND_DATASET_WORKSPACE")
    return Path(override).expanduser().resolve() if override else DATASET_WORKSPACE_DIR


def _active_dataset_id(workspace_root: Path, dataset_id: str | None = None) -> str | None:
    if dataset_id:
        return dataset_id
    registry = workspace_root / "datasets.sqlite3"
    if not registry.exists():
        return None
    try:
        with sqlite3.connect(str(registry), timeout=5) as conn:
            conn.row_factory = sqlite3.Row
            conn.execute("PRAGMA busy_timeout=5000")
            row = conn.execute(
                "SELECT active_dataset_id FROM dataset_state WHERE id = 1"
            ).fetchone()
    except sqlite3.Error:
        return None
    value = row["active_dataset_id"] if row else None
    return str(value) if value else None


def _active_collection_db(dataset_id: str | None = None) -> tuple[Path, str] | None:
    workspace_root = _dataset_workspace_root()
    active_dataset = _active_dataset_id(workspace_root, dataset_id)
    if not active_dataset:
        return None
    collection_db = workspace_root / active_dataset / "meta" / "collection.sqlite3"
    if not collection_db.exists():
        return None
    return collection_db, active_dataset


def _dataset_document_by_name(
    file_name: str,
    dataset_id: str | None = None,
    *,
    file_types: set[str] | None = None,
) -> tuple[sqlite3.Row, Path, str] | None:
    clean_name = Path(file_name).name.strip()
    if not clean_name:
        return None
    collection = _active_collection_db(dataset_id)
    if collection is None:
        return None
    collection_db, active_dataset = collection
    type_filter = ""
    params: list[Any] = [clean_name, clean_name, Path(clean_name).stem, f"%/{clean_name}"]
    if file_types:
        placeholders = ",".join("?" for _ in file_types)
        type_filter = f"AND lower(file_type) IN ({placeholders})"
        params.extend(sorted(file_types))
    try:
        with sqlite3.connect(str(collection_db), timeout=5) as conn:
            conn.row_factory = sqlite3.Row
            conn.execute("PRAGMA busy_timeout=5000")
            row = conn.execute(
                f"""
                SELECT *
                FROM documents
                WHERE deleted_at IS NULL
                  AND (
                    original_filename = ?
                    OR source_name = ?
                    OR title = ?
                    OR stored_path LIKE ?
                  )
                  {type_filter}
                ORDER BY original_filename
                LIMIT 1
                """,
                params,
            ).fetchone()
    except sqlite3.Error:
        return None
    return (row, collection_db, active_dataset) if row else None


def _dataset_pdf_path_by_name(pdf_name: str, dataset_id: str | None = None) -> Path | None:
    document = _dataset_document_by_name(pdf_name, dataset_id, file_types={"pdf"})
    if document is None:
        return None
    row, _, _ = document
    candidate = Path(row["stored_path"]).expanduser().resolve()
    if candidate.is_file() and candidate.suffix.lower() == ".pdf":
        return candidate
    return None


def _searchable_text(value: str | None) -> str:
    if not value:
        return ""
    return re.sub(r"[\W_]+", "", value.lower(), flags=re.UNICODE)


def _source_match_score(query: str | None, text: str) -> float:
    query_text = _searchable_text(query)
    page_text = _searchable_text(text)
    if not page_text:
        return 0.0
    if not query_text:
        return 0.0
    if query_text in page_text:
        return float(len(query_text)) + 1000.0

    cjk_chars = re.findall(r"[\u4e00-\u9fff]", query_text)
    grams = {query_text[index : index + 2] for index in range(max(0, len(query_text) - 1))}
    grams = {gram for gram in grams if len(gram) == 2 and re.search(r"[\u4e00-\u9fff]", gram)}
    words = {
        token
        for token in re.findall(r"[a-z0-9]{2,}|[\u4e00-\u9fff]{2,}", query_text)
        if len(token) >= 2
    }
    hits = sum(1 for gram in grams if gram in page_text)
    word_hits = sum(len(word) for word in words if word in page_text)
    cjk_hits = sum(1 for char in cjk_chars if char in page_text)
    return hits * 3.0 + word_hits * 2.0 + cjk_hits * 0.1


def _dataset_pdf_path_by_page_quote(
    page_no: int,
    *,
    quote: str | None = None,
    dataset_id: str | None = None,
) -> Path | None:
    collection = _active_collection_db(dataset_id)
    if collection is None:
        return None
    collection_db, _active_dataset = collection
    try:
        with sqlite3.connect(str(collection_db), timeout=5) as conn:
            conn.row_factory = sqlite3.Row
            conn.execute("PRAGMA busy_timeout=5000")
            rows = conn.execute(
                """
                SELECT d.stored_path, d.original_filename, p.text
                FROM pdf_pages p
                JOIN documents d ON d.doc_id = p.doc_id
                WHERE d.file_type = 'pdf'
                  AND d.deleted_at IS NULL
                  AND p.page_number = ?
                ORDER BY d.original_filename
                """,
                (page_no,),
            ).fetchall()
    except sqlite3.Error:
        return None

    best_path: Path | None = None
    best_score = -1.0
    for row in rows:
        candidate = Path(row["stored_path"]).expanduser().resolve()
        if not candidate.is_file() or candidate.suffix.lower() != ".pdf":
            continue
        score = _source_match_score(quote, row["text"])
        if score > best_score:
            best_score = score
            best_path = candidate
    return best_path


def _decode_json_value(value: str | None, default: Any = None) -> Any:
    if not value:
        return default
    try:
        return json.loads(value)
    except (TypeError, ValueError, json.JSONDecodeError):
        return default


def _dataset_pdf_path_by_evidence_id(
    evidence_id: str | None,
    dataset_id: str | None = None,
) -> Path | None:
    if not evidence_id:
        return None
    kind, _, raw_id = evidence_id.partition(":")
    if kind != "chunk" or not raw_id:
        return None
    collection = _active_collection_db(dataset_id)
    if collection is None:
        return None
    collection_db, _active_dataset = collection
    try:
        with sqlite3.connect(str(collection_db), timeout=5) as conn:
            conn.row_factory = sqlite3.Row
            conn.execute("PRAGMA busy_timeout=5000")
            row = conn.execute(
                """
                SELECT d.stored_path
                FROM chunks c
                JOIN documents d ON d.doc_id = c.doc_id
                WHERE c.chunk_id = ?
                  AND d.file_type = 'pdf'
                  AND d.deleted_at IS NULL
                LIMIT 1
                """,
                (raw_id,),
            ).fetchone()
    except sqlite3.Error:
        return None
    if row is None:
        return None
    candidate = Path(row["stored_path"]).expanduser().resolve()
    return candidate if candidate.is_file() and candidate.suffix.lower() == ".pdf" else None


def _dataset_memo_artifact_path(raw_path: str) -> Path:
    if not raw_path:
        raise HTTPException(status_code=400, detail="memo artifact path is required")
    workspace_root = _dataset_workspace_root().resolve()
    try:
        candidate = Path(raw_path).expanduser().resolve()
    except OSError as exc:
        raise HTTPException(status_code=400, detail=f"Invalid memo artifact path: {raw_path}") from exc
    if candidate.suffix.lower() not in {".pdf", ".html"}:
        raise HTTPException(status_code=400, detail="Only memo PDF/HTML artifacts can be opened.")
    try:
        candidate.relative_to(workspace_root)
    except ValueError as exc:
        raise HTTPException(status_code=403, detail="Memo artifact is outside the dataset workspace.") from exc
    if not candidate.is_file():
        raise HTTPException(status_code=404, detail=f"Memo artifact not found: {candidate}")
    return candidate


def _is_precise_pdf_bbox(bbox: Any, page_width: float, page_height: float) -> bool:
    if not isinstance(bbox, (list, tuple)) or len(bbox) != 4:
        return False
    try:
        x_min, y_min, x_max, y_max = (float(value) for value in bbox)
    except (TypeError, ValueError):
        return False
    width = max(0.0, x_max - x_min)
    height = max(0.0, y_max - y_min)
    if width <= 0 or height <= 0:
        return False
    if page_width and width >= page_width * 0.92 and height >= page_height * 0.92:
        return False
    return True


def _dataset_chunk_citation(row: sqlite3.Row) -> str:
    filename = row["original_filename"]
    page_start = row["page_start"]
    page_end = row["page_end"]
    if page_start and page_end and page_end != page_start:
        return f"{filename} p.{page_start}-{page_end}"
    if page_start:
        return f"{filename} p.{page_start}"
    return str(row["display_text"] or row["source_ref"] or filename)


def _dataset_chunk_match_score(row: sqlite3.Row, quote: str | None, tokens: list[str]) -> float:
    if not tokens:
        return 0.0
    text = " ".join(
        str(row[key] or "")
        for key in ("content", "title_path", "summary", "source_ref", "display_text")
    )
    score = _score_text(text, tokens)
    quote_text = _normalize_match_text(quote or "")
    content_text = _normalize_match_text(str(row["content"] or ""))
    if quote_text and quote_text in content_text:
        score += min(80.0, 20.0 + len(quote_text) * 0.5)
    return score


def _best_dataset_pdf_chunk(
    pdf_path: Path,
    page_no: int,
    *,
    quote: str | None = None,
    evidence_id: str | None = None,
    dataset_id: str | None = None,
) -> _DatasetPdfChunk | None:
    collection = _active_collection_db(dataset_id)
    if collection is None:
        return None
    collection_db, _active_dataset = collection
    tokens = _query_tokens(quote)

    raw_evidence_id = ""
    if evidence_id:
        kind, _, raw_id = evidence_id.partition(":")
        raw_evidence_id = raw_id if kind == "chunk" else ""

    sql = """
        SELECT c.chunk_id, c.content, c.content_type, c.title_path, c.summary,
               c.source_ref, c.chunk_index, d.doc_id, d.original_filename, d.stored_path, l.page_start,
               l.page_end, l.bbox_json, l.display_text
        FROM chunks c
        JOIN documents d ON d.doc_id = c.doc_id
        LEFT JOIN chunk_locations l
          ON l.chunk_id = c.chunk_id
         AND l.location_index = (
             SELECT MIN(location_index) FROM chunk_locations WHERE chunk_id = c.chunk_id
         )
        WHERE d.file_type = 'pdf'
          AND d.deleted_at IS NULL
          AND c.content_type IN ('pdf_speaker_turn', 'pdf_page')
    """
    params: list[Any] = []
    if raw_evidence_id:
        sql += " AND c.chunk_id = ?"
        params.append(raw_evidence_id)
    else:
        sql += """
          AND (
            d.stored_path = ?
            OR d.original_filename = ?
          )
          AND l.page_start IS NOT NULL
          AND ? BETWEEN l.page_start AND COALESCE(l.page_end, l.page_start)
        """
        params.extend([str(pdf_path), pdf_path.name, page_no])
    sql += " ORDER BY c.chunk_index"

    try:
        with sqlite3.connect(str(collection_db), timeout=5) as conn:
            conn.row_factory = sqlite3.Row
            conn.execute("PRAGMA busy_timeout=5000")
            rows = conn.execute(sql, params).fetchall()
    except sqlite3.Error:
        return None

    if raw_evidence_id and rows:
        row = rows[0]
        return _DatasetPdfChunk(
            evidence_id=f"chunk:{row['chunk_id']}",
            doc_id=row["doc_id"],
            chunk_id=row["chunk_id"],
            chunk_index=int(row["chunk_index"]),
            content_type=row["content_type"],
            content=row["content"],
            citation=_dataset_chunk_citation(row),
            bbox=_decode_json_value(row["bbox_json"], None),
            match_score=9999.0,
        )

    if not rows or not tokens:
        return None

    scored: list[tuple[float, float, int, sqlite3.Row]] = []
    for row in rows:
        score = _dataset_chunk_match_score(row, quote, tokens)
        if score < 4.0:
            continue
        normalized_length = max(1.0, len(_normalize_match_text(str(row["content"] or ""))) / 260.0)
        density = score / normalized_length
        specificity = 2 if row["content_type"] == "pdf_speaker_turn" else 1
        scored.append((score, density, specificity, row))
    if not scored:
        return None

    best_score = max(item[0] for item in scored)
    close_matches = [item for item in scored if item[0] >= best_score * 0.55]
    score, density, _specificity, row = max(
        close_matches,
        key=lambda item: (item[2], item[1], item[0]),
    )
    return _DatasetPdfChunk(
        evidence_id=f"chunk:{row['chunk_id']}",
        doc_id=row["doc_id"],
        chunk_id=row["chunk_id"],
        chunk_index=int(row["chunk_index"]),
        content_type=row["content_type"],
        content=row["content"],
        citation=_dataset_chunk_citation(row),
        bbox=_decode_json_value(row["bbox_json"], None),
        match_score=round(score + density * 0.001, 3),
    )


def _following_answer_chunk_bboxes(
    selected: _DatasetPdfChunk,
    page_no: int,
    *,
    page_width: float,
    page_height: float,
    dataset_id: str | None = None,
) -> list[tuple[float, float, float, float]]:
    if not _has_question_cue(selected.content):
        return []
    question_speaker = _speaker_id(selected.content.splitlines()[0] if selected.content else "")
    if not question_speaker:
        return []

    collection = _active_collection_db(dataset_id)
    if collection is None:
        return []
    collection_db, _active_dataset = collection
    try:
        with sqlite3.connect(str(collection_db), timeout=5) as conn:
            conn.row_factory = sqlite3.Row
            conn.execute("PRAGMA busy_timeout=5000")
            rows = conn.execute(
                """
                SELECT c.content, c.chunk_index, l.bbox_json
                FROM chunks c
                JOIN chunk_locations l ON l.chunk_id = c.chunk_id
                WHERE c.doc_id = ?
                  AND c.content_type = 'pdf_speaker_turn'
                  AND c.chunk_index > ?
                  AND l.page_start = ?
                ORDER BY c.chunk_index
                LIMIT 8
                """,
                (selected.doc_id, selected.chunk_index, page_no),
            ).fetchall()
    except sqlite3.Error:
        return []

    answer_speaker: str | None = None
    bboxes: list[tuple[float, float, float, float]] = []
    for row in rows:
        speaker = _speaker_id(str(row["content"] or "").splitlines()[0])
        if not speaker:
            continue
        if answer_speaker is None:
            if speaker == question_speaker:
                continue
            answer_speaker = speaker
        elif speaker != answer_speaker:
            break
        bbox = _decode_json_value(row["bbox_json"], None)
        if _is_precise_pdf_bbox(bbox, page_width, page_height):
            bboxes.append(tuple(float(value) for value in bbox))
    return bboxes


def _column_index(column: str) -> int:
    value = 0
    for char in column.upper():
        if not ("A" <= char <= "Z"):
            raise ValueError(f"Invalid Excel column: {column}")
        value = value * 26 + (ord(char) - ord("A") + 1)
    return value


def _column_label(index: int) -> str:
    if index < 1:
        raise ValueError(f"Invalid Excel column index: {index}")
    chars: list[str] = []
    value = index
    while value:
        value, remainder = divmod(value - 1, 26)
        chars.append(chr(ord("A") + remainder))
    return "".join(reversed(chars))


def _parse_excel_range(range_ref: str) -> tuple[int, int, int, int]:
    clean = range_ref.strip().replace("$", "")
    match = re.fullmatch(
        r"([A-Za-z]{1,3})([1-9]\d{0,6})(?::([A-Za-z]{1,3})([1-9]\d{0,6}))?",
        clean,
    )
    if not match:
        raise HTTPException(status_code=400, detail=f"Invalid Excel range: {range_ref}")
    start_col = _column_index(match.group(1))
    start_row = int(match.group(2))
    end_col = _column_index(match.group(3) or match.group(1))
    end_row = int(match.group(4) or match.group(2))
    row_min, row_max = sorted((start_row, end_row))
    col_min, col_max = sorted((start_col, end_col))
    if (row_max - row_min + 1) * (col_max - col_min + 1) > 4000:
        raise HTTPException(status_code=400, detail="Excel source range is too large to render.")
    return row_min, row_max, col_min, col_max


def _excel_workbook_source(
    workbook_name: str,
    *,
    sheet_name: str | None = None,
    range_ref: str | None = None,
    dataset_id: str | None = None,
) -> dict[str, Any]:
    document = _dataset_document_by_name(workbook_name, dataset_id, file_types=EXCEL_FILE_TYPES)
    if document is None:
        raise HTTPException(status_code=404, detail=f"Excel workbook not found in dataset: {workbook_name}")
    doc, collection_db, active_dataset = document
    doc_id = str(doc["doc_id"])

    try:
        with sqlite3.connect(str(collection_db), timeout=5) as conn:
            conn.row_factory = sqlite3.Row
            conn.execute("PRAGMA busy_timeout=5000")
            sheets = conn.execute(
                """
                SELECT sheet_name, sheet_role, used_range, row_count, col_count,
                       non_empty_cell_count, formula_count, formula_density, summary
                FROM excel_sheets
                WHERE doc_id = ?
                ORDER BY sheet_index
                """,
                (doc_id,),
            ).fetchall()
            sheet_lookup = {str(row["sheet_name"]).lower(): row for row in sheets}

            if not sheet_name:
                return {
                    "kind": "excel",
                    "mode": "workbook",
                    "dataset_id": active_dataset,
                    "doc_id": doc_id,
                    "file_name": doc["original_filename"],
                    "stored_path": doc["stored_path"],
                    "sheets": [_excel_sheet_payload(row) for row in sheets],
                }

            sheet = sheet_lookup.get(sheet_name.lower())
            if sheet is None:
                raise HTTPException(
                    status_code=404,
                    detail=f"Sheet not found in workbook {doc['original_filename']}: {sheet_name}",
                )

            if not range_ref:
                regions = conn.execute(
                    """
                    SELECT region_type, cell_range, row_count, col_count,
                           non_empty_cell_count, formula_count, summary
                    FROM excel_regions
                    WHERE doc_id = ? AND lower(sheet_name) = lower(?)
                    ORDER BY region_index
                    LIMIT 40
                    """,
                    (doc_id, sheet["sheet_name"]),
                ).fetchall()
                return {
                    "kind": "excel",
                    "mode": "sheet",
                    "dataset_id": active_dataset,
                    "doc_id": doc_id,
                    "file_name": doc["original_filename"],
                    "stored_path": doc["stored_path"],
                    "sheet": _excel_sheet_payload(sheet),
                    "regions": [_excel_region_payload(row) for row in regions],
                }

            row_min, row_max, col_min, col_max = _parse_excel_range(range_ref)
            cells = conn.execute(
                """
                SELECT cell_ref, row_index, col_index, display_value, raw_value,
                       numeric_value, formula, cached_value, number_format,
                       row_label, col_label, period, unit, is_formula
                FROM excel_cells
                WHERE doc_id = ?
                  AND lower(sheet_name) = lower(?)
                  AND row_index BETWEEN ? AND ?
                  AND col_index BETWEEN ? AND ?
                ORDER BY row_index, col_index
                """,
                (doc_id, sheet["sheet_name"], row_min, row_max, col_min, col_max),
            ).fetchall()
    except HTTPException:
        raise
    except sqlite3.Error as exc:
        raise HTTPException(status_code=500, detail=f"Could not read Excel source: {exc}") from exc

    return {
        "kind": "excel",
        "mode": "range",
        "dataset_id": active_dataset,
        "doc_id": doc_id,
        "file_name": doc["original_filename"],
        "stored_path": doc["stored_path"],
        "sheet": _excel_sheet_payload(sheet),
        "range_ref": range_ref,
        "row_min": row_min,
        "row_max": row_max,
        "col_min": col_min,
        "col_max": col_max,
        "column_labels": [_column_label(index) for index in range(col_min, col_max + 1)],
        "cells": [_excel_cell_payload(row) for row in cells],
    }


def _excel_sheet_payload(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "sheet_name": row["sheet_name"],
        "sheet_role": row["sheet_role"],
        "used_range": row["used_range"],
        "row_count": row["row_count"],
        "col_count": row["col_count"],
        "non_empty_cell_count": row["non_empty_cell_count"],
        "formula_count": row["formula_count"],
        "formula_density": row["formula_density"],
        "summary": row["summary"],
    }


def _excel_region_payload(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "region_type": row["region_type"],
        "cell_range": row["cell_range"],
        "row_count": row["row_count"],
        "col_count": row["col_count"],
        "non_empty_cell_count": row["non_empty_cell_count"],
        "formula_count": row["formula_count"],
        "summary": row["summary"],
    }


def _excel_cell_payload(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "cell_ref": row["cell_ref"],
        "row_index": row["row_index"],
        "col_index": row["col_index"],
        "display_value": row["display_value"],
        "raw_value": row["raw_value"],
        "numeric_value": row["numeric_value"],
        "formula": row["formula"],
        "cached_value": row["cached_value"],
        "number_format": row["number_format"],
        "row_label": row["row_label"],
        "col_label": row["col_label"],
        "period": row["period"],
        "unit": row["unit"],
        "is_formula": bool(row["is_formula"]),
    }


def _render_page_image(pdf_path: Path, page_no: int, dpi: int = SOURCE_RENDER_DPI) -> tuple[Path, int, int]:
    page = _safe_page_no(page_no)
    SOURCE_RENDER_DIR.mkdir(parents=True, exist_ok=True)
    cache_key = _render_cache_key(pdf_path, page, dpi)
    prefix = SOURCE_RENDER_DIR / cache_key
    image_path = prefix.with_suffix(".png")
    if not image_path.is_file():
        command = [
            _require_tool("pdftoppm"),
            "-f",
            str(page),
            "-l",
            str(page),
            "-singlefile",
            "-png",
            "-r",
            str(dpi),
            str(pdf_path),
            str(prefix),
        ]
        result = subprocess.run(command, capture_output=True, text=True, timeout=30, check=False)
        if result.returncode != 0 or not image_path.is_file():
            detail = (result.stderr or result.stdout or "Could not render PDF page.").strip()
            raise HTTPException(status_code=400, detail=detail)
    width, height = _png_size(image_path)
    return image_path, width, height


def _extract_page_words(pdf_path: Path, page_no: int) -> tuple[float, float, list[_BboxWord]]:
    try:
        return _extract_page_words_with_pymupdf(pdf_path, page_no)
    except Exception as exc:  # noqa: BLE001
        _logger.info("PyMuPDF bbox extraction failed for %s page %s: %s", pdf_path, page_no, exc)
    return _extract_page_words_with_pdftotext(pdf_path, page_no)


def _extract_page_words_with_pymupdf(pdf_path: Path, page_no: int) -> tuple[float, float, list[_BboxWord]]:
    page = _safe_page_no(page_no)
    try:
        import fitz  # type: ignore[import-not-found]
    except Exception as exc:  # noqa: BLE001
        raise RuntimeError("PyMuPDF is not installed") from exc

    with fitz.open(str(pdf_path)) as document:
        if page > document.page_count:
            raise HTTPException(status_code=400, detail=f"PDF page out of range: {page}")
        pdf_page = document.load_page(page - 1)
        rect = pdf_page.rect
        words = [
            _BboxWord(
                text=str(item[4]).strip(),
                x_min=float(item[0]),
                y_min=float(item[1]),
                x_max=float(item[2]),
                y_max=float(item[3]),
            )
            for item in pdf_page.get_text("words", sort=True)
            if len(item) >= 5 and str(item[4]).strip()
        ]
    return float(rect.width), float(rect.height), words


def _extract_page_words_with_pdftotext(pdf_path: Path, page_no: int) -> tuple[float, float, list[_BboxWord]]:
    page = _safe_page_no(page_no)
    command = [
        _require_tool("pdftotext"),
        "-f",
        str(page),
        "-l",
        str(page),
        "-bbox",
        str(pdf_path),
        "-",
    ]
    result = subprocess.run(command, capture_output=True, text=True, timeout=30, check=False)
    if result.returncode != 0:
        detail = (result.stderr or result.stdout or "Could not extract PDF page text.").strip()
        raise HTTPException(status_code=400, detail=detail)
    parser = _PdfBboxParser()
    parser.feed(result.stdout)
    return parser.page_width, parser.page_height, parser.words


def _normalize_token(value: str) -> str:
    return re.sub(r"[^a-z0-9\u4e00-\u9fff]+", "", unicodedata.normalize("NFKC", value).lower())


def _normalize_match_text(value: str) -> str:
    normalized = unicodedata.normalize("NFKC", value).lower()
    return re.sub(r"[^a-z0-9\u4e00-\u9fff%]+", "", normalized)


_TOKEN_RE = re.compile(r"[A-Za-z][A-Za-z0-9&./'-]*|\d+(?:\.\d+)?%?")
_CJK_RUN_RE = re.compile(r"[\u4e00-\u9fff]{2,}")
_SPEAKER_HEADER_RE = re.compile(r"^\s*发言人\s*(\d+)\s+\d{1,2}:\d{2}:\d{2}\s*$")
_STOP_TOKENS = {
    "and",
    "the",
    "for",
    "from",
    "with",
    "that",
    "this",
    "into",
    "about",
    "current",
    "core",
    "risk",
    "risks",
    "这个",
    "一个",
    "一些",
    "就是",
    "其实",
    "进行",
    "相关",
    "影响",
    "评估",
}
_QUERY_EXPANSIONS = {
    "汽车": "automotive vehicle vehicles sales revenue",
    "销售": "sales revenue",
    "收入": "revenue revenues sales",
    "能源": "energy generation storage",
    "服务": "services other",
    "多元": "diversify diversified energy services",
    "软件": "software",
    "人工智能": "artificial intelligence AI",
    "自动驾驶": "FSD Robotaxi autonomous driving",
    "关税": "tariff tariffs duties",
    "供应链": "supply chain suppliers",
    "成本": "cost costs structure",
    "贸易": "trade policy tariffs",
    "现金流": "cash flow liquidity",
    "资本开支": "capital expenditures capex",
}


def _query_tokens(quote: str | None) -> list[str]:
    if not quote:
        return []
    expanded = unicodedata.normalize("NFKC", quote)
    expanded = re.sub(r"https?://\S+", " ", expanded)
    expanded = re.sub(r"[`*_#>\[\]()]|（\s*[-–—]?\s*\d{1,4}\s*）", " ", expanded)
    expanded = re.sub(r"\bp\.\s*\d{1,4}\b|\bpara\.?\s*\d+\b", " ", expanded, flags=re.I)
    for needle, addition in _QUERY_EXPANSIONS.items():
        if needle in quote:
            expanded += f" {addition}"

    tokens: list[str] = []
    seen: set[str] = set()
    for run in _CJK_RUN_RE.findall(expanded):
        normalized_run = _normalize_token(run)
        if len(normalized_run) < 2:
            continue
        if 2 <= len(normalized_run) <= 10 and normalized_run not in seen:
            seen.add(normalized_run)
            tokens.append(normalized_run)
        for size in (3, 2):
            if len(normalized_run) < size:
                continue
            for index in range(0, len(normalized_run) - size + 1):
                token = normalized_run[index : index + size]
                if token in _STOP_TOKENS or token in seen:
                    continue
                seen.add(token)
                tokens.append(token)
                if len(tokens) >= 48:
                    break
            if len(tokens) >= 48:
                break
        if len(tokens) >= 48:
            break

    for raw in _TOKEN_RE.findall(expanded):
        token = _normalize_token(raw)
        if token.isdigit():
            continue
        if len(token) < 2 or token in _STOP_TOKENS or token in seen:
            continue
        seen.add(token)
        tokens.append(token)
        if len(tokens) >= 64:
            break
    return tokens


def _group_words_into_lines(words: list[_BboxWord]) -> list[_BboxLine]:
    sorted_words = sorted(words, key=lambda word: ((word.y_min + word.y_max) / 2, word.x_min))
    grouped: list[list[_BboxWord]] = []
    centers: list[float] = []
    for word in sorted_words:
        center = (word.y_min + word.y_max) / 2
        if grouped and abs(center - centers[-1]) <= 3.5:
            grouped[-1].append(word)
            centers[-1] = (centers[-1] * (len(grouped[-1]) - 1) + center) / len(grouped[-1])
        else:
            grouped.append([word])
            centers.append(center)

    lines: list[_BboxLine] = []
    for line_words in grouped:
        words_by_x = sorted(line_words, key=lambda word: word.x_min)
        lines.append(
            _BboxLine(
                text=" ".join(word.text for word in words_by_x),
                x_min=min(word.x_min for word in words_by_x),
                y_min=min(word.y_min for word in words_by_x),
                x_max=max(word.x_max for word in words_by_x),
                y_max=max(word.y_max for word in words_by_x),
            )
        )
    return lines


def _score_text(text: str, tokens: list[str]) -> float:
    normalized = _normalize_match_text(text)
    score = 0.0
    for token in tokens:
        if token and token in normalized:
            if re.search(r"[\u4e00-\u9fff]", token):
                score += max(2.0, len(token) * 1.25)
            elif token.isdigit():
                score += 0.25
            else:
                score += 2.0
    return score


def _is_speaker_header(text: str) -> bool:
    return bool(_SPEAKER_HEADER_RE.match(unicodedata.normalize("NFKC", text)))


def _speaker_id(text: str) -> str | None:
    match = _SPEAKER_HEADER_RE.match(unicodedata.normalize("NFKC", text))
    return match.group(1) if match else None


def _is_footer_line(text: str) -> bool:
    normalized = unicodedata.normalize("NFKC", text)
    return bool(re.search(r"知识星球|前沿信息收录|VX[:：]", normalized, flags=re.I))


def _trim_trailing_footer_lines(lines: list[_BboxLine], start: int, end: int) -> int:
    while end > start and _is_footer_line(lines[end - 1].text):
        end -= 1
    return end


def _speaker_blocks(lines: list[_BboxLine]) -> list[_LineBlock]:
    headers = [(index, _speaker_id(line.text)) for index, line in enumerate(lines)]
    headers = [(index, speaker) for index, speaker in headers if speaker is not None]
    blocks: list[_LineBlock] = []
    for offset, (header_index, speaker) in enumerate(headers):
        next_header = headers[offset + 1][0] if offset + 1 < len(headers) else len(lines)
        block_end = _trim_trailing_footer_lines(lines, header_index, next_header)
        if block_end > header_index + 1:
            blocks.append(_LineBlock(header_index, block_end, speaker))
    return blocks


def _has_question_cue(text: str) -> bool:
    normalized = unicodedata.normalize("NFKC", text)
    return bool(re.search(r"请教|问一下|想请您|能不能|问题", normalized))


def _expand_span_to_semantic_block(
    lines: list[_BboxLine],
    start: int,
    end: int,
) -> tuple[int, int]:
    speaker_headers = [index for index, line in enumerate(lines) if _is_speaker_header(line.text)]
    if not speaker_headers:
        return start, end

    expanded_start = start
    for header_index in reversed(speaker_headers):
        if header_index <= start:
            expanded_start = header_index
            break

    expanded_end = end
    last_line = max(start, end - 1)
    for header_index in speaker_headers:
        if header_index > last_line:
            expanded_end = header_index
            break
    else:
        expanded_end = end

    if expanded_end <= expanded_start:
        return start, end
    expanded_end = _trim_trailing_footer_lines(lines, expanded_start, expanded_end)

    blocks = _speaker_blocks(lines)
    current_block_index = next(
        (
            index
            for index, block in enumerate(blocks)
            if block.start <= expanded_start < block.end
        ),
        None,
    )
    if current_block_index is None:
        return expanded_start, expanded_end

    current_block = blocks[current_block_index]
    current_text = " ".join(line.text for line in lines[current_block.start : current_block.end])
    next_block_index = current_block_index + 1
    if (
        _has_question_cue(current_text)
        and next_block_index < len(blocks)
        and blocks[next_block_index].speaker_id != current_block.speaker_id
    ):
        answer_speaker = blocks[next_block_index].speaker_id
        while next_block_index < len(blocks) and blocks[next_block_index].speaker_id == answer_speaker:
            expanded_end = blocks[next_block_index].end
            next_block_index += 1
    return expanded_start, expanded_end


def _best_highlight_rects(words: list[_BboxWord], quote: str | None) -> list[tuple[float, float, float, float]]:
    tokens = _query_tokens(quote)
    if not tokens:
        return []
    lines = _group_words_into_lines(words)
    if not lines:
        return []

    best_score = 0.0
    best_density = 0.0
    best_span: tuple[int, int] | None = None
    max_window = min(8, len(lines))
    for start in range(len(lines)):
        for window_size in range(1, max_window + 1):
            end = start + window_size
            if end > len(lines):
                break
            window_text = " ".join(line.text for line in lines[start:end])
            score = _score_text(window_text, tokens)
            density = score / window_size if window_size else score
            if score > best_score or (score == best_score and density > best_density):
                best_score = score
                best_density = density
                best_span = (start, end)

    if best_span is None or best_score < 4.0:
        return []

    start, end = _expand_span_to_semantic_block(lines, *best_span)
    span_lines = lines[start:end]
    padding_x = 4.0
    padding_y = 2.0
    return [
        (
            max(0.0, min(line.x_min for line in span_lines) - padding_x),
            max(0.0, min(line.y_min for line in span_lines) - padding_y),
            max(line.x_max for line in span_lines) + padding_x,
            max(line.y_max for line in span_lines) + padding_y,
        )
    ]


def _rect_payload(
    rect: tuple[float, float, float, float],
    *,
    page_width: float,
    page_height: float,
    image_width: int,
    image_height: int,
) -> dict[str, float]:
    x_min, y_min, x_max, y_max = rect
    scale_x = image_width / page_width if page_width else SOURCE_RENDER_DPI / 72
    scale_y = image_height / page_height if page_height else SOURCE_RENDER_DPI / 72
    x = max(0.0, x_min * scale_x)
    y = max(0.0, y_min * scale_y)
    width = max(1.0, (x_max - x_min) * scale_x)
    height = max(1.0, (y_max - y_min) * scale_y)
    return {
        "x": x,
        "y": y,
        "width": width,
        "height": height,
        "x_pct": x / image_width * 100 if image_width else 0.0,
        "y_pct": y / image_height * 100 if image_height else 0.0,
        "width_pct": width / image_width * 100 if image_width else 0.0,
        "height_pct": height / image_height * 100 if image_height else 0.0,
    }


class _PrivateFundPdfWorkspace:
    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._llm_client, self._llm_summary = _load_chat_client()
        self.demo = PdfResearchDemo(llm_client=self._llm_client)
        self.document = None
        self.company_name = "阳光电源"
        self.ticker = "300274"
        self.memo_pdfs: dict[str, Path] = {}

    def status(self) -> dict[str, Any]:
        with self._lock:
            return {
                "status": "ready" if self.document else "empty",
                "company_name": self.company_name,
                "ticker": self.ticker,
                "active_document": _jsonable(self.document) if self.document else None,
                "evidence_count": len(self.demo.store.evidence),
                "citation_count": len(self.demo.store.citations),
                "memo_pdf_count": len(self.memo_pdfs),
                "llm": self._llm_summary,
                "default_pdf_path": str(DEFAULT_PDF_PATH),
            }

    def register_pdf(self, request: RegisterPdfRequest) -> dict[str, Any]:
        pdf_path = Path(request.pdf_path).expanduser().resolve()
        if not pdf_path.is_file():
            raise HTTPException(status_code=404, detail=f"PDF not found: {pdf_path}")
        if pdf_path.suffix.lower() != ".pdf":
            raise HTTPException(status_code=400, detail="The selected file must be a PDF.")

        company_name = (request.company_name or "阳光电源").strip() or "阳光电源"
        ticker = (request.ticker or "300274").strip() or "300274"

        with self._lock:
            self.demo = PdfResearchDemo(llm_client=self._llm_client)
            try:
                self.document = self.demo.ingest_pdf(pdf_path, None)
            except Exception as exc:  # noqa: BLE001
                raise HTTPException(status_code=400, detail=str(exc)) from exc
            self.company_name = company_name
            self.ticker = ticker
            self.memo_pdfs = {}
            return self.status()

    def ask(self, request: AskPdfRequest) -> dict[str, Any]:
        question = request.question.strip()
        if not question:
            raise HTTPException(status_code=400, detail="Question is required.")
        if self.document is None:
            raise HTTPException(status_code=409, detail="Register a PDF before asking questions.")

        top_k = max(1, min(int(request.top_k or 3), 10))
        with self._lock:
            result = self.demo.answer_question(question, top_k=top_k)
            return {
                "question": result.question,
                "answer": result.answer,
                "needs_review": result.needs_review,
                "llm_used": result.llm_used,
                "llm_error": result.llm_error,
                "citations": _jsonable(result.citations),
                "traces": _trace_payload(self.demo, result.citations),
            }

    def trace(self, citation_id: str) -> dict[str, Any]:
        with self._lock:
            trace = self.demo.trace_citation(citation_id)
        if not trace:
            raise HTTPException(status_code=404, detail="Citation not found.")
        return _jsonable(trace)

    def generate_memo(self, request: MemoRequest | None = None) -> dict[str, Any]:
        if self.document is None:
            raise HTTPException(status_code=409, detail="Register a PDF before generating a memo.")

        company_name = (request.company_name if request and request.company_name else self.company_name).strip()
        ticker = (request.ticker if request and request.ticker else self.ticker).strip()
        if not company_name or not ticker:
            raise HTTPException(status_code=400, detail="Company name and ticker are required.")

        with self._lock:
            memo = self.demo.generate_memo(company_name, ticker)
            pdf_path = render_memo_pdf(memo)
            self.memo_pdfs[memo.memo_id] = pdf_path
            return self._memo_payload(memo, pdf_path)

    def memo_pdf_path(self, memo_id: str) -> Path:
        with self._lock:
            pdf_path = self.memo_pdfs.get(memo_id)
        if pdf_path is None or not pdf_path.is_file():
            raise HTTPException(status_code=404, detail="Memo PDF not found.")
        return pdf_path

    def source_pdf_path(
        self,
        pdf_path: str | None = None,
        *,
        pdf_name: str | None = None,
        evidence_id: str | None = None,
        dataset_id: str | None = None,
        page_no: int | None = None,
        quote: str | None = None,
    ) -> Path:
        if pdf_path:
            resolved = Path(pdf_path).expanduser().resolve()
        elif pdf_name:
            resolved = _dataset_pdf_path_by_name(pdf_name, dataset_id=dataset_id)
            if resolved is None:
                raise HTTPException(status_code=404, detail=f"PDF not found in dataset: {pdf_name}")
        elif evidence_id:
            resolved = _dataset_pdf_path_by_evidence_id(evidence_id, dataset_id=dataset_id)
            if resolved is None:
                raise HTTPException(status_code=404, detail=f"PDF source not found for evidence: {evidence_id}")
        else:
            with self._lock:
                registered_pdf = (
                    Path(self.document.file_path).expanduser().resolve()
                    if self.document
                    else None
                )
            resolved = None
            if page_no:
                resolved = _dataset_pdf_path_by_page_quote(page_no, quote=quote, dataset_id=dataset_id)
            if resolved is None:
                resolved = registered_pdf
            if resolved is None:
                raise HTTPException(
                    status_code=404,
                    detail="PDF source not found. Provide pdf_name or use an active private-fund dataset.",
                )
        if not resolved.is_file():
            raise HTTPException(status_code=404, detail=f"PDF not found: {resolved}")
        if resolved.suffix.lower() != ".pdf":
            raise HTTPException(status_code=400, detail="The selected file must be a PDF.")
        return resolved

    def _memo_payload(self, memo: MemoDraft, pdf_path: Path) -> dict[str, Any]:
        return {
            "memo_id": memo.memo_id,
            "title": memo.title,
            "markdown": memo.to_markdown(),
            "sections": _jsonable(memo.sections),
            "llm_used": memo.llm_used,
            "llm_error": memo.llm_error,
            "citations": _jsonable(memo.citations),
            "traces": _trace_payload(self.demo, memo.citations),
            "pdf_path": str(pdf_path),
            "pdf_url": f"/v1/private-fund/memo/{memo.memo_id}/pdf",
        }


def create_private_fund_pdf_router(workspace: _PrivateFundPdfWorkspace | None = None) -> APIRouter:
    """Create local private-fund PDF endpoints mounted under ``/v1``."""
    router = APIRouter()
    active_workspace = workspace or _PrivateFundPdfWorkspace()

    @router.get("/private-fund/projects")
    def list_projects() -> dict[str, Any]:
        return {
            "projects": _list_projects_payload(),
            "labels": {
                "dataset_id": PRIVATE_FUND_PROJECT_LABEL_ID,
                "dataset_name": PRIVATE_FUND_PROJECT_LABEL_NAME,
            },
        }

    @router.post("/private-fund/projects")
    def create_project(request: CreateProjectRequest) -> dict[str, Any]:
        project = _create_project_row(request)
        return {"project": project}

    @router.get("/private-fund/projects/{dataset_id}")
    def get_project(dataset_id: str) -> dict[str, Any]:
        row = _require_project_row(dataset_id)
        return {"project": _project_payload(row), "files": _project_files_payload(dataset_id)}

    @router.post("/private-fund/projects/{dataset_id}/activate")
    def activate_project(dataset_id: str) -> dict[str, Any]:
        return _set_active_dataset(dataset_id)

    @router.post("/private-fund/projects/{dataset_id}/files")
    def upload_project_files(
        dataset_id: str,
        files: list[UploadFile] = FastApiFile(...),
    ) -> dict[str, Any]:
        if not files:
            raise HTTPException(status_code=400, detail="At least one file is required.")
        return _save_uploaded_project_files(dataset_id, files)

    @router.delete("/private-fund/projects/{dataset_id}/files/{file_name}")
    def delete_project_file(dataset_id: str, file_name: str) -> dict[str, Any]:
        _require_project_row(dataset_id)
        safe_name = Path(file_name).name
        candidates = [
            _project_uploads_dir(dataset_id) / safe_name,
            _project_dataset_root(dataset_id) / "raw" / safe_name,
        ]
        deleted = False
        for path in candidates:
            if path.exists() and path.is_file():
                path.unlink()
                deleted = True
        if not deleted:
            raise HTTPException(status_code=404, detail=f"File not found: {safe_name}")
        uploads_dir = _project_uploads_dir(dataset_id)
        count = len(_supported_files_in(uploads_dir)) if uploads_dir.exists() else len(_supported_files_in(_project_dataset_root(dataset_id) / "raw"))
        with _connect_global_registry() as conn:
            conn.execute(
                "UPDATE datasets SET file_count = ?, updated_at = ? WHERE dataset_id = ?",
                (count, _now_iso(), dataset_id),
            )
            conn.commit()
        row = _require_project_row(dataset_id)
        return {"project": _project_payload(row), "files": _project_files_payload(dataset_id)}

    @router.post("/private-fund/projects/{dataset_id}/pipeline")
    def run_project_pipeline(
        dataset_id: str,
        background_tasks: BackgroundTasks,
        request: RunProjectPipelineRequest | None = None,
    ) -> dict[str, Any]:
        row = _require_project_row(dataset_id)
        uploads_dir = _seed_uploads_from_raw(dataset_id)
        if not _supported_files_in(uploads_dir):
            raise HTTPException(status_code=400, detail="Upload at least one PDF/XLSX/XLSM file before running pipeline.")
        job_id = hashlib.sha256(f"{dataset_id}\0{_now_iso()}".encode("utf-8")).hexdigest()[:16]
        payload = {
            "dataset_id": dataset_id,
            "dataset_name": row["name"],
            "company_name": row["company_name"],
            "company_ticker": row["company_ticker"],
            "directory_path": str(uploads_dir),
            "workspace_root": str(_dataset_workspace_root()),
            "recursive": request.recursive if request else True,
            "reset": request.reset if request else True,
        }
        with _PRIVATE_FUND_PIPELINE_JOBS_LOCK:
            _PRIVATE_FUND_PIPELINE_JOBS[job_id] = {
                "job_id": job_id,
                "dataset_id": dataset_id,
                "status": "queued",
                "created_at": _now_iso(),
                "directory_path": str(uploads_dir),
                "workspace_root": str(_dataset_workspace_root()),
            }
        background_tasks.add_task(_project_pipeline_worker, job_id, payload)
        return {"job": dict(_PRIVATE_FUND_PIPELINE_JOBS[job_id])}

    @router.get("/private-fund/pipeline-jobs/{job_id}")
    def get_project_pipeline_job(job_id: str) -> dict[str, Any]:
        with _PRIVATE_FUND_PIPELINE_JOBS_LOCK:
            job = _PRIVATE_FUND_PIPELINE_JOBS.get(job_id)
        if not job:
            raise HTTPException(status_code=404, detail="Unknown private-fund pipeline job.")
        return {"job": dict(job)}

    @router.get("/private-fund/pdf/status")
    def status() -> dict[str, Any]:
        return active_workspace.status()

    @router.post("/private-fund/pdf/register")
    def register_pdf(request: RegisterPdfRequest) -> dict[str, Any]:
        return active_workspace.register_pdf(request)

    @router.post("/private-fund/pdf/ask")
    def ask_pdf(request: AskPdfRequest) -> dict[str, Any]:
        return active_workspace.ask(request)

    @router.get("/private-fund/citations/{citation_id}")
    def trace_citation(citation_id: str) -> dict[str, Any]:
        return active_workspace.trace(citation_id)

    @router.post("/private-fund/memo/generate")
    def generate_memo(request: MemoRequest | None = None) -> dict[str, Any]:
        return active_workspace.generate_memo(request)

    @router.get("/private-fund/memo/{memo_id}/pdf")
    def memo_pdf(memo_id: str) -> FileResponse:
        pdf_path = active_workspace.memo_pdf_path(memo_id)
        return FileResponse(pdf_path, media_type="application/pdf", filename=pdf_path.name)

    @router.get("/private-fund/dataset/memo/file")
    def dataset_memo_file(path: str = Query(..., max_length=4096)) -> FileResponse:
        artifact_path = _dataset_memo_artifact_path(path)
        media_type = (
            "application/pdf"
            if artifact_path.suffix.lower() == ".pdf"
            else "text/html; charset=utf-8"
        )
        return FileResponse(artifact_path, media_type=media_type, filename=artifact_path.name)

    @router.get("/private-fund/pdf/source/page")
    def source_page(
        page_no: int = Query(..., ge=1),
        quote: str | None = Query(default=None, max_length=1200),
        pdf_path: str | None = Query(default=None),
        pdf_name: str | None = Query(default=None),
        evidence_id: str | None = Query(default=None),
        dataset_id: str | None = Query(default=None),
    ) -> dict[str, Any]:
        resolved_pdf_path = active_workspace.source_pdf_path(
            pdf_path,
            pdf_name=pdf_name,
            evidence_id=evidence_id,
            dataset_id=dataset_id,
            page_no=page_no,
            quote=quote,
        )
        image_path, image_width, image_height = _render_page_image(resolved_pdf_path, page_no)
        highlight_error = None
        try:
            page_width, page_height, words = _extract_page_words(resolved_pdf_path, page_no)
        except HTTPException as exc:
            page_width, page_height, words = 0.0, 0.0, []
            highlight_error = str(exc.detail)
        dataset_chunk = _best_dataset_pdf_chunk(
            resolved_pdf_path,
            page_no,
            quote=quote,
            evidence_id=evidence_id,
            dataset_id=dataset_id,
        )
        highlight_query = quote
        highlight_mode = "quote"
        if dataset_chunk and dataset_chunk.content_type == "pdf_speaker_turn":
            highlight_query = dataset_chunk.content
            highlight_mode = "dataset_chunk"
        rects = []
        if dataset_chunk and _is_precise_pdf_bbox(dataset_chunk.bbox, page_width, page_height):
            rects = [tuple(float(value) for value in dataset_chunk.bbox)]
            if not evidence_id:
                rects.extend(
                    _following_answer_chunk_bboxes(
                        dataset_chunk,
                        page_no,
                        page_width=page_width,
                        page_height=page_height,
                        dataset_id=dataset_id,
                    )
                )
            highlight_mode = "dataset_bbox"
        if not rects:
            rects = _best_highlight_rects(words, highlight_query)
        highlights = [
            _rect_payload(
                rect,
                page_width=page_width,
                page_height=page_height,
                image_width=image_width,
                image_height=image_height,
            )
            for rect in rects
        ]
        image_url = "/v1/private-fund/pdf/source/page-image?" + urlencode(
            {"page_no": page_no, "pdf_path": str(resolved_pdf_path)}
        )
        return {
            "page_no": page_no,
            "pdf_path": str(resolved_pdf_path),
            "file_name": resolved_pdf_path.name,
            "image_url": image_url,
            "image_width": image_width,
            "image_height": image_height,
            "page_width": page_width,
            "page_height": page_height,
            "highlights": highlights,
            "matched": bool(highlights),
            "highlight_error": highlight_error,
            "highlight_source": {
                "mode": highlight_mode,
                "evidence_id": dataset_chunk.evidence_id if dataset_chunk else None,
                "content_type": dataset_chunk.content_type if dataset_chunk else None,
                "citation": dataset_chunk.citation if dataset_chunk else None,
                "match_score": dataset_chunk.match_score if dataset_chunk else None,
            },
        }

    @router.get("/private-fund/pdf/source/page-image")
    def source_page_image(
        page_no: int = Query(..., ge=1),
        pdf_path: str | None = Query(default=None),
        pdf_name: str | None = Query(default=None),
        evidence_id: str | None = Query(default=None),
        dataset_id: str | None = Query(default=None),
    ) -> FileResponse:
        resolved_pdf_path = active_workspace.source_pdf_path(
            pdf_path,
            pdf_name=pdf_name,
            evidence_id=evidence_id,
            dataset_id=dataset_id,
            page_no=page_no,
        )
        image_path, _, _ = _render_page_image(resolved_pdf_path, page_no)
        return FileResponse(
            image_path,
            media_type="image/png",
            filename=f"{resolved_pdf_path.stem}-p{page_no}.png",
        )

    @router.get("/private-fund/excel/source/range")
    def excel_source_range(
        workbook_name: str = Query(..., min_length=1, max_length=240),
        sheet_name: str | None = Query(default=None, max_length=120),
        range_ref: str | None = Query(default=None, max_length=80),
        dataset_id: str | None = Query(default=None),
    ) -> dict[str, Any]:
        return _excel_workbook_source(
            workbook_name,
            sheet_name=sheet_name,
            range_ref=range_ref,
            dataset_id=dataset_id,
        )

    return router
