#!/usr/bin/env python3
"""Private-fund research directory ingestion pipeline.

This pipeline treats a local directory as one research dataset. It stores a
unified evidence skeleton in SQLite while keeping Excel-specific structure in
dedicated fact tables:

    workspace_root/
      datasets.sqlite3
      <dataset_id>/
        raw/
        meta/collection.sqlite3

PDF files are parsed by text extraction first. OCR/MinerU is intentionally not
used here because the private-fund workflow needs a fast direct-text path and
can fall back to the legacy PDF pipeline only for scanned or complex-layout
files.
"""

from __future__ import annotations

import argparse
import bisect
import hashlib
import json
import os
import re
import shutil
import sqlite3
import unicodedata
from dataclasses import asdict, dataclass, field
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Optional


SUPPORTED_EXTENSIONS = {".pdf", ".xlsx", ".xlsm"}
DEFAULT_MAX_PDF_CHARS = 2200
DEFAULT_MAX_REGION_LABELS = 30


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8", errors="replace")).hexdigest()


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def json_safe(value: Any) -> Any:
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    if isinstance(value, Path):
        return str(value)
    if isinstance(value, dict):
        return {str(k): json_safe(v) for k, v in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [json_safe(v) for v in value]
    return value


def dumps_json(value: Any) -> str:
    return json.dumps(json_safe(value), ensure_ascii=False, sort_keys=True)


def normalize_text(value: Any) -> str:
    text = "" if value is None else str(value)
    text = unicodedata.normalize("NFKC", text)
    return re.sub(r"\s+", " ", text).strip()


def cell_display(value: Any, max_len: int = 160) -> str:
    if value is None:
        return ""
    if isinstance(value, (datetime, date)):
        text = value.isoformat()
    else:
        text = normalize_text(value)
    if len(text) > max_len:
        return text[: max_len - 1] + "..."
    return text


def safe_slug(value: str, fallback: str = "dataset") -> str:
    value = unicodedata.normalize("NFKC", value or "")
    value = re.sub(r"[^\w\u4e00-\u9fff.-]+", "_", value, flags=re.UNICODE)
    value = value.strip("._-")
    return value or fallback


def default_workspace_root() -> Path:
    override = os.environ.get("PRIVATE_FUND_DATASET_WORKSPACE")
    if override:
        return Path(override).expanduser().resolve()
    return Path.cwd().resolve() / "output" / "private_fund_datasets"


@dataclass
class IngestOptions:
    source_dir: Path
    workspace_root: Path
    dataset_id: str
    dataset_name: str
    company_name: str = ""
    company_ticker: str = ""
    recursive: bool = True
    reset: bool = False
    job_id: Optional[str] = None


@dataclass
class DocumentIngestResult:
    doc_id: str
    filename: str
    file_type: str
    status: str
    chunk_count: int = 0
    location_count: int = 0
    pdf_page_count: int = 0
    excel_sheet_count: int = 0
    excel_region_count: int = 0
    excel_cell_count: int = 0
    metric_fact_count: int = 0
    error_message: Optional[str] = None


@dataclass
class IngestResult:
    job_id: str
    dataset_id: str
    dataset_name: str
    source_dir: str
    workspace_root: str
    dataset_root: str
    collection_db_path: str
    global_db_path: str
    status: str
    file_count: int
    documents: list[DocumentIngestResult] = field(default_factory=list)
    started_at: str = ""
    finished_at: str = ""
    message: str = ""


def connect_sqlite(path: Path) -> sqlite3.Connection:
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(path), timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def ensure_global_schema(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS datasets (
            dataset_id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            status TEXT NOT NULL,
            source_dir TEXT,
            dataset_root TEXT NOT NULL,
            company_name TEXT,
            company_ticker TEXT,
            file_count INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            metadata_json TEXT
        );

        CREATE TABLE IF NOT EXISTS dataset_state (
            id INTEGER PRIMARY KEY CHECK(id = 1),
            active_dataset_id TEXT,
            updated_at TEXT NOT NULL
        );
        """
    )
    conn.execute(
        "INSERT OR IGNORE INTO dataset_state (id, active_dataset_id, updated_at) VALUES (1, NULL, ?)",
        (now_iso(),),
    )
    conn.commit()


def ensure_collection_schema(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS documents (
            doc_id TEXT PRIMARY KEY,
            dataset_id TEXT NOT NULL,
            title TEXT NOT NULL,
            original_filename TEXT NOT NULL,
            stored_path TEXT NOT NULL,
            file_type TEXT NOT NULL,
            doc_type TEXT,
            source_type TEXT,
            source_name TEXT,
            company_name TEXT,
            company_ticker TEXT,
            document_date TEXT,
            checksum TEXT NOT NULL,
            file_size INTEGER NOT NULL,
            status TEXT NOT NULL,
            chunk_count INTEGER NOT NULL DEFAULT 0,
            error_message TEXT,
            metadata_json TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            deleted_at TEXT
        );

        CREATE TABLE IF NOT EXISTS chunks (
            chunk_id TEXT PRIMARY KEY,
            dataset_id TEXT NOT NULL,
            doc_id TEXT NOT NULL,
            chunk_index INTEGER NOT NULL,
            content TEXT NOT NULL,
            content_type TEXT NOT NULL,
            title_path TEXT,
            summary TEXT,
            token_count INTEGER,
            content_hash TEXT NOT NULL,
            prev_chunk_id TEXT,
            next_chunk_id TEXT,
            source_ref TEXT,
            metadata_json TEXT,
            created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS chunk_locations (
            location_id TEXT PRIMARY KEY,
            chunk_id TEXT NOT NULL,
            doc_id TEXT NOT NULL,
            location_index INTEGER NOT NULL DEFAULT 0,
            page_start INTEGER,
            page_end INTEGER,
            page_numbers_json TEXT,
            slide_start INTEGER,
            slide_end INTEGER,
            sheet_name TEXT,
            cell_range TEXT,
            heading_path TEXT,
            bbox_json TEXT,
            source_refs_json TEXT,
            display_text TEXT NOT NULL,
            metadata_json TEXT
        );

        CREATE TABLE IF NOT EXISTS index_registry (
            index_id TEXT PRIMARY KEY,
            dataset_id TEXT NOT NULL,
            index_type TEXT NOT NULL,
            collection_name TEXT,
            index_path TEXT NOT NULL,
            source_doc_ids_json TEXT,
            source_chunk_count INTEGER,
            status TEXT NOT NULL,
            built_at TEXT,
            error_message TEXT,
            metadata_json TEXT
        );

        CREATE TABLE IF NOT EXISTS ingest_jobs (
            job_id TEXT PRIMARY KEY,
            dataset_id TEXT NOT NULL,
            job_type TEXT NOT NULL,
            status TEXT NOT NULL,
            doc_ids_json TEXT,
            file_count INTEGER NOT NULL DEFAULT 0,
            log_path TEXT,
            message TEXT,
            returncode INTEGER,
            created_at TEXT NOT NULL,
            started_at TEXT,
            finished_at TEXT,
            metadata_json TEXT
        );

        CREATE TABLE IF NOT EXISTS pdf_pages (
            page_id TEXT PRIMARY KEY,
            dataset_id TEXT NOT NULL,
            doc_id TEXT NOT NULL,
            page_number INTEGER NOT NULL,
            text TEXT NOT NULL,
            char_count INTEGER NOT NULL,
            word_count INTEGER NOT NULL,
            extraction_method TEXT NOT NULL,
            bbox_json TEXT,
            metadata_json TEXT
        );

        CREATE TABLE IF NOT EXISTS excel_workbooks (
            workbook_id TEXT PRIMARY KEY,
            dataset_id TEXT NOT NULL,
            doc_id TEXT NOT NULL,
            workbook_type TEXT NOT NULL,
            sheet_count INTEGER NOT NULL,
            visible_sheet_count INTEGER NOT NULL,
            formula_count INTEGER NOT NULL,
            non_empty_cell_count INTEGER NOT NULL,
            formula_density REAL NOT NULL,
            metadata_json TEXT
        );

        CREATE TABLE IF NOT EXISTS excel_sheets (
            sheet_id TEXT PRIMARY KEY,
            dataset_id TEXT NOT NULL,
            doc_id TEXT NOT NULL,
            sheet_index INTEGER NOT NULL,
            sheet_name TEXT NOT NULL,
            sheet_role TEXT NOT NULL,
            sheet_state TEXT,
            used_range TEXT,
            row_count INTEGER NOT NULL,
            col_count INTEGER NOT NULL,
            non_empty_cell_count INTEGER NOT NULL,
            formula_count INTEGER NOT NULL,
            formula_density REAL NOT NULL,
            summary TEXT,
            header_json TEXT,
            metadata_json TEXT
        );

        CREATE TABLE IF NOT EXISTS excel_regions (
            region_id TEXT PRIMARY KEY,
            dataset_id TEXT NOT NULL,
            doc_id TEXT NOT NULL,
            sheet_name TEXT NOT NULL,
            region_index INTEGER NOT NULL,
            region_type TEXT NOT NULL,
            cell_range TEXT NOT NULL,
            row_count INTEGER NOT NULL,
            col_count INTEGER NOT NULL,
            non_empty_cell_count INTEGER NOT NULL,
            formula_count INTEGER NOT NULL,
            formula_density REAL NOT NULL,
            summary TEXT,
            header_json TEXT,
            metadata_json TEXT
        );

        CREATE TABLE IF NOT EXISTS excel_cells (
            cell_id TEXT PRIMARY KEY,
            dataset_id TEXT NOT NULL,
            doc_id TEXT NOT NULL,
            sheet_name TEXT NOT NULL,
            cell_ref TEXT NOT NULL,
            row_index INTEGER NOT NULL,
            col_index INTEGER NOT NULL,
            value_type TEXT NOT NULL,
            display_value TEXT,
            raw_value TEXT,
            numeric_value REAL,
            formula TEXT,
            cached_value TEXT,
            number_format TEXT,
            row_label TEXT,
            col_label TEXT,
            period TEXT,
            unit TEXT,
            is_formula INTEGER NOT NULL DEFAULT 0,
            metadata_json TEXT
        );

        CREATE TABLE IF NOT EXISTS metric_facts (
            fact_id TEXT PRIMARY KEY,
            dataset_id TEXT NOT NULL,
            doc_id TEXT NOT NULL,
            metric_name TEXT NOT NULL,
            metric_alias TEXT,
            period TEXT,
            value_text TEXT,
            value_numeric REAL,
            unit TEXT,
            sheet_name TEXT NOT NULL,
            cell_ref TEXT NOT NULL,
            source_range TEXT,
            formula TEXT,
            confidence REAL NOT NULL DEFAULT 0.5,
            metadata_json TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_documents_dataset_status ON documents(dataset_id, status);
        CREATE INDEX IF NOT EXISTS idx_chunks_doc_index ON chunks(doc_id, chunk_index);
        CREATE INDEX IF NOT EXISTS idx_locations_chunk ON chunk_locations(chunk_id);
        CREATE INDEX IF NOT EXISTS idx_pdf_pages_doc_page ON pdf_pages(doc_id, page_number);
        CREATE INDEX IF NOT EXISTS idx_excel_sheets_doc ON excel_sheets(doc_id, sheet_name);
        CREATE INDEX IF NOT EXISTS idx_excel_regions_doc ON excel_regions(doc_id, sheet_name, cell_range);
        CREATE INDEX IF NOT EXISTS idx_excel_cells_doc_sheet ON excel_cells(doc_id, sheet_name, cell_ref);
        CREATE INDEX IF NOT EXISTS idx_metric_facts_metric ON metric_facts(doc_id, metric_name, period);
        CREATE INDEX IF NOT EXISTS idx_metric_facts_source ON metric_facts(doc_id, sheet_name, cell_ref);
        CREATE INDEX IF NOT EXISTS idx_index_registry_dataset_type ON index_registry(dataset_id, index_type);
        """
    )
    conn.commit()


def _location_id(chunk_id: str, loc_index: int, display: str) -> str:
    return sha256_text(f"{chunk_id}\0{loc_index}\0{display}")[:40]


def _chunk_id(doc_id: str, index: int, content: str, source_ref: str) -> str:
    return sha256_text(f"{doc_id}\0{index}\0{source_ref}\0{sha256_text(content)}")[:40]


def _token_count(content: str) -> int:
    return len(re.findall(r"\w+", content))


def _copy_to_raw(source: Path, raw_dir: Path) -> Path:
    raw_dir.mkdir(parents=True, exist_ok=True)
    target = raw_dir / source.name
    if source.resolve() == target.resolve():
        return target
    if target.exists():
        src_hash = sha256_file(source)
        dst_hash = sha256_file(target)
        if src_hash == dst_hash:
            return target
        target = raw_dir / f"{source.stem}_{src_hash[:8]}{source.suffix}"
    shutil.copy2(source, target)
    return target


def _iter_supported_files(source_dir: Path, recursive: bool) -> list[Path]:
    iterator = source_dir.rglob("*") if recursive else source_dir.glob("*")
    files = [
        path
        for path in iterator
        if path.is_file()
        and path.suffix.lower() in SUPPORTED_EXTENSIONS
        and not any(part.startswith(".") for part in path.relative_to(source_dir).parts)
    ]
    return sorted(files, key=lambda p: str(p).lower())


def _delete_document_payload(conn: sqlite3.Connection, doc_id: str) -> None:
    for table in (
        "chunk_locations",
        "chunks",
        "pdf_pages",
        "excel_workbooks",
        "excel_sheets",
        "excel_regions",
        "excel_cells",
        "metric_facts",
    ):
        conn.execute(f"DELETE FROM {table} WHERE doc_id = ?", (doc_id,))


def _register_document(
    conn: sqlite3.Connection,
    *,
    dataset_id: str,
    stored_path: Path,
    original_filename: str,
    checksum: str,
    company_name: str,
    company_ticker: str,
    doc_type: str,
) -> str:
    doc_id = sha256_text(f"{dataset_id}\0{original_filename}\0{checksum}")[:40]
    now = now_iso()
    _delete_document_payload(conn, doc_id)
    conn.execute("DELETE FROM documents WHERE doc_id = ?", (doc_id,))
    conn.execute(
        """
        INSERT INTO documents (
            doc_id, dataset_id, title, original_filename, stored_path, file_type,
            doc_type, source_type, source_name, company_name, company_ticker,
            document_date, checksum, file_size, status, chunk_count, error_message,
            metadata_json, created_at, updated_at, deleted_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
        """,
        (
            doc_id,
            dataset_id,
            Path(original_filename).stem,
            original_filename,
            str(stored_path),
            stored_path.suffix.lower().lstrip("."),
            doc_type,
            "local_directory",
            stored_path.name,
            company_name,
            company_ticker,
            _date_from_filename(original_filename),
            checksum,
            stored_path.stat().st_size,
            "parsing",
            0,
            None,
            dumps_json({"source": "private_fund_directory_ingest"}),
            now,
            now,
        ),
    )
    return doc_id


def _date_from_filename(name: str) -> str:
    text = unicodedata.normalize("NFKC", name)
    for pattern, fmt in (
        (r"(20\d{2})[-_.年]?([01]\d)[-_.月]?([0-3]\d)", "%Y-%m-%d"),
        (r"(20\d{2})([01]\d)([0-3]\d)", "%Y-%m-%d"),
    ):
        match = re.search(pattern, text)
        if match:
            y, m, d = match.groups()
            try:
                return datetime.strptime(f"{y}-{m}-{d}", "%Y-%m-%d").date().isoformat()
            except ValueError:
                pass
    match = re.search(r"(20\d{2})", text)
    return f"{match.group(1)}-01-01" if match else ""


def _write_chunks(
    conn: sqlite3.Connection,
    *,
    dataset_id: str,
    doc_id: str,
    chunks: list[dict[str, Any]],
) -> tuple[int, int]:
    now = now_iso()
    chunk_rows: list[dict[str, Any]] = []
    loc_rows: list[dict[str, Any]] = []
    chunk_ids: list[str] = []

    for index, chunk in enumerate(chunks, start=1):
        content = str(chunk.get("content") or "")
        source_ref = str(chunk.get("source_ref") or "")
        chunk_id = _chunk_id(doc_id, index, content, source_ref)
        chunk_ids.append(chunk_id)
        title_path = chunk.get("title_path")
        if isinstance(title_path, list):
            title_text = " > ".join(str(x) for x in title_path if str(x).strip())
        else:
            title_text = str(title_path or chunk.get("title") or "")
        chunk_rows.append(
            {
                "chunk_id": chunk_id,
                "dataset_id": dataset_id,
                "doc_id": doc_id,
                "chunk_index": index,
                "content": content,
                "content_type": str(chunk.get("content_type") or "text"),
                "title_path": title_text,
                "summary": chunk.get("summary") or None,
                "token_count": _token_count(content),
                "content_hash": sha256_text(content),
                "prev_chunk_id": None,
                "next_chunk_id": None,
                "source_ref": source_ref or None,
                "metadata_json": dumps_json(chunk.get("metadata") or {}),
                "created_at": now,
            }
        )
        locations = chunk.get("locations") or []
        if not locations:
            locations = [{"display_text": source_ref or title_text}]
        for loc_index, loc in enumerate(locations):
            display = str(loc.get("display_text") or loc.get("source_ref") or source_ref or title_text)
            loc_rows.append(
                {
                    "location_id": _location_id(chunk_id, loc_index, display),
                    "chunk_id": chunk_id,
                    "doc_id": doc_id,
                    "location_index": loc_index,
                    "page_start": loc.get("page_start"),
                    "page_end": loc.get("page_end"),
                    "page_numbers_json": dumps_json(loc.get("page_numbers")) if loc.get("page_numbers") else None,
                    "slide_start": loc.get("slide_start"),
                    "slide_end": loc.get("slide_end"),
                    "sheet_name": loc.get("sheet_name"),
                    "cell_range": loc.get("cell_range"),
                    "heading_path": title_text,
                    "bbox_json": dumps_json(loc.get("bbox")) if loc.get("bbox") else None,
                    "source_refs_json": dumps_json([display]),
                    "display_text": display,
                    "metadata_json": dumps_json(loc.get("metadata") or {}),
                }
            )

    for idx, row in enumerate(chunk_rows):
        row["prev_chunk_id"] = chunk_ids[idx - 1] if idx > 0 else None
        row["next_chunk_id"] = chunk_ids[idx + 1] if idx + 1 < len(chunk_ids) else None

    if chunk_rows:
        conn.executemany(
            """
            INSERT INTO chunks (
                chunk_id, dataset_id, doc_id, chunk_index, content, content_type,
                title_path, summary, token_count, content_hash, prev_chunk_id,
                next_chunk_id, source_ref, metadata_json, created_at
            ) VALUES (
                :chunk_id, :dataset_id, :doc_id, :chunk_index, :content, :content_type,
                :title_path, :summary, :token_count, :content_hash, :prev_chunk_id,
                :next_chunk_id, :source_ref, :metadata_json, :created_at
            )
            """,
            chunk_rows,
        )
    if loc_rows:
        conn.executemany(
            """
            INSERT INTO chunk_locations (
                location_id, chunk_id, doc_id, location_index, page_start, page_end,
                page_numbers_json, slide_start, slide_end, sheet_name, cell_range,
                heading_path, bbox_json, source_refs_json, display_text, metadata_json
            ) VALUES (
                :location_id, :chunk_id, :doc_id, :location_index, :page_start, :page_end,
                :page_numbers_json, :slide_start, :slide_end, :sheet_name, :cell_range,
                :heading_path, :bbox_json, :source_refs_json, :display_text, :metadata_json
            )
            """,
            loc_rows,
        )
    conn.execute(
        "UPDATE documents SET chunk_count = ?, updated_at = ? WHERE doc_id = ?",
        (len(chunk_rows), now_iso(), doc_id),
    )
    return len(chunk_rows), len(loc_rows)


def _extract_pdf_pages(path: Path) -> tuple[list[dict[str, Any]], str]:
    layout_pages = _extract_pdf_layout_pages(path)
    try:
        import pdfplumber  # type: ignore

        pages = []
        with pdfplumber.open(str(path)) as pdf:
            for idx, page in enumerate(pdf.pages, start=1):
                text = page.extract_text() or ""
                words = page.extract_words() or []
                layout = layout_pages.get(idx, {})
                pages.append(
                    {
                        "page_number": idx,
                        "text": text.strip(),
                        "word_count": len(words),
                        "bbox": layout.get("bbox") or [0, 0, float(page.width), float(page.height)],
                        "lines": layout.get("lines") or [],
                    }
                )
        return pages, "pdfplumber"
    except Exception:
        if layout_pages:
            pages = []
            for idx in sorted(layout_pages):
                layout = layout_pages[idx]
                lines = layout.get("lines") or []
                text = "\n".join(str(line.get("text") or "").strip() for line in lines if str(line.get("text") or "").strip())
                pages.append(
                    {
                        "page_number": idx,
                        "text": text.strip(),
                        "word_count": len(lines),
                        "bbox": layout.get("bbox"),
                        "lines": lines,
                    }
                )
            return pages, "pymupdf"
        try:
            from pypdf import PdfReader  # type: ignore

            reader = PdfReader(str(path))
            pages = []
            for idx, page in enumerate(reader.pages, start=1):
                text = page.extract_text() or ""
                layout = layout_pages.get(idx, {})
                pages.append(
                    {
                        "page_number": idx,
                        "text": text.strip(),
                        "word_count": len(text.split()),
                        "bbox": layout.get("bbox"),
                        "lines": layout.get("lines") or [],
                    }
                )
            return pages, "pypdf"
        except Exception as exc:
            raise RuntimeError(f"Unable to extract PDF text from {path}: {exc}") from exc


def _extract_pdf_layout_pages(path: Path) -> dict[int, dict[str, Any]]:
    try:
        import fitz  # type: ignore
    except Exception:
        return {}

    try:
        pages: dict[int, dict[str, Any]] = {}
        with fitz.open(str(path)) as document:
            for page_index in range(document.page_count):
                page = document.load_page(page_index)
                rect = page.rect
                words = [
                    {
                        "text": str(item[4]).strip(),
                        "x_min": float(item[0]),
                        "y_min": float(item[1]),
                        "x_max": float(item[2]),
                        "y_max": float(item[3]),
                    }
                    for item in page.get_text("words", sort=True)
                    if len(item) >= 5 and str(item[4]).strip()
                ]
                pages[page_index + 1] = {
                    "bbox": [0, 0, float(rect.width), float(rect.height)],
                    "lines": _group_pdf_words_into_lines(words),
                }
        return pages
    except Exception:
        return {}


def _group_pdf_words_into_lines(words: list[dict[str, Any]]) -> list[dict[str, Any]]:
    sorted_words = sorted(words, key=lambda word: ((word["y_min"] + word["y_max"]) / 2, word["x_min"]))
    grouped: list[list[dict[str, Any]]] = []
    centers: list[float] = []
    for word in sorted_words:
        center = (word["y_min"] + word["y_max"]) / 2
        if grouped and abs(center - centers[-1]) <= 3.5:
            grouped[-1].append(word)
            centers[-1] = (centers[-1] * (len(grouped[-1]) - 1) + center) / len(grouped[-1])
        else:
            grouped.append([word])
            centers.append(center)

    lines: list[dict[str, Any]] = []
    for line_words in grouped:
        words_by_x = sorted(line_words, key=lambda word: word["x_min"])
        lines.append(
            {
                "text": " ".join(word["text"] for word in words_by_x).strip(),
                "bbox": [
                    min(word["x_min"] for word in words_by_x),
                    min(word["y_min"] for word in words_by_x),
                    max(word["x_max"] for word in words_by_x),
                    max(word["y_max"] for word in words_by_x),
                ],
            }
        )
    return lines


def _split_long_text(text: str, max_chars: int = DEFAULT_MAX_PDF_CHARS) -> list[str]:
    text = text.strip()
    if len(text) <= max_chars:
        return [text] if text else []
    paragraphs = [p.strip() for p in re.split(r"\n\s*\n+", text) if p.strip()]
    if len(paragraphs) <= 1:
        paragraphs = [p.strip() for p in re.split(r"(?<=[。！？?!])\s+", text) if p.strip()]
    out: list[str] = []
    current = ""
    for para in paragraphs:
        candidate = f"{current}\n\n{para}".strip() if current else para
        if current and len(candidate) > max_chars:
            out.append(current)
            current = para
        else:
            current = candidate
    if current:
        out.append(current)
    return out


_SPEAKER_SEGMENT_RE = re.compile(r"发[言⾔]人\s*\d+\s+\d{2}:\d{2}:\d{2}")


def _is_pdf_footer_text(text: str) -> bool:
    normalized = unicodedata.normalize("NFKC", text)
    return bool(re.search(r"知识星球|前沿信息收录|VX[:：]", normalized, flags=re.I))


def _union_line_bbox(lines: list[dict[str, Any]]) -> list[float] | None:
    bboxes = [line.get("bbox") for line in lines if isinstance(line.get("bbox"), list) and len(line["bbox"]) == 4]
    if not bboxes:
        return None
    return [
        float(min(bbox[0] for bbox in bboxes)),
        float(min(bbox[1] for bbox in bboxes)),
        float(max(bbox[2] for bbox in bboxes)),
        float(max(bbox[3] for bbox in bboxes)),
    ]


def _speaker_segments_from_lines(page_lines: list[dict[str, Any]]) -> list[dict[str, Any]]:
    if not page_lines:
        return []

    segments: list[dict[str, Any]] = []
    current: list[dict[str, Any]] = []
    prefix: list[dict[str, Any]] = []

    def finish(lines: list[dict[str, Any]]) -> None:
        content_lines = [
            str(line.get("text") or "").strip()
            for line in lines
            if str(line.get("text") or "").strip() and not _is_pdf_footer_text(str(line.get("text") or ""))
        ]
        text = "\n".join(content_lines).strip()
        if len(text) >= 40:
            content_line_set = set(content_lines)
            bbox_lines = [
                line
                for line in lines
                if str(line.get("text") or "").strip() in content_line_set
                and not _is_pdf_footer_text(str(line.get("text") or ""))
            ]
            segments.append({"text": text, "bbox": _union_line_bbox(bbox_lines)})

    for line in page_lines:
        text = unicodedata.normalize("NFKC", str(line.get("text") or "")).strip()
        if not text:
            continue
        if _SPEAKER_SEGMENT_RE.search(text):
            if current:
                finish(current)
            elif prefix:
                finish(prefix)
            current = [line]
            prefix = []
        elif current:
            current.append(line)
        else:
            prefix.append(line)

    if current:
        finish(current)
    elif prefix:
        finish(prefix)
    return segments


def _speaker_segments(page_text: str, page_lines: list[dict[str, Any]] | None = None) -> list[dict[str, Any]]:
    line_segments = _speaker_segments_from_lines(page_lines or [])
    if line_segments:
        return line_segments

    page_text = unicodedata.normalize("NFKC", page_text)
    marker = re.compile(r"(发[言⾔]人\s*\d+\s+\d{2}:\d{2}:\d{2})")
    parts = marker.split(page_text)
    if len(parts) <= 1:
        return []
    segments: list[dict[str, Any]] = []
    prefix = parts[0].strip()
    for i in range(1, len(parts), 2):
        head = parts[i].strip()
        body = parts[i + 1].strip() if i + 1 < len(parts) else ""
        text = f"{head}\n{body}".strip()
        if len(text) >= 40:
            segments.append({"text": text, "bbox": None})
    if prefix and len(prefix) >= 80:
        segments.insert(0, {"text": prefix, "bbox": None})
    return segments


def ingest_pdf(conn: sqlite3.Connection, *, dataset_id: str, doc_id: str, path: Path) -> DocumentIngestResult:
    pages, method = _extract_pdf_pages(path)
    page_rows = []
    chunks: list[dict[str, Any]] = []
    total_chars = 0
    for page in pages:
        text = page["text"]
        page_no = int(page["page_number"])
        total_chars += len(text)
        page_rows.append(
            {
                "page_id": sha256_text(f"{doc_id}\0page\0{page_no}")[:40],
                "dataset_id": dataset_id,
                "doc_id": doc_id,
                "page_number": page_no,
                "text": text,
                "char_count": len(text),
                "word_count": int(page.get("word_count") or len(text.split())),
                "extraction_method": method,
                "bbox_json": dumps_json(page.get("bbox")) if page.get("bbox") else None,
                "metadata_json": dumps_json({"source": "private_fund_directory_ingest"}),
            }
        )
        if text:
            page_segments = _split_long_text(text)
            for part_index, segment in enumerate(page_segments, start=1):
                title = f"{path.stem} p.{page_no}" if len(page_segments) == 1 else f"{path.stem} p.{page_no} part {part_index}"
                chunks.append(
                    {
                        "content": segment,
                        "content_type": "pdf_page",
                        "title_path": [path.stem, f"page {page_no}"],
                        "summary": segment[:240],
                        "source_ref": f"{path.name} p.{page_no}",
                        "metadata": {"extraction_method": method, "part_index": part_index},
                        "locations": [
                            {
                                "page_start": page_no,
                                "page_end": page_no,
                                "display_text": f"{path.name} p.{page_no}",
                                "bbox": page.get("bbox"),
                                "metadata": {"part_index": part_index},
                            }
                        ],
                        "title": title,
                    }
                )
            for turn_index, segment in enumerate(_speaker_segments(text, page.get("lines") or []), start=1):
                segment_text = str(segment.get("text") or "").strip()
                if not segment_text:
                    continue
                chunks.append(
                    {
                        "content": segment_text,
                        "content_type": "pdf_speaker_turn",
                        "title_path": [path.stem, f"page {page_no}", f"speaker turn {turn_index}"],
                        "summary": segment_text[:240],
                        "source_ref": f"{path.name} p.{page_no}, turn {turn_index}",
                        "metadata": {"extraction_method": method, "turn_index": turn_index},
                        "locations": [
                            {
                                "page_start": page_no,
                                "page_end": page_no,
                                "display_text": f"{path.name} p.{page_no}",
                                "bbox": segment.get("bbox") or page.get("bbox"),
                                "metadata": {"turn_index": turn_index},
                            }
                        ],
                    }
                )

    summary = (
        f"PDF document: {path.name}\n"
        f"Pages: {len(pages)}\n"
        f"Extraction method: {method}\n"
        f"Total text characters: {total_chars}\n"
        "OCR required: no, direct text extraction succeeded.\n"
    )
    chunks.insert(
        0,
        {
            "content": summary,
            "content_type": "pdf_document_summary",
            "title_path": [path.stem, "document summary"],
            "summary": summary,
            "source_ref": path.name,
            "metadata": {"page_count": len(pages), "extraction_method": method, "total_chars": total_chars},
            "locations": [{"page_start": 1 if pages else None, "page_end": len(pages) or None, "display_text": path.name}],
        },
    )

    if page_rows:
        conn.executemany(
            """
            INSERT INTO pdf_pages (
                page_id, dataset_id, doc_id, page_number, text, char_count,
                word_count, extraction_method, bbox_json, metadata_json
            ) VALUES (
                :page_id, :dataset_id, :doc_id, :page_number, :text, :char_count,
                :word_count, :extraction_method, :bbox_json, :metadata_json
            )
            """,
            page_rows,
        )
    chunk_count, location_count = _write_chunks(conn, dataset_id=dataset_id, doc_id=doc_id, chunks=chunks)
    return DocumentIngestResult(
        doc_id=doc_id,
        filename=path.name,
        file_type="pdf",
        status="indexed",
        chunk_count=chunk_count,
        location_count=location_count,
        pdf_page_count=len(pages),
    )


def _col_letter(index: int) -> str:
    letters = ""
    while index:
        index, rem = divmod(index - 1, 26)
        letters = chr(65 + rem) + letters
    return letters


def _cell_ref(row: int, col: int) -> str:
    return f"{_col_letter(col)}{row}"


def _range_ref(min_row: int, min_col: int, max_row: int, max_col: int) -> str:
    return f"{_cell_ref(min_row, min_col)}:{_cell_ref(max_row, max_col)}"


def _is_formula(value: Any) -> bool:
    return isinstance(value, str) and value.startswith("=")


def _numeric_value(value: Any) -> Optional[float]:
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value)
    text = normalize_text(value).replace(",", "")
    if not text:
        return None
    percent = text.endswith("%")
    if percent:
        text = text[:-1]
    try:
        number = float(text)
        return number / 100.0 if percent else number
    except ValueError:
        return None


