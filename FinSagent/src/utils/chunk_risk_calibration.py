from __future__ import annotations

import importlib
import logging
import pickle
import sys
import threading
from pathlib import Path
from typing import Any, Dict, List

import numpy as np
import pandas as pd

logger = logging.getLogger(__name__)

CURRENT_FILE = Path(__file__).resolve()
PROJECT_ROOT = CURRENT_FILE.parents[2]
TOKEN_PATTERN = __import__("re").compile(r"[\u4e00-\u9fff]|[A-Za-z]+(?:'[A-Za-z]+)?|\d+(?:\.\d+)?")
NUMBER_PATTERN = __import__("re").compile(r"\d+(?:\.\d+)?")
YEAR_PATTERN = __import__("re").compile(r"(?:19|20)\d{2}")


def _import_external_lightgbm() -> Any:
    blocked = {PROJECT_ROOT.resolve()}
    removed: List[str] = []
    for path in list(sys.path):
        try:
            resolved = Path(path or ".").resolve()
        except Exception:
            continue
        if resolved in blocked:
            removed.append(path)
            sys.path.remove(path)
    try:
        try:
            return importlib.import_module("lightgbm")
        except ModuleNotFoundError as exc:
            raise ModuleNotFoundError(
                "The external 'lightgbm' package is not installed in the current environment. "
                "Install it before enabling chunk risk calibration."
            ) from exc
    finally:
        for path in reversed(removed):
            if path not in sys.path:
                sys.path.insert(0, path)


_EXTERNAL_LIGHTGBM = None
_EXTERNAL_LIGHTGBM_LOCK = threading.Lock()


def _ensure_lightgbm_imported() -> Any:
    global _EXTERNAL_LIGHTGBM
    if _EXTERNAL_LIGHTGBM is None:
        with _EXTERNAL_LIGHTGBM_LOCK:
            if _EXTERNAL_LIGHTGBM is None:
                _EXTERNAL_LIGHTGBM = _import_external_lightgbm()
    return _EXTERNAL_LIGHTGBM


def _simple_tokens(text: Any) -> List[str]:
    if text is None:
        return []
    return [token.lower() for token in TOKEN_PATTERN.findall(str(text))]


def _extract_numbers(text: Any) -> set[str]:
    if text is None:
        return set()
    return set(NUMBER_PATTERN.findall(str(text)))


def _extract_years(text: Any) -> set[int]:
    if text is None:
        return set()
    return {int(value) for value in YEAR_PATTERN.findall(str(text))}


def _detect_query_language(text: Any) -> str:
    text = str(text or "")
    has_zh = any("\u4e00" <= ch <= "\u9fff" for ch in text)
    has_ascii_alpha = any(("a" <= ch.lower() <= "z") for ch in text)
    if has_zh and has_ascii_alpha:
        return "mixed"
    if has_zh:
        return "zh"
    if has_ascii_alpha:
        return "en"
    return "other"


def _parse_doc_year(value: Any) -> float:
    text = str(value or "").strip()
    if len(text) >= 4 and text[:4].isdigit():
        return float(int(text[:4]))
    return float("nan")


def _extract_page_number(metadata: Dict[str, Any]) -> float:
    for key in ("page_idx", "page_number", "page", "pageIndex"):
        value = metadata.get(key)
        if value is None or value == "":
            continue
        try:
            return float(value)
        except (TypeError, ValueError):
            continue
    return float("nan")


