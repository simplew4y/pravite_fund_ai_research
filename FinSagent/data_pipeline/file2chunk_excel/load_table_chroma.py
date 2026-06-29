#!/usr/bin/env python3
"""Load Excel table chunks into table_chroma."""

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


def extract_table_markdown(content: str) -> str:
    marker = "Table preview:"
    if marker in content:
        return content.split(marker, 1)[1].strip()
    return content.strip()


def table_summary(chunk: dict[str, Any], title_path: str, content: str) -> str:
    summary = str(chunk.get("summary") or "").strip()
    if summary:
        return summary
    sheet = str(chunk.get("sheet_name") or "").strip()
    cell_range = str(chunk.get("cell_range") or "").strip()
    preview = " ".join(line.strip(" |") for line in extract_table_markdown(content).splitlines()[:5] if line.strip())[:360]
    source = f"{sheet}!{cell_range}" if sheet and cell_range else str(chunk.get("source_ref") or "")
    return f"{title_path} Excel table from {source}. Sample values: {preview}".strip()


def iter_excel_tables(base_final: Path) -> Iterable[tuple[str, str, dict[str, Any], str]]:
    rel_source = relative_datasets_path(base_final)
    data = load_json(base_final)
    if not isinstance(data, list):
        raise ValueError(f"base_final.json must contain a list: {base_final}")
    for idx, chunk in enumerate(data, start=1):
        if not isinstance(chunk, dict):
            continue
        content_type = str(chunk.get("content_type") or chunk.get("type") or "")
        if content_type != "excel_table":
            continue
        content = str(chunk.get("content") or "").strip()
        if not content:
            continue
        title_path = title_path_text(chunk.get("title_path") or chunk.get("title"))
        summary = table_summary(chunk, title_path, content)
        sheet = str(chunk.get("sheet_name") or "").strip()
        cell_range = str(chunk.get("cell_range") or "").strip()
        caption_parts = [part for part in [title_path, f"{sheet}!{cell_range}" if sheet and cell_range else ""] if part]
        caption = " | ".join(caption_parts) or base_final.parent.name
        embed_text = f"CAPTION:\n{caption}\n\nSUMMARY:\n{summary}\n"
        table_id = sha256_text(f"excel-table\0{rel_source}\0{idx}\0{sha256_text(content)}")[:40]
        metadata = clean_metadata(
            {
                "source_file": rel_source,
                "table_index": int(chunk.get("chunk_index") or idx),
                "page_idx": "",
                "table_caption": caption,
                "table_footnote": "",
                "original_img_path": "",
                "original_index": int(chunk.get("chunk_index") or idx),
                "content": content,
                "summary": summary,
                "content_type": "excel_table",
                "file_type": "excel",
                "title_path": title_path,
                "sheet_name": sheet,
                "cell_range": cell_range,
                "source_ref": chunk.get("source_ref") or "",
                "source_locations_json": json.dumps(chunk.get("source_locations") or [], ensure_ascii=False),
                "metadata_json": json.dumps(chunk.get("metadata") or {}, ensure_ascii=False),
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
                json.dumps({"loader": "file2chunk_excel.load_table_chroma"}, ensure_ascii=False),
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


def load_excel_tables(
    *,
    config_path: Path,
    dataset_root: Path,
    base_dir: Path,
    collection_name: str,
    batch_size: int,
    reset_collection: bool,
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
    for base_final in iter_base_final_files(base_dir):
        source_file = relative_datasets_path(base_final)
        source_files.add(source_file)
        if not reset_collection:
            deleted += delete_source(table_chroma, source_file)
        for table_id, embed_text, metadata, _ in iter_excel_tables(base_final):
            ids.append(table_id)
            texts.append(embed_text)
            metadatas.append(metadata)

    for start in tqdm(range(0, len(texts), batch_size), desc="Storing excel tables"):
        end = start + batch_size
        embeddings = rag.embeddings.embed_documents(texts[start:end])
        table_chroma.add_texts(texts=texts[start:end], metadatas=metadatas[start:end], ids=ids[start:end], embeddings=embeddings)

    if texts:
        update_index_registry(dataset_root, dataset_root.name, collection_name, len(texts))
        mark_dataset_indexed(dataset_root, dataset_root.name)
    return {
        "dataset_root": str(dataset_root),
        "collection_name": collection_name,
        "base_dir": str(base_dir),
        "source_files": sorted(source_files),
        "stored_tables": len(texts),
        "deleted_existing_tables": deleted,
        "reset_collection": reset_collection,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Load Excel table chunks into table_chroma.")
    parser.add_argument("--config", default=str(DEFAULT_CONFIG))
    parser.add_argument("--dataset-root", default="")
    parser.add_argument("--base-dir", default="", help="base_final root; defaults to {dataset_root}/2_final/excel")
    parser.add_argument("--collection", default="")
    parser.add_argument("--batch-size", type=int, default=64)
    parser.add_argument("--reset-collection", action="store_true")
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s")
    dataset_root = Path(args.dataset_root).resolve() if args.dataset_root else None
    base_dir = Path(args.base_dir).resolve() if args.base_dir else None
    if dataset_root is None and base_dir is not None:
        dataset_root = infer_dataset_root(base_dir)
    if dataset_root is None:
        raise ValueError("--dataset-root is required unless --base-dir is under a datasets/{dataset_id} directory")
    if base_dir is None:
        base_dir = dataset_root / "2_final" / "excel"
    collection_name = args.collection or dataset_root.name
    result = load_excel_tables(
        config_path=Path(args.config),
        dataset_root=dataset_root,
        base_dir=base_dir,
        collection_name=collection_name,
        batch_size=args.batch_size,
        reset_collection=bool(args.reset_collection),
    )
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