def _period_from_label(label: str) -> str:
    label = normalize_text(label)
    patterns = [
        r"\b(20\d{2}[A-Z]?)\b",
        r"\b([1-4]Q\s*20\d{2})\b",
        r"\b(20\d{2}\s*[EQAF])\b",
        r"\b(FY\s*20\d{2})\b",
    ]
    for pattern in patterns:
        match = re.search(pattern, label, flags=re.IGNORECASE)
        if match:
            return normalize_text(match.group(1))
    return ""


def _looks_like_period_label(label: str) -> bool:
    return bool(_period_from_label(label))


def _unit_from_text(text: str) -> str:
    text = normalize_text(text)
    if "%" in text:
        return "%"
    for unit in ("CNYm", "RMBm", "USDm", "GWh", "MWh", "Wh", "MW", "GW", "元/Wh"):
        if unit.lower() in text.lower():
            return unit
    return ""


def _unit_from_number_format(number_format: str) -> str:
    return "%" if "%" in str(number_format or "") else ""


def _sheet_role(sheet_name: str, sample_text: str) -> str:
    text = f"{sheet_name} {sample_text}".lower()
    checks = [
        ("valuation_dcf", ("dcf", "wacc", "terminal value", "valuation")),
        ("sensitivity", ("sensitivity", "敏感")),
        ("driver_model", ("driver", "assumption", "asp", "shipment")),
        ("financial_statement", ("pl_bs_cfs", "income statement", "balance sheet", "cash flow")),
        ("quarterly_results", ("qoq", "results", "quarter")),
        ("output_table", ("table", "snapshot", "breakdown")),
        ("chart_data", ("chart",)),
        ("raw_upload", ("upload", "bloomberg", "@")),
        ("resource_note", ("resource", "products", "产品")),
    ]
    for role, words in checks:
        if any(word in text for word in words):
            return role
    return "worksheet"


