from __future__ import annotations

import argparse
import asyncio
import json
import logging
import sys
import threading
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Dict, Iterable, List, Tuple

import numpy as np
import pandas as pd
import torch
from FlagEmbedding import FlagLLMReranker

CURRENT_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = CURRENT_DIR.parent
SRC_ROOT = PROJECT_ROOT / "src"
if str(SRC_ROOT) not in sys.path:
    sys.path.insert(0, str(SRC_ROOT))
if str(CURRENT_DIR) not in sys.path:
    sys.path.insert(0, str(CURRENT_DIR))

from agents.general.prompts import REWRITE_PROMPT
from agents.shared import rewrite_for_agent
from core.RAGManager import RAGManager
from core.SessionManager import SessionManager
from utils.chunk_utils import build_chunk_dedupe_key

from text_utils import (
    DATASET_SPECS,
    DatasetSpec,
    detect_query_language,
    extract_numbers,
    extract_page_number,
    extract_years,
    get_question,
    iter_dataset_specs,
    load_ground_truth,
    load_project_config,
    normalise_text,
    parse_doc_year,
    simple_tokens,
    texts_match,
)

logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s")
logger = logging.getLogger("lightgbm.build_dataset")
PATH_ORDER = ["FAISS", "BM25", "Title Summary", "Table"]


def reset_rag_manager_singleton() -> None:
    RAGManager._instance = None
    RAGManager._config = None
    RAGManager._collections = {}
    RAGManager._retrievers = []
    RAGManager._embedding_lock = None


def extract_gt_entries(entries: Iterable[Any]) -> Tuple[set[str], List[str]]:
    ids: set[str] = set()
    texts: List[str] = []
    for entry in entries or []:
        if isinstance(entry, str):
            if entry.strip():
                texts.append(entry)
            continue
        if not isinstance(entry, dict):
            continue
        for key in ("chunk_id", "doc_id", "id"):
            value = entry.get(key)
            if value:
                ids.add(str(value))
        for key in ("content", "chunk", "text", "page_content"):
            value = entry.get(key)
            if isinstance(value, str) and value.strip():
                texts.append(value)
                break
    return ids, texts


def build_labeler(item: Dict[str, Any]):
    positive_entries = item.get("content") or item.get("positives") or []
    positive_ids, positive_texts = extract_gt_entries(positive_entries)
    negative_ids, negative_texts = extract_gt_entries(item.get("negatives", []))

    def resolve_label(chunk: Dict[str, Any]) -> Tuple[int, str]:
        metadata = chunk.get("metadata") or {}
        doc_id = metadata.get("doc_id")
        text = chunk.get("page_content", "")
        if doc_id is not None and str(doc_id) in positive_ids:
            return 1, "positive_id"
        if any(texts_match(text, candidate) for candidate in positive_texts):
            return 1, "positive_text"
        if doc_id is not None and str(doc_id) in negative_ids:
            return 0, "negative_id"
        if any(texts_match(text, candidate) for candidate in negative_texts):
            return 0, "negative_text"
        return 0, "implicit_negative"

    return resolve_label


def retrieve_faiss_chunks(retriever: Any, query: str, limit: int) -> List[Dict[str, Any]]:
    seen_ids: set[int] = set()
    chunks: List[Dict[str, Any]] = []
    faiss_ids_list, faiss_scores_list = retriever.faiss_retriever.invoke([query], 2048)
    faiss_ids = faiss_ids_list[0]
    faiss_scores = faiss_scores_list[0]
    effective_ids = {int(idx): float(score) for idx, score in zip(faiss_ids, faiss_scores)}
    bundle_id = 0
    for rank, (idx, score) in enumerate(zip(faiss_ids[:limit], faiss_scores[:limit]), start=1):
        idx = int(idx)
        score = float(score)
        if idx in seen_ids:
            continue
        seen_ids.add(idx)
        ids, metadata = retriever._resolve_bundle_ids(idx)
        seen_ids.update(ids)
        ids = retriever._expand_ids(ids, metadata, effective_ids, seen_ids)
        for chunk in retriever._materialize_bundle(ids, score, "FAISS", bundle_id):
            chunk["path_rank"] = rank
            chunks.append(chunk)
        bundle_id += 1
    return chunks


