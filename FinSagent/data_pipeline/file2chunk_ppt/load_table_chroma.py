#!/usr/bin/env python3
"""Load PPT table artifacts into table_chroma."""

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

DEFAULT_CONFIG = PROJECT_ROOT / "config" / "production.yaml"
LOGGER = logging.getLogger(__name__)


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def load_config(config_path: str | Path) -> dict[str, Any]:
    with Path(config_path).open("r", encoding="utf-8") as fh:
        return yaml.safe_load(fh) or {}


def sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


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
    cfg["persist_directory"] = str(dataset_root / "5_database")
    cfg["collection_name"] = collection_name
    cfg["pageindex_index_dir"] = str(dataset_root / "5_database" / "pageindex")
    cfg.setdefault("allow_missing_bm25_index", True)
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


def iter_table_artifacts(table_dir: str | Path, include_all: bool = False) -> Iterable[Path]:
    root = Path(table_dir).resolve()
    if root.is_file():
        yield root
        return
    if not root.exists():
        return
    for path in sorted(root.rglob("*_table_reconstructed.json")):
        if include_all or path.name.endswith("_ppt_table_reconstructed.json"):
            yield path


def load_json(path: str | Path) -> Any:
    return json.loads(Path(path).read_text(encoding="utf-8"))


def first_text(value: Any) -> str:
    if isinstance(value, list):
        return " ".join(str(item) for item in value if str(item).strip()).strip()
    return str(value or "").strip()


def iter_ppt_tables(table_file: Path) -> Iterable[tuple[str, str, dict[str, Any], str]]:
    rel_source = relative_datasets_path(table_file)
    items = load_json(table_file)
    if not isinstance(items, list):
        raise ValueError(f"table artifact must contain a list: {table_file}")
    for idx, item in enumerate(items, start=1):
        if not isinstance(item, dict):
            continue
        content = str(item.get("content") or "").strip()
        summary = str(item.get("summary") or "").strip()
        if not content or not summary:
            continue
        caption = first_text(item.get("table_caption"))
        footnote = first_text(item.get("table_footnote"))
        embed_text = f"CAPTION:\n{caption}\n\nSUMMARY:\n{summary}\n\nFOOTNOTE:\n{footnote}\n"
        original_index = item.get("original_index")
        table_id = sha256_text(f"ppt-table\0{rel_source}\0{idx}\0{sha256_text(content)}")[:40]
        metadata = clean_metadata(
            {
                "source_file": rel_source,
                "table_index": idx,
                "page_idx": "",
                "table_caption": caption,
                "table_footnote": footnote,
                "original_img_path": item.get("original_img_path") or "",
                "original_index": original_index if original_index is not None else idx,
                "content": content,
                "summary": summary,
                "content_type": "ppt_table",
                "file_type": "ppt",
                "source_type": item.get("source_type") or "ppt_table",
                "source_locations_json": json.dumps(item.get("source_locations") or [], ensure_ascii=False),
                "metadata_json": json.dumps(item.get("metadata") or {}, ensure_ascii=False),
            }
        )
        yield table_id, embed_text, metadata, rel_source


def delete_source(collection: Any, source_file: str) -> int:
    try:
        existing = collection.get(where={"source_file": source_file}, include=[])
    except Exception:
        LOGGER.warning("Unable to query existing table_chroma docs for source_file=%s", source_file, exc_info=True)
        return 0
    ids = existing.get("ids") or []
    if ids:
        collection.delete(ids=ids)
    return len(ids)