def _region_type(sheet_name: str, values: list[Any], formula_count: int) -> str:
    text = normalize_text(" ".join(cell_display(v, 80) for v in values)).lower()
    mapping = [
        ("valuation_dcf", ("dcf", "wacc", "terminal value", "valuation")),
        ("sensitivity", ("sensitivity", "敏感")),
        ("income_statement", ("revenue", "gross profit", "net profit", "eps", "income statement")),
        ("cash_flow", ("free cash flow", "cash flow", "fcf")),
        ("driver_assumption", ("driver", "asp", "shipment", "assumption", "orders")),
        ("business_breakdown", ("breakdown", "segment", "contribution")),
        ("note", ("note", "摘要", "q&a")),
    ]
    for region_type, words in mapping:
        if any(word in text for word in words):
            return region_type
    if formula_count / max(1, len(values)) >= 0.25:
        return "formula_block"
    if len(values) >= 6:
        return "table"
    return "text_block"


def _workbook_type(sheet_summaries: list[dict[str, Any]]) -> str:
    formulas = sum(int(s["formula_count"]) for s in sheet_summaries)
    non_empty = sum(int(s["non_empty_cell_count"]) for s in sheet_summaries)
    density = formulas / max(1, non_empty)
    role_text = " ".join(str(s.get("sheet_role") or "") for s in sheet_summaries)
    if density >= 0.15 or any(role in role_text for role in ("valuation_dcf", "driver_model", "sensitivity")):
        return "valuation_model"
    if len(sheet_summaries) <= 3 and density < 0.1:
        return "simple_table"
    return "financial_workbook"


