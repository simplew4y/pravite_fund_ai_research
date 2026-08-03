import logging
import torch
logger = logging.getLogger(__name__)

from typing import Dict, List, Optional, Set, Union, Any
from langchain_community.vectorstores import FAISS
from langchain_chroma import Chroma
from langchain_core.documents import Document
from .profiler import profiler
import time

from .bm25Retriever import BM25Retriever
from .faissRetriever import FaissRetriever, EmptyFaissRetriever
from .pageindexRetriever import PageIndexRetriever, normalize_doc_key

class EnsembleRetriever:
    """Base class for retriever wrappers that handle document content retrieval"""

    def __init__(self, bm25_dir: str,
                 chroma: Chroma,
                 ts_chroma: Chroma,
                 k: int,
                 embeddings: Any,
                 faiss_k: int = None,
                 bm25_k: int = None,
                 faiss_ts_k: int = None,
                 table_k: int = None,
                 table_chroma: Chroma = None,
                 enable_expand: bool = False,
                 embedding_lock: Optional[Any] = None,
                 allow_missing_bm25_index: bool = True,
                 pageindex_mode: str = "off",
                 pageindex_index_dir: Optional[str] = None,
                 pageindex_k: Optional[int] = None,
                 pageindex_node_top_k: int = 8,
                 pageindex_max_chunks_per_node: int = 3,
                 pageindex_page_window: int = 0,
                 pageindex_include_node_summary: bool = False,
                 pageindex_recency_boost: float = 0.0,
                 ):
        super().__init__()
        self.embeddings = embeddings
        self.embedding_lock = embedding_lock
        self.faiss_k = faiss_k if faiss_k is not None else k
        self.bm25_k = bm25_k if bm25_k is not None else k
        self.faiss_ts_k = faiss_ts_k if faiss_ts_k is not None else k
        self.table_k = table_k if table_k is not None else k
        self.enable_expand = enable_expand
        self.chroma = chroma
        self.table_chroma = table_chroma
        self.pageindex_mode = str(pageindex_mode or "off").lower()
        self.pageindex_k = int(pageindex_k if pageindex_k is not None else k)
        self.pageindex_max_chunks_per_node = max(1, int(pageindex_max_chunks_per_node))
        self.pageindex_page_window = max(0, int(pageindex_page_window))
        self.pageindex_include_node_summary = bool(pageindex_include_node_summary)
        self.bm25_retriever = BM25Retriever(
            bm25_dir, allow_missing_index=allow_missing_bm25_index
        )

        docs = chroma.get(include=["metadatas", "embeddings"])
        metadatas = docs.get("metadatas") or []
        emb_main = docs.get("embeddings")
        if emb_main is None:
            emb_main = []
        self.chunk_metadata = metadatas
        self.docid2idx = {}
        for idx, doc in enumerate(self.chunk_metadata):
            did = doc.get("doc_id") if doc else None
            if did:
                self.docid2idx[did] = idx
        self.num_chunk = len(self.chunk_metadata)

        if self.num_chunk == 0 or len(emb_main) == 0:
            logger.warning(
                "[EnsembleRetriever] Main Chroma collection is empty; dense retrieval returns no text chunks."
            )
            self.faiss_retriever = EmptyFaissRetriever()
        else:
            self.faiss_retriever = FaissRetriever(emb_main, embeddings, embedding_lock=embedding_lock)

        ts_docs = ts_chroma.get(include=["documents", "embeddings"])
        ts_docs_list = ts_docs.get("documents") or []
        ts_emb = ts_docs.get("embeddings")
        if ts_emb is None:
            ts_emb = []
        if len(ts_emb) == 0 or len(ts_docs_list) == 0:
            self.title_summary_faiss_retriever = EmptyFaissRetriever()
            self.title_summaries = []
        else:
            self.title_summary_faiss_retriever = FaissRetriever(
                ts_emb, embeddings, embedding_lock=embedding_lock
            )
            self.title_summaries = ts_docs_list
        self.pageindex_retriever = None
        self.pageindex_dockey2idxs: Dict[str, List[int]] = {}
        if self.pageindex_mode not in {"off", "none", "false", ""}:
            if not pageindex_index_dir:
                logger.warning("[EnsembleRetriever] PageIndex mode=%s but pageindex_index_dir is not set.", self.pageindex_mode)
            else:
                self.pageindex_retriever = PageIndexRetriever(
                    index_dir=pageindex_index_dir,
                    node_top_k=pageindex_node_top_k,
                    recency_boost=pageindex_recency_boost,
                )
                self.pageindex_dockey2idxs = self._build_pageindex_doc_map()
                if self.pageindex_retriever.available:
                    logger.info(
                        "[EnsembleRetriever] PageIndex enabled mode=%s nodes=%d mapped_docs=%d",
                        self.pageindex_mode,
                        len(self.pageindex_retriever.nodes),
                        len(self.pageindex_dockey2idxs),
                    )
                else:
                    logger.warning("[EnsembleRetriever] PageIndex enabled but no nodes were loaded.")

        if self.table_k > 0 and table_chroma is not None:
            table_docs = table_chroma.get(include=["documents", "embeddings", "metadatas"])
            t_emb = table_docs.get("embeddings")
            t_docs = table_docs.get("documents") or []
            t_meta = table_docs.get("metadatas") or []
            if t_emb is None or len(t_emb) == 0:
                self.table_faiss_retriever = None
                self.table_captions = []
                self.table_metadata = []
                logger.warning("[EnsembleRetriever] Table Chroma is empty; table retrieval disabled.")
            else:
                self.table_faiss_retriever = FaissRetriever(
                    t_emb, embeddings, embedding_lock=embedding_lock
                )
                self.table_captions = t_docs
                self.table_metadata = t_meta
        else:
            self.table_faiss_retriever = None
            self.table_captions = []
            self.table_metadata = []
            logger.warning("[EnsembleRetriever] Table retrieval is disabled.")

    def _resolve_bundle_ids(self, idx: int) -> tuple[List[int], Dict]:
        ids = [idx]
        doc_metadata = self.chunk_metadata[idx]
        if doc_metadata.get('bundle_id', None) is not None:
            bundle_id = doc_metadata['bundle_id']
            ids = [i for i, metadata in enumerate(self.chunk_metadata) if metadata.get('bundle_id', None) == bundle_id]
        return ids, doc_metadata

    @staticmethod
    def _source_doc_id(metadata: Optional[Dict]) -> str:
        metadata = metadata or {}
        # New collections preserve the SQLite source document id explicitly.
        # Legacy collections only have doc_id=chunk_id and therefore cannot be
        # safely company-filtered.
        return str(metadata.get("source_doc_id") or "")

    def _idx_allowed(self, idx: int, allowed_source_doc_ids: Optional[Set[str]]) -> bool:
        if idx < 0 or idx >= len(self.chunk_metadata):
            return False
        if not allowed_source_doc_ids:
            return True
        return self._source_doc_id(self.chunk_metadata[idx]) in allowed_source_doc_ids

    def _build_pageindex_doc_map(self) -> Dict[str, List[int]]:
        doc_map: Dict[str, List[int]] = {}
        for idx, metadata in enumerate(self.chunk_metadata):
            keys = {
                normalize_doc_key(metadata.get("filename")),
                normalize_doc_key(metadata.get("source_file")),
                normalize_doc_key(metadata.get("source")),
                normalize_doc_key(metadata.get("file_name")),
            }
            for key in keys:
                if key:
                    doc_map.setdefault(key, []).append(idx)
        return doc_map

    def _page_candidates_for_node(self, start_page: int, end_page: int) -> Set[int]:
        pages: Set[int] = set()
        for page in range(start_page, end_page + 1):
            for offset in range(-self.pageindex_page_window, self.pageindex_page_window + 1):
                candidate = page + offset
                if candidate >= 0:
                    pages.add(candidate)
                if page - 1 + offset >= 0:
                    pages.add(page - 1 + offset)
        return pages

    def _metadata_page_number(self, idx: int) -> Optional[int]:
        try:
            return int(self.chunk_metadata[idx].get("page_number", -999999))
        except (TypeError, ValueError):
            return None

    def _expand_ids(self, ids: List[int], doc_metadata: Dict, effective_ids: Dict[int, float], seen_ids: Set[int]) -> List[int]:
        seed_score = effective_ids.get(ids[0], 0.0)
        if (seed_score <= 0.72) or (not self.enable_expand):
            return ids

        prev_doc_id = doc_metadata['prev_chunk_id']
        next_doc_id = doc_metadata['next_chunk_id']
        expanded_ids = list(ids)
        while len(expanded_ids) < 4:
            flag = False
            if prev_doc_id != "" and self.docid2idx.get(prev_doc_id, -1) != -1:
                prev_id = self.docid2idx[prev_doc_id]
                if effective_ids.get(prev_id, 0) > 0.66 and prev_id not in seen_ids:
                    flag = True
                    seen_ids.add(prev_id)
                    expanded_ids.insert(0, prev_id)
                    prev_doc_id = self.chunk_metadata[prev_id]['prev_chunk_id']

            if next_doc_id != "" and self.docid2idx.get(next_doc_id, -1) != -1:
                next_id = self.docid2idx[next_doc_id]
                if effective_ids.get(next_id, 0) > 0.66 and next_id not in seen_ids:
                    flag = True
                    seen_ids.add(next_id)
                    expanded_ids.append(next_id)
                    next_doc_id = self.chunk_metadata[next_id]['next_chunk_id']
            if not flag:
                break
        return expanded_ids

    def _materialize_bundle(self, ids: List[int], score: float, retriever_name: str, bundle_id: int) -> List[Dict]:
        doc_ids = [self.chunk_metadata[idx]['doc_id'] for idx in ids]
        docs_dict = self.chroma.get(ids=doc_ids, include=['documents', 'metadatas'])
        return [
            {
                "retriever": retriever_name,
                "score": float(score),
                "page_content": docs_dict['documents'][idx],
                "metadata": docs_dict['metadatas'][idx],
                "bundle_id": bundle_id
            }
            for idx in range(len(docs_dict['documents']))
        ]

    def _materialize_pageindex_bundle(self, ids: List[int], score: float, bundle_id: int, node) -> List[Dict]:
        doc_ids = [self.chunk_metadata[idx]['doc_id'] for idx in ids]
        docs_dict = self.chroma.get(ids=doc_ids, include=['documents', 'metadatas'])
        chunks = []
        for idx in range(len(docs_dict['documents'])):
            metadata = dict(docs_dict['metadatas'][idx])
            metadata.update(
                {
                    "pageindex_doc_name": node.doc_name,
                    "pageindex_doc_date": node.doc_date,
                    "pageindex_node_id": node.node_id,
                    "pageindex_node_title": node.title,
                    "pageindex_node_summary": node.summary,
                    "pageindex_start_page": node.start_page,
                    "pageindex_end_page": node.end_page,
                }
            )
            page_content = docs_dict['documents'][idx]
            if self.pageindex_include_node_summary and node.summary:
                page_content = (
                    "[PageIndex structural summary]\n"
                    f"Document: {node.doc_name}\n"
                    f"Date: {node.doc_date or 'unknown'}\n"
                    f"Pages: {node.start_page}-{node.end_page}\n"
                    f"Title: {node.title}\n"
                    f"Summary: {node.summary}\n\n"
                    "[Mapped page chunk]\n"
                    f"{page_content}"
                )
            chunks.append(
                {
                    "retriever": "PageIndex",
                    "score": float(score),
                    "page_content": page_content,
                    "metadata": metadata,
                    "bundle_id": bundle_id
                }
            )
        return chunks

    def retrieve_faiss_only(
        self,
        input: str,
        k: Optional[int] = None,
        seen_ids: Optional[Set[int]] = None,
        start_bundle_id: int = 0,
        agent: str = "general",
        allowed_source_doc_ids: Optional[Set[str]] = None,
    ) -> List[Dict]:
        seen_ids = seen_ids if seen_ids is not None else set()
        chunk_list = []
        bundle_cnt = start_bundle_id
        effective_k = self.faiss_k if k is None else k

        if effective_k <= 0:
            return chunk_list

        allowed_ct = self._content_type_filter(agent)

        profiler.start("retrieve_faiss")
        faiss_ids_list, faiss_scores_list = self.faiss_retriever.invoke([input], self.num_chunk)
        faiss_ids, faiss_scores = faiss_ids_list[0], faiss_scores_list[0]
        effective_ids = {idx: score for idx, score in zip(faiss_ids, faiss_scores)}

        emitted = 0
        for idx, score in zip(faiss_ids, faiss_scores):
            if emitted >= effective_k:
                break
            if idx in seen_ids or not self._idx_allowed(idx, allowed_source_doc_ids):
                continue
            # Agent-based content_type filter
            if allowed_ct is not None and idx < len(self.chunk_metadata):
                meta = self.chunk_metadata[idx]
                if meta and meta.get("content_type") not in allowed_ct:
                    continue
            seen_ids.add(idx)
            ids, doc_metadata = self._resolve_bundle_ids(idx)
            ids = [i for i in ids if self._idx_allowed(i, allowed_source_doc_ids)]
            if not ids:
                continue
            seen_ids.update(ids)
            ids = self._expand_ids(ids, doc_metadata, effective_ids, seen_ids)
            chunk_list.extend(self._materialize_bundle(ids, score, "FAISS", bundle_cnt))
            bundle_cnt += 1
            emitted += 1

        profiler.end("retrieve_faiss")
        return chunk_list

    def retrieve_non_faiss_text(
        self,
        input: str,
        seen_ids: Optional[Set[int]] = None,
        start_bundle_id: int = 0,
        allowed_source_doc_ids: Optional[Set[str]] = None,
    ) -> List[Dict]:
        seen_ids = seen_ids if seen_ids is not None else set()
        chunk_list = []
        bundle_cnt = start_bundle_id

        if self.faiss_ts_k > 0:
            profiler.start("retrieve_faiss_ts")
            title_summary_ids, title_summary_scores = self.title_summary_faiss_retriever.invoke([input], self.faiss_ts_k)
            title_summary_ids, title_summary_scores = title_summary_ids[0], title_summary_scores[0]
            for title_idx, score in zip(title_summary_ids, title_summary_scores):
                title_summary = self.title_summaries[title_idx]
                chunk_idxs = [idx for idx, metadata in enumerate(self.chunk_metadata) if metadata.get('title_summary', '') == title_summary]
                for idx in chunk_idxs:
                    if idx in seen_ids or not self._idx_allowed(idx, allowed_source_doc_ids):
                        continue
                    seen_ids.add(idx)
                    ids, _ = self._resolve_bundle_ids(idx)
                    ids = [i for i in ids if self._idx_allowed(i, allowed_source_doc_ids)]
                    seen_ids.update(ids)
                    chunk_list.extend(self._materialize_bundle(ids, score, "Title Summary", bundle_cnt))
                    bundle_cnt += 1
            profiler.end("retrieve_faiss_ts")

        if self.bm25_k > 0 and self.pageindex_mode not in {"replace_bm25", "replace"}:
            profiler.start("retrieve_bm25")
            bm25_ids, bm25_scores = self.bm25_retriever.invoke(input, self.num_chunk)
            emitted = 0
            for idx, score in zip(bm25_ids, bm25_scores):
                if emitted >= self.bm25_k:
                    break
                if idx in seen_ids or not self._idx_allowed(idx, allowed_source_doc_ids):
                    continue
                seen_ids.add(idx)
                ids, _ = self._resolve_bundle_ids(idx)
                ids = [i for i in ids if self._idx_allowed(i, allowed_source_doc_ids)]
                seen_ids.update(ids)
                chunk_list.extend(self._materialize_bundle(ids, score, "BM25", bundle_cnt))
                bundle_cnt += 1
                emitted += 1
            profiler.end("retrieve_bm25")

        return chunk_list

    def retrieve_pageindex(
        self,
        input: str,
        seen_ids: Optional[Set[int]] = None,
        start_bundle_id: int = 0,
        allowed_source_doc_ids: Optional[Set[str]] = None,
    ) -> List[Dict]:
        seen_ids = seen_ids if seen_ids is not None else set()
        chunk_list = []
        bundle_cnt = start_bundle_id

        if (
            self.pageindex_k <= 0
            or self.pageindex_retriever is None
            or not self.pageindex_retriever.available
        ):
            return chunk_list

        profiler.start("retrieve_pageindex")
        hits = self.pageindex_retriever.retrieve_nodes(input)
        emitted_total = 0
        for hit in hits:
            if emitted_total >= self.pageindex_k:
                break
            node = hit.node
            candidate_idxs = self.pageindex_dockey2idxs.get(node.doc_key, [])
            candidate_idxs = [idx for idx in candidate_idxs if self._idx_allowed(idx, allowed_source_doc_ids)]
            if not candidate_idxs:
                continue

            pages = self._page_candidates_for_node(node.start_page, node.end_page)
            matched_idxs = [
                idx for idx in candidate_idxs
                if self._metadata_page_number(idx) in pages
            ]
            if not matched_idxs:
                continue

            matched_idxs = sorted(
                matched_idxs,
                key=lambda idx: self.chunk_metadata[idx].get("global_id", idx),
            )
            emitted_for_node = 0
            for idx in matched_idxs:
                if idx in seen_ids:
                    continue
                seen_ids.add(idx)
                ids, _ = self._resolve_bundle_ids(idx)
                ids = [i for i in ids if self._idx_allowed(i, allowed_source_doc_ids)]
                seen_ids.update(ids)
                materialized = self._materialize_pageindex_bundle(ids, hit.score, bundle_cnt, node)
                chunk_list.extend(materialized)
                bundle_cnt += 1
                emitted_for_node += len(ids)
                emitted_total += len(materialized)
                if (
                    emitted_for_node >= self.pageindex_max_chunks_per_node
                    or emitted_total >= self.pageindex_k
                ):
                    break

        profiler.end("retrieve_pageindex")
        profiler.add_metric("retrieved_pageindex", len(chunk_list))
        return chunk_list

    def _content_type_filter(self, agent: str) -> Optional[Set[str]]:
        """Return content_type values to KEEP for a given agent.

        Returns None to keep all (no filter).
        """
        if agent == "quant":
            # quant: prefer tables and metric facts, skip pure text
            return {"excel_region_summary", "excel_sheet_summary",
                    "excel_workbook_summary", "metric_fact", "table"}
        if agent == "market_researcher":
            # market_researcher: prefer text, skip raw table region dumps
            return {"text", "excel_model_section", "pdf_section"}
        return None  # keep all

    @profiler.profile_function(name="retrieve")
    def invoke(
        self,
        input: str,
        agent: str = "general",
        allowed_source_doc_ids: Optional[Set[str]] = None,
    ) -> List[Dict]:
        """Get documents with their content"""

        seen_ids = set()
        chunk_list = self.retrieve_faiss_only(
            input, agent=agent, seen_ids=seen_ids,
            allowed_source_doc_ids=allowed_source_doc_ids,
        )
        next_bundle_id = max([chunk['bundle_id'] for chunk in chunk_list], default=-1) + 1
        chunk_list.extend(self.retrieve_non_faiss_text(
            input, seen_ids=seen_ids, start_bundle_id=next_bundle_id,
            allowed_source_doc_ids=allowed_source_doc_ids,
        ))
        next_bundle_id = max([chunk['bundle_id'] for chunk in chunk_list], default=-1) + 1
        chunk_list.extend(self.retrieve_pageindex(
            input, seen_ids=seen_ids, start_bundle_id=next_bundle_id,
            allowed_source_doc_ids=allowed_source_doc_ids,
        ))

        if self.table_k > 0 and self.table_faiss_retriever is not None:
            profiler.add_metric("retrieved_chunks", len(chunk_list))

        return chunk_list

    def retrieve_tables(
        self, input: str, k: Optional[int] = None, agent: str = "general",
        allowed_source_doc_ids: Optional[Set[str]] = None,
    ) -> List[Dict]:
        """
        Retrieve top-K tables independently from text chunks.
        """
        effective_k = self.table_k if k is None else k
        if effective_k <= 0 or self.table_faiss_retriever is None:
            return []

        allowed_ct = self._content_type_filter(agent)

        profiler.start("retrieve_tables")
        search_k = len(self.table_metadata) if allowed_source_doc_ids else effective_k
        table_ids_list, table_scores_list = self.table_faiss_retriever.invoke([input], search_k)
        table_ids, table_scores = table_ids_list[0], table_scores_list[0]

        table_chunks = []
        for idx, score in zip(table_ids, table_scores):
            if idx < 0 or idx >= len(self.table_metadata):
                continue
            if allowed_source_doc_ids and self._source_doc_id(self.table_metadata[idx]) not in allowed_source_doc_ids:
                continue
            caption = self.table_captions[idx]
            # copy metadata so we don't mutate cached objects
            metadata = dict(self.table_metadata[idx]) if idx < len(self.table_metadata) else {}
            content = metadata.pop('content', '')
            # logger.info(
            #     "[TableRetrieval] hit idx=%s score=%.4f caption=%s source=%s page=%s",
            #     idx,
            #     float(score),
            #     caption.replace("\n", " ") if caption else "",
            #     metadata.get("source_file", ""),
            #     metadata.get("page_idx", ""),
            # )

            table_chunks.append(
                {
                    "retriever": "Table",
                    "score": float(score),
                    "page_content": content,
                    "metadata": {
                        **metadata,
                        "caption": caption,
                        "content_type": "table"
                    },
                    # bundle_id kept local to tables so downstream logic can keep text ranking untouched
                    "bundle_id": len(table_chunks)
                }
            )
            if len(table_chunks) >= effective_k:
                break

        profiler.end("retrieve_tables")
        profiler.add_metric("retrieved_tables", len(table_chunks))
        return table_chunks

    def compute_similarity(self, chunks: List[str], selected_indices: List[int], candidate_index: int) -> List[float]:
        """
        计算 candidate_index 对应 chunk 和 selected_indices 对应 chunks 的相似度（GPU 加速）。

        参数:
            chunks (List[str]): 文档块的字符串列表。
            selected_indices (List[int]): 选定的索引列表。
            candidate_index (int): 候选索引。

        返回:
            List[float]: candidate_index 对应 chunk 和 selected_indices 对应 chunks 的相似度列表。
        """
        # 将字符串转化为嵌入向量
        device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
        if self.embedding_lock is None:
            vectors = self.embeddings.embed_documents(chunks)
        else:
            with self.embedding_lock:
                vectors = self.embeddings.embed_documents(chunks)
        embeddings = torch.tensor(vectors, device=device)

        # 提取 candidate_index 对应的嵌入向量
        candidate_embedding = embeddings[candidate_index].unsqueeze(0)  # 添加 batch 维度

        # 提取 selected_indices 对应的嵌入向量
        selected_embeddings = embeddings[selected_indices]

        # 归一化嵌入向量
        candidate_embedding = torch.nn.functional.normalize(candidate_embedding, dim=-1)
        selected_embeddings = torch.nn.functional.normalize(selected_embeddings, dim=-1)

        # 计算余弦相似度 (使用点积)
        similarity = torch.matmul(selected_embeddings, candidate_embedding.T).squeeze(-1)

        return similarity

    def compute_similarity_mtx(self, chunks: List[str]) -> torch.Tensor:
        device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
        if not chunks:
            return torch.empty((0, 0), device=device)

        if self.embedding_lock is None:
            embeddings = torch.stack([torch.tensor(self.embeddings.embed_query(chunk), device=device) for chunk in chunks])
        else:
            with self.embedding_lock:
                embeddings = torch.stack([torch.tensor(self.embeddings.embed_query(chunk), device=device) for chunk in chunks])

        embeddings = torch.nn.functional.normalize(embeddings, dim=-1)
        similarity_mtx = torch.matmul(embeddings, embeddings.T)
        return similarity_mtx

