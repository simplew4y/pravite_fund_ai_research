#!/usr/bin/env python3
"""Load PPT slide/notes chunks into Chroma, TS-Chroma, and BM25."""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import logging
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

import yaml
from tqdm import tqdm

PROJECT_ROOT = Path(__file__).resolve().parents[2]
SRC_DIR = PROJECT_ROOT / "src"
if str(SRC_DIR) not in sys.path:
    sys.path.insert(0, str(SRC_DIR))

from core.RAGManager import RAGManager  # noqa: E402
from utils.bm25Retriever import load_from_chroma_and_save  # noqa: E402

DEFAULT_CONFIG = PROJECT_ROOT / "config" / "production.yaml"
TEXT_CONTENT_TYPES = {"ppt_slide", "ppt_notes"}
LOGGER = logging.getLogger(__name__)


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def load_config(config_path: str | Path) -> dict[str, Any]:
    with Path(config_path).open("r", encoding="utf-8") as fh:
        return yaml.safe_load(fh) or {}


def sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def title_path_text(value: Any) -> str:
    if isinstance(value, list):
        return " > ".join(str(item) for item in value if str(item).strip())
    return str(value or "")


def relative_datasets_path(path: str | Path) -> str:
    resolved = Path(path).resolve()
    parts = resolved.parts
    if "datasets" in parts:
        idx = parts.index("datasets")
        return "/".join(parts[idx:])
    return resolved.as_posix()


def infer_dataset_root(path: str | Path) -> Path | None:
    resolved = Path(path).resolve()
    parts = resolved.parts
    if "datasets" not in parts:
        return None
    idx = parts.index("datasets")
    if len(parts) <= idx + 1:
        return None
    return Path(*parts[: idx + 2]).resolve()


def configure_for_dataset(config: dict[str, Any], dataset_root: Path, collection_name: str) -> dict[str, Any]:
    cfg = copy.deepcopy(config)
    persist_dir = dataset_root / "5_database"
    cfg["persist_directory"] = str(persist_dir)
    cfg["collection_name"] = collection_name
    cfg["pageindex_index_dir"] = str(persist_dir / "pageindex")
    cfg.setdefault("allow_missing_bm25_index", True)
    agentic = cfg.get("agentic_search")
    if isinstance(agentic, dict):
        agentic["roots"] = [str(dataset_root)]
    return cfg


def clean_metadata(metadata: dict[str, Any]) -> dict[str, Any]:
    cleaned: dict[str, Any] = {}
    for key, value in metadata.items():
        if value is None:
            cleaned[key] = ""
        elif isinstance(value, (str, int, float, bool)):
            cleaned[key] = value
        else:
            cleaned[key] = json.dumps(value, ensure_ascii=False)
    return cleaned


def iter_base_final_files(base_dir: str | Path) -> Iterable[Path]:
    root = Path(base_dir).resolve()
    if root.is_file():
        if root.name == "base_final.json":
            yield root
        return
    if root.exists():
        yield from sorted(path for path in root.rglob("base_final.json") if path.is_file())


def load_json(path: str | Path) -> Any:
    return json.loads(Path(path).read_text(encoding="utf-8"))


def title_summary_for_chunk(chunk: dict[str, Any], title_path: str) -> str:
    summary = str(chunk.get("summary") or "").strip()
    if summary:
        return f"title: {title_path}\nsummary: {summary}"
    slide_number = chunk.get("slide_number")
    suffix = f"\nsource: slide {slide_number}" if slide_number else ""
    return f"title: {title_path}{suffix}"


def iter_text_chunks(base_final: Path) -> Iterable[tuple[str, dict[str, Any]]]:
    rel_source = relative_datasets_path(base_final)
    data = load_json(base_final)
    if not isinstance(data, list):
        raise ValueError(f"base_final.json must contain a list: {base_final}")
    for local_idx, chunk in enumerate(data, start=1):
        if not isinstance(chunk, dict):
            continue
        content_type = str(chunk.get("content_type") or chunk.get("type") or "ppt_slide")
        if content_type not in TEXT_CONTENT_TYPES:
            continue
        content = str(chunk.get("content") or "").strip()
        if not content:
            continue
        title_path = title_path_text(chunk.get("title_path") or chunk.get("title"))
        source_ref = str(chunk.get("source_ref") or "")
        content_hash = str(chunk.get("content_hash") or sha256_text(content))
        doc_id = sha256_text(f"{rel_source}\0{local_idx}\0{content_hash}")[:40]
        metadata = {
            "filename": base_final.parent.name,
            "file_name": base_final.parent.name,
            "source_file": rel_source,
            "source": rel_source,
            "source_ref": source_ref,
            "source_doc_id": base_final.parent.name,
            "doc_id": doc_id,
            "chunk_index": int(chunk.get("chunk_index") or local_idx),
            "global_id": 0,
            "page_number": -1,
            "date_published": "",
            "content_type": content_type,
            "file_type": "ppt",
            "title_path": title_path,
            "slide_number": chunk.get("slide_number") or "",
            "title_summary": title_summary_for_chunk(chunk, title_path),
            "metadata_json": json.dumps(chunk.get("metadata") or {}, ensure_ascii=False),
        }
        yield content, clean_metadata(metadata)