def _nonempty_cells(ws) -> dict[tuple[int, int], Any]:
    cells: dict[tuple[int, int], Any] = {}
    for key, cell in getattr(ws, "_cells", {}).items():
        value = cell.value
        if value is not None and cell_display(value):
            cells[(cell.row, cell.column)] = value
    return cells


def _sheet_bounds(cells: dict[tuple[int, int], Any]) -> Optional[tuple[int, int, int, int]]:
    if not cells:
        return None
    rows = [row for row, _ in cells]
    cols = [col for _, col in cells]
    return min(rows), min(cols), max(rows), max(cols)


def _group_sorted(values: list[int], gap: int = 1) -> list[tuple[int, int]]:
    if not values:
        return []
    values = sorted(set(values))
    groups: list[tuple[int, int]] = []
    start = prev = values[0]
    for value in values[1:]:
        if value - prev <= gap + 1:
            prev = value
        else:
            groups.append((start, prev))
            start = prev = value
    groups.append((start, prev))
    return groups


def _detect_regions(cells: dict[tuple[int, int], Any]) -> list[tuple[int, int, int, int]]:
    row_groups = _group_sorted([row for row, _ in cells], gap=1)
    regions: list[tuple[int, int, int, int]] = []
    for row_start, row_end in row_groups:
        cols = [col for row, col in cells if row_start <= row <= row_end]
        for col_start, col_end in _group_sorted(cols, gap=1):
            region_cells = [
                (row, col)
                for row, col in cells
                if row_start <= row <= row_end and col_start <= col <= col_end
            ]
            if region_cells:
                rows = [row for row, _ in region_cells]
                cols_in_region = [col for _, col in region_cells]
                regions.append((min(rows), min(cols_in_region), max(rows), max(cols_in_region)))
    return regions


