#!/usr/bin/env python3
"""Standalone Excel to semantic chunks pipeline."""

from __future__ import annotations

import argparse
import json
import logging
import sys
import uuid
from pathlib import Path
from typing import Any

from common import (
    DEFAULT_DOC_TYPE,
    connect_collection,
    dump_json,
    ensure_supported_excel,
    now_iso,
    relative_datasets_path,
    safe_stem,
    sha256_text,
    update_document_failure,
)
from step1_inspect_workbook import inspect_workbook
from step2_classify_workbook import classify_workbook
from step3_detect_regions import detect_regions
from step4_build_semantic_chunks import build_semantic_chunks
from step5_optional_llm_label import apply_llm_labels


def infer_dataset_root(excel_path: Path) -> Path | None:
    parent = excel_path.parent
    if parent.name == "excel" and parent.parent.name == "0_raw":
        return parent.parent.parent.resolve()
    return None


def setup_logging(dataset_root: Path | None, job_id: str) -> Path | None:
    handlers: list[logging.Handler] = [logging.StreamHandler(sys.stdout)]
    log_path = None
    if dataset_root is not None:
        log_path = dataset_root / "logs" / "excel" / f"{job_id}.log"
        log_path.parent.mkdir(parents=True, exist_ok=True)
        handlers.append(logging.FileHandler(log_path, encoding="utf-8"))
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s - %(levelname)s - %(message)s",
        handlers=handlers,
        force=True,
    )
    return log_path


def _title_path_text(chunk: dict[str, Any]) -> str:
    title_path = chunk.get("title_path")
    if isinstance(title_path, list):
        return " > ".join(str(item) for item in title_path if item)
    return str(title_path or chunk.get("title") or "")


