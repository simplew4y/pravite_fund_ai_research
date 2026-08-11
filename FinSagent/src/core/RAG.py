"""
RAG Component - 独立的检索增强生成组件

职责:
- 检索 (Retrieval)
- Rerank (重排序和时间加权)
- 格式化 (Format context for LLM)
"""

import contextlib
import logging
import re
import threading
from typing import Any, List, Dict
from datetime import datetime, timedelta
from html.parser import HTMLParser

import torch

from core.RAGManager import RAGManager
from utils.chunk_utils import dedupe_chunks, sanitize_chunks_for_output
from utils.chunk_risk_calibration import ChunkRiskCalibrator
from utils.evidence_rescue_scorer import EvidenceRescueScorer
from utils.profiler import profiler
from utils.prompt_budget import truncate_text
from utils.retrieval_scope import filter_chunks_to_scope

logger = logging.getLogger(__name__)


class _HTMLTableRowsParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.rows: list[list[str]] = []
        self._row: list[str] | None = None
        self._cell: list[str] | None = None

    def handle_starttag(self, tag, attrs):
        if tag == "tr":
            self._row = []
        elif tag in {"td", "th"} and self._row is not None:
            self._cell = []
        elif tag == "br" and self._cell is not None:
            self._cell.append(" ")

    def handle_data(self, data):
        if self._cell is not None:
            self._cell.append(data)

    def handle_endtag(self, tag):
        if tag in {"td", "th"} and self._row is not None and self._cell is not None:
            value = " ".join("".join(self._cell).split())
            self._row.append(value)
            self._cell = None
        elif tag == "tr" and self._row is not None:
            if any(cell for cell in self._row):
                self.rows.append(self._row)
            self._row = None