def _nearest_left_label(row_text_cols: dict[int, list[tuple[int, str]]], row: int, col: int) -> str:
    cols = row_text_cols.get(row) or []
    indexes = [item[0] for item in cols]
    pos = bisect.bisect_left(indexes, col) - 1
    while pos >= 0:
        label = cols[pos][1]
        if label:
            return label
        pos -= 1
    return ""


def _nearest_top_label(col_text_rows: dict[int, list[tuple[int, str]]], row: int, col: int) -> str:
    rows = col_text_rows.get(col) or []
    indexes = [item[0] for item in rows]
    pos = bisect.bisect_left(indexes, row) - 1
    while pos >= 0:
        label = rows[pos][1]
        if label:
            return label
        pos -= 1
    return ""


def _sample_labels(cells: dict[tuple[int, int], Any], max_items: int = DEFAULT_MAX_REGION_LABELS) -> list[str]:
    labels: list[str] = []
    for _, value in sorted(cells.items(), key=lambda item: item[0]):
        text = cell_display(value, 80)
        if text and not _is_formula(value) and not re.fullmatch(r"[-+]?\d+(\.\d+)?%?", text):
            labels.append(text)
        if len(labels) >= max_items:
            break
    return labels


def ingest_excel(conn: sqlite3.Connection, *, dataset_id: str, doc_id: str, path: Path) -> DocumentIngestResult:
    try:
        from openpyxl import load_workbook  # type: ignore
    except Exception as exc:
        raise RuntimeError("openpyxl is required for Excel ingestion") from exc

    wb_formula = load_workbook(path, data_only=False, read_only=False, keep_links=False)
    wb_values = load_workbook(path, data_only=True, read_only=False, keep_links=False)

    sheet_rows: list[dict[str, Any]] = []
    region_rows: list[dict[str, Any]] = []
    cell_rows: list[dict[str, Any]] = []
    fact_rows: list[dict[str, Any]] = []
    chunks: list[dict[str, Any]] = []

    for sheet_index, ws in enumerate(wb_formula.worksheets, start=1):
        values_ws = wb_values[ws.title] if ws.title in wb_values.sheetnames else None
        cells = _nonempty_cells(ws)
        bounds = _sheet_bounds(cells)
        formula_count = sum(1 for value in cells.values() if _is_formula(value))
        non_empty = len(cells)
        if bounds:
            min_row, min_col, max_row, max_col = bounds
            used_range = _range_ref(min_row, min_col, max_row, max_col)
            row_count = max_row - min_row + 1
            col_count = max_col - min_col + 1
        else:
            min_row = min_col = max_row = max_col = 0
            used_range = ""
            row_count = col_count = 0
        labels = _sample_labels(cells)
        role = _sheet_role(ws.title, " ".join(labels))
        sheet_unit = ""
        for label in labels[:10]:
            sheet_unit = _unit_from_text(label)
            if sheet_unit:
                break
        formula_density = formula_count / max(1, non_empty)
        sheet_summary = (
            f"Excel sheet: {ws.title}\n"
            f"Role: {role}\n"
            f"Used range: {used_range or 'empty'}\n"
            f"Non-empty cells: {non_empty}; formulas: {formula_count}; formula density: {formula_density:.2%}\n"
            f"Key labels: {', '.join(labels[:20])}"
        )
        sheet_id = sha256_text(f"{doc_id}\0sheet\0{ws.title}")[:40]
        sheet_rows.append(
            {
                "sheet_id": sheet_id,
                "dataset_id": dataset_id,
                "doc_id": doc_id,
                "sheet_index": sheet_index,
                "sheet_name": ws.title,
                "sheet_role": role,
                "sheet_state": ws.sheet_state,
                "used_range": used_range,
                "row_count": row_count,
                "col_count": col_count,
                "non_empty_cell_count": non_empty,
                "formula_count": formula_count,
                "formula_density": formula_density,
                "summary": sheet_summary,
                "header_json": dumps_json(labels),
                "metadata_json": dumps_json(
                    {
                        "freeze_panes": str(ws.freeze_panes or ""),
                        "merged_ranges": [str(rng) for rng in ws.merged_cells.ranges],
                    }
                ),
            }
        )
        if non_empty:
            chunks.append(
                {
                    "content": sheet_summary,
                    "content_type": "excel_sheet_summary",
                    "title_path": [path.stem, ws.title, "sheet summary"],
                    "summary": sheet_summary[:240],
                    "source_ref": f"{path.name} {ws.title}!{used_range}",
                    "metadata": {"sheet_role": role, "used_range": used_range},
                    "locations": [
                        {
                            "sheet_name": ws.title,
                            "cell_range": used_range,
                            "display_text": f"{ws.title}!{used_range}",
                            "metadata": {"sheet_role": role},
                        }
                    ],
                }
            )

        row_text_cols: dict[int, list[tuple[int, str]]] = {}
        col_text_rows: dict[int, list[tuple[int, str]]] = {}
        for (row, col), value in cells.items():
            formula = _is_formula(value)
            cached_for_label = values_ws.cell(row, col).value if formula and values_ws is not None else None
            text = cell_display(cached_for_label if formula else value, 120)
            raw_text = cell_display(value, 120)
            if text and not formula and _numeric_value(value) is None:
                row_text_cols.setdefault(row, []).append((col, text))
            if text and (_numeric_value(text) is None or _looks_like_period_label(text) or row <= max(5, min_row + 4)):
                col_text_rows.setdefault(col, []).append((row, text))
            elif raw_text and not formula and _numeric_value(raw_text) is None:
                col_text_rows.setdefault(col, []).append((row, raw_text))
        for items in row_text_cols.values():
            items.sort(key=lambda x: x[0])
        for items in col_text_rows.values():
            items.sort(key=lambda x: x[0])

        for (row, col), value in sorted(cells.items(), key=lambda item: item[0]):
            cached = values_ws.cell(row, col).value if values_ws is not None else None
            formula = str(value) if _is_formula(value) else None
            display = cell_display(cached if formula else value, 200)
            row_label = _nearest_left_label(row_text_cols, row, col)
            col_label = _nearest_top_label(col_text_rows, row, col)
            period = _period_from_label(col_label) or _period_from_label(display)
            number_format = str(ws.cell(row, col).number_format or "")
            unit = (
                _unit_from_text(row_label)
                or _unit_from_text(col_label)
                or _unit_from_text(display)
                or _unit_from_number_format(number_format)
                or sheet_unit
            )
            numeric = _numeric_value(cached if formula else value)
            cell_ref = _cell_ref(row, col)
            value_type = "formula" if formula else type(value).__name__
            cell_id = sha256_text(f"{doc_id}\0{ws.title}\0{cell_ref}")[:40]
            cell_rows.append(
                {
                    "cell_id": cell_id,
                    "dataset_id": dataset_id,
                    "doc_id": doc_id,
                    "sheet_name": ws.title,
                    "cell_ref": cell_ref,
                    "row_index": row,
                    "col_index": col,
                    "value_type": value_type,
                    "display_value": display,
                    "raw_value": cell_display(value, 500),
                    "numeric_value": numeric,
                    "formula": formula,
                    "cached_value": cell_display(cached, 500) if formula else None,
                    "number_format": number_format,
                    "row_label": row_label,
                    "col_label": col_label,
                    "period": period,
                    "unit": unit,
                    "is_formula": 1 if formula else 0,
                    "metadata_json": dumps_json({"sheet_role": role}),
                }
            )
            if numeric is not None and row_label:
                fact_id = sha256_text(f"{doc_id}\0{ws.title}\0{cell_ref}\0{row_label}\0{period}")[:40]
                confidence = 0.85 if period else 0.65
                fact_rows.append(
                    {
                        "fact_id": fact_id,
                        "dataset_id": dataset_id,
                        "doc_id": doc_id,
                        "metric_name": row_label,
                        "metric_alias": normalize_text(row_label).lower(),
                        "period": period,
                        "value_text": display,
                        "value_numeric": numeric,
                        "unit": unit,
                        "sheet_name": ws.title,
                        "cell_ref": cell_ref,
                        "source_range": f"{ws.title}!{cell_ref}",
                        "formula": formula,
                        "confidence": confidence,
                        "metadata_json": dumps_json({"col_label": col_label, "sheet_role": role}),
                    }
                )

        for region_index, (r1, c1, r2, c2) in enumerate(_detect_regions(cells), start=1):
            region_values = [
                cells[(row, col)]
                for row in range(r1, r2 + 1)
                for col in range(c1, c2 + 1)
                if (row, col) in cells
            ]
            region_formula_count = sum(1 for value in region_values if _is_formula(value))
            region_range = _range_ref(r1, c1, r2, c2)
            region_type = _region_type(ws.title, region_values, region_formula_count)
            region_labels = _sample_labels({(idx, 1): v for idx, v in enumerate(region_values, start=1)})
            region_summary = (
                f"Excel region: {ws.title}!{region_range}\n"
                f"Sheet role: {role}\n"
                f"Region type: {region_type}\n"
                f"Rows: {r2 - r1 + 1}; columns: {c2 - c1 + 1}; non-empty cells: {len(region_values)}; "
                f"formulas: {region_formula_count}\n"
                f"Key labels: {', '.join(region_labels[:20])}"
            )
            region_id = sha256_text(f"{doc_id}\0region\0{ws.title}\0{region_range}\0{region_index}")[:40]
            region_rows.append(
                {
                    "region_id": region_id,
                    "dataset_id": dataset_id,
                    "doc_id": doc_id,
                    "sheet_name": ws.title,
                    "region_index": region_index,
                    "region_type": region_type,
                    "cell_range": region_range,
                    "row_count": r2 - r1 + 1,
                    "col_count": c2 - c1 + 1,
                    "non_empty_cell_count": len(region_values),
                    "formula_count": region_formula_count,
                    "formula_density": region_formula_count / max(1, len(region_values)),
                    "summary": region_summary,
                    "header_json": dumps_json(region_labels),
                    "metadata_json": dumps_json({"sheet_role": role}),
                }
            )
            chunks.append(
                {
                    "content": region_summary,
                    "content_type": "excel_region_summary",
                    "title_path": [path.stem, ws.title, region_type, region_range],
                    "summary": region_summary[:240],
                    "source_ref": f"{path.name} {ws.title}!{region_range}",
                    "metadata": {"sheet_role": role, "region_type": region_type, "cell_range": region_range},
                    "locations": [
                        {
                            "sheet_name": ws.title,
                            "cell_range": region_range,
                            "display_text": f"{ws.title}!{region_range}",
                            "metadata": {"sheet_role": role, "region_type": region_type},
                        }
                    ],
                }
            )

    workbook_type = _workbook_type(sheet_rows)
    total_formulas = sum(int(row["formula_count"]) for row in sheet_rows)
    total_cells = sum(int(row["non_empty_cell_count"]) for row in sheet_rows)
    workbook_summary = (
        f"Excel workbook: {path.name}\n"
        f"Workbook type: {workbook_type}\n"
        f"Sheets: {len(sheet_rows)}; non-empty cells: {total_cells}; formulas: {total_formulas}; "
        f"formula density: {total_formulas / max(1, total_cells):.2%}\n"
        "Sheet roles:\n"
        + "\n".join(f"- {row['sheet_name']}: {row['sheet_role']} ({row['used_range']})" for row in sheet_rows)
    )
    chunks.insert(
        0,
        {
            "content": workbook_summary,
            "content_type": "excel_workbook_summary",
            "title_path": [path.stem, "workbook summary"],
            "summary": workbook_summary[:240],
            "source_ref": path.name,
            "metadata": {"workbook_type": workbook_type, "sheet_count": len(sheet_rows)},
            "locations": [{"display_text": path.name, "metadata": {"workbook_type": workbook_type}}],
        },
    )

    conn.execute(
        """
        INSERT INTO excel_workbooks (
            workbook_id, dataset_id, doc_id, workbook_type, sheet_count,
            visible_sheet_count, formula_count, non_empty_cell_count,
            formula_density, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            sha256_text(f"{doc_id}\0workbook")[:40],
            dataset_id,
            doc_id,
            workbook_type,
            len(sheet_rows),
            sum(1 for ws in wb_formula.worksheets if ws.sheet_state == "visible"),
            total_formulas,
            total_cells,
            total_formulas / max(1, total_cells),
            dumps_json({"source": "private_fund_directory_ingest"}),
        ),
    )
    if sheet_rows:
        conn.executemany(
            """
            INSERT INTO excel_sheets (
                sheet_id, dataset_id, doc_id, sheet_index, sheet_name, sheet_role,
                sheet_state, used_range, row_count, col_count, non_empty_cell_count,
                formula_count, formula_density, summary, header_json, metadata_json
            ) VALUES (
                :sheet_id, :dataset_id, :doc_id, :sheet_index, :sheet_name, :sheet_role,
                :sheet_state, :used_range, :row_count, :col_count, :non_empty_cell_count,
                :formula_count, :formula_density, :summary, :header_json, :metadata_json
            )
            """,
            sheet_rows,
        )
    if region_rows:
        conn.executemany(
            """
            INSERT INTO excel_regions (
                region_id, dataset_id, doc_id, sheet_name, region_index, region_type,
                cell_range, row_count, col_count, non_empty_cell_count, formula_count,
                formula_density, summary, header_json, metadata_json
            ) VALUES (
                :region_id, :dataset_id, :doc_id, :sheet_name, :region_index, :region_type,
                :cell_range, :row_count, :col_count, :non_empty_cell_count, :formula_count,
                :formula_density, :summary, :header_json, :metadata_json
            )
            """,
            region_rows,
        )
    if cell_rows:
        conn.executemany(
            """
            INSERT INTO excel_cells (
                cell_id, dataset_id, doc_id, sheet_name, cell_ref, row_index, col_index,
                value_type, display_value, raw_value, numeric_value, formula, cached_value,
                number_format, row_label, col_label, period, unit, is_formula, metadata_json
            ) VALUES (
                :cell_id, :dataset_id, :doc_id, :sheet_name, :cell_ref, :row_index, :col_index,
                :value_type, :display_value, :raw_value, :numeric_value, :formula, :cached_value,
                :number_format, :row_label, :col_label, :period, :unit, :is_formula, :metadata_json
            )
            """,
            cell_rows,
        )
    if fact_rows:
        conn.executemany(
            """
            INSERT INTO metric_facts (
                fact_id, dataset_id, doc_id, metric_name, metric_alias, period,
                value_text, value_numeric, unit, sheet_name, cell_ref, source_range,
                formula, confidence, metadata_json
            ) VALUES (
                :fact_id, :dataset_id, :doc_id, :metric_name, :metric_alias, :period,
                :value_text, :value_numeric, :unit, :sheet_name, :cell_ref, :source_range,
                :formula, :confidence, :metadata_json
            )
            """,
            fact_rows,
        )

    chunk_count, location_count = _write_chunks(conn, dataset_id=dataset_id, doc_id=doc_id, chunks=chunks)
    return DocumentIngestResult(
        doc_id=doc_id,
        filename=path.name,
        file_type=path.suffix.lower().lstrip("."),
        status="indexed",
        chunk_count=chunk_count,
        location_count=location_count,
        excel_sheet_count=len(sheet_rows),
        excel_region_count=len(region_rows),
        excel_cell_count=len(cell_rows),
        metric_fact_count=len(fact_rows),
    )


def _doc_type_for_path(path: Path) -> str:
    name = normalize_text(path.name).lower()
    if path.suffix.lower() in {".xlsx", ".xlsm"}:
        return "valuation_model"
    if "交流" in name or "transcript" in name or "电话会" in name:
        return "meeting_transcript"
    if "qa" in name or "q&a" in name or "问答" in name:
        return "research_qa_note"
    return "research_note" if path.suffix.lower() == ".pdf" else "document"


def _update_document_status(conn: sqlite3.Connection, doc_id: str, status: str, error: Optional[str] = None) -> None:
    conn.execute(
        "UPDATE documents SET status = ?, error_message = ?, updated_at = ? WHERE doc_id = ?",
        (status, error, now_iso(), doc_id),
    )


def _sync_index_registry(conn: sqlite3.Connection, dataset_id: str, source_doc_ids: list[str], chunk_count: int) -> None:
    now = now_iso()
    rows = [
        {
            "index_id": sha256_text(f"{dataset_id}\0sqlite_structured")[:40],
            "dataset_id": dataset_id,
            "index_type": "sqlite_structured",
            "collection_name": dataset_id,
            "index_path": "meta/collection.sqlite3",
            "source_doc_ids_json": dumps_json(source_doc_ids),
            "source_chunk_count": chunk_count,
            "status": "ready",
            "built_at": now,
            "error_message": None,
            "metadata_json": dumps_json({"tables": ["documents", "chunks", "chunk_locations", "excel_cells", "metric_facts"]}),
        },
        {
            "index_id": sha256_text(f"{dataset_id}\0summary_chunks")[:40],
            "dataset_id": dataset_id,
            "index_type": "summary_chunks",
            "collection_name": dataset_id,
            "index_path": "meta/collection.sqlite3:chunks",
            "source_doc_ids_json": dumps_json(source_doc_ids),
            "source_chunk_count": chunk_count,
            "status": "ready",
            "built_at": now,
            "error_message": None,
            "metadata_json": dumps_json({"note": "Chunks are ready for a later Chroma/BM25 indexing step."}),
        },
    ]
    conn.executemany(
        """
        INSERT OR REPLACE INTO index_registry (
            index_id, dataset_id, index_type, collection_name, index_path,
            source_doc_ids_json, source_chunk_count, status, built_at,
            error_message, metadata_json
        ) VALUES (
            :index_id, :dataset_id, :index_type, :collection_name, :index_path,
            :source_doc_ids_json, :source_chunk_count, :status, :built_at,
            :error_message, :metadata_json
        )
        """,
        rows,
    )


def ingest_directory(
    *,
    directory_path: str | Path,
    workspace_root: str | Path | None = None,
    dataset_id: Optional[str] = None,
    dataset_name: Optional[str] = None,
    company_name: str = "",
    company_ticker: str = "",
    recursive: bool = True,
    reset: bool = False,
    job_id: Optional[str] = None,
) -> IngestResult:
    source_dir = Path(directory_path).expanduser().resolve()
    if not source_dir.is_dir():
        raise FileNotFoundError(f"directory_path is not a directory: {source_dir}")

    workspace = Path(workspace_root).expanduser().resolve() if workspace_root else default_workspace_root()
    dataset_id = safe_slug(dataset_id or source_dir.name)
    dataset_name = dataset_name or source_dir.name
    dataset_root = workspace / dataset_id
    raw_dir = dataset_root / "raw"
    meta_dir = dataset_root / "meta"
    collection_db_path = meta_dir / "collection.sqlite3"
    global_db_path = workspace / "datasets.sqlite3"
    started = now_iso()
    job_id = job_id or sha256_text(f"{dataset_id}\0{source_dir}\0{started}")[:16]

    if reset and dataset_root.exists():
        shutil.rmtree(dataset_root)

    workspace.mkdir(parents=True, exist_ok=True)
    raw_dir.mkdir(parents=True, exist_ok=True)
    meta_dir.mkdir(parents=True, exist_ok=True)

    files = _iter_supported_files(source_dir, recursive=recursive)
    result = IngestResult(
        job_id=job_id,
        dataset_id=dataset_id,
        dataset_name=dataset_name,
        source_dir=str(source_dir),
        workspace_root=str(workspace),
        dataset_root=str(dataset_root),
        collection_db_path=str(collection_db_path),
        global_db_path=str(global_db_path),
        status="running",
        file_count=len(files),
        started_at=started,
    )

    with connect_sqlite(global_db_path) as global_conn:
        ensure_global_schema(global_conn)
        global_conn.execute(
            """
            INSERT OR REPLACE INTO datasets (
                dataset_id, name, status, source_dir, dataset_root, company_name,
                company_ticker, file_count, created_at, updated_at, metadata_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, COALESCE((SELECT created_at FROM datasets WHERE dataset_id = ?), ?), ?, ?)
            """,
            (
                dataset_id,
                dataset_name,
                "indexing",
                str(source_dir),
                str(dataset_root),
                company_name,
                company_ticker,
                len(files),
                dataset_id,
                started,
                started,
                dumps_json({"pipeline": "private_fund_directory_ingest"}),
            ),
        )
        global_conn.execute(
            "INSERT OR REPLACE INTO dataset_state (id, active_dataset_id, updated_at) VALUES (1, ?, ?)",
            (dataset_id, now_iso()),
        )
        global_conn.commit()

    doc_ids: list[str] = []
    try:
        with connect_sqlite(collection_db_path) as conn:
            ensure_collection_schema(conn)
            conn.execute(
                """
                INSERT OR REPLACE INTO ingest_jobs (
                    job_id, dataset_id, job_type, status, doc_ids_json, file_count,
                    log_path, message, returncode, created_at, started_at, finished_at,
                    metadata_json
                ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, NULL, ?, ?, NULL, ?)
                """,
                (
                    job_id,
                    dataset_id,
                    "private_fund_directory",
                    "running",
                    dumps_json([]),
                    len(files),
                    "Directory ingestion started.",
                    started,
                    started,
                    dumps_json({"source_dir": str(source_dir), "recursive": recursive}),
                ),
            )
            conn.commit()

            for source_path in files:
                stored_path = _copy_to_raw(source_path, raw_dir)
                checksum = sha256_file(stored_path)
                doc_type = _doc_type_for_path(stored_path)
                doc_id = _register_document(
                    conn,
                    dataset_id=dataset_id,
                    stored_path=stored_path,
                    original_filename=source_path.name,
                    checksum=checksum,
                    company_name=company_name,
                    company_ticker=company_ticker,
                    doc_type=doc_type,
                )
                doc_ids.append(doc_id)
                try:
                    if stored_path.suffix.lower() == ".pdf":
                        doc_result = ingest_pdf(conn, dataset_id=dataset_id, doc_id=doc_id, path=stored_path)
                    elif stored_path.suffix.lower() in {".xlsx", ".xlsm"}:
                        doc_result = ingest_excel(conn, dataset_id=dataset_id, doc_id=doc_id, path=stored_path)
                    else:
                        raise ValueError(f"Unsupported file type: {stored_path.suffix}")
                    _update_document_status(conn, doc_id, "indexed")
                    result.documents.append(doc_result)
                except Exception as exc:
                    _update_document_status(conn, doc_id, "failed", str(exc))
                    result.documents.append(
                        DocumentIngestResult(
                            doc_id=doc_id,
                            filename=source_path.name,
                            file_type=stored_path.suffix.lower().lstrip("."),
                            status="failed",
                            error_message=str(exc),
                        )
                    )
                conn.commit()

            total_chunks = conn.execute("SELECT COUNT(*) FROM chunks").fetchone()[0]
            _sync_index_registry(conn, dataset_id, doc_ids, int(total_chunks or 0))
            failures = [doc for doc in result.documents if doc.status == "failed"]
            result.status = "failed" if failures else "completed"
            result.finished_at = now_iso()
            result.message = (
                f"Ingested {len(result.documents)} documents with {len(failures)} failures."
                if failures
                else f"Ingested {len(result.documents)} documents successfully."
            )
            conn.execute(
                """
                UPDATE ingest_jobs
                SET status = ?, doc_ids_json = ?, message = ?, returncode = ?,
                    finished_at = ?, metadata_json = ?
                WHERE job_id = ?
                """,
                (
                    result.status,
                    dumps_json(doc_ids),
                    result.message,
                    1 if failures else 0,
                    result.finished_at,
                    dumps_json(asdict(result)),
                    job_id,
                ),
            )
            conn.commit()
    except Exception:
        result.status = "failed"
        result.finished_at = now_iso()
        result.message = "Directory ingestion failed before completion."
        raise
    finally:
        with connect_sqlite(global_db_path) as global_conn:
            ensure_global_schema(global_conn)
            global_conn.execute(
                "UPDATE datasets SET status = ?, updated_at = ?, file_count = ?, metadata_json = ? WHERE dataset_id = ?",
                (result.status, now_iso(), len(files), dumps_json(asdict(result)), dataset_id),
            )
            global_conn.commit()

    return result


def result_to_dict(result: IngestResult) -> dict[str, Any]:
    return asdict(result)


def main() -> None:
    parser = argparse.ArgumentParser(description="Ingest a private-fund research directory into structured SQLite.")
    parser.add_argument("--directory", required=True, help="Directory containing PDF/Excel documents.")
    parser.add_argument("--workspace-root", default="", help="Output workspace root. Defaults to ./output/private_fund_datasets.")
    parser.add_argument("--dataset-id", default="", help="Dataset id. Defaults to directory name.")
    parser.add_argument("--dataset-name", default="", help="Human readable dataset name.")
    parser.add_argument("--company-name", default="", help="Company name metadata.")
    parser.add_argument("--company-ticker", default="", help="Ticker metadata.")
    parser.add_argument("--no-recursive", action="store_true", help="Only scan direct children.")
    parser.add_argument("--reset", action="store_true", help="Delete the target dataset directory before ingesting.")
    args = parser.parse_args()

    result = ingest_directory(
        directory_path=args.directory,
        workspace_root=args.workspace_root or None,
        dataset_id=args.dataset_id or None,
        dataset_name=args.dataset_name or None,
        company_name=args.company_name,
        company_ticker=args.company_ticker,
        recursive=not args.no_recursive,
        reset=args.reset,
    )
    print(dumps_json(result_to_dict(result)))


if __name__ == "__main__":
    main()
