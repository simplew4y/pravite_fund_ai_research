import logging
import os
logger = logging.getLogger(__name__)

from langchain_core.retrievers import BaseRetriever
from langchain_core.documents import Document
from langchain_core.callbacks import CallbackManagerForRetrieverRun
from langchain_chroma import Chroma
from typing import List, Dict, Any, Optional
import numpy as np
import bm25s
try:
    from langchain_core.pydantic_v1 import PrivateAttr
except ModuleNotFoundError:
    from pydantic import PrivateAttr
import Stemmer

def load_from_chroma_and_save(documents: List[Document], save_dir: str):
    if not documents:
        logger.warning("load_from_chroma_and_save: no documents; skip BM25 build.")
        return

    corpus = [doc.page_content for doc in documents]
    doc_ids = [doc.metadata['doc_id'] for doc in documents]
    stemmer = Stemmer.Stemmer('english')
    corpus_tokens = bm25s.tokenize(corpus, stopwords="english", stemmer=stemmer)
    retriever = bm25s.BM25()
    retriever.index(corpus_tokens)
    retriever.save(save_dir, corpus=doc_ids)

    logging.info(f"{len(documents)} documents saved to {save_dir}")

class BM25Retriever:
    """BM25 retriever compatible with LangChain that supports metadata filtering."""

    def __init__(
        self,
        dir_path: str,
        load_corpus: bool = True,
        min_score: Optional[float] = None,
        stemmer: str = "english",
        allow_missing_index: bool = True,
    ):
        """Initialize the BM25 retriever.
        
        Args:
            documents: List of LangChain Document objects
            dir_path: Path to the BM25 index
            k: Number of documents to retrieve
            load_corpus: Whether to load the corpus from the index
            min_score: Minimum score threshold for retrieval
            stemmer: Stemmer to use, default is "english"
            allow_missing_index: If True and index files are absent, retriever runs in no-op mode
                (returns empty results) so the API can start before data/indices exist.
        """
        super().__init__()
        
        self.min_score = min_score
        self._stemmer = Stemmer.Stemmer(stemmer)
        params_path = os.path.join(dir_path, "params.index.json")
        if not os.path.isfile(params_path):
            if allow_missing_index:
                logger.warning(
                    "BM25 index not found at %s; keyword (BM25) retrieval disabled until data is loaded. "
                    "Run data_pipeline/load_data.py (it builds bm25_index at the end) or copy bm25_index from a complete dataset.",
                    params_path,
                )
                self._bm25_engine = None
                self.doc_len = 0
                return
            raise FileNotFoundError(
                f"BM25 索引不完整或不存在: 缺少 {params_path}。"
                f"请先运行 data_pipeline/load_data.py 完成导入（脚本末尾会生成 bm25_index），"
                f"或将已有数据集的 bm25_index 目录拷到当前 persist_directory 下。"
            )
        self._bm25_engine = bm25s.BM25.load(dir_path, load_corpus=load_corpus)
        self.doc_len = len(self._bm25_engine.corpus)

    @property
    def is_available(self) -> bool:
        return self._bm25_engine is not None

    def invoke(
        self,
        query: str,
        k: int,
        metadata_filters: Optional[Dict[str, Any]] = None,
    ):
        """Get documents relevant to the query.
        
        Args:
            query: String query to search for
            run_manager: CallbackManager for the retriever run
            metadata_filters: Optional dict of metadata field-value pairs to filter on
            
        Returns:
            List of relevant Document objects (doc_id)
        """

        if self._bm25_engine is None or k <= 0:
            return [], []

        query_tokens = bm25s.tokenize([query], stopwords="english", stemmer=self._stemmer)
        
        # Get BM25 scores
        if metadata_filters:
            raise NotImplementedError("Metadata filtering is not supported yet.")
            # doc_ids = self._get_filtered_doc_ids(query_tokens, metadata_filters)
        else:
            # docs: {'id': bm25_id, 'text': doc_id}
            docs, scores = self._bm25_engine.retrieve(
                query_tokens,
                k=k,
                return_as="tuple"
            )
            
            docs, scores = docs[0], scores[0]

            if self.min_score is not None:
                docs = [doc for doc, score in zip(docs, scores) if score >= self.min_score]

            ids = [doc['id'] for doc in docs]
            return ids, scores
        

    # TODO: support metadata filtering
    def _get_filtered_doc_ids(
        self,
        query_tokens: List[str],
        metadata_filters: Optional[Dict[str, Any]] = None
    ):
        docs, scores = self._bm25_engine.retrieve(
            query_tokens,
            return_as="tuple",
            k=self.doc_len
        )
        
        docs, scores = docs[0], scores[0]

        doc_ids = [doc['text'] for doc in docs]
        
        # Create mask for filtered documents
        mask = np.ones(self.doc_len, dtype=bool)
            
        # Apply metadata filters if provided
        if metadata_filters:
            for field, value in metadata_filters.items():
                field_mask = np.array([
                    doc.metadata.get(field) == value
                    for doc in self.documents
                ])
                mask &= field_mask
                
        # Apply score threshold
        if self.min_score is not None:
            mask &= (scores >= self.min_score)
            
        # Get filtered scores and documents
        filtered_scores = scores[mask]
        filtered_docs = np.array(doc_ids)[mask]
        
        # Sort by score and get top k
        if len(filtered_scores) == 0:
            return []
            
        top_k_indices = np.argsort(filtered_scores)[-self.k:][::-1]
        
        return [filtered_docs[i] for i in top_k_indices]