if __name__ == "__main__":
    import os
    import yaml
    config_path = os.getenv('CONFIG_PATH', '../config/production.yaml')
    with open(config_path, 'r') as file:
        config = yaml.safe_load(file)

    #collection_name = "lotus"
    collection_name = 'zeekr'
    embeddings_model_name = config['embeddings_model_name']
    embeddings = HuggingFaceEmbeddings(model_name=embeddings_model_name)

    from langchain_chroma import Chroma
    chroma = Chroma(
        collection_name=collection_name,
        embedding_function =embeddings,
        persist_directory=os.path.join(config['persist_directory'], "chroma"),
        relevance_score_fn="l2" # l2, ip, cosine
    )
    ts_chroma = Chroma(
        collection_name=collection_name,
        embedding_function =embeddings,
        persist_directory=os.path.join(config['persist_directory'], "ts_chroma"),
        relevance_score_fn="l2" # l2, ip, cosine
    )

    bm25_dir = os.path.join(config['persist_directory'], "bm25_index", collection_name)
    retriever = EnsembleRetriever(bm25_dir, chroma, ts_chroma, 10, embeddings,
                                  faiss_k=0, bm25_k=0, faiss_ts_k=10)

    rewritten = "title: Recommendation to LCAA Shareholders summary: The LCAA Board expresses strong confidence in the fairness and advantages of all proposals set for discussion at the Extraordinary General Meeting. They unanimously urge shareholders to support the NTA Proposal, the Business Combination Proposal, the Merger Proposal, and the Adjournment Proposal, should it be introduced."

    hyde_chunks = []

    recall_chunks = retriever.invoke(rewritten, hyde_chunks)

    # save indices and distances into a log file
    with open("ensemble_retriever.log", "w") as f:
        f.write(str(recall_chunks))
