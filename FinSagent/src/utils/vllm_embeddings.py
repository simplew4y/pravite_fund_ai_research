"""VLLMEmbeddings — OpenAI-compatible embedding via vLLM or DashScope."""
import logging
import threading
import time
from typing import List, Optional

import requests

logger = logging.getLogger(__name__)


class VLLMEmbeddings:
    """Embeddings via a vLLM / DashScope compatible endpoint.

    Thread-safe rate limiter: parallel calls queue behind a lock so
    API-based backends (DashScope) don't get throttled (429).
    """

    _global_lock = threading.Lock()
    _last_request_time: float = 0.0

    def __init__(
        self,
        endpoint_url: str,
        model_name: str,
        timeout_seconds: float = 60.0,
        batch_size: int = 32,
        api_key: Optional[str] = None,
    ) -> None:
        self.endpoint_url = endpoint_url.rstrip("/")
        self.model_name = model_name
        self.timeout_seconds = timeout_seconds
        self.batch_size = max(int(batch_size), 1)
        self._session = requests.Session()
        if api_key and str(api_key).upper() not in {"EMPTY", "NONE", "NULL"}:
            self._session.headers.update({"Authorization": f"Bearer {api_key}"})

    def _embed_batch(self, texts: List[str]) -> List[List[float]]:
        with self._global_lock:
            now = time.time()
            elapsed = now - self._last_request_time
            if elapsed < 0.6:
                time.sleep(0.6 - elapsed)
            type(self)._last_request_time = time.time()

            response = self._session.post(
                self.endpoint_url,
                json={
                    "model": self.model_name,
                    "input": texts,
                },
                timeout=self.timeout_seconds,
            )
            if response.status_code == 429:
                logger.warning("Embedding API rate limited (429), waiting 5s…")
                time.sleep(5.0)
                response = self._session.post(
                    self.endpoint_url,
                    json={"model": self.model_name, "input": texts},
                    timeout=self.timeout_seconds,
                )
            response.raise_for_status()
            payload = response.json()

        items = payload.get("data", [])
        ordered_embeddings: List[List[float]] = [None] * len(texts)
        for idx, item in enumerate(items):
            output_index = item.get("index", idx)
            ordered_embeddings[output_index] = item["embedding"]

        missing = [idx for idx, emb in enumerate(ordered_embeddings) if emb is None]
        if missing:
            raise ValueError(f"Missing embeddings for indices: {missing}")

        return ordered_embeddings

    def embed_documents(self, texts: List[str]) -> List[List[float]]:
        if not texts:
            return []
        all_embeddings: List[List[float]] = []
        for start in range(0, len(texts), self.batch_size):
            batch = texts[start:start + self.batch_size]
            all_embeddings.extend(self._embed_batch(batch))
        return all_embeddings

    def embed_query(self, text: str) -> List[float]:
        return self.embed_documents([text])[0]

    async def aembed_documents(self, texts: List[str]) -> List[List[float]]:
        return self.embed_documents(texts)

    async def aembed_query(self, text: str) -> List[float]:
        return self.embed_query(text)