def update_index_registry(dataset_root: Path, dataset_id: str, collection_name: str, table_count: int) -> None:
    if table_count <= 0:
        return
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
        index_path = dataset_root / "5_database" / "table_chroma"
        conn.execute(
            """
            INSERT OR REPLACE INTO index_registry (
                index_id, dataset_id, index_type, collection_name, index_path,
                source_doc_ids_json, source_chunk_count, status, built_at,
                error_message, metadata_json
            ) VALUES (?, ?, 'table_chroma', ?, ?, ?, ?, 'ready', ?, NULL, ?)
            """,
            (
                sha256_text(f"{dataset_id}\0table_chroma\0{relative_datasets_path(index_path)}")[:40],
                dataset_id,
                collection_name,
                relative_datasets_path(index_path),
                json.dumps([], ensure_ascii=False),
                table_count,
                now_iso(),
                json.dumps({"loader": "file2chunk_ppt.load_table_chroma"}, ensure_ascii=False),
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


def load_ppt_tables(
    *,
    config_path: Path,
    dataset_root: Path,
    table_dir: Path,
    collection_name: str,
    batch_size: int,
    reset_collection: bool,
    include_all_table_artifacts: bool,
) -> dict[str, Any]:
    config = configure_for_dataset(load_config(config_path), dataset_root, collection_name)
    rag = RAGManager(config)
    rag.create_collection(collection_name)
    _, _, table_chroma = rag._collections[collection_name]
    if table_chroma is None:
        raise RuntimeError("table_chroma is not initialized for this collection")
    if reset_collection:
        table_chroma.reset_collection()

    ids: list[str] = []
    texts: list[str] = []
    metadatas: list[dict[str, Any]] = []
    source_files: set[str] = set()
    deleted = 0
    for table_file in iter_table_artifacts(table_dir, include_all=include_all_table_artifacts):
        source_file = relative_datasets_path(table_file)
        source_files.add(source_file)
        if not reset_collection:
            deleted += delete_source(table_chroma, source_file)
        for table_id, embed_text, metadata, _ in iter_ppt_tables(table_file):
            ids.append(table_id)
            texts.append(embed_text)
            metadatas.append(metadata)

    for start in tqdm(range(0, len(texts), batch_size), desc="Storing ppt tables"):
        end = start + batch_size
        embeddings = rag.embeddings.embed_documents(texts[start:end])
        table_chroma.add_texts(texts=texts[start:end], metadatas=metadatas[start:end], ids=ids[start:end], embeddings=embeddings)

    if texts:
        update_index_registry(dataset_root, dataset_root.name, collection_name, len(texts))
        mark_dataset_indexed(dataset_root, dataset_root.name)
    return {
        "dataset_root": str(dataset_root),
        "collection_name": collection_name,
        "table_dir": str(table_dir),
        "source_files": sorted(source_files),
        "stored_tables": len(texts),
        "deleted_existing_tables": deleted,
        "reset_collection": reset_collection,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Load PPT table artifacts into table_chroma.")
    parser.add_argument("--config", default=str(DEFAULT_CONFIG))
    parser.add_argument("--dataset-root", default="")
    parser.add_argument("--table-dir", default="", help="defaults to {dataset_root}/4_processed_table")
    parser.add_argument("--collection", default="")
    parser.add_argument("--batch-size", type=int, default=64)
    parser.add_argument("--reset-collection", action="store_true")
    parser.add_argument("--include-all-table-artifacts", action="store_true", help="Also load non-PPT *_table_reconstructed.json files.")
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s")
    dataset_root = Path(args.dataset_root).resolve() if args.dataset_root else None
    table_dir = Path(args.table_dir).resolve() if args.table_dir else None
    if dataset_root is None and table_dir is not None:
        dataset_root = infer_dataset_root(table_dir)
    if dataset_root is None:
        raise ValueError("--dataset-root is required unless --table-dir is under a datasets/{dataset_id} directory")
    if table_dir is None:
        table_dir = dataset_root / "4_processed_table"
    collection_name = args.collection or dataset_root.name
    result = load_ppt_tables(
        config_path=Path(args.config),
        dataset_root=dataset_root,
        table_dir=table_dir,
        collection_name=collection_name,
        batch_size=args.batch_size,
        reset_collection=bool(args.reset_collection),
        include_all_table_artifacts=bool(args.include_all_table_artifacts),
    )
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
