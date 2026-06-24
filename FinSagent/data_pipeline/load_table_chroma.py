import os
import sys
import json
import yaml
import argparse
import hashlib
import logging
from typing import Dict, Iterable, List

from tqdm import tqdm

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # FinSagent/
SRC_DIR = os.path.join(PROJECT_ROOT, "src")
sys.path.insert(0, SRC_DIR)
DEFAULT_CONFIG = os.path.join(PROJECT_ROOT, "config", "config_0309.yaml")

from core.RAGManager import RAGManager  # noqa: E402

logging.basicConfig(
    filename="load_table_chroma.log",
    filemode="w",
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger(__name__)


def load_config(config_path: str) -> Dict:
    with open(config_path, "r") as file:
        return yaml.safe_load(file)


def iter_table_json_files(base_dir: str) -> Iterable[str]:
    """Yield all *_table_reconstructed.json files under base_dir."""
    for root, _, files in os.walk(base_dir):
        for fname in files:
            if fname.endswith("_table_reconstructed.json"):
                yield os.path.join(root, fname)


def build_doc_id(summary: str, content: str, source_file: str, idx: int) -> str:
    raw = f"{summary}|{content}|{source_file}|{idx}"
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def import_tables_into_chroma(
    rag_manager: RAGManager,
    collection_name: str,
    table_files: List[str],
    batch_size: int = 64,
) -> int:
    """Load table summaries/content into table_chroma."""
    _, _, table_chroma = rag_manager._collections[collection_name]
    if table_chroma is None:
        raise ValueError("table_chroma is not initialized for this collection.")

    table_chroma.reset_collection()

    texts: List[str] = []
    metadatas: List[Dict] = []
    ids: List[str] = []
    total = 0

    for table_file in tqdm(table_files, desc="Loading table files"):
        with open(table_file, "r") as f:
            items = json.load(f)

        for idx, item in enumerate(items):
            summary = item.get("summary", "").strip()
            content = item.get("content", "")
            if not summary:
                logger.warning("Skip table without summary in %s at index %d", table_file, idx)
                continue

            doc_id = build_doc_id(summary, content, table_file, idx)
            metadata = {
                "source_file": table_file,
                "table_index": idx,
                "page_idx": item.get("page_idx"),
                "table_caption": (item.get("table_caption") or [""])[0],
                "table_footnote": (item.get("table_footnote") or [""])[0],
                "original_img_path": item.get("original_img_path"),
                "original_index": item.get("original_index"),
                # content is stored as plain text; only summary is embedded
                "content": content,
                "summary": summary,
            }

            caption = " ".join(item.get("table_caption") or [])
            footnote = " ".join(item.get("table_footnote") or [])

            embed_text = (
                f"CAPTION:\n{caption}\n\n"
                f"SUMMARY:\n{summary}\n\n"
                f"FOOTNOTE:\n{footnote}\n"
            )

            texts.append(embed_text)
            metadatas.append(metadata)
            ids.append(doc_id)
            total += 1

            if len(texts) >= batch_size:
                embeddings = rag_manager.embeddings.embed_documents(texts)
                table_chroma.add_texts(
                    texts=texts,
                    metadatas=metadatas,
                    ids=ids,
                    embeddings=embeddings,
                )
                texts, metadatas, ids = [], [], []

    if texts:
        embeddings = rag_manager.embeddings.embed_documents(texts)
        table_chroma.add_texts(
            texts=texts,
            metadatas=metadatas,
            ids=ids,
            embeddings=embeddings,
        )

    logger.info("Stored %d tables into table_chroma collection %s", total, collection_name)
    return total


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Load SEC table HTML into a dedicated Chroma collection (summary is embedded)."
    )
    parser.add_argument(
        "--config",
        type=str,
        default=DEFAULT_CONFIG,
        help="Path to YAML config (embedding model + persist_directory).",
    )
    parser.add_argument(
        "--base-dir",
        type=str,
        default="/root/autodl-tmp/RAG_Agent_data/lotus/20250701/filtered_pdf_processed_table",
        help="Root directory containing *_table_reconstructed.json files.",
    )
    parser.add_argument(
        "--collection",
        type=str,
        default="lotus",
        help="Collection name to use inside table_chroma.",
    )
    parser.add_argument(
        "--batch-size",
        type=int,
        default=64,
        help="Number of tables per embedding/write batch.",
    )
    args = parser.parse_args()

    config = load_config(args.config)
    rag = RAGManager(config)
    rag.create_collection(args.collection)

    print("persist_directory =", config.get("persist_directory"))

    table_files = sorted(iter_table_json_files(args.base_dir))
    if not table_files:
        logger.error("No *_table_reconstructed.json files found under %s", args.base_dir)
        return

    total = import_tables_into_chroma(rag, args.collection, table_files, args.batch_size)
    print(f"Stored {total} tables into table_chroma collection '{args.collection}'.")


if __name__ == "__main__":
    main()