def delete_source(collection: Any, source_file: str) -> int:
    try:
        existing = collection.get(where={"source_file": source_file}, include=[])
    except Exception:
        LOGGER.warning("Unable to query existing Chroma docs for source_file=%s", source_file, exc_info=True)
        return 0
    ids = existing.get("ids") or []
    if ids:
        collection.delete(ids=ids)
    return len(ids)


def add_in_batches(collection: Any, texts: list[str], metadatas: list[dict[str, Any]], ids: list[str], batch_size: int) -> None:
    for start in tqdm(range(0, len(texts), batch_size), desc="Storing ppt chunks"):
        end = start + batch_size
        collection.add_texts(texts=texts[start:end], metadatas=metadatas[start:end], ids=ids[start:end])


def add_title_summaries(ts_chroma: Any, metadatas: list[dict[str, Any]], batch_size: int) -> int:
    seen: set[str] = set()
    texts: list[str] = []
    ids: list[str] = []
    ts_metadatas: list[dict[str, Any]] = []
    for metadata in metadatas:
        text = str(metadata.get("title_summary") or "").strip()
        if not text or text in seen:
            continue
        seen.add(text)
        texts.append(text)
        ids.append(sha256_text(f"ppt-ts\0{metadata.get('source_file')}\0{text}")[:40])
        ts_metadatas.append(clean_metadata({"source_file": metadata.get("source_file"), "file_type": "ppt"}))
    for start in tqdm(range(0, len(texts), batch_size), desc="Storing ppt title summaries"):
        end = start + batch_size
        ts_chroma.add_texts(texts=texts[start:end], metadatas=ts_metadatas[start:end], ids=ids[start:end])
    return len(texts)


def update_index_registry(dataset_root: Path, dataset_id: str, collection_name: str, counts: dict[str, int]) -> None:
    db_path = dataset_root / "meta" / "collection.sqlite3"
    if not db_path.exists():
        return
    conn = sqlite3.connect(db_path)
    try:
        conn.executescript(
            """
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
            """
        )
        built_at = now_iso()
        paths = {
            "chroma": dataset_root / "5_database" / "chroma",
            "ts_chroma": dataset_root / "5_database" / "ts_chroma",
            "bm25": dataset_root / "5_database" / "bm25_index" / collection_name,
        }
        for index_type, path in paths.items():
            count = counts.get(index_type, counts.get("chroma", 0))
            if count <= 0:
                continue
            conn.execute(
                """
                INSERT OR REPLACE INTO index_registry (
                    index_id, dataset_id, index_type, collection_name, index_path,
                    source_doc_ids_json, source_chunk_count, status, built_at,
                    error_message, metadata_json
                ) VALUES (?, ?, ?, ?, ?, ?, ?, 'ready', ?, NULL, ?)
                """,
                (
                    sha256_text(f"{dataset_id}\0{index_type}\0{relative_datasets_path(path)}")[:40],
                    dataset_id,
                    index_type,
                    collection_name,
                    relative_datasets_path(path),
                    json.dumps([], ensure_ascii=False),
                    count,
                    built_at,
                    json.dumps({"loader": "file2chunk_ppt.load_data"}, ensure_ascii=False),
                ),
            )
        conn.commit()
    finally:
        conn.close()


def mark_dataset_indexed(dataset_root: Path, dataset_id: str) -> None:
    registry = dataset_root.parent / "datasets.sqlite3"
    if not registry.exists():
        return
    try:
        conn = sqlite3.connect(registry)
        try:
            conn.execute("UPDATE datasets SET status = 'indexed', updated_at = ? WHERE dataset_id = ?", (now_iso(), dataset_id))
            conn.commit()
        finally:
            conn.close()
    except sqlite3.Error:
        LOGGER.warning("Unable to update global dataset status for %s", dataset_id, exc_info=True)