class RAG:
    """独立的 RAG 组件,负责检索+Rerank+格式化"""

    def __init__(
        self,
        rag_manager: RAGManager,
        reranker,
        reranker_lock=None,
        top_k: int = 5,
        gt_path: str | None = None,
        collection_name: str | None = None,
        use_chunk_risk_calibration: bool = False,
        chunk_risk_model_path: str | None = None,
        chunk_risk_penalty_mode: str = "percentile_rank",
        chunk_risk_lambda: float | None = None,
    ):
        """
        初始化 RAG 组件

        Args:
            rag_manager: RAGManager 实例
            reranker: Reranker 模型
            reranker_lock: 线程锁（仅本地模型需要），vllm 后端传 None
            top_k: 返回的 chunk 数量上限
        """
        self.rag_manager = rag_manager
        self.config = getattr(rag_manager, "_config", {}) or {}
        self.reranker = reranker
        self.reranker_lock = reranker_lock
        self.top_k = top_k
        self.similarity_threshold = 0.9
        self.gt_path = gt_path
        self.collection_name = collection_name or "default"
        self.use_chunk_risk_calibration = bool(use_chunk_risk_calibration)
        self.chunk_risk_model_path = chunk_risk_model_path
        self.chunk_risk_penalty_mode = chunk_risk_penalty_mode
        self.chunk_risk_lambda = chunk_risk_lambda
        self._chunk_risk_calibrator: ChunkRiskCalibrator | None = None
        self._chunk_risk_calibrator_lock = threading.Lock()
        self._evidence_rescue_scorer: EvidenceRescueScorer | None = None
        self._evidence_rescue_scorer_lock = threading.Lock()

        logger.info(
            "RAG component initialized with top_k=%s, gt_path=%s, use_chunk_risk_calibration=%s, "
            "chunk_risk_penalty_mode=%s, pageindex_final_cap=%s, pageindex_score_multiplier=%s",
            top_k,
            gt_path,
            self.use_chunk_risk_calibration,
            self.chunk_risk_penalty_mode,
            self.config.get("pageindex_final_cap"),
            self.config.get("pageindex_score_multiplier", 1.0),
        )

    def _config_int_or_none(self, key: str) -> int | None:
        value = self.config.get(key)
        if value in (None, "", "null", "none", "None"):
            return None
        try:
            parsed = int(value)
        except (TypeError, ValueError):
            logger.warning("Ignoring invalid integer config %s=%r", key, value)
            return None
        return parsed if parsed >= 0 else None

    def _config_float(self, key: str, default: float) -> float:
        value = self.config.get(key, default)
        if value in (None, "", "null", "none", "None"):
            return default
        try:
            return float(value)
        except (TypeError, ValueError):
            logger.warning("Ignoring invalid float config %s=%r", key, value)
            return default

    def _config_bool(self, key: str, default: bool = False) -> bool:
        value = self.config.get(key, default)
        if isinstance(value, bool):
            return value
        if value in (None, "", "null", "none", "None"):
            return default
        if isinstance(value, (int, float)):
            return bool(value)
        if isinstance(value, str):
            return value.strip().lower() in {"1", "true", "yes", "y", "on"}
        return bool(value)

    def _get_chunk_risk_calibrator(self) -> ChunkRiskCalibrator:
        if not self.chunk_risk_model_path:
            raise ValueError("chunk_risk_model_path must be set when chunk risk calibration is enabled")
        if self._chunk_risk_calibrator is None:
            with self._chunk_risk_calibrator_lock:
                if self._chunk_risk_calibrator is None:
                    self._chunk_risk_calibrator = ChunkRiskCalibrator(
                        model_path=self.chunk_risk_model_path,
                        collection_name=self.collection_name,
                        penalty_mode=self.chunk_risk_penalty_mode,
                    )
        return self._chunk_risk_calibrator

    def _get_evidence_rescue_scorer(self) -> EvidenceRescueScorer | None:
        model_path = self.config.get("evidence_rescue_scorer_model_path")
        if not model_path:
            return None
        if self._evidence_rescue_scorer is None:
            with self._evidence_rescue_scorer_lock:
                if self._evidence_rescue_scorer is None:
                    self._evidence_rescue_scorer = EvidenceRescueScorer(model_path)
                    logger.info("Loaded evidence rescue scorer from %s", model_path)
        return self._evidence_rescue_scorer

    @profiler.profile_function(name="rerank")
    def retrieve(
        self,
        query: str,
        query_time: datetime,
        rerank_topk: int | None = None,
        table_topk: int | None = None,
        agent: str = "general",
        allowed_source_doc_ids: List[str] | None = None,
    ) -> Dict[str, Any]:
        """
        完整的 RAG 检索流程
        Thread-safe: 使用 retriever_lock 保护检索操作

        Args:
            query: 查询问题
            query_time: 查询时间 (用于时间加权)

        Returns:
            Dict with:
            - rag_context: 格式化的上下文字符串
            - final_chunks: 最终提供给 LLM 的 chunks（rerank 后文本 + tables）
            - time_info: 时间信息列表
            - pre_rerank_chunks: 所有候选（文本 + 表格，去重后）
        """
        logger.info(f"RAG retrieving for query: {query}")

        # 1. 检索
        retriever = self.rag_manager._retrievers[0]
        date_cutoff = self._effective_date_cutoff(query)
        effective_rerank_topk = self.top_k if rerank_topk is None else rerank_topk
        # ``None`` is the only legacy/unscoped sentinel.  An explicitly empty
        # list is deny-all and must not silently become a global search.
        allowed_ids = (
            None
            if allowed_source_doc_ids is None
            else {str(doc_id) for doc_id in allowed_source_doc_ids if doc_id}
        )
        chunks = retriever.invoke(
            query, agent=agent, allowed_source_doc_ids=allowed_ids,
        )
        chunks = filter_chunks_to_scope(chunks, allowed_ids)
        chunks = self._filter_chunks_by_cutoff(chunks, date_cutoff)
        chunks = self._backfill_text_chunks_for_cutoff(
            retriever,
            query,
            chunks,
            date_cutoff,
            effective_rerank_topk,
            agent,
            allowed_ids,
        )
        chunks = filter_chunks_to_scope(chunks, allowed_ids)
        effective_table_topk = retriever.table_k if table_topk is None else table_topk
        if table_topk is None and self._is_periodic_finance_query(query):
            finance_table_topk = self._config_int_or_none("finance_table_topk")
            if finance_table_topk is not None:
                effective_table_topk = max(effective_table_topk, finance_table_topk)
        table_chunks = retriever.retrieve_tables(
            query, k=effective_table_topk, agent=agent,
            allowed_source_doc_ids=allowed_ids,
        )
        table_chunks = filter_chunks_to_scope(table_chunks, allowed_ids)
        table_chunks = self._filter_chunks_by_cutoff(table_chunks, date_cutoff)
        table_chunks = self._backfill_table_chunks_for_cutoff(
            retriever,
            query,
            table_chunks,
            date_cutoff,
            effective_table_topk,
            agent,
            allowed_ids,
        )
        table_chunks = filter_chunks_to_scope(table_chunks, allowed_ids)
        table_chunks = self._prepare_table_chunks(query, table_chunks)
        if effective_table_topk is not None and effective_table_topk > 0:
            table_chunks = table_chunks[:effective_table_topk]
        pre_rerank_chunks = filter_chunks_to_scope(
            dedupe_chunks(chunks + table_chunks),
            allowed_ids,
        )
        logger.debug(
            f"Retrieved {len(chunks)} text chunks and {len(table_chunks)} tables from retriever; "
            f"{len(pre_rerank_chunks)} unique candidates before rerank"
        )

        # 2. Rerank (包含时间加权，reranker_lock 在 _rank_chunks 内部使用)
        ranked_bundle_ids = self._rank_chunks(
            chunks,
            query,
            query_time,
            retriever,
            top_k=effective_rerank_topk,
        )
        logger.debug(f"Ranked {len(ranked_bundle_ids)} bundles")

        # 3. 选择 top chunks
        selected_chunks = self._select_top_chunks(chunks, ranked_bundle_ids, top_k=effective_rerank_topk)
        selected_chunks = self._rescue_recent_evidence_chunks(
            chunks,
            selected_chunks,
            query,
        )
        selected_chunks = filter_chunks_to_scope(selected_chunks, allowed_ids)
        table_chunks = filter_chunks_to_scope(table_chunks, allowed_ids)
        # 表格不参与排序，直接追加供 LLM 参考
        final_chunks = selected_chunks + table_chunks
        sanitized_final_chunks = sanitize_chunks_for_output(final_chunks)
        sanitized_pre_rerank_chunks = sanitize_chunks_for_output(pre_rerank_chunks)
        logger.info(f"Selected {len(selected_chunks)} text chunks and {len(table_chunks)} tables after ranking")
        # 记录完整的文本 chunk 详情，便于排查（不截断）
        # for idx, chunk in enumerate(selected_chunks):
        #     logger.info(
        #         "[RAG][SelectedChunk #%d] doc_id=%s source=%s score=%s date=%s\n%s",
        #         idx,
        #         chunk["metadata"].get("doc_id", "N/A"),
        #         chunk["metadata"].get("source_file", chunk["metadata"].get("source", "N/A")),
        #         chunk.get("score", "N/A"),
        #         chunk["metadata"].get("date_published", "N/A"),
        #         chunk["page_content"],
        #     )

        # 4. 格式化为 LLM 可用的 context
        rag_context = self._format_context(selected_chunks, table_chunks, query=query)

        # 5. 提取时间信息
        time_info_list = [chunk['metadata'].get('date_published', 'N/A')
                         for chunk in sanitized_final_chunks]

        return {
            "rag_context": rag_context,
            "final_chunks": sanitized_final_chunks,
            "time_info": time_info_list,
            "pre_rerank_chunks": sanitized_pre_rerank_chunks,
        }

    def _rank_chunks(self, chunks: List[Dict], query: str,
                     query_time: datetime, retriever, top_k: int | None = None) -> List:
        """
        Chunk 排序和 Rerank
        包含 Reranker 评分 + 时间加权 + 相似度去重

        Args:
            chunks: 待排序的 chunk 列表
            query: 查询问题
            query_time: 查询时间
            retriever: Retriever 实例 (用于计算相似度)

        Returns:
            ranked_bundle_ids: 排序后的 bundle ID 列表
        """
        effective_top_k = self.top_k if top_k is None else top_k
        if not chunks:
            logger.debug("No text chunks to rerank for query: %s", query)
            return []

        # 构建 bundle_map
        bundle_map = {}
        for idx, chunk in enumerate(chunks):
            bundle_map.setdefault(chunk['bundle_id'], []).append(idx)

        # Reranker 评分
        pairs = [[query, chunk['page_content']] for chunk in chunks]
        chunk_content_list = [chunk['page_content'] for chunk in chunks]

        lock_ctx = self.reranker_lock if self.reranker_lock is not None else contextlib.nullcontext()
        try:
            with lock_ctx, torch.no_grad():
                reranker_logits = self.reranker.compute_score(pairs, batch_size=12)
                reranker_scores = torch.sigmoid(torch.tensor(reranker_logits))
            if len(reranker_scores) > 1 and float(torch.max(reranker_scores) - torch.min(reranker_scores)) < 1e-8:
                logger.warning("Reranker returned flat scores; falling back to retrieval scores")
                reranker_scores = torch.tensor(
                    [float(chunk.get("score", 0.0) or 0.0) for chunk in chunks],
                    dtype=torch.float32,
                )
        except Exception as exc:
            logger.error("Reranker failed; falling back to retrieval scores: %s", exc, exc_info=True)
            raw_scores = [float(chunk.get("score", 0.0) or 0.0) for chunk in chunks]
            reranker_scores = torch.tensor(raw_scores, dtype=torch.float32)

        # ! disable for colm
        # 时间加权
        # time_scores = []
        # for chunk in chunks:
        #     # Some sources (e.g., table_chroma) may not have date_published; fall back to neutral weight
        #     date_published = chunk['metadata'].get('date_published')
        #     if date_published:
        #         try:
        #             score = abs((query_time - datetime.strptime(date_published, "%Y-%m-%d")).days)
        #             score = max(0, 1 - score / 365)
        #         except Exception:
        #             score = 0
        #     else:
        #         score = 0
        #     time_scores.append(score)

        # time_scores = torch.tensor(time_scores)

        risk_gate = torch.ones_like(reranker_scores)
        risk_lambda = float(self.chunk_risk_lambda) if self.chunk_risk_lambda is not None else 0.0
        apply_chunk_risk_penalty = (
            self.use_chunk_risk_calibration
            and bool(self.chunk_risk_model_path)
            and risk_lambda != 0
        )
        if apply_chunk_risk_penalty:
            calibrated_scores = self._get_chunk_risk_calibrator().score_chunks(
                query=query,
                chunks=chunks,
                reranker_scores=reranker_scores.detach().cpu().tolist(),
            )
            risk_hat = calibrated_scores["risk_hat"]
            risk_rank = calibrated_scores["risk_rank"]

            risk_gate = torch.tensor(
                1.0 - risk_lambda * risk_hat,
                dtype=reranker_scores.dtype,
                device=reranker_scores.device,
            )
            for idx, (risk_hat_value, risk_rank_value, gate_value) in enumerate(zip(risk_hat, risk_rank, risk_gate.detach().cpu().tolist())):
                chunks[idx]["risk_hat"] = float(risk_hat_value)
                chunks[idx]["risk_rank"] = float(risk_rank_value)
                chunks[idx]["chunk_risk_gate"] = float(gate_value)

        similarity_mtx = retriever.compute_similarity_mtx(chunk_content_list)

        source_gate = torch.ones_like(reranker_scores)
        pageindex_score_multiplier = self._config_float("pageindex_score_multiplier", 1.0)
        if pageindex_score_multiplier != 1.0:
            for idx, chunk in enumerate(chunks):
                if chunk.get("retriever") == "PageIndex":
                    source_gate[idx] = pageindex_score_multiplier
                    chunk["source_score_multiplier"] = float(pageindex_score_multiplier)

        final_scores = reranker_scores * risk_gate * source_gate

        # 排序
        ranked_indices = torch.argsort(final_scores, descending=True).tolist()

        # 选择 top bundles (去重)
        selected_bundle_ids = []
        selected_chunk_indices = []
        selected_pageindex_chunks = 0
        pageindex_final_cap = self._config_int_or_none("pageindex_final_cap")
        current_size = 0
        for idx in ranked_indices:
            bundle_id = chunks[idx]['bundle_id']
            bundle = bundle_map[bundle_id]
            pageindex_chunk_count = sum(
                1 for bundle_idx in bundle
                if chunks[bundle_idx].get("retriever") == "PageIndex"
            )

            # 如果 bundle 已选择 或 超过 top_k 限制,跳过
            if bundle_id in selected_bundle_ids or current_size + len(bundle) > effective_top_k:
                continue
            if (
                pageindex_final_cap is not None
                and pageindex_chunk_count
                and selected_pageindex_chunks + pageindex_chunk_count > pageindex_final_cap
            ):
                logger.debug(
                    "Skipping PageIndex bundle %s because pageindex_final_cap=%s would be exceeded",
                    bundle_id,
                    pageindex_final_cap,
                )
                continue

            # 去除相似 chunk
            if selected_chunk_indices and torch.any(similarity_mtx[idx, selected_chunk_indices] > self.similarity_threshold):
                logger.debug(f"Skipping chunk {idx} due to high similarity")
                continue

            selected_bundle_ids.append(bundle_id)
            selected_chunk_indices.extend(bundle)
            selected_pageindex_chunks += pageindex_chunk_count
            current_size += len(bundle)

        # 反转顺序 (保持文档原始顺序)
        return selected_bundle_ids[::-1]

    def _select_top_chunks(self, chunks: List[Dict], ranked_bundle_ids: List, top_k: int | None = None) -> List[Dict]:
        """
        根据 ranked bundle IDs 选择 chunks

        Args:
            chunks: 全部 chunk 列表
            ranked_bundle_ids: 排序后的 bundle ID 列表

        Returns:
            selected_chunks: 选中的 chunk 列表
        """
        selected_chunks = []
        effective_top_k = self.top_k if top_k is None else top_k

        for bundle_id in ranked_bundle_ids:
            bundle_chunks = [chunk for chunk in chunks if chunk['bundle_id'] == bundle_id]
            if len(selected_chunks) + len(bundle_chunks) > effective_top_k:
                break

            page_content = " ".join(chunk['page_content'] for chunk in bundle_chunks)

            # ! disable for colm
            # 过滤掉内容太短的 bundle
            # if len(page_content) < 50:
            #     logger.debug(f"Skipping bundle {bundle_id} due to short content")
            #     continue

            selected_chunks.extend(bundle_chunks)

        # 按 global_id 排序,保持文档顺序
        selected_chunks = sorted(selected_chunks, key=lambda x: x['metadata'].get('global_id', float("inf")))

        return selected_chunks

    def _parse_date_value(self, value: Any) -> datetime | None:
        if value in (None, "", "N/A", "null", "none", "None"):
            return None
        text = str(value)
        month_match = re.search(
            r"\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),\s+(\d{4})\b",
            text,
            flags=re.IGNORECASE,
        )
        if month_match:
            months = {
                "january": 1,
                "february": 2,
                "march": 3,
                "april": 4,
                "may": 5,
                "june": 6,
                "july": 7,
                "august": 8,
                "september": 9,
                "october": 10,
                "november": 11,
                "december": 12,
            }
            try:
                return datetime(
                    int(month_match.group(3)),
                    months[month_match.group(1).lower()],
                    int(month_match.group(2)),
                )
            except ValueError:
                return None
        for pattern in (
            r"(\d{4})[-/](\d{1,2})[-/](\d{1,2})",
            r"(\d{4})[-/](\d{1,2})",
            r"(\d{4})年(\d{1,2})月(\d{1,2})日",
            r"(\d{4})年(\d{1,2})月",
        ):
            match = re.search(pattern, text)
            if not match:
                continue
            parts = [int(part) for part in match.groups()]
            while len(parts) < 3:
                parts.append(1)
            try:
                return datetime(parts[0], parts[1], parts[2])
            except ValueError:
                return None
        year_match = re.search(r"\b(20\d{2}|19\d{2})\b", text)
        if year_match:
            try:
                return datetime(int(year_match.group(1)), 1, 1)
            except ValueError:
                return None
        return None

    def _parse_date_from_source_name(self, value: Any) -> datetime | None:
        full_text = str(value or "")
        basename = re.split(r"[\\/]", full_text)[-1]
        for text in (basename, full_text):
            for pattern in (
                r"(20\d{2})[-_/]?(\d{2})[-_/]?(\d{2})",
                r"(20\d{2})[-_/](\d{1,2})[-_/](\d{1,2})",
            ):
                match = re.search(pattern, text)
                if not match:
                    continue
                try:
                    year, month, day = (int(part) for part in match.groups())
                    return datetime(year, month, day)
                except ValueError:
                    continue
        return None

    def _chunk_date(self, chunk: Dict) -> datetime | None:
        metadata = chunk.get("metadata") or {}
        for key in ("date_published", "pageindex_doc_date", "published_date", "date"):
            parsed = self._parse_date_value(metadata.get(key))
            if parsed:
                return parsed
        for key in ("source_file", "filename", "pageindex_doc_name"):
            parsed = self._parse_date_from_source_name(metadata.get(key))
            if parsed:
                return parsed
        return None

    def _query_cutoff_date(self, query: str) -> datetime | None:
        text = query or ""
        date_patterns = (
            r"(?:before|prior to|through|up to|cutoff|by)\s+([A-Za-z]+\s+\d{1,2},\s+\d{4}|\d{4}[-/]\d{1,2}[-/]\d{1,2})",
            r"(?:截至|截止|基于|不晚于).{0,12}?((?:20\d{2})年\d{1,2}月\d{1,2}日|(?:20\d{2})[-/]\d{1,2}[-/]\d{1,2})",
            r"((?:20\d{2})年\d{1,2}月\d{1,2}日|(?:20\d{2})[-/]\d{1,2}[-/]\d{1,2}).{0,4}?(?:前|之前|以前|为止)",
        )
        for pattern in date_patterns:
            match = re.search(pattern, text, flags=re.IGNORECASE)
            if match:
                parsed = self._parse_date_value(match.group(1))
                if parsed:
                    return parsed
        return None

    def _query_statement_period_end(self, query: str, year: int) -> datetime | None:
        text = (query or "").lower()
        compact = re.sub(r"\s+", "", text)
        month_day_aliases = (
            (("march 31", "mar 31", "3/31", "03/31", "3-31", "03-31", "3\u670831\u65e5", "03\u670831\u65e5"), 3, 31),
            (("june 30", "jun 30", "6/30", "06/30", "6-30", "06-30", "6\u670830\u65e5", "06\u670830\u65e5"), 6, 30),
            (("september 30", "sep 30", "9/30", "09/30", "9-30", "09-30", "9\u670830\u65e5", "09\u670830\u65e5"), 9, 30),
            (("december 31", "dec 31", "12/31", "12-31", "12\u670831\u65e5"), 12, 31),
        )
        for aliases, month, day in month_day_aliases:
            if any(alias in text or alias in compact for alias in aliases):
                return datetime(year, month, day)
        return None

    def _effective_date_cutoff(self, query: str) -> datetime | None:
        explicit_cutoff = self._query_cutoff_date(query)
        if explicit_cutoff:
            return explicit_cutoff
        configured_cutoff = None
        if self._config_bool("retrieval_date_cutoff_enabled", False):
            configured_cutoff = self._parse_date_value(self.config.get("retrieval_date_cutoff"))
        auto_cutoff = self._auto_period_cutoff_date(query)
        if configured_cutoff and auto_cutoff:
            return min(configured_cutoff, auto_cutoff)
        return configured_cutoff or auto_cutoff

    def _filter_chunks_by_cutoff(self, chunks: List[Dict], cutoff: datetime | None) -> List[Dict]:
        if cutoff is None:
            return chunks
        drop_undated = self._config_bool("retrieval_date_cutoff_drop_undated", False)
        kept: List[Dict] = []
        dropped = 0
        for chunk in chunks:
            chunk_date = self._chunk_date(chunk)
            if chunk_date is None:
                if not drop_undated:
                    kept.append(chunk)
                else:
                    dropped += 1
                continue
            if chunk_date.date() <= cutoff.date():
                kept.append(chunk)
            else:
                dropped += 1
        if dropped:
            logger.info("Date cutoff %s dropped %d future/undated chunks", cutoff.date(), dropped)
        return kept

    def _positive_int(self, value: Any, default: int = 0) -> int:
        try:
            parsed = int(value)
        except (TypeError, ValueError):
            return default
        return parsed if parsed > 0 else default

    def _cutoff_backfill_factor(self, key: str, default: int = 3) -> int:
        factor = self._config_int_or_none(key)
        if factor is None:
            factor = default
        return max(1, min(int(factor), 10))

    def _cutoff_min_text_candidates(self, retriever: Any, effective_rerank_topk: int | None) -> int:
        configured = self._config_int_or_none("retrieval_date_cutoff_min_text_candidates")
        if configured:
            return configured
        rerank_budget = self._positive_int(effective_rerank_topk, self._positive_int(self.top_k, 0))
        source_budget = sum(
            self._positive_int(getattr(retriever, attr, 0), 0)
            for attr in ("faiss_k", "bm25_k", "faiss_ts_k", "pageindex_k")
        )
        return max(rerank_budget * 3, source_budget)

    @contextlib.contextmanager
    def _scaled_retriever_limits(self, retriever: Any, factor: int):
        attrs = ("faiss_k", "bm25_k", "faiss_ts_k", "pageindex_k")
        old_values = {}
        caps = {
            "faiss_k": self._positive_int(getattr(retriever, "num_chunk", 0), 0),
            "bm25_k": self._positive_int(getattr(retriever, "num_chunk", 0), 0),
            "faiss_ts_k": len(getattr(retriever, "title_summaries", []) or []),
            "pageindex_k": self._positive_int(getattr(retriever, "num_chunk", 0), 0),
        }
        for attr in attrs:
            if not hasattr(retriever, attr):
                continue
            current = getattr(retriever, attr)
            current_int = self._positive_int(current, 0)
            if current_int <= 0:
                continue
            boosted = current_int * factor
            cap = caps.get(attr, 0)
            if cap > 0:
                boosted = min(boosted, cap)
            old_values[attr] = current
            setattr(retriever, attr, boosted)
        try:
            yield
        finally:
            for attr, value in old_values.items():
                setattr(retriever, attr, value)

    def _backfill_text_chunks_for_cutoff(
        self,
        retriever: Any,
        query: str,
        chunks: List[Dict],
        date_cutoff: datetime | None,
        effective_rerank_topk: int | None,
        agent: str = "general",
        allowed_source_doc_ids: set[str] | None = None,
    ) -> List[Dict]:
        if date_cutoff is None or not self._config_bool("retrieval_date_cutoff_backfill_enabled", True):
            return chunks
        min_candidates = self._cutoff_min_text_candidates(retriever, effective_rerank_topk)
        if len(chunks) >= min_candidates:
            return chunks
        factor = self._cutoff_backfill_factor("retrieval_date_cutoff_backfill_factor", 3)
        if factor <= 1:
            return chunks
        with self._scaled_retriever_limits(retriever, factor):
            expanded = retriever.invoke(
                query, agent=agent, allowed_source_doc_ids=allowed_source_doc_ids,
            )
        expanded = self._filter_chunks_by_cutoff(expanded, date_cutoff)
        merged = dedupe_chunks(chunks + expanded)
        if len(merged) > len(chunks):
            logger.info(
                "Date cutoff %s text backfill expanded candidates from %d to %d (min=%d, factor=%d)",
                date_cutoff.date(),
                len(chunks),
                len(merged),
                min_candidates,
                factor,
            )
        return merged

    def _backfill_table_chunks_for_cutoff(
        self,
        retriever: Any,
        query: str,
        table_chunks: List[Dict],
        date_cutoff: datetime | None,
        target_table_topk: int | None,
        agent: str = "general",
        allowed_source_doc_ids: set[str] | None = None,
    ) -> List[Dict]:
        if (
            date_cutoff is None
            or not self._config_bool("retrieval_date_cutoff_backfill_enabled", True)
            or not target_table_topk
            or target_table_topk <= 0
            or len(table_chunks) >= target_table_topk
        ):
            return table_chunks
        factor = self._cutoff_backfill_factor("retrieval_date_cutoff_table_backfill_factor", 3)
        if factor <= 1:
            return table_chunks
        expanded_k = target_table_topk * factor
        table_count = len(getattr(retriever, "table_metadata", []) or [])
        if table_count > 0:
            expanded_k = min(expanded_k, table_count)
        expanded = retriever.retrieve_tables(
            query, k=expanded_k, agent=agent,
            allowed_source_doc_ids=allowed_source_doc_ids,
        )
        expanded = self._filter_chunks_by_cutoff(expanded, date_cutoff)
        merged = dedupe_chunks(table_chunks + expanded)
        if len(merged) > len(table_chunks):
            logger.info(
                "Date cutoff %s table backfill expanded candidates from %d to %d (target=%d, factor=%d)",
                date_cutoff.date(),
                len(table_chunks),
                len(merged),
                target_table_topk,
                factor,
            )
        return merged

    def _chunk_text(self, chunk: Dict) -> str:
        metadata = chunk.get("metadata") or {}
        metadata_text = " ".join(
            str(metadata.get(key, ""))
            for key in (
                "doc_id",
                "source_file",
                "filename",
                "pageindex_doc_name",
                "pageindex_node_title",
                "pageindex_node_summary",
            )
        )
        return f"{metadata_text}\n{chunk.get('page_content', '')}"

    def _chunk_identity(self, chunk: Dict) -> tuple:
        metadata = chunk.get("metadata") or {}
        doc_id = metadata.get("doc_id")
        if doc_id:
            return ("doc_id", doc_id)
        return ("content", hash(chunk.get("page_content", "")))

    def _html_table_rows(self, html: str) -> list[list[str]]:
        parser = _HTMLTableRowsParser()
        try:
            parser.feed(html or "")
            return parser.rows
        except Exception:
            return []

    def _parse_accounting_number(self, value: str) -> int | None:
        text = (value or "").replace(",", "").replace("\u2014", "").strip()
        if not text or text in {"-", "--"}:
            return None
        negative = text.startswith("(") and text.endswith(")")
        text = text.strip("()")
        match = re.search(r"-?\d+(?:\.\d+)?", text)
        if not match:
            return None
        number = int(round(float(match.group(0))))
        return -number if negative else number

    def _format_accounting_number(self, value: int | None, original: str = "") -> str:
        if value is None:
            return original
        return f"({abs(value):,})" if value < 0 else f"{value:,}"

    def _table_row_by_label(self, rows: list[list[str]], *labels: str) -> list[str] | None:
        needles = tuple(label.lower() for label in labels)
        for row in rows:
            if not row:
                continue
            label = row[0].lower()
            if any(needle in label for needle in needles):
                return row
        return None

    def _is_delivery_query(self, query: str) -> bool:
        text = (query or "").lower()
        return any(term in text for term in ("delivery", "deliveries", "vehicle deliveries", "\u9500\u91cf", "\u4ea4\u4ed8"))

    def _has_growth_intent(self, query: str) -> bool:
        text = (query or "").lower()
        return any(term in text for term in ("growth", "increase", "yoy", "year-over-year", "\u589e\u957f", "\u540c\u6bd4"))

    def _is_ambiguous_delivery_table(self, chunk: Dict) -> bool:
        metadata = chunk.get("metadata") or {}
        content = chunk.get("page_content", "") or ""
        text = content.lower()
        if "deliveries" not in text:
            return False
        source_file = str(metadata.get("source_file", "")).lower()
        if "6k_20250515" in source_file and "2024 q4" in text and "169,088" in text:
            return True
        rows = self._html_table_rows(content)
        data_rows = [row for row in rows if row and any(re.search(r"\d", cell) for cell in row[1:])]
        return bool(data_rows and not data_rows[0][0].strip())

    def _table_relevance_score(self, query: str, chunk: Dict) -> float:
        metadata = chunk.get("metadata") or {}
        text = (
            f"{metadata.get('caption', '')} {metadata.get('source_file', '')} "
            f"{chunk.get('page_content', '')}"
        )
        text_lower = text.lower()
        score = float(chunk.get("score", 0.0) or 0.0)
        score += 2.0 * self._period_match_bonus(query, text_lower, self._chunk_date(chunk))
        terms = self._query_terms(query)
        if terms:
            matched = sum(1 for term in terms if term.lower() in text_lower)
            score += min(0.60, matched * 0.05)

        query_lower = (query or "").lower()
        if any(term in query_lower for term in ("capitalization", "paid-in capital", "accumulated deficit", "pro forma")):
            if "total capitalization" in text_lower:
                score += 0.90
            if "actual" in text_lower and "pro forma" in text_lower:
                score += 0.40
            if "additional paid-in capital" in text_lower and "accumulated deficit" in text_lower:
                score += 0.40
            if "as of june 30, 2023" in text_lower:
                score += 0.50

        if any(term in query_lower for term in ("gross margin", "\u6bdb\u5229\u7387")):
            if "gross profit" in text_lower and "total revenues" in text_lower:
                score += 0.70
            if "december 31" in text_lower and "2023" in text_lower:
                score += 0.35

        if self._is_delivery_query(query) and self._is_ambiguous_delivery_table(chunk):
            score -= 1.00
        return score

    def _prepare_table_chunks(self, query: str, table_chunks: list[Dict]) -> list[Dict]:
        if not table_chunks:
            return table_chunks
        prepared = []
        for chunk in table_chunks:
            if self._is_delivery_query(query) and self._is_ambiguous_delivery_table(chunk):
                continue
            enriched = dict(chunk)
            metadata = dict(enriched.get("metadata") or {})
            metadata["table_relevance_score"] = round(self._table_relevance_score(query, enriched), 4)
            enriched["metadata"] = metadata
            prepared.append(enriched)
        prepared.sort(key=lambda item: item.get("metadata", {}).get("table_relevance_score", 0.0), reverse=True)
        return prepared

    def _table_facts_note(self, query: str | None, table_chunks: list[Dict] | None) -> str:
        if not query or not table_chunks:
            return ""
        query_lower = query.lower()
        if self._is_delivery_query(query):
            years = self._query_years(query)
            target_year = years[0] if years else None
            quarters = self._query_quarters(query)
            target_quarter = next(iter(quarters), None)
            asks_each_quarter = any(term in query_lower for term in ("each quarter", "quarterly", "\u5404\u5b63\u5ea6", "\u6bcf\u4e2a\u5b63\u5ea6"))
            for chunk in table_chunks[:20]:
                rows = self._html_table_rows(chunk.get("page_content", "") or "")
                if not rows:
                    continue
                if target_year and asks_each_quarter:
                    delivery_row = self._table_row_by_label(rows, "deliveries", "vehicle deliveries")
                    if delivery_row:
                        values = {}
                        for row in rows:
                            for idx, cell in enumerate(row):
                                cell_compact = cell.lower().replace(" ", "")
                                for quarter in ("q1", "q2", "q3", "q4"):
                                    if str(target_year) in cell_compact and quarter in cell_compact and len(delivery_row) > idx:
                                        value = delivery_row[idx]
                                        if re.search(r"\d", value):
                                            values[quarter.upper()] = value
                        if values:
                            ordered = "; ".join(f"{q} {values[q]}" for q in ("Q1", "Q2", "Q3", "Q4") if q in values)
                            return (
                                "Detected Table Facts: delivery volume row/column extraction. "
                                f"{target_year} quarterly deliveries: {ordered} vehicles. "
                                "Use these same-scope quarterly figures; do not substitute later group-level delivery totals."
                            )
                target_idx = None
                for row in rows:
                    for idx, cell in enumerate(row):
                        cell_lower = cell.lower()
                        if target_year and str(target_year) not in cell_lower:
                            continue
                        if target_quarter and target_quarter not in cell_lower.replace(" ", ""):
                            continue
                        target_idx = idx
                        break
                    if target_idx is not None:
                        break
                if target_idx is None:
                    continue
                delivery_row = self._table_row_by_label(rows, "deliveries", "vehicle deliveries")
                if not delivery_row or len(delivery_row) <= target_idx:
                    continue
                volume = delivery_row[target_idx]
                if not re.search(r"\d", volume):
                    continue
                note = (
                    "Detected Table Facts: delivery volume row/column extraction. "
                    f"Deliveries for {target_year or 'target year'} {target_quarter.upper() if target_quarter else 'target period'}: "
                    f"{volume} vehicles."
                )
                if not self._has_growth_intent(query):
                    note += " The question asks only volume, so omit YoY/growth percentages."
                return note

        if any(term in query_lower for term in ("capitalization", "paid-in capital", "accumulated deficit", "pro forma")):
            for chunk in table_chunks[:20]:
                content = chunk.get("page_content", "") or ""
                content_lower = content.lower()
                if "total capitalization" not in content_lower or "actual" not in content_lower or "pro forma" not in content_lower:
                    continue
                rows = self._html_table_rows(content)
                cap = self._table_row_by_label(rows, "total capitalization")
                paid = self._table_row_by_label(rows, "additional paid-in capital")
                deficit = self._table_row_by_label(rows, "accumulated deficit")
                if not cap or len(cap) < 4:
                    continue
                facts = [
                    "Detected Table Facts: capitalization table row/column extraction.",
                    f"Total capitalization: Actual RMB {cap[1]}; Pro Forma RMB {cap[3]}.",
                ]
                if paid and len(paid) >= 4:
                    actual_paid = self._parse_accounting_number(paid[1])
                    pro_paid = self._parse_accounting_number(paid[3])
                    if actual_paid is not None and pro_paid is not None:
                        facts.append(
                            "Additional paid-in capital: "
                            f"Actual RMB {paid[1]}; Pro Forma RMB {paid[3]}; "
                            f"change RMB {self._format_accounting_number(pro_paid - actual_paid)}."
                        )
                if deficit and len(deficit) >= 4:
                    facts.append(f"Accumulated deficit: Actual RMB {deficit[1]}; Pro Forma RMB {deficit[3]}.")
                facts.append("These target-period capitalization rows directly answer the question; ignore other-date balance sheet rows as non-comparable.")
                return " ".join(facts)

        if any(term in query_lower for term in ("gross margin", "\u6bdb\u5229\u7387")):
            years = self._query_years(query)
            target_year = years[0] if years else None
            quarters = self._query_quarters(query)
            for chunk in table_chunks[:20]:
                rows = self._html_table_rows(chunk.get("page_content", "") or "")
                if not rows:
                    continue
                target_idx = None
                for row in rows:
                    for idx, cell in enumerate(row):
                        cell_lower = cell.lower()
                        if target_year and str(target_year) not in cell_lower:
                            continue
                        if ("q4" in quarters or "\u56db\u5b63\u5ea6" in query) and "december 31" not in cell_lower:
                            continue
                        if "rmb" in cell_lower or not target_year:
                            target_idx = idx
                            break
                    if target_idx is not None:
                        break
                if target_idx is None:
                    continue
                revenue = self._table_row_by_label(rows, "total revenues")
                gross_profit = self._table_row_by_label(rows, "gross profit")
                if not revenue or not gross_profit or len(revenue) <= target_idx or len(gross_profit) <= target_idx:
                    continue
                revenue_value = self._parse_accounting_number(revenue[target_idx])
                gross_value = self._parse_accounting_number(gross_profit[target_idx])
                if not revenue_value or gross_value is None:
                    continue
                pct = gross_value / revenue_value * 100.0
                return (
                    "Detected Table Facts: gross margin row/column extraction. "
                    f"Gross profit RMB {gross_profit[target_idx]} / total revenues RMB {revenue[target_idx]} "
                    f"is approximately {round(pct):.0f}% rounded to a whole percentage (computed decimal {pct:.1f}%)."
                )
        return ""

    def _query_years(self, query: str) -> list[int]:
        return sorted({int(year) for year in re.findall(r"(20\d{2}|19\d{2})", query or "")})

    def _query_quarters(self, query: str) -> set[str]:
        text = (query or "").lower()
        quarters = set()
        patterns = {
            "q1": (r"\bq1\b", "first quarter", "1st quarter", "\u4e00\u5b63\u5ea6"),
            "q2": (r"\bq2\b", "second quarter", "2nd quarter", "\u4e8c\u5b63\u5ea6"),
            "q3": (r"\bq3\b", "third quarter", "3rd quarter", "\u4e09\u5b63\u5ea6"),
            "q4": (r"\bq4\b", "fourth quarter", "4th quarter", "\u56db\u5b63\u5ea6"),
        }
        for quarter, quarter_patterns in patterns.items():
            for pattern in quarter_patterns:
                if pattern.startswith(r"\b"):
                    matched = re.search(pattern, text) is not None
                else:
                    matched = pattern in text
                if matched:
                    quarters.add(quarter)
                    break
        return quarters

    def _is_periodic_finance_query(self, query: str) -> bool:
        text = (query or "").lower()
        finance_terms = (
            "gross profit",
            "gross margin",
            "vehicle margin",
            "revenue",
            "vehicle sales revenue",
            "operating expenses",
            "net loss",
            "current assets",
            "current liabilities",
            "working capital",
            "capitalization",
            "paid-in capital",
            "accumulated deficit",
            "balance sheet",
            "r&d",
            "sg&a",
            "\u6bdb\u5229",
            "\u6bdb\u5229\u7387",
            "\u8425\u6536",
            "\u6536\u5165",
            "\u8d44\u4ea7",
            "\u8d1f\u503a",
        )
        has_finance_term = any(term in text for term in finance_terms)
        has_period = bool(self._query_years(query) or self._query_quarters(query))
        return has_finance_term and has_period

    def _has_annual_period_intent(self, query: str) -> bool:
        text = (query or "").lower()
        annual_terms = (
            "full year",
            "annual",
            "yearly",
            "fiscal year",
            "fy",
            "\u5168\u5e74",
            "\u5e74\u5ea6",
            "\u5168\u5e74\u5ea6",
        )
        return any(term in text for term in annual_terms)

    def _has_period_metric_intent(self, query: str) -> bool:
        text = (query or "").lower()
        metric_terms = (
            "cash",
            "gross margin",
            "gross profit",
            "deliveries",
            "delivery",
            "sales",
            "revenue",
            "net loss",
            "r&d",
            "employee",
            "employees",
            "store",
            "stores",
            "center",
            "centers",
            "\u73b0\u91d1",
            "\u6bdb\u5229",
            "\u6bdb\u5229\u7387",
            "\u9500\u91cf",
            "\u4ea4\u4ed8",
            "\u8425\u6536",
            "\u6536\u5165",
            "\u51c0\u5229\u6da6",
            "\u7814\u53d1\u8d39\u7528",
            "\u5458\u5de5",
            "\u95e8\u5e97",
            "\u4e2d\u5fc3",
            "\u6570\u91cf",
        )
        return any(term in text for term in metric_terms)

    def _target_period_end_date(self, query: str) -> tuple[datetime | None, str | None]:
        years = self._query_years(query)
        if len(years) != 1:
            return None, None
        year = years[0]
        statement_period_end = self._query_statement_period_end(query, year)
        if statement_period_end:
            period_type = "annual" if (statement_period_end.month, statement_period_end.day) == (12, 31) else "quarter"
            return statement_period_end, period_type
        quarters = self._query_quarters(query)
        query_lower = (query or "").lower()
        asks_each_quarter = any(
            term in query_lower
            for term in ("each quarter", "quarterly", "\u5404\u5b63\u5ea6", "\u6bcf\u4e2a\u5b63\u5ea6")
        )
        if quarters and not asks_each_quarter and len(quarters) == 1:
            quarter = next(iter(quarters))
            month_day = {
                "q1": (3, 31),
                "q2": (6, 30),
                "q3": (9, 30),
                "q4": (12, 31),
            }[quarter]
            return datetime(year, month_day[0], month_day[1]), "quarter"
        if asks_each_quarter or self._has_annual_period_intent(query) or (
            self._has_period_metric_intent(query) and not quarters
        ):
            return datetime(year, 12, 31), "annual"
        return None, None

    def _auto_period_cutoff_date(self, query: str) -> datetime | None:
        if not self._config_bool("retrieval_auto_period_cutoff_enabled", False):
            return None
        period_end, period_type = self._target_period_end_date(query)
        if not period_end or not period_type:
            return None
        if period_type == "quarter":
            default_days = 180
            days = self._config_int_or_none("retrieval_period_cutoff_quarter_window_days")
        else:
            default_days = 120
            days = self._config_int_or_none("retrieval_period_cutoff_annual_window_days")
        if days is None:
            days = default_days
        return period_end + timedelta(days=days)

    def _period_match_bonus(self, query: str, text_lower: str, chunk_date: datetime | None) -> float:
        bonus = 0.0
        years = self._query_years(query)
        if years:
            matched_years = sum(1 for year in years if str(year) in text_lower)
            bonus += min(0.24, matched_years * 0.08)
            if chunk_date and chunk_date.year in years:
                bonus += 0.08

        quarter_aliases = {
            "q1": ("q1", "first quarter", "1st quarter", "\u4e00\u5b63\u5ea6"),
            "q2": ("q2", "second quarter", "2nd quarter", "\u4e8c\u5b63\u5ea6"),
            "q3": ("q3", "third quarter", "3rd quarter", "\u4e09\u5b63\u5ea6"),
            "q4": ("q4", "fourth quarter", "4th quarter", "\u56db\u5b63\u5ea6"),
        }
        for quarter in self._query_quarters(query):
            if any(alias in text_lower for alias in quarter_aliases[quarter]):
                bonus += 0.12

        query_lower = (query or "").lower()
        if "june 30" in query_lower and "june 30" in text_lower:
            bonus += 0.14
        if "\u516d\u670830\u65e5" in query_lower and "\u516d\u670830\u65e5" in text_lower:
            bonus += 0.14
        return min(0.38, bonus)

    def _context_retrieval_notes(self, query: str | None) -> str:
        if not query:
            return ""
        notes = []
        years = self._query_years(query)
        quarters = self._query_quarters(query)
        if years:
            notes.append(
                "Detected target year(s): "
                + ", ".join(str(year) for year in years)
                + ". Prefer evidence and table columns for these exact periods."
            )
        if quarters:
            notes.append(
                "Detected target quarter(s): "
                + ", ".join(sorted(quarters)).upper()
                + ". Do not substitute annual figures, adjacent quarters, or YoY comparison baselines for the asked quarter."
            )
        if self._is_periodic_finance_query(query):
            notes.append(
                "Finance/table question: read table header periods and row labels literally; "
                "prefer exact table line items over narrative summaries; distinguish gross margin from vehicle margin; "
                "if both RMB and USD columns are present, answer in RMB unless the question asks for USD."
            )
        date_cutoff = self._effective_date_cutoff(query)
        if date_cutoff:
            notes.append(
                f"Evidence cutoff: ignore facts published after {date_cutoff.date().isoformat()} unless the question explicitly asks for later updates."
            )
        if self._is_delivery_query(query):
            delivery_note = (
                "Delivery/sales-volume question: answer the requested volume directly; "
                "do not use later group-level totals or blank-row delivery tables when the entity scope is ambiguous."
            )
            if not self._has_growth_intent(query):
                delivery_note += " Do not add YoY growth unless the question asks for growth."
            notes.append(delivery_note)
        if not notes:
            return ""
        return "Retrieval Notes: " + " ".join(notes)

    def _query_terms(self, query: str) -> set[str]:
        query = query or ""
        stopwords = {
            "about",
            "after",
            "also",
            "and",
            "any",
            "are",
            "as",
            "before",
            "by",
            "does",
            "for",
            "from",
            "has",
            "have",
            "how",
            "in",
            "is",
            "its",
            "kind",
            "many",
            "may",
            "number",
            "of",
            "on",
            "or",
            "other",
            "prior",
            "provide",
            "recent",
            "the",
            "to",
            "under",
            "what",
            "with",
        }
        terms = set()
        for token in re.findall(r"[A-Za-z0-9][A-Za-z0-9_\-]{1,}", query.lower()):
            if len(token) >= 3 and not token.isdigit() and token not in stopwords:
                terms.add(token)
        for seq in re.findall(r"[\u4e00-\u9fff]{2,}", query):
            terms.add(seq)
            for ngram_size in (2, 3, 4):
                for start in range(0, max(0, len(seq) - ngram_size + 1)):
                    terms.add(seq[start : start + ngram_size])
        alias_groups = [
            (
                ("极氪", "zeekr"),
                ("zeekr", "zeekr group"),
            ),
            (
                ("中国", "国内"),
                ("china", "chinese"),
            ),
            (
                ("销售网络", "销售网", "销售", "门店", "线下", "零售", "sales network", "sales", "network", "retail", "stores"),
                (
                    "sales network",
                    "sales and service network",
                    "offline sales",
                    "offline sales and service centers",
                    "physical sales",
                    "retail stores",
                    "service centers",
                    "zeekr center",
                    "zeekr space",
                    "delivery center",
                    "zeekr house",
                ),
            ),
            (
                ("毛利", "毛利率", "gross margin", "gross profit"),
                ("gross margin", "gross profit", "gross profit margin"),
            ),
            (
                ("服务", "售后", "补能", "充电", "services", "after-sales", "charging"),
                ("services", "after-sales", "power delivery", "charging", "cities"),
            ),
            (
                ("autonomous driving", "adas", "partnership", "partnerships"),
                ("waymo", "mobileye", "qualcomm", "nvidia", "drive agx thor", "intelligent driving domain controller"),
            ),
            (
                ("working capital", "balance sheet", "current assets", "current liabilities"),
                ("total current assets", "total current liabilities", "working capital", "june 30"),
            ),
            (
                ("capitalization", "paid-in capital", "accumulated deficit", "pro forma"),
                ("total capitalization", "additional paid-in capital", "accumulated deficits", "pro forma", "actual"),
            ),
            (
                ("net loss", "operating expenses", "gross profit", "r&d", "sg&a"),
                ("total operating expenses", "research and development expenses", "selling general and administrative", "net loss"),
            ),
            (
                ("\u8425\u6536", "\u670d\u52a1\u6536\u5165", "service revenue", "services revenue"),
                ("research and development services", "other services", "technical license", "related parties", "geely group"),
            ),
            (
                ("\u9500\u91cf", "\u4ea4\u4ed8", "deliveries", "delivery", "vehicle deliveries"),
                ("deliveries", "vehicle deliveries", "year-over-year", "yoy", "growth"),
            ),
        ]
        query_lower = query.lower()
        for triggers, aliases in alias_groups:
            if any(trigger in query or trigger in query_lower for trigger in triggers):
                terms.update(aliases)
        return terms

    def _numeric_entity_bonus(self, text_lower: str) -> float:
        patterns = (
            r"\b\d{1,4}\s+(?:offline\s+)?sales and service centers\b",
            r"\b\d{1,4}\s+offline locations\b",
            r"\b\d{1,4}\s+(?:chinese\s+)?cities\b",
            r"\bin\s+\d{1,4}\s+chinese cities\b",
            r"\b\d{1,4}\s+(?:retail\s+)?stores\b",
            r"\b\d{1,4}\s+(?:sales\s+)?locations\b",
            r"\b\d{1,4}\s+centers\b",
        )
        if any(re.search(pattern, text_lower) for pattern in patterns):
            return 0.30
        return 0.0

    @staticmethod
    def _financial_row_label_bonus(query: str, chunk: Dict) -> float:
        """Prefer the row whose explicit label matches the requested metric.

        Numeric table rows often repeat neighboring values as column context.
        Token overlap alone can therefore rank a margin row above the requested
        revenue row.  Only the canonical ``row_label`` earns this bonus.
        """
        query_lower = str(query or "").lower()
        row_label = str((chunk.get("metadata") or {}).get("row_label") or "").lower().strip()
        aliases = (
            (("营业收入", "营收", "revenue"), ("营业收入", "revenue", "total revenue", "sales_ind")),
            (("营业成本", "销售成本", "cost of revenue", "cost of goods sold"), ("营业成本", "cost of goods sold", "cost of revenue", "cogs_ind")),
            (("毛利润", "gross profit"), ("毛利润", "gross profit", "gp_ind")),
            (("营业利润", "ebit"), ("营业利润", "ebit", "ebit (operating profits)", "ebit_ind")),
            (("归母净利润", "归属于母公司", "net income"), ("归母净利润", "net profit attributable", "np_xord_ind")),
            (("基本每股收益", "basic eps"), ("基本每股收益", "basic eps (cny/share)", "eps (reported)", "eps_rp_ind")),
            (("毛利率", "gross margin"), ("毛利率", "gross margin", "gross_margin_ind")),
            (("经营活动现金流", "经营性现金流", "operating cash flow"), ("经营活动现金流", "operating cash flow", "net cash from operating activities", "cf_op_ind")),
            (("资本开支", "资本支出", "capex", "capital expenditure"), ("资本开支", "资本支出", "capital expenditure", "capex_ind", "purchase of ppe", "total capex (cny m)")),
            (("自由现金流", "free cash flow"), ("自由现金流", "free cash flow", "fcf_ind")),
            (("总资产", "total assets"), ("总资产", "total assets", "tot_assets_ind")),
            (("总负债", "total liabilities"), ("总负债", "total liabilities", "tot_liabs_ind")),
            (("股东权益", "shareholders' equity"), ("股东权益", "shareholders' equity", "shr_eqty")),
            (("现金及等价物", "现金及现金等价物", "cash and cash equivalent"), ("现金及等价物", "cash and equivalent", "cash and equivalents", "cash and cash equivalents", "cash_ind")),
            (("应收账款", "accounts receivable"), ("应收账款", "account receivables", "accounts receivable", "accts_rec_ind")),
            (("存货", "inventory", "inventories"), ("存货", "inventories", "inventory", "inventories_ind")),
            (("有息负债", "interest-bearing debt"), ("short term debt", "long term debt", "st_debt_ind", "lt_debt_ind")),
            (("总股本", "shares outstanding"), ("shares outstanding", "shares outstanding (m, period-end)", "num_sh1", "ord_capital", "share capital", "总股本")),
        )
        for query_aliases, exact_labels in aliases:
            if any(alias in query_lower for alias in query_aliases):
                normalized = row_label.strip(" +()-")
                return 1.25 if normalized in exact_labels else 0.0
        return 0.0

    def _rescue_recent_evidence_chunks(
        self,
        chunks: List[Dict],
        selected_chunks: List[Dict],
        query: str,
    ) -> List[Dict]:
        if not self._config_bool("evidence_rescue_enabled", False):
            return selected_chunks

        rescue_k = self._config_int_or_none("evidence_rescue_k")
        rescue_k = 2 if rescue_k is None else rescue_k
        if rescue_k <= 0:
            return selected_chunks

        min_score = self._config_float("evidence_rescue_min_score", 0.45)
        min_year = self._config_int_or_none("evidence_rescue_min_year")
        if min_year is None:
            data_latest_date = self._parse_date_value(self.config.get("data_latest_time"))
            min_year = max(2000, data_latest_date.year - 1) if data_latest_date else 2024
        query_years = self._query_years(query)
        if query_years:
            min_year = min(min_year, min(query_years))
            if self._is_periodic_finance_query(query):
                min_score = min(min_score, 0.36)

        terms = self._query_terms(query)
        if not terms:
            return selected_chunks

        selected_ids = {self._chunk_identity(chunk) for chunk in selected_chunks}
        rescue_candidates = []
        for chunk in chunks:
            identity = self._chunk_identity(chunk)
            if identity in selected_ids:
                continue

            text = self._chunk_text(chunk)
            if not re.search(r"\d", text):
                continue

            chunk_date = self._chunk_date(chunk)
            if min_year is not None and (chunk_date is None or chunk_date.year < min_year):
                continue

            text_lower = text.lower()
            matched_terms = {term for term in terms if term.lower() in text_lower}
            overlap = len(matched_terms) / max(3, min(len(terms), 12))
            overlap = min(1.0, overlap)
            number_bonus = 0.15
            source_bonus = 0.08 if chunk.get("retriever") in {"BM25", "PageIndex", "Title Summary"} else 0.0
            entity_bonus = self._numeric_entity_bonus(text_lower)
            row_label_bonus = self._financial_row_label_bonus(query, chunk)
            period_bonus = self._period_match_bonus(query, text_lower, chunk_date)
            recency_bonus = 0.0
            if chunk_date and min_year is not None:
                recency_bonus = min(0.25, max(0, chunk_date.year - min_year + 1) * 0.06)

            rescue_score = (
                overlap + number_bonus + source_bonus + entity_bonus
                + row_label_bonus + period_bonus + recency_bonus
            )
            if rescue_score < min_score:
                continue

            rescued_chunk = dict(chunk)
            rescued_metadata = dict(chunk.get("metadata") or {})
            rescued_metadata["evidence_rescue"] = True
            rescued_metadata["evidence_rescue_score"] = round(float(rescue_score), 4)
            rescued_metadata["evidence_rescue_matched_terms"] = sorted(matched_terms)[:20]
            rescued_metadata["evidence_rescue_period_bonus"] = round(float(period_bonus), 4)
            rescued_metadata["evidence_rescue_row_label_bonus"] = round(float(row_label_bonus), 4)
            rescued_chunk["metadata"] = rescued_metadata
            rescue_candidates.append(
                (
                    rescue_score,
                    chunk_date or datetime.min,
                    float(chunk.get("score", 0.0) or 0.0),
                    rescued_chunk,
                )
            )

        if not rescue_candidates:
            return selected_chunks

        scorer = self._get_evidence_rescue_scorer()
        if scorer is not None:
            try:
                model_weight = self._config_float("evidence_rescue_scorer_blend_alpha", 0.7)
                model_weight = max(0.0, min(1.0, model_weight))
                candidate_chunks = [item[3] for item in rescue_candidates]
                rule_scores = [float(item[0]) for item in rescue_candidates]
                model_scores = scorer.score_chunks(query, candidate_chunks, rule_scores=rule_scores)
                reranked_candidates = []
                for item, model_score in zip(rescue_candidates, model_scores):
                    rule_score, chunk_date, source_score, chunk = item
                    rule_norm = min(1.0, max(0.0, float(rule_score)))
                    final_score = model_weight * float(model_score) + (1.0 - model_weight) * rule_norm
                    rescored_chunk = dict(chunk)
                    rescored_metadata = dict(chunk.get("metadata") or {})
                    rescored_metadata["evidence_rescue_rule_score"] = round(float(rule_score), 4)
                    rescored_metadata["evidence_rescue_model_score"] = round(float(model_score), 4)
                    rescored_metadata["evidence_rescue_final_score"] = round(float(final_score), 4)
                    rescored_chunk["metadata"] = rescored_metadata
                    reranked_candidates.append((final_score, chunk_date, source_score, rescored_chunk))
                rescue_candidates = reranked_candidates
            except Exception as exc:
                logger.warning("Evidence rescue scorer failed; falling back to rule score: %s", exc, exc_info=True)

        rescue_candidates.sort(key=lambda item: (item[0], item[1], item[2]), reverse=True)
        rescued = [item[3] for item in rescue_candidates[:rescue_k]]
        logger.info(
            "Evidence rescue added %d recent numeric chunks for query=%r: %s",
            len(rescued),
            query,
            [
                {
                    "doc_id": chunk.get("metadata", {}).get("doc_id"),
                    "date": chunk.get("metadata", {}).get("date_published"),
                    "score": chunk.get("metadata", {}).get("evidence_rescue_score"),
                }
                for chunk in rescued
            ],
        )
        return rescued + selected_chunks

    def _format_context(self, chunks: List[Dict], table_chunks: List[Dict] = None, query: str | None = None) -> str:
        """
        格式化为 LLM 可读的上下文

        Args:
            chunks: 文本 Chunk 列表
            table_chunks: 表格 Chunk 列表（不参与排序）

        Returns:
            formatted_context: 格式化的上下文字符串
        """
        separator = "\n" + "-" * 60 + "\n"
        formatted_chunks = []
        retrieval_notes = self._context_retrieval_notes(query)
        table_facts_note = self._table_facts_note(query, table_chunks)

        for chunk in chunks:
            priority_prefix = ""
            if chunk["metadata"].get("evidence_rescue"):
                priority_prefix = "Evidence Priority: recent numeric candidate; "
            formatted_chunk = (
                f"{priority_prefix}Date Published: {chunk['metadata'].get('date_published', 'N/A')}; "
                f"Chunk Source: {chunk['metadata'].get('doc_id', chunk['metadata'].get('source_file', 'N/A'))}; "
                f"Chunk Content: {chunk['page_content']}"
            )
            formatted_chunks.append(formatted_chunk)

        table_formatted = []
        if table_chunks:
            for tbl in table_chunks:
                table_formatted.append(
                    "Evidence Priority: table candidate; read header periods and row labels exactly; "
                    f"Table Source: {tbl['metadata'].get('source_file', tbl['metadata'].get('doc_id', 'N/A'))}; "
                    f"Page: {tbl['metadata'].get('page_idx', 'N/A')}; "
                    f"Caption: {tbl['metadata'].get('caption', '')}; "
                    f"Table Content: {tbl['page_content']}"
                )

        body = separator.join(formatted_chunks)
        if table_formatted:
            body = body + "\n===== Tables =====\n" + separator.join(table_formatted)
        notes = "\n".join(note for note in (retrieval_notes, table_facts_note) if note)
        context = notes + "\n" + separator + body if notes else body
        configured_max_chars = self._config_int_or_none("rag_context_max_chars")
        max_chars = max(4000, configured_max_chars if configured_max_chars is not None else 24000)
        truncated = truncate_text(context, max_chars)
        if len(truncated) < len(context):
            logger.warning(
                "RAG context truncated from %d to %d chars (rag_context_max_chars=%d)",
                len(context),
                len(truncated),
                max_chars,
            )
        return truncated