def retrieve_title_summary_chunks(retriever: Any, query: str) -> List[Dict[str, Any]]:
    seen_ids: set[int] = set()
    chunks: List[Dict[str, Any]] = []
    title_ids, title_scores = retriever.title_summary_faiss_retriever.invoke([query], retriever.faiss_ts_k)
    bundle_id = 0
    for rank, (title_idx, score) in enumerate(zip(title_ids[0], title_scores[0]), start=1):
        title_summary = retriever.title_summaries[int(title_idx)]
        chunk_idxs = [idx for idx, metadata in enumerate(retriever.chunk_metadata) if metadata.get("title_summary", "") == title_summary]
        for idx in chunk_idxs:
            if idx in seen_ids:
                continue
            seen_ids.add(idx)
            ids, _ = retriever._resolve_bundle_ids(idx)
            seen_ids.update(ids)
            for chunk in retriever._materialize_bundle(ids, float(score), "Title Summary", bundle_id):
                chunk["path_rank"] = rank
                chunks.append(chunk)
            bundle_id += 1
    return chunks


def retrieve_bm25_chunks(retriever: Any, query: str) -> List[Dict[str, Any]]:
    seen_ids: set[int] = set()
    chunks: List[Dict[str, Any]] = []
    bm25_ids, bm25_scores = retriever.bm25_retriever.invoke(query, retriever.num_chunk)
    bundle_id = 0
    for rank, (idx, score) in enumerate(zip(bm25_ids[: retriever.bm25_k], bm25_scores[: retriever.bm25_k]), start=1):
        idx = int(idx)
        if idx in seen_ids:
            continue
        seen_ids.add(idx)
        ids, _ = retriever._resolve_bundle_ids(idx)
        seen_ids.update(ids)
        for chunk in retriever._materialize_bundle(ids, float(score), "BM25", bundle_id):
            chunk["path_rank"] = rank
            chunks.append(chunk)
        bundle_id += 1
    return chunks


def retrieve_table_chunks(retriever: Any, query: str) -> List[Dict[str, Any]]:
    if retriever.table_k <= 0 or retriever.table_faiss_retriever is None:
        return []
    chunks: List[Dict[str, Any]] = []
    table_ids, table_scores = retriever.table_faiss_retriever.invoke([query], retriever.table_k)
    for rank, (idx, score) in enumerate(zip(table_ids[0], table_scores[0]), start=1):
        metadata = dict(retriever.table_metadata[int(idx)]) if int(idx) < len(retriever.table_metadata) else {}
        content = metadata.pop("content", "")
        chunks.append(
            {
                "retriever": "Table",
                "score": float(score),
                "page_content": content,
                "metadata": {**metadata, "caption": retriever.table_captions[int(idx)], "content_type": "table"},
                "bundle_id": rank - 1,
                "path_rank": rank,
            }
        )
    return chunks


def aggregate_candidates(chunks: Iterable[Dict[str, Any]]) -> List[Dict[str, Any]]:
    by_key: Dict[str, Dict[str, Any]] = {}
    for chunk in chunks:
        key = build_chunk_dedupe_key(chunk)
        path = chunk.get("retriever", "")
        entry = by_key.setdefault(
            key,
            {
                "chunk_key": key,
                "page_content": chunk.get("page_content", ""),
                "metadata": dict(chunk.get("metadata") or {}),
                "paths": [],
                "path_set": set(),
                "path_scores": {},
                "path_ranks": {},
            },
        )
        if path not in entry["path_set"]:
            entry["path_set"].add(path)
            entry["paths"].append(path)
        entry["path_scores"][path] = max(entry["path_scores"].get(path, float("-inf")), float(chunk.get("score", np.nan)))
        entry["path_ranks"][path] = min(entry["path_ranks"].get(path, 10**9), int(chunk.get("path_rank", 10**9)))
    candidates: List[Dict[str, Any]] = []
    for entry in by_key.values():
        ordered_paths = [path for path in PATH_ORDER if path in entry["path_set"]]
        entry["paths"] = ordered_paths
        entry.pop("path_set", None)
        candidates.append(entry)
    return candidates