def load_ppt_data(
    *,
    config_path: Path,
    dataset_root: Path,
    base_dir: Path,
    collection_name: str,
    batch_size: int,
    reset_collection: bool,
    build_bm25: bool,
) -> dict[str, Any]:
    config = configure_for_dataset(load_config(config_path), dataset_root, collection_name)
    rag = RAGManager(config)
    rag.create_collection(collection_name)
    chroma, ts_chroma, _ = rag._collections[collection_name]
    if reset_collection:
        chroma.reset_collection()
        ts_chroma.reset_collection()

    texts: list[str] = []
    metadatas: list[dict[str, Any]] = []
    ids: list[str] = []
    source_files: set[str] = set()
    deleted = 0
    for base_final in iter_base_final_files(base_dir):
        source_file = relative_datasets_path(base_final)
        source_files.add(source_file)
        if not reset_collection:
            deleted += delete_source(chroma, source_file)
            delete_source(ts_chroma, source_file)
        for content, metadata in iter_text_chunks(base_final):
            metadata["global_id"] = len(metadatas)
            texts.append(content)
            metadatas.append(metadata)
            ids.append(str(metadata["doc_id"]))

    for idx, metadata in enumerate(metadatas):
        same_prev = idx > 0 and metadata.get("source_file") == metadatas[idx - 1].get("source_file")
        same_next = idx + 1 < len(metadatas) and metadata.get("source_file") == metadatas[idx + 1].get("source_file")
        metadata["prev_chunk_id"] = ids[idx - 1] if same_prev else ""
        metadata["next_chunk_id"] = ids[idx + 1] if same_next else ""

    if texts:
        add_in_batches(chroma, texts, metadatas, ids, batch_size)
    title_count = add_title_summaries(ts_chroma, metadatas, batch_size)

    bm25_count = 0
    if build_bm25:
        documents = rag.get_collection_documents(collection_name)
        bm25_count = len(documents)
        bm25_save_dir = dataset_root / "5_database" / "bm25_index" / collection_name
        load_from_chroma_and_save(documents, str(bm25_save_dir))

    if texts or title_count or bm25_count:
        update_index_registry(
            dataset_root,
            dataset_root.name,
            collection_name,
            {"chroma": len(texts), "ts_chroma": title_count, "bm25": bm25_count},
        )
        mark_dataset_indexed(dataset_root, dataset_root.name)
    return {
        "dataset_root": str(dataset_root),
        "collection_name": collection_name,
        "base_dir": str(base_dir),
        "source_files": sorted(source_files),
        "stored_chunks": len(texts),
        "stored_title_summaries": title_count,
        "deleted_existing_chunks": deleted,
        "bm25_documents": bm25_count,
        "reset_collection": reset_collection,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Load PPT semantic chunks into Chroma/TS-Chroma/BM25.")
    parser.add_argument("--config", default=str(DEFAULT_CONFIG))
    parser.add_argument("--dataset-root", default="")
    parser.add_argument("--base-dir", default="", help="base_final root; defaults to {dataset_root}/2_final/ppt")
    parser.add_argument("--collection", default="")
    parser.add_argument("--batch-size", type=int, default=64)
    parser.add_argument("--reset-collection", action="store_true")
    parser.add_argument("--no-bm25", action="store_true")
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s")
    dataset_root = Path(args.dataset_root).resolve() if args.dataset_root else None
    base_dir = Path(args.base_dir).resolve() if args.base_dir else None
    if dataset_root is None and base_dir is not None:
        dataset_root = infer_dataset_root(base_dir)
    if dataset_root is None:
        raise ValueError("--dataset-root is required unless --base-dir is under a datasets/{dataset_id} directory")
    if base_dir is None:
        base_dir = dataset_root / "2_final" / "ppt"
    collection_name = args.collection or dataset_root.name
    result = load_ppt_data(
        config_path=Path(args.config),
        dataset_root=dataset_root,
        base_dir=base_dir,
        collection_name=collection_name,
        batch_size=args.batch_size,
        reset_collection=bool(args.reset_collection),
        build_bm25=not bool(args.no_bm25),
    )
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
