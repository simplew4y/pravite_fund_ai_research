from typing import List

import requests
from langchain_core.embeddings import Embeddings


class VLLMEmbeddings(Embeddings):
    """LangChain-compatible embeddings wrapper for vLLM embedding service."""

    def __init__(
        self,
        endpoint_url: str,
        model_name: str,
        timeout_seconds: float = 60.0,
        batch_size: int = 32,
    ) -> None:
        self.endpoint_url = endpoint_url.rstrip("/")
        self.model_name = model_name
        self.timeout_seconds = timeout_seconds
        self.batch_size = max(int(batch_size), 1)
        self._session = requests.Session()

    def _embed_batch(self, texts: List[str]) -> List[List[float]]:
        response = self._session.post(
            self.endpoint_url,
            json={
                "model": self.model_name,
                "input": texts,
            },
            timeout=self.timeout_seconds,
        )
        if not response.ok:
            lengths = [len(text) for text in texts]
            raise RuntimeError(
                f"Embedding request failed with HTTP {response.status_code}; "
                f"batch_size={len(texts)}, char_lengths={lengths}, "
                f"response={response.text[:1000]!r}"
            )
        payload = response.json()

        items = payload.get("data", [])
        ordered_embeddings: List[List[float]] = [None] * len(texts)  # type: ignore[list-item]
        for idx, item in enumerate(items):
            output_index = item.get("index", idx)
            ordered_embeddings[output_index] = item["embedding"]

        missing = [idx for idx, embedding in enumerate(ordered_embeddings) if embedding is None]
        if missing:
            raise ValueError(f"Missing embeddings for indices: {missing}")

        return ordered_embeddings  # type: ignore[return-value]

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