def rerank_scores(reranker: FlagLLMReranker, query: str, candidates: List[Dict[str, Any]], batch_size: int) -> List[float]:
    if not candidates:
        return []
    pairs = [(query, candidate.get("page_content", "")) for candidate in candidates]
    with torch.no_grad():
        raw_scores = reranker.compute_score(pairs, batch_size=batch_size)
    scores = torch.sigmoid(torch.tensor(raw_scores, dtype=torch.float32)).tolist()
    return [float(score) for score in scores]


def build_feature_row(
    spec: DatasetSpec,
    idx: int,
    original_question: str,
    agent: str,
    query: str,
    subquery_index: int,
    num_subqueries: int,
    candidate: Dict[str, Any],
    cross_encoder_score: float,
    label: int,
    label_source: str,
) -> Dict[str, Any]:
    metadata = candidate.get("metadata") or {}
    chunk_text = candidate.get("page_content", "")
    query_tokens = simple_tokens(query)
    chunk_tokens = simple_tokens(chunk_text)
    query_token_set = set(query_tokens)
    chunk_token_set = set(chunk_tokens)
    overlap = query_token_set & chunk_token_set
    numbers_query = extract_numbers(query)
    numbers_chunk = extract_numbers(chunk_text)
    years_query = extract_years(query)
    years_chunk = extract_years(chunk_text)
    title_summary = metadata.get("title_summary", "")
    title_tokens = simple_tokens(title_summary)
    path_scores = candidate.get("path_scores", {})
    path_ranks = candidate.get("path_ranks", {})
    available_ranks = [rank for rank in path_ranks.values() if rank < 10**9]
    chunk_type = metadata.get("content_type") or ("table" if "Table" in candidate.get("paths", []) else "text")
    retrieval_path = "|".join(candidate.get("paths", [])) or "unknown"
    return {
        "dataset_id": spec.dataset_id,
        "collection_name": spec.collection_name,
        "group_id": f"{spec.dataset_id}:{idx}",
        "question_idx": idx,
        "agent": agent,
        "query_language": detect_query_language(query),
        "query_text": query,
        "original_question": original_question,
        "chunk_key": candidate.get("chunk_key", ""),
        "chunk_text": chunk_text,
        "doc_id": metadata.get("doc_id", ""),
        "source_file": metadata.get("source_file", metadata.get("source", "")),
        "retrieval_path": retrieval_path,
        "chunk_type": chunk_type,
        "num_retrieval_paths": len(candidate.get("paths", [])),
        "has_faiss": int("FAISS" in candidate.get("paths", [])),
        "has_bm25": int("BM25" in candidate.get("paths", [])),
        "has_title_summary": int("Title Summary" in candidate.get("paths", [])),
        "has_table": int("Table" in candidate.get("paths", [])),
        "faiss_score": path_scores.get("FAISS", np.nan),
        "bm25_score": path_scores.get("BM25", np.nan),
        "title_summary_score": path_scores.get("Title Summary", np.nan),
        "table_score": path_scores.get("Table", np.nan),
        "faiss_rank": path_ranks.get("FAISS", np.nan),
        "bm25_rank": path_ranks.get("BM25", np.nan),
        "title_summary_rank": path_ranks.get("Title Summary", np.nan),
        "table_rank": path_ranks.get("Table", np.nan),
        "min_rank": min(available_ranks) if available_ranks else np.nan,
        "cross_encoder_score": cross_encoder_score,
        "query_token_len": len(query_tokens),
        "chunk_token_len": len(chunk_tokens),
        "token_overlap_count": len(overlap),
        "token_overlap_ratio_query": (len(overlap) / len(query_token_set)) if query_token_set else 0.0,
        "token_overlap_ratio_chunk": (len(overlap) / len(chunk_token_set)) if chunk_token_set else 0.0,
        "token_jaccard": (len(overlap) / len(query_token_set | chunk_token_set)) if (query_token_set or chunk_token_set) else 0.0,
        "query_number_count": len(numbers_query),
        "chunk_number_count": len(numbers_chunk),
        "number_overlap_count": len(numbers_query & numbers_chunk),
        "year_overlap_count": len(years_query & years_chunk),
        "title_summary_token_len": len(title_tokens),
        "page_number": extract_page_number(metadata),
        "doc_year": parse_doc_year(metadata.get("date_published")),
        "label": int(label),
        "label_source": label_source,
    }


