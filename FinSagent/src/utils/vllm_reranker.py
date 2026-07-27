import math
import logging
import time
from collections import defaultdict
from typing import DefaultDict, List, Optional, Tuple

import requests

logger = logging.getLogger(__name__)


class VLLMReranker:
    """FlagEmbedding-compatible reranker wrapper for a vLLM rerank service."""

    def __init__(
        self,
        endpoint_url: str,
        model_name: str,
        timeout_seconds: float = 60.0,
        api_key: Optional[str] = None,
        max_retries: int = 2,
        retry_backoff_seconds: float = 0.5,
        score_transform: str = "logit",
    ) -> None:
        self.endpoint_url = endpoint_url.rstrip("/")
        self.model_name = model_name
        self.timeout_seconds = timeout_seconds
        self.max_retries = max(0, int(max_retries))
        self.retry_backoff_seconds = max(0.0, float(retry_backoff_seconds))
        self.score_transform = str(score_transform or "logit").lower()
        self._session = requests.Session()
        if api_key and str(api_key).upper() not in {"EMPTY", "NONE", "NULL"}:
            self._session.headers.update({"Authorization": f"Bearer {api_key}"})

    @staticmethod
    def _to_logit(score: float) -> float:
        clipped = min(max(float(score), 1e-6), 1.0 - 1e-6)
        return math.log(clipped / (1.0 - clipped))

    def _transform_score(self, score: float) -> float:
        if self.score_transform == "logit":
            return self._to_logit(score)
        if self.score_transform in {"identity", "raw"}:
            return float(score)
        raise ValueError(f"Unsupported vLLM reranker score_transform: {self.score_transform}")

    def _post_rerank(self, payload: dict) -> dict:
        last_exc: Exception | None = None
        for attempt in range(self.max_retries + 1):
            try:
                response = self._session.post(
                    self.endpoint_url,
                    json=payload,
                    timeout=self.timeout_seconds,
                )
                response.raise_for_status()
                return response.json()
            except requests.HTTPError as exc:
                status_code = exc.response.status_code if exc.response is not None else None
                if status_code is not None and status_code < 500:
                    raise
                last_exc = exc
            except requests.RequestException as exc:
                last_exc = exc

            if attempt >= self.max_retries:
                break

            delay = self.retry_backoff_seconds * (2 ** attempt)
            logger.warning(
                "vLLM reranker request failed, retrying in %.2fs (%d/%d): %s",
                delay,
                attempt + 1,
                self.max_retries,
                last_exc,
            )
            time.sleep(delay)

        assert last_exc is not None
        raise last_exc

    def _rerank_single_query(self, query: str, docs: List[str]) -> List[float]:
        if not docs:
            return []

        payload = self._post_rerank(
            {
                "model": self.model_name,
                "query": query,
                "documents": docs,
                "top_n": len(docs),
            }
        )

        logits = [self._to_logit(0.5)] * len(docs)
        for item in payload.get("results", []):
            doc_index = item["index"]
            if 0 <= doc_index < len(logits):
                logits[doc_index] = self._transform_score(item["relevance_score"])
        return logits

    def compute_score(self, pairs: List[List[str]], batch_size: int = 12) -> List[float]:
        if not pairs:
            return []

        grouped: DefaultDict[str, List[Tuple[int, str]]] = defaultdict(list)
        for idx, pair in enumerate(pairs):
            if len(pair) != 2:
                raise ValueError(f"Each pair must contain [query, document], got: {pair}")
            grouped[pair[0]].append((idx, pair[1]))

        scores = [0.0] * len(pairs)
        for query, indexed_docs in grouped.items():
            ordered_docs = [doc for _, doc in indexed_docs]
            logits = self._rerank_single_query(query, ordered_docs)
            for (original_index, _), logit in zip(indexed_docs, logits):
                scores[original_index] = logit
        return scores
