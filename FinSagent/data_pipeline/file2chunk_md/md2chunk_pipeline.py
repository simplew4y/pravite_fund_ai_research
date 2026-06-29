#!/usr/bin/env python3
"""Standalone Markdown to semantic chunks pipeline."""

from __future__ import annotations

import argparse
import json
import logging
import sys
import uuid
from pathlib import Path

from common import DEFAULT_DOC_TYPE, dump_json, ensure_supported_file, relative_datasets_path, safe_stem, update_document_failure, write_chunks_to_db
from step1_parse_md_to_blocks import parse_markdown_to_blocks
from step2_build_semantic_chunks import build_semantic_chunks
from step3_optional_llm_label import apply_llm_labels


def infer_dataset_root(file_path: Path) -> Path | None:
    parent = file_path.parent
    if parent.name == "md" and parent.parent.name == "0_raw":
        return parent.parent.parent.resolve()
    return None


def setup_logging(dataset_root: Path | None, job_id: str) -> None:
    handlers: list[logging.Handler] = [logging.StreamHandler(sys.stdout)]
    if dataset_root is not None:
        log_path = dataset_root / "logs" / "md" / f"{job_id}.log"
        log_path.parent.mkdir(parents=True, exist_ok=True)
        handlers.append(logging.FileHandler(log_path, encoding="utf-8"))
    logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s", handlers=handlers, force=True)


def run_pipeline(args: argparse.Namespace) -> dict:
    file_path = ensure_supported_file(args.file)
    dataset_root = Path(args.dataset_root).resolve() if args.dataset_root else infer_dataset_root(file_path)
    dataset_id = args.dataset_id or (dataset_root.name if dataset_root is not None else "")
    job_id = args.job_id or uuid.uuid4().hex[:16]
    setup_logging(dataset_root, job_id)
    if args.write_db and (dataset_root is None or not dataset_id or not args.doc_id):
        raise ValueError("--write-db requires --dataset-root (or inferable path), --dataset-id, and --doc-id")

    stem = safe_stem(file_path)
    if dataset_root is not None:
        processed_dir = dataset_root / "1_processed" / "md" / stem
        final_dir = dataset_root / "2_final" / "md" / stem
    else:
        base = Path(args.output_dir or Path.cwd() / "md_outputs").resolve()
        processed_dir = base / "1_processed" / "md" / stem
        final_dir = base / "2_final" / "md" / stem
    processed_dir.mkdir(parents=True, exist_ok=True)
    final_dir.mkdir(parents=True, exist_ok=True)

    blocks_path = processed_dir / "blocks.json"
    raw_chunks_path = final_dir / "base_final.raw.json"
    final_path = final_dir / "base_final.json"
    doc_type = args.doc_type or DEFAULT_DOC_TYPE

    logging.info("Step 1: parsing Markdown %s", file_path)
    dump_json(parse_markdown_to_blocks(file_path), blocks_path)

    logging.info("Step 2: building semantic chunks")
    chunks = build_semantic_chunks(blocks_path, doc_type=doc_type, max_chunk_chars=args.max_chunk_chars)
    dump_json(chunks, raw_chunks_path)

    logging.info("Step 3: optional LLM labeling enabled=%s", bool(args.enable_llm_label))
    chunks = apply_llm_labels(chunks, env_path=args.env, enabled=bool(args.enable_llm_label))
    dump_json(chunks, final_path)

    if args.write_db:
        logging.info("Writing %d Markdown chunks to collection DB", len(chunks))
        write_chunks_to_db(dataset_root=dataset_root, dataset_id=dataset_id, doc_id=args.doc_id, doc_type=doc_type, chunks=chunks)

    result = {
        "file": str(file_path),
        "dataset_root": str(dataset_root) if dataset_root is not None else None,
        "dataset_id": dataset_id or None,
        "doc_id": args.doc_id or None,
        "doc_type": doc_type,
        "blocks_path": relative_datasets_path(blocks_path),
        "base_final_path": relative_datasets_path(final_path),
        "chunk_count": len(chunks),
        "write_db": bool(args.write_db),
    }
    logging.info("Markdown pipeline complete: %s", json.dumps(result, ensure_ascii=False))
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description="Standalone semantic Markdown file2chunk pipeline.")
    parser.add_argument("--file", required=True, help="Path to .md/.markdown file")
    parser.add_argument("--dataset-root", default="")
    parser.add_argument("--dataset-id", default="")
    parser.add_argument("--doc-id", default="")
    parser.add_argument("--doc-type", default=DEFAULT_DOC_TYPE)
    parser.add_argument("--write-db", action="store_true")
    parser.add_argument("--enable-llm-label", action="store_true")
    parser.add_argument("--env", default=str(Path(__file__).resolve().parents[1] / ".env"))
    parser.add_argument("--output-dir", default="")
    parser.add_argument("--job-id", default="")
    parser.add_argument("--max-chunk-chars", type=int, default=6000)
    args = parser.parse_args()
    try:
        print(json.dumps(run_pipeline(args), ensure_ascii=False, indent=2))
    except Exception as exc:
        if args.write_db and args.doc_id:
            dataset_root = Path(args.dataset_root).resolve() if args.dataset_root else infer_dataset_root(Path(args.file).resolve())
            if dataset_root is not None:
                update_document_failure(dataset_root, args.doc_id, str(exc))
        raise


if __name__ == "__main__":
    main()
