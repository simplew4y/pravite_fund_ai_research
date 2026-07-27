"""LocalEmbeddings — CPU-inference via sentence-transformers.

Drop-in replacement for VLLMEmbeddings when config
``embedding_backend: "local"``.  Zero API calls, zero ports,
zero rate limits.
"""

import logging
import os
from typing import List, Optional

logger = logging.getLogger(__name__)

_DEFAULT_MODEL = "BAAI/bge-small-zh-v1.5"


class LocalEmbeddings:
    """LangChain-compatible local embedding via sentence-transformers."""

    def __init__(
        self,
        model_name: str = _DEFAULT_MODEL,
        batch_size: int = 16,
        device: str = "cpu",
    ):
        self.model_name = model_name
        self.batch_size = batch_size
        self.device = device
        self._model = None

    # ------------------------------------------------------------------
    # Lazy-load helpers
    # ------------------------------------------------------------------
    @property
    def model(self):
        if self._model is None:
            self._load()
        return self._model

    def _load(self):
        import huggingface_hub as hf

        # Check cache first
        try:
            hf.snapshot_download(self.model_name, local_files_only=True)
        except Exception:
            print(
                f"Embedding model \"{self.model_name}\" not cached (~30 MB).\n"
                f"Downloading once — this will not happen again."
            )
            hf.snapshot_download(self.model_name)

        from sentence_transformers import SentenceTransformer

        logger.info("Loading embedding model %s on %s ...", self.model_name, self.device)
        # Set offline env vars so SentenceTransformer doesn't re-check remote
        old_offline = os.environ.get("TRANSFORMERS_OFFLINE")
        old_hf_offline = os.environ.get("HF_HUB_OFFLINE")
        os.environ["TRANSFORMERS_OFFLINE"] = "1"
        os.environ["HF_HUB_OFFLINE"] = "1"
        try:
            self._model = SentenceTransformer(
                self.model_name,
                device=self.device,
            )
        finally:
            # Restore env vars so other code (e.g. LLM calls via API) stays unaffected
            if old_offline is None:
                os.environ.pop("TRANSFORMERS_OFFLINE", None)
            else:
                os.environ["TRANSFORMERS_OFFLINE"] = old_offline
            if old_hf_offline is None:
                os.environ.pop("HF_HUB_OFFLINE", None)
            else:
                os.environ["HF_HUB_OFFLINE"] = old_hf_offline
        logger.info("Embedding model loaded.")

    # ------------------------------------------------------------------
    # LangChain Embeddings interface
    # ------------------------------------------------------------------
    def embed_documents(self, texts: List[str]) -> List[List[float]]:
        if not texts:
            return []
        embeds = self.model.encode(
            texts,
            batch_size=self.batch_size,
            show_progress_bar=False,
            normalize_embeddings=True,
        )
        return embeds.tolist()

    def embed_query(self, text: str) -> List[float]:
        return self.embed_documents([text])[0]

    async def aembed_documents(self, texts: List[str]) -> List[List[float]]:
        return self.embed_documents(texts)

    async def aembed_query(self, text: str) -> List[float]:
        return self.embed_query(text)
