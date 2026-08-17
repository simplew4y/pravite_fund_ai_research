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

        is_dashscope = "dashscope" in self.endpoint_url or "aliyuncs.com" in self.endpoint_url

        if is_dashscope:
            payload = {
                "model": self.model_name,
                "input": {
                    "query": query,
                    "documents": docs,
                },
                "parameters": {
                    "top_n": len(docs),
                },
            }
        else:
            payload = {
                "model": self.model_name,
                "query": query,
                "documents": docs,
                "top_n": len(docs),
            }

        result = self._post_rerank(payload)

        logits = [self._to_logit(0.5)] * len(docs)
        results_list = result.get("results", result.get("output", {}).get("results", []))
        if not results_list and "output" in result:
            results_list = result["output"].get("results", [])
        for item in results_list:
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


class LocalReranker:
    """CPU-based CrossEncoder reranker using sentence-transformers.

    Drop-in replacement for VLLMReranker — same ``compute_score`` interface,
    no HTTP calls, no ports needed.
    """

    def __init__(
        self,
        model_name: str = "BAAI/bge-reranker-v2-m3",
        device: str = "cpu",
        batch_size: int = 12,
    ):
        import os
        os.environ.setdefault("HF_HUB_OFFLINE", "1")
        os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")

        self.model_name = model_name
        self.device = device
        self.batch_size = batch_size
        self._model = None

    @property
    def model(self):
        if self._model is None:
            self._load()
        return self._model

    def _load(self):
        import huggingface_hub as hf
        import os
        try:
            model_path = hf.snapshot_download(self.model_name, local_files_only=True)
        except Exception:
            # Try ModelScope cache
            ms_path = os.path.expanduser(
                f"/root/autodl-tmp/models/{self.model_name}"
            )
            if os.path.exists(ms_path):
                model_path = ms_path
                logger.info("Using ModelScope cache for %s", self.model_name)
            else:
                logger.warning(
                    "Reranker model %s not cached locally. "
                    "Falling back to flat scoring (0.5). "
                    "Download the model and restart to enable reranking.",
                    self.model_name,
                )
                self._load_failed = True
                return
        from sentence_transformers import CrossEncoder
        logger.info("Loading reranker %s from %s on %s ...", self.model_name, model_path, self.device)
        self._model = CrossEncoder(model_path, device=self.device)
        logger.info("Reranker loaded.")

    def compute_score(self, pairs: List[List[str]], batch_size: Optional[int] = None) -> List[float]:
        if not pairs:
            return []
        if getattr(self, "_load_failed", False):
            # Flat 0.5 fallback — same as the old mock reranker
            return [0.5] * len(pairs)
        bs = batch_size or self.batch_size
        scores = self.model.predict(pairs, batch_size=bs, show_progress_bar=False)
        return [float(s) if not isinstance(s, (int, float)) else s for s in scores]
