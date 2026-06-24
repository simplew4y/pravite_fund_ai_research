from __future__ import annotations

import json
import math
import re
from pathlib import Path
from typing import Any


TOKEN_RE = re.compile(r"[\u4e00-\u9fff]|[A-Za-z]+(?:'[A-Za-z]+)?|\d+(?:\.\d+)?")
NUMBER_RE = re.compile(r"\d+(?:\.\d+)?")
YEAR_RE = re.compile(r"(?:19|20)\d{2}")
RETRIEVER_VALUES = ("BM25", "FAISS", "PageIndex", "Title Summary", "Table")


def _tokens(text: Any) -> list[str]:
    return [token.lower() for token in TOKEN_RE.findall(str(text or ""))]


def _numbers(text: Any) -> set[str]:
    return set(NUMBER_RE.findall(str(text or "")))


def _years(text: Any) -> set[int]:
    return {int(value) for value in YEAR_RE.findall(str(text or ""))}


def _safe_float(value: Any, default: float = 0.0) -> float:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return default
    if math.isnan(parsed) or math.isinf(parsed):
        return default
    return parsed


def chunk_text_for_rescue(chunk: dict[str, Any]) -> str:
    metadata = chunk.get("metadata") or {}
    parts = [
        chunk.get("page_content", ""),
        metadata.get("title_summary", ""),
        metadata.get("caption", ""),
        metadata.get("source_file", ""),
        metadata.get("doc_id", ""),
        metadata.get("date_published", ""),
        metadata.get("pageindex_doc_date", ""),
    ]
    return " ".join(str(part) for part in parts if part)


def _doc_year(chunk: dict[str, Any]) -> float:
    metadata = chunk.get("metadata") or {}
    for key in ("date_published", "pageindex_doc_date"):
        value = str(metadata.get(key) or "")
        match = YEAR_RE.search(value)
        if match:
            return float(match.group(0))
    return 0.0


def build_rescue_features(
    query: str,
    chunk: dict[str, Any],
    rule_score: float = 0.0,
) -> dict[str, float]:
    text = chunk_text_for_rescue(chunk)
    query_tokens = _tokens(query)
    chunk_tokens = _tokens(text)
    query_set = set(query_tokens)
    chunk_set = set(chunk_tokens)
    overlap = query_set & chunk_set
    query_numbers = _numbers(query)
    chunk_numbers = _numbers(text)
    query_years = _years(query)
    chunk_years = _years(text)
    retriever = str(chunk.get("retriever") or "unknown")
    metadata = chunk.get("metadata") or {}
    content_type = str(metadata.get("content_type") or ("table" if retriever == "Table" else "text")).lower()

    features: dict[str, float] = {
        "bias_feature": 1.0,
        "rule_score": _safe_float(rule_score),
        "raw_score": _safe_float(chunk.get("score")),
        "query_token_len": float(len(query_tokens)),
        "chunk_token_len": float(len(chunk_tokens)),
        "token_overlap_count": float(len(overlap)),
        "token_overlap_ratio_query": (len(overlap) / len(query_set)) if query_set else 0.0,
        "token_overlap_ratio_chunk": (len(overlap) / len(chunk_set)) if chunk_set else 0.0,
        "token_jaccard": (len(overlap) / len(query_set | chunk_set)) if (query_set or chunk_set) else 0.0,
        "query_number_count": float(len(query_numbers)),
        "chunk_number_count": float(len(chunk_numbers)),
        "number_overlap_count": float(len(query_numbers & chunk_numbers)),
        "query_year_count": float(len(query_years)),
        "chunk_year_count": float(len(chunk_years)),
        "year_overlap_count": float(len(query_years & chunk_years)),
        "doc_year": _doc_year(chunk),
        "content_length": float(len(text)),
        "is_table": 1.0 if content_type == "table" else 0.0,
        "has_number": 1.0 if chunk_numbers else 0.0,
        "has_query_year": 1.0 if query_years else 0.0,
    }
    for value in RETRIEVER_VALUES:
        key = "retriever_" + value.lower().replace(" ", "_")
        features[key] = 1.0 if retriever == value else 0.0
    return features


class EvidenceRescueScorer:
    """Small JSON linear scorer for optional learned evidence rescue reranking."""

    def __init__(self, model_path: str | Path):
        self.model_path = str(model_path)
        with open(model_path, encoding="utf-8") as f:
            bundle = json.load(f)
        required = {"feature_names", "weights", "bias", "means", "scales"}
        missing = sorted(required - set(bundle))
        if missing:
            raise ValueError(f"Invalid evidence rescue scorer bundle; missing keys: {missing}")
        self.feature_names = list(bundle["feature_names"])
        self.weights = [float(value) for value in bundle["weights"]]
        self.bias = float(bundle["bias"])
        self.means = {str(key): float(value) for key, value in dict(bundle["means"]).items()}
        self.scales = {str(key): max(float(value), 1e-9) for key, value in dict(bundle["scales"]).items()}
        if len(self.feature_names) != len(self.weights):
            raise ValueError("feature_names and weights length mismatch in evidence rescue scorer bundle")

    def score_one(self, query: str, chunk: dict[str, Any], rule_score: float = 0.0) -> float:
        features = build_rescue_features(query, chunk, rule_score=rule_score)
        logit = self.bias
        for name, weight in zip(self.feature_names, self.weights):
            value = float(features.get(name, 0.0))
            value = (value - self.means.get(name, 0.0)) / self.scales.get(name, 1.0)
            logit += weight * value
        if logit >= 0:
            z = math.exp(-logit)
            return 1.0 / (1.0 + z)
        z = math.exp(logit)
        return z / (1.0 + z)

    def score_chunks(
        self,
        query: str,
        chunks: list[dict[str, Any]],
        rule_scores: list[float] | None = None,
    ) -> list[float]:
        rule_scores = rule_scores or [0.0] * len(chunks)
        return [self.score_one(query, chunk, rule_score=score) for chunk, score in zip(chunks, rule_scores)]