class ChunkRiskCalibrator:
    def __init__(
        self,
        model_path: str,
        collection_name: str,
        penalty_mode: str = "percentile_rank",
    ):
        self.model_path = str(model_path)
        self.collection_name = collection_name or "default"
        self.penalty_mode = penalty_mode
        self._bundle: Dict[str, Any] | None = None
        self._bundle_lock = threading.Lock()
        self._predict_lock = threading.Lock()

    def _load_bundle(self) -> Dict[str, Any]:
        if self._bundle is not None:
            return self._bundle
        with self._bundle_lock:
            if self._bundle is not None:
                return self._bundle
            if not self.model_path:
                raise ValueError("chunk_risk_model_path must be set when chunk risk calibration is enabled")
            model_path = Path(self.model_path)
            if not model_path.exists():
                raise FileNotFoundError(f"Chunk risk model bundle not found: {model_path}")
            _ensure_lightgbm_imported()
            with model_path.open("rb") as f:
                bundle = pickle.load(f)
            required = {"model", "feature_columns", "categorical_columns", "categories"}
            missing = sorted(required - set(bundle.keys()))
            if missing:
                raise ValueError(f"Invalid chunk risk model bundle, missing keys: {missing}")
            model = bundle["model"]
            model_kind = self._infer_model_kind(bundle)
            if model_kind == "binary" and not hasattr(model, "predict_proba"):
                raise ValueError(
                    "Chunk risk calibration binary bundles must provide predict_proba()."
                )
            if model_kind == "lambdarank" and not hasattr(model, "predict"):
                raise ValueError(
                    "Chunk risk calibration LambdaRank bundles must provide predict()."
                )
            if model_kind not in {"binary", "lambdarank"}:
                raise ValueError(f"Unsupported chunk risk model kind: {model_kind}")
            bundle["model_kind"] = model_kind
            self._bundle = bundle
            logger.info(
                "Loaded chunk risk calibration bundle from %s with model_kind=%s penalty_mode=%s and %s reduced features",
                model_path,
                model_kind,
                self.penalty_mode,
                len(bundle["feature_columns"]),
            )
            return bundle

    def _build_path_ranks(self, chunks: List[Dict[str, Any]]) -> Dict[int, int]:
        counters: Dict[str, int] = {}
        bundle_ranks: Dict[tuple[str, Any], int] = {}
        chunk_ranks: Dict[int, int] = {}
        for idx, chunk in enumerate(chunks):
            path = str(chunk.get("retriever") or "unknown")
            bundle_key = (path, chunk.get("bundle_id"))
            if bundle_key not in bundle_ranks:
                counters[path] = counters.get(path, 0) + 1
                bundle_ranks[bundle_key] = counters[path]
            chunk_ranks[idx] = bundle_ranks[bundle_key]
        return chunk_ranks

    def _build_rows(
        self,
        query: str,
        chunks: List[Dict[str, Any]],
        reranker_scores: List[float],
    ) -> pd.DataFrame:
        chunk_ranks = self._build_path_ranks(chunks)
        rows: List[Dict[str, Any]] = []
        for idx, chunk in enumerate(chunks):
            metadata = chunk.get("metadata") or {}
            chunk_text = chunk.get("page_content", "")
            path = str(chunk.get("retriever") or "unknown")
            path_rank = chunk_ranks[idx]
            query_tokens = _simple_tokens(query)
            chunk_tokens = _simple_tokens(chunk_text)
            query_token_set = set(query_tokens)
            chunk_token_set = set(chunk_tokens)
            overlap = query_token_set & chunk_token_set
            numbers_query = _extract_numbers(query)
            numbers_chunk = _extract_numbers(chunk_text)
            years_query = _extract_years(query)
            years_chunk = _extract_years(chunk_text)
            title_summary = metadata.get("title_summary", "")
            title_tokens = _simple_tokens(title_summary)
            chunk_type = metadata.get("content_type") or ("table" if path == "Table" else "text")
            rows.append(
                {
                    "dataset_id": self.collection_name,
                    "query_language": _detect_query_language(query),
                    "retrieval_path": path,
                    "chunk_type": chunk_type,
                    "num_retrieval_paths": 1,
                    "has_faiss": int(path == "FAISS"),
                    "has_bm25": int(path == "BM25"),
                    "has_title_summary": int(path == "Title Summary"),
                    "has_table": int(path == "Table"),
                    "faiss_score": float(chunk.get("score", np.nan)) if path == "FAISS" else np.nan,
                    "bm25_score": float(chunk.get("score", np.nan)) if path == "BM25" else np.nan,
                    "title_summary_score": float(chunk.get("score", np.nan)) if path == "Title Summary" else np.nan,
                    "table_score": float(chunk.get("score", np.nan)) if path == "Table" else np.nan,
                    "faiss_rank": float(path_rank) if path == "FAISS" else np.nan,
                    "bm25_rank": float(path_rank) if path == "BM25" else np.nan,
                    "title_summary_rank": float(path_rank) if path == "Title Summary" else np.nan,
                    "table_rank": float(path_rank) if path == "Table" else np.nan,
                    "min_rank": float(path_rank),
                    "cross_encoder_score": float(reranker_scores[idx]),
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
                    "page_number": _extract_page_number(metadata),
                    "doc_year": _parse_doc_year(metadata.get("date_published")),
                }
            )
        return pd.DataFrame(rows)

    def _apply_categories(
        self,
        df: pd.DataFrame,
        feature_columns: List[str],
        categories: Dict[str, List[str]],
    ) -> pd.DataFrame:
        x = df.loc[:, feature_columns].copy()
        for column, allowed in categories.items():
            if column in x.columns:
                x[column] = pd.Categorical(x[column].fillna("missing").astype(str), categories=allowed)
        return x

    def _to_percentile_rank(self, values: np.ndarray) -> np.ndarray:
        if values.size == 0:
            return values
        order = np.argsort(values, kind="mergesort")
        ranks = np.empty(values.size, dtype=float)
        ranks[order] = (np.arange(values.size, dtype=float) + 1.0) / float(values.size)
        return ranks

    def _infer_model_kind(self, bundle: Dict[str, Any]) -> str:
        model = bundle["model"]
        model_kind = str(bundle.get("model_kind") or "").strip().lower()
        if model_kind:
            return model_kind

        summary = bundle.get("summary")
        if isinstance(summary, dict):
            objective_used = str(summary.get("objective_used") or "").strip().lower()
            if objective_used in {"binary", "lambdarank"}:
                return objective_used

        objective_used = str(bundle.get("objective_used") or "").strip().lower()
        if objective_used in {"binary", "lambdarank"}:
            return objective_used

        if hasattr(model, "predict_proba"):
            return "binary"
        if hasattr(model, "predict"):
            return "lambdarank"
        raise ValueError(
            "Chunk risk calibration requires a LightGBM model bundle with objective_used metadata or predict_proba()/predict()."
        )

    def score_chunks(
        self,
        query: str,
        chunks: List[Dict[str, Any]],
        reranker_scores: List[float],
    ) -> Dict[str, np.ndarray]:
        bundle = self._load_bundle()
        feature_columns = list(bundle["feature_columns"])
        categories = dict(bundle["categories"])
        df = self._build_rows(query, chunks, reranker_scores)
        for column in feature_columns:
            if column not in df.columns:
                df[column] = np.nan
        x = self._apply_categories(df, feature_columns, categories)
        model = bundle["model"]
        model_kind = str(bundle.get("model_kind") or "binary")
        if self.penalty_mode != "percentile_rank":
            raise ValueError(f"Unsupported chunk_risk_penalty_mode: {self.penalty_mode}")

        if model_kind == "binary":
            with self._predict_lock:
                p_relevant = np.asarray(model.predict_proba(x)[:, 1], dtype=float)
            risk_hat = 1.0 - p_relevant
            risk_rank = self._to_percentile_rank(risk_hat)
            return {
                "p_relevant": p_relevant,
                "risk_hat": risk_hat,
                "risk_rank": risk_rank,
            }

        with self._predict_lock:
            raw_scores = np.asarray(model.predict(x), dtype=float)
        relevance_rank = self._to_percentile_rank(raw_scores)
        risk_rank = 1.0 - relevance_rank
        risk_hat = risk_rank
        return {
            "raw_scores": raw_scores,
            "relevance_rank": relevance_rank,
            "risk_hat": risk_hat,
            "risk_rank": risk_rank,
        }