class OfflineDatasetBuilder:
    def __init__(
        self,
        config_path: str | None,
        retrieve_top_k: int,
        rerank_batch_size: int,
        reranker_device: str = "cuda",
        embedding_device: str | None = None,
    ):
        self.base_config = load_project_config(config_path)
        if embedding_device:
            self.base_config["embedding_device"] = embedding_device
        self.retrieve_top_k = retrieve_top_k
        self.rerank_batch_size = rerank_batch_size
        use_fp16 = reranker_device.startswith("cuda")
        self.reranker = FlagLLMReranker(self.base_config.get("rerank_model"), devices=reranker_device, use_fp16=use_fp16)
        self.reranker_lock = threading.Lock()
        self.session_manager = SessionManager("lightgbm-dataset-builder", self.base_config)
        self.max_sub_queries = 3

    async def _rewrite_general_queries_async(self, question: str, retriever: Any) -> List[str]:
        rag_proxy = SimpleNamespace(rag_manager=SimpleNamespace(_retrievers=[retriever]))
        sub_queries = await rewrite_for_agent(
            "general",
            question,
            [],
            self.session_manager,
            REWRITE_PROMPT,
            max_sub_queries=self.max_sub_queries,
            rag=rag_proxy,
            enable_query_decompose=False,
        )
        return sub_queries or [question]

    def rewrite_general_queries(self, question: str, retriever: Any) -> List[str]:
        sub_queries = asyncio.run(self._rewrite_general_queries_async(question, retriever))
        cleaned = [query.strip() for query in sub_queries if isinstance(query, str) and query.strip()]
        return cleaned or [question]

    def _get_retriever(self, spec: DatasetSpec):
        reset_rag_manager_singleton()
        config = dict(self.base_config)
        config["persist_directory"] = spec.persist_directory
        config["collection_name"] = spec.collection_name
        config["gt_path"] = spec.gt_path
        config["retrieve_top_k"] = self.retrieve_top_k
        rag_manager = RAGManager(config, collections={spec.collection_name: self.retrieve_top_k})
        return rag_manager._retrievers[0]

    def _collect_query_candidates(self, retriever: Any, query: str) -> List[Dict[str, Any]]:
        chunks: List[Dict[str, Any]] = []
        chunks.extend(retrieve_faiss_chunks(retriever, query, self.retrieve_top_k))
        chunks.extend(retrieve_title_summary_chunks(retriever, query))
        chunks.extend(retrieve_bm25_chunks(retriever, query))
        chunks.extend(retrieve_table_chunks(retriever, query))
        return aggregate_candidates(chunks)

    def build(self, dataset_ids: Iterable[str] | None = None, max_questions: int | None = None) -> pd.DataFrame:
        rows: List[Dict[str, Any]] = []
        for spec in iter_dataset_specs(dataset_ids):
            logger.info("Building rows for %s", spec.dataset_id)
            retriever = self._get_retriever(spec)
            gt_items = load_ground_truth(spec.gt_path)
            if max_questions is not None:
                gt_items = gt_items[:max_questions]
            for idx, item in enumerate(gt_items):
                question = get_question(item)
                if not question:
                    continue
                labeler = build_labeler(item)
                clean_subqueries = self.rewrite_general_queries(question, retriever)
                for subquery_index, query in enumerate(clean_subqueries):
                    candidates = self._collect_query_candidates(retriever, query)
                    with self.reranker_lock:
                        scores = rerank_scores(self.reranker, query, candidates, self.rerank_batch_size)
                    for candidate, cross_encoder_score in zip(candidates, scores):
                        label, label_source = labeler(candidate)
                        rows.append(
                            build_feature_row(
                                spec=spec,
                                idx=idx,
                                original_question=question,
                                agent="general",
                                query=query,
                                subquery_index=subquery_index,
                                num_subqueries=len(clean_subqueries),
                                candidate=candidate,
                                cross_encoder_score=cross_encoder_score,
                                label=label,
                                label_source=label_source,
                            )
                        )
                if (idx + 1) % 10 == 0:
                    logger.info("%s: processed %s questions, rows=%s", spec.dataset_id, idx + 1, len(rows))
        return pd.DataFrame(rows)