def _chunk_rows(dataset_id: str, doc_id: str, chunks: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    now = now_iso()
    chunk_rows: list[dict[str, Any]] = []
    location_rows: list[dict[str, Any]] = []
    chunk_ids: list[str] = []

    for idx, chunk in enumerate(chunks, start=1):
        content = str(chunk.get("content") or "")
        content_hash = chunk.get("content_hash") or sha256_text(content)
        source_ref = str(chunk.get("source_ref") or "")
        chunk_id = sha256_text(f"{doc_id}\0{idx}\0{source_ref}\0{content_hash}")[:40]
        chunk_ids.append(chunk_id)
        title_text = _title_path_text(chunk)
        metadata = dict(chunk.get("metadata") or {})
        metadata.update(
            {
                "source": "file2chunk_excel",
                "source_ref": source_ref,
                "source_locations": chunk.get("source_locations") or [],
            }
        )
        chunk_rows.append(
            {
                "chunk_id": chunk_id,
                "dataset_id": dataset_id,
                "doc_id": doc_id,
                "chunk_index": idx,
                "content": content,
                "content_type": chunk.get("content_type") or "excel_section",
                "title_path": title_text,
                "summary": chunk.get("summary") or None,
                "token_count": None,
                "content_hash": content_hash,
                "prev_chunk_id": None,
                "next_chunk_id": None,
                "source_ref": source_ref or None,
                "metadata_json": json.dumps(metadata, ensure_ascii=False),
                "created_at": now,
            }
        )

        locations = chunk.get("source_locations") or []
        if not locations:
            locations = [
                {
                    "sheet_name": chunk.get("sheet_name"),
                    "cell_range": chunk.get("cell_range"),
                    "region_type": chunk.get("content_type"),
                }
            ]
        for loc_index, loc in enumerate(locations):
            sheet_name = loc.get("sheet_name")
            cell_range = loc.get("cell_range")
            display = f"{sheet_name}!{cell_range}" if sheet_name and cell_range else source_ref or title_text
            location_rows.append(
                {
                    "location_id": sha256_text(f"{chunk_id}\0{loc_index}\0{display}")[:40],
                    "chunk_id": chunk_id,
                    "doc_id": doc_id,
                    "location_index": loc_index,
                    "page_start": None,
                    "page_end": None,
                    "page_numbers_json": None,
                    "slide_start": None,
                    "slide_end": None,
                    "sheet_name": sheet_name,
                    "cell_range": cell_range,
                    "heading_path": title_text,
                    "bbox_json": None,
                    "source_refs_json": json.dumps([display], ensure_ascii=False) if display else None,
                    "display_text": display or title_text,
                    "metadata_json": json.dumps(loc, ensure_ascii=False),
                }
            )

    for idx, row in enumerate(chunk_rows):
        row["prev_chunk_id"] = chunk_ids[idx - 1] if idx > 0 else None
        row["next_chunk_id"] = chunk_ids[idx + 1] if idx + 1 < len(chunk_ids) else None
    return chunk_rows, location_rows


def write_chunks_to_db(
    *,
    dataset_root: Path,
    dataset_id: str,
    doc_id: str,
    doc_type: str,
    chunks: list[dict[str, Any]],
) -> None:
    chunk_rows, location_rows = _chunk_rows(dataset_id, doc_id, chunks)
    with connect_collection(dataset_root) as conn:
        doc = conn.execute("SELECT * FROM documents WHERE doc_id = ?", (doc_id,)).fetchone()
        if doc is None:
            raise ValueError(f"document not found in collection.sqlite3: {doc_id}")
        conn.execute("DELETE FROM chunk_locations WHERE doc_id = ?", (doc_id,))
        conn.execute("DELETE FROM chunks WHERE doc_id = ?", (doc_id,))
        if chunk_rows:
            conn.executemany(
                """
                INSERT INTO chunks (
                    chunk_id, dataset_id, doc_id, chunk_index, content,
                    content_type, title_path, summary, token_count, content_hash,
                    prev_chunk_id, next_chunk_id, source_ref, metadata_json, created_at
                ) VALUES (
                    :chunk_id, :dataset_id, :doc_id, :chunk_index, :content,
                    :content_type, :title_path, :summary, :token_count, :content_hash,
                    :prev_chunk_id, :next_chunk_id, :source_ref, :metadata_json, :created_at
                )
                """,
                chunk_rows,
            )
            conn.executemany(
                """
                INSERT INTO chunk_locations (
                    location_id, chunk_id, doc_id, location_index, page_start,
                    page_end, page_numbers_json, slide_start, slide_end,
                    sheet_name, cell_range, heading_path, bbox_json,
                    source_refs_json, display_text, metadata_json
                ) VALUES (
                    :location_id, :chunk_id, :doc_id, :location_index, :page_start,
                    :page_end, :page_numbers_json, :slide_start, :slide_end,
                    :sheet_name, :cell_range, :heading_path, :bbox_json,
                    :source_refs_json, :display_text, :metadata_json
                )
                """,
                location_rows,
            )
        conn.execute(
            """
            UPDATE documents
            SET doc_type = ?, status = ?, chunk_count = ?, error_message = NULL,
                updated_at = ?
            WHERE doc_id = ?
            """,
            (doc_type, "parsed", len(chunk_rows), now_iso(), doc_id),
        )
        conn.commit()


def run_pipeline(args: argparse.Namespace) -> dict[str, Any]:
    excel_path = ensure_supported_excel(args.excel)
    dataset_root = Path(args.dataset_root).resolve() if args.dataset_root else infer_dataset_root(excel_path)
    dataset_id = args.dataset_id or (dataset_root.name if dataset_root is not None else "")
    job_id = args.job_id or uuid.uuid4().hex[:16]
    setup_logging(dataset_root, job_id)

    if args.write_db and (dataset_root is None or not dataset_id or not args.doc_id):
        raise ValueError("--write-db requires --dataset-root (or inferable path), --dataset-id, and --doc-id")

    stem = safe_stem(excel_path)
    if dataset_root is not None:
        processed_dir = dataset_root / "1_processed" / "excel" / stem
        final_dir = dataset_root / "2_final" / "excel" / stem
    else:
        base = Path(args.output_dir or Path.cwd() / "excel_outputs").resolve()
        processed_dir = base / "1_processed" / "excel" / stem
        final_dir = base / "2_final" / "excel" / stem
    processed_dir.mkdir(parents=True, exist_ok=True)
    final_dir.mkdir(parents=True, exist_ok=True)

    manifest_path = processed_dir / "workbook_manifest.json"
    classification_path = processed_dir / "classification.json"
    regions_path = processed_dir / "regions.json"
    raw_chunks_path = final_dir / "base_final.raw.json"
    final_path = final_dir / "base_final.json"
    doc_type = args.doc_type or DEFAULT_DOC_TYPE

    logging.info("Step 1: inspecting workbook %s", excel_path)
    dump_json(inspect_workbook(excel_path), manifest_path)

    logging.info("Step 2: classifying workbook")
    dump_json(classify_workbook(manifest_path), classification_path)

    logging.info("Step 3: detecting source regions")
    dump_json(detect_regions(excel_path, manifest_path, classification_path), regions_path)

    logging.info("Step 4: building semantic chunks")
    chunks = build_semantic_chunks(
        excel_path,
        regions_path,
        classification_path,
        doc_type=doc_type,
        max_preview_rows=args.max_preview_rows,
        max_preview_cols=args.max_preview_cols,
        max_chunk_chars=args.max_chunk_chars,
    )
    dump_json(chunks, raw_chunks_path)

    logging.info("Step 5: optional LLM labeling enabled=%s", bool(args.enable_llm_label))
    chunks = apply_llm_labels(chunks, env_path=args.env, enabled=bool(args.enable_llm_label))
    dump_json(chunks, final_path)

    if args.write_db:
        logging.info("Writing %d semantic Excel chunks to collection DB", len(chunks))
        write_chunks_to_db(
            dataset_root=dataset_root,
            dataset_id=dataset_id,
            doc_id=args.doc_id,
            doc_type=doc_type,
            chunks=chunks,
        )

    classification = json.loads(classification_path.read_text(encoding="utf-8"))
    regions = json.loads(regions_path.read_text(encoding="utf-8"))
    result = {
        "excel": str(excel_path),
        "dataset_root": str(dataset_root) if dataset_root is not None else None,
        "dataset_id": dataset_id or None,
        "doc_id": args.doc_id or None,
        "doc_type": doc_type,
        "workbook_type": classification.get("workbook_type"),
        "region_count": len(regions.get("regions", [])),
        "chunk_count": len(chunks),
        "manifest_path": relative_datasets_path(manifest_path),
        "classification_path": relative_datasets_path(classification_path),
        "regions_path": relative_datasets_path(regions_path),
        "base_final_path": relative_datasets_path(final_path),
        "write_db": bool(args.write_db),
    }
    logging.info("Excel pipeline complete: %s", json.dumps(result, ensure_ascii=False))
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description="Standalone semantic Excel file2chunk pipeline.")
    parser.add_argument("--excel", required=True, help="Path to .xlsx/.xlsm file")
    parser.add_argument("--dataset-root", default="", help="Dataset root, e.g. /.../datasets/dataset_xxx")
    parser.add_argument("--dataset-id", default="", help="Dataset id; defaults to dataset root directory name")
    parser.add_argument("--doc-id", default="", help="Document id in collection.sqlite3")
    parser.add_argument("--doc-type", default=DEFAULT_DOC_TYPE, help="Document type written to documents.doc_type")
    parser.add_argument("--write-db", action="store_true", help="Write chunks/locations to collection.sqlite3")
    parser.add_argument("--enable-llm-label", action="store_true", help="Enable optional LLM chunk labeling")
    parser.add_argument("--env", default=str(Path(__file__).resolve().parents[1] / ".env"), help="Path to data_pipeline/.env")
    parser.add_argument("--output-dir", default="", help="Output base dir when not running inside a dataset")
    parser.add_argument("--job-id", default="", help="Optional job id for log filename")
    parser.add_argument("--max-preview-rows", type=int, default=80)
    parser.add_argument("--max-preview-cols", type=int, default=24)
    parser.add_argument("--max-chunk-chars", type=int, default=6000)
    args = parser.parse_args()

    try:
        result = run_pipeline(args)
        print(json.dumps(result, ensure_ascii=False, indent=2))
    except Exception as exc:
        if args.write_db:
            dataset_root = Path(args.dataset_root).resolve() if args.dataset_root else infer_dataset_root(Path(args.excel).resolve())
            if dataset_root is not None and args.doc_id:
                update_document_failure(dataset_root, args.doc_id, str(exc))
        raise


if __name__ == "__main__":
    main()