def build_manifest(df: pd.DataFrame) -> Dict[str, Any]:
    categorical_columns = ["retrieval_path", "chunk_type", "dataset_id", "query_language"]
    non_feature_columns = [
        "collection_name",
        "group_id",
        "question_idx",
        "agent",
        "query_text",
        "original_question",
        "chunk_key",
        "chunk_text",
        "doc_id",
        "source_file",
        "label",
        "label_source",
    ]
    feature_columns = [column for column in df.columns if column not in non_feature_columns]
    return {
        "row_count": int(len(df)),
        "positive_rate": float(df["label"].mean()) if len(df) else 0.0,
        "feature_columns": feature_columns,
        "categorical_columns": categorical_columns,
        "dataset_counts": {key: int(value) for key, value in df["dataset_id"].value_counts().to_dict().items()},
        "label_source_counts": {key: int(value) for key, value in df["label_source"].value_counts().to_dict().items()},
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config-path", default=None)
    parser.add_argument("--datasets", nargs="*", default=list(DATASET_SPECS.keys()))
    parser.add_argument("--output-csv", default=str(CURRENT_DIR / "data" / "chunk_features.csv"))
    parser.add_argument("--manifest-json", default=str(CURRENT_DIR / "data" / "feature_manifest.json"))
    parser.add_argument("--retrieve-top-k", type=int, default=10)
    parser.add_argument("--rerank-batch-size", type=int, default=12)
    parser.add_argument("--reranker-device", default="cuda")
    parser.add_argument("--embedding-device", default=None)
    parser.add_argument("--max-questions", type=int, default=None)
    args = parser.parse_args()

    output_csv = Path(args.output_csv)
    manifest_json = Path(args.manifest_json)
    output_csv.parent.mkdir(parents=True, exist_ok=True)
    manifest_json.parent.mkdir(parents=True, exist_ok=True)

    builder = OfflineDatasetBuilder(
        args.config_path,
        args.retrieve_top_k,
        args.rerank_batch_size,
        reranker_device=args.reranker_device,
        embedding_device=args.embedding_device,
    )
    df = builder.build(args.datasets, args.max_questions)
    df.to_csv(output_csv, index=False)
    manifest = build_manifest(df)
    with manifest_json.open("w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)
    logger.info("Saved %s rows to %s", len(df), output_csv)
    logger.info("Saved manifest to %s", manifest_json)


if __name__ == "__main__":
    main()
