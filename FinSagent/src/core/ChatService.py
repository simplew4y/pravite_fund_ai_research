"""
ChatService - 对话服务

职责:
- 多会话管理
- 会话超时清理
- 共享资源管理 (RAG, Reranker)
- 对外接口: generate_response_async()
"""

import asyncio
import logging
import threading
from datetime import datetime, timedelta
from pathlib import Path
from typing import Dict, Tuple, List, AsyncGenerator, Any, Optional

from FlagEmbedding import FlagLLMReranker

from core.RAG import RAG
from core.RAGManager import RAGManager
from core.SessionManager import SessionManager
from core.AgenticRAG import build_agentic_rag_workflow, extract_retrieved_chunks
from core.findebate_helper import run_findebate_baseline
from core.moa_helper import run_moa_baseline
from agents.general.workflow import build_general_subgraph
from agentic_search_loop import (
    AgenticSearchConfig,
    AgenticSearchLoop,
    CorpusStore,
    SearchEvent,
    SessionManagerChatClient,
)
from utils.vllm_reranker import VLLMReranker
from utils.session_history_store import session_history_store_from_config

logger = logging.getLogger(__name__)


class _DraftHolder:
    """Async bridge: Phase 1 sets the draft, Phase 2's synthesis_node awaits it.

    Includes a timeout to guarantee Phase 2 never hangs if Phase 1 crashes.
    """

    DEFAULT_TIMEOUT = 120  # seconds

    def __init__(self, timeout: float = DEFAULT_TIMEOUT):
        self._event = asyncio.Event()
        self._draft = ""
        self._error: str | None = None
        self._timeout = timeout

    def set_draft(self, draft: str):
        self._draft = draft
        self._event.set()

    def set_error(self, error: str):
        """Mark Phase 1 as failed; unblocks get_draft() so Phase 2 continues."""
        self._error = error
        self._draft = ""
        self._event.set()

    async def get_draft(self) -> str:
        """Wait for Phase 1 draft with timeout. Returns '' on timeout or error."""
        try:
            await asyncio.wait_for(self._event.wait(), timeout=self._timeout)
        except asyncio.TimeoutError:
            logger.warning(f"_DraftHolder timed out after {self._timeout}s; Phase 2 proceeds without preliminary draft")
            return ""
        if self._error:
            logger.warning(f"_DraftHolder received Phase 1 error: {self._error}; proceeding without draft")
            return ""
        return self._draft


class ChatService:
    """对话服务,负责会话管理和资源管理"""

    def __init__(self, config, rag_manager: RAGManager, rerank_topk: int, session_timeout: int = 1800):
        """
        初始化 ChatService

        Args:
            config: 配置字典
            rag_manager: RAGManager 实例
            rerank_topk: Rerank 返回的 top-k chunks
            session_timeout: 会话超时时间(秒)
        """
        self.config = config
        self.session_timeout = session_timeout
        self.sessions_lock = threading.Lock()

        # 会话管理
        self.sessions: Dict[str, Dict] = {}  # session_id -> {"manager": SessionManager, "timestamp": datetime}

        # 初始化共享资源
        logger.info("Initializing shared resources...")

        # Reranker
        reranker_backend = str(config.get("reranker_backend", "flagembedding")).lower()
        if reranker_backend == "vllm":
            reranker = VLLMReranker(
                endpoint_url=config.get("reranker_vllm_url", "http://127.0.0.1:5432/rerank"),
                model_name=config.get('rerank_model'),
                timeout_seconds=float(config.get("reranker_timeout_seconds", 60)),
                api_key=config.get("reranker_vllm_api_key"),
                max_retries=int(config.get("reranker_vllm_max_retries", 2)),
                retry_backoff_seconds=float(config.get("reranker_vllm_retry_backoff_seconds", 0.5)),
                score_transform=config.get("reranker_vllm_score_transform", "logit"),
            )
        else:
            reranker = FlagLLMReranker(
                config.get('rerank_model'),
                devices='cuda',
                use_fp16=True
            )
        reranker_lock = None if reranker_backend == "vllm" else threading.Lock()

        # RAG 组件
        self.rag = RAG(
            rag_manager,
            reranker,
            reranker_lock,
            rerank_topk,
            gt_path=config.get("gt_path"),
            collection_name=config.get("collection_name"),
            use_chunk_risk_calibration=config.get("use_chunk_risk_calibration", False),
            chunk_risk_model_path=config.get("chunk_risk_model_path"),
            chunk_risk_penalty_mode=config.get("chunk_risk_penalty_mode", "percentile_rank"),
            chunk_risk_lambda=config.get("chunk_risk_lambda"),
        )

        # Workflow (单例,所有 session 共享)
        self.workflow = build_agentic_rag_workflow()
        self.general_graph = build_general_subgraph()

        self.session_history_store = session_history_store_from_config(config)
        self._agentic_search_corpus: Optional[CorpusStore] = None

        # Research Memory
        try:
            from core.ResearchMemory import ResearchMemory
            self.memory = ResearchMemory(
                base_dir=config.get("memory", {}).get("dir", ".memory")
            )
            # Wire embedding function
            try:
                if hasattr(self, 'rag') and self.rag and self.rag.rag_manager:
                    r = self.rag.rag_manager._retrievers[0]
                    self.memory.set_embedding_fn(r.embeddings.embed_query)
            except Exception:
                pass
            # Wire LLM for checkpoint
            try:
                llm_base = config.get("llm_base_url", "")
                llm_key = config.get("llm_api_key", "EMPTY")
                llm_model = config.get("llm_model_name", "")
                if llm_base and llm_model:
                    import openai
                    lc = openai.OpenAI(api_key=llm_key, base_url=llm_base)
                    def _llm_call(prompt, _lc=lc, _model=llm_model):
                        return _lc.chat.completions.create(
                            model=_model,
                            messages=[{"role": "user", "content": prompt}],
                            temperature=0, max_tokens=1024
                        ).choices[0].message.content
                    self.memory.set_llm_fn(_llm_call)
            except Exception:
                pass
            logger.info("ResearchMemory initialized")
        except Exception as e:
            self.memory = None
            logger.warning("ResearchMemory not available: %s", e)

        logger.info("ChatService initialized successfully")

    def get_or_create_session(self, session_id: str) -> SessionManager:
        """
        获取或创建 SessionManager

        Args:
            session_id: 会话 ID

        Returns:
            SessionManager 实例
        """
        with self.sessions_lock:
            if session_id not in self.sessions:
                session_manager = SessionManager(session_id, self.config)
                self._load_session_history(session_manager)
                self.sessions[session_id] = {
                    'manager': session_manager,
                    'timestamp': datetime.now()
                }
                logger.info(f"Created new session: {session_id}")
            else:
                # 更新时间戳
                self.sessions[session_id]['timestamp'] = datetime.now()

        return self.sessions[session_id]['manager']

    def _load_session_history(self, session_manager: SessionManager) -> None:
        """从 SQLite 加载会话历史到 SessionManager 的 chat_history"""
        store = self.session_history_store
        if store is None:
            return
        try:
            messages = store.fetch_messages_if_active(session_manager.session_id)
            if messages is None:
                return
            for m in messages:
                if m.get("question"):
                    session_manager.add_to_chat_history("user", m["question"])
                if m.get("final_answer"):
                    session_manager.add_to_chat_history("assistant", m["final_answer"])
            logger.info(f"[Session {session_manager.session_id}] Loaded {len(messages)} history turns")
        except Exception as e:
            logger.warning(f"[Session {session_manager.session_id}] Failed to load history: {e}", exc_info=True)

    def cleanup_old_sessions(self):
        """清理过期会话"""
        current_time = datetime.now()
        timeout_delta = timedelta(seconds=self.session_timeout)

        with self.sessions_lock:
            expired = [
                sid for sid, data in self.sessions.items()
                if current_time - data['timestamp'] > timeout_delta
            ]

            for sid in expired:
                del self.sessions[sid]
                logger.info(f"Removed expired session {sid}")

    async def _summarize_and_update_title(
        self,
        session_id: str,
        question: str,
        final_answer: str,
    ) -> None:
        """用 LLM 总结 QA 生成标题，并更新 sessions 表。"""
        store = self.session_history_store
        if store is None:
            return
        try:
            messages = store.fetch_messages_if_active(session_id)
            if messages is not None and len(messages) > 1:
                logger.info(f"[Session {session_id}] Title already set, skipping update")
                return
            sm = self.get_or_create_session(session_id)
            response = await sm.async_llm.chat.completions.create(
                model=self.config.get("llm_model_name", "Qwen/Qwen2___5-72B-Instruct-AWQ"),
                messages=[
                    {
                        "role": "user",
                        "content": (
                            "请根据以下问答生成一个简洁的会话标题，不超过30字，"
                            "只输出标题，不要加引号或其他符号：\n"
                            f"问：{question}\n答：{final_answer[:500]}"
                        ),
                    }
                ],
                max_tokens=50,
                temperature=0.3,
            )
            title = (response.choices[0].message.content or "").strip()
            if title:
                # 强制不超过30字
                if len(title) > 30:
                    title = title[:29] + "…"
                await asyncio.to_thread(store.update_session_title, session_id, title)
                logger.info(f"[Session {session_id}] Title updated: {title}")
        except Exception as e:
            logger.warning(f"[Session {session_id}] Failed to summarize title: {e}", exc_info=True)

    async def _persist_session_history_turn(
        self,
        session_id: str,
        question: str,
        draft_answer: Optional[str],
        final_answer: str,
        activated_agents: Optional[List[str]],
        is_off_topic: bool,
    ) -> None:
        store = self.session_history_store
        if store is None:
            return
        if not (final_answer or "").strip():
            return
        await asyncio.to_thread(
            store.append_turn,
            session_id,
            question,
            draft_answer,
            final_answer,
            activated_agents or [],
            is_off_topic,
        )

    def _get_memory_context(self, question: str, session_id: str) -> str:
        if hasattr(self, 'memory') and self.memory:
            try:
                return self.memory.retrieve_for_prompt(question, session_id=session_id)
            except Exception:
                pass
        return ''

    def _build_agentic_initial_state(
        self,
        question: str,
        session_manager: SessionManager,
        draft_holder: _DraftHolder | None = None,
    ) -> Dict[str, Any]:
        state: Dict[str, Any] = {
            "original_query": question,
            "user_query_raw": question,
            "chat_history": session_manager.get_chat_history_copy(),
            "rag": self.rag,
            "session_manager": session_manager,
            "config": self.config,
            "debug_stop_after_retrieval": False,
            "final_answer": "",
            "is_complete": False,
            "missing_info": [],
            "iteration": 0,
            "max_iterations": 2,
            "selected_agents": [],
            "routing_reason": "",
            "pending_agents": [],
            "enable_query_decompose": bool(self.config.get("enable_ctx_decomp", False)),
            "agent_outputs": {},
            "merged_evidence": [],
            "merged_pre_rerank_candidates": [],
            "conflict_notes": [],
            "need_fact_confirmation": False,
            "off_topic": False,
            "preliminary_draft": "",
        }
        if draft_holder is not None:
            state["draft_holder"] = draft_holder
        return state

    def _agentic_search_config(self) -> Dict[str, Any]:
        value = self.config.get("agentic_search", {})
        return value if isinstance(value, dict) else {}

    def _project_root(self) -> Path:
        return Path(__file__).resolve().parents[2]

    def _agentic_search_roots(self) -> List[Path]:
        cfg = self._agentic_search_config()
        raw_roots = cfg.get("roots") or []
        if isinstance(raw_roots, (str, Path)):
            raw_roots = [raw_roots]
        roots = [Path(root).expanduser().resolve() for root in raw_roots if str(root).strip()]
        if roots:
            return roots

        persist = self.config.get("persist_directory")
        if persist:
            dataset_root = Path(str(persist)).expanduser().resolve().parent
            for name in ("0_raw_pdf", "1_processed_pdf", "3_base_final"):
                candidate = dataset_root / name
                if candidate.exists():
                    roots.append(candidate)
        return roots

    def _build_agentic_search_corpus(self) -> CorpusStore:
        if self._agentic_search_corpus is not None:
            return self._agentic_search_corpus

        roots = self._agentic_search_roots()
        if not roots:
            raise ValueError(
                "agentic_search roots are not configured and no corpus directories were inferred from persist_directory"
            )
        cache_dir = self._project_root() / ".agentic_search_cache" / "pdf_text"
        self._agentic_search_corpus = CorpusStore(roots=roots, cache_dir=cache_dir)
        logger.info(
            "Agentic Search corpus initialized: roots=%s cache_dir=%s",
            [str(root) for root in roots],
            cache_dir,
        )
        return self._agentic_search_corpus

    def _build_agentic_search_loop(self, session_manager: SessionManager) -> AgenticSearchLoop:
        search_config = AgenticSearchConfig.from_agentic_search_config(
            self._agentic_search_config(),
            model=str(self.config.get("llm_model_name") or session_manager.model_name),
            base_url=self.config.get("llm_base_url"),
            api_key=str(self.config.get("llm_api_key", "EMPTY")),
        )
        client = SessionManagerChatClient(session_manager, search_config)
        return AgenticSearchLoop(self._build_agentic_search_corpus(), search_config, client=client)

    def _map_agentic_search_event(self, event: SearchEvent) -> Optional[Dict[str, Any]]:
        data = event.data or {}
        turn = data.get("iteration")
        if event.event == "loop_start":
            return {
                "stage": "start",
                "roots": data.get("roots", []),
                "tool_names": data.get("tool_names", []),
            }
        if event.event == "iteration_start":
            return {
                "stage": "turn_start",
                "turn": turn,
                "finalization": bool(data.get("finalization", False)),
            }
        if event.event == "assistant_delta":
            return {
                "stage": "assistant_delta",
                "turn": turn,
                "content": data.get("content", ""),
                "finalization": bool(data.get("finalization", False)),
            }
        if event.event == "assistant_message":
            return {
                "stage": "assistant_message",
                "turn": turn,
                "content": data.get("content", ""),
                "finalization": bool(data.get("finalization", False)),
            }
        if event.event == "tool_call_delta":
            return {
                "stage": "tool_call_delta",
                "turn": turn,
                "tool_call_id": data.get("tool_call_id", ""),
                "index": data.get("index"),
                "name": data.get("name", ""),
                "argument_delta": data.get("argument_delta", ""),
                "arguments_so_far": data.get("arguments_so_far", ""),
                "finalization": bool(data.get("finalization", False)),
            }
        if event.event == "tool_call":
            return {
                "stage": "tool_call",
                "turn": turn,
                "tool_call_id": data.get("tool_call_id", ""),
                "name": data.get("name", ""),
                "arguments": data.get("arguments", {}),
                "note": data.get("note", ""),
                "streaming": bool(data.get("streaming", False)),
                "finalization": bool(data.get("finalization", False)),
            }
        if event.event == "tool_result":
            return {
                "stage": "tool_result",
                "turn": turn,
                "tool_call_id": data.get("tool_call_id", ""),
                "name": data.get("name", ""),
                "ok": bool(data.get("ok", False)),
                "content": data.get("content", ""),
                "error": data.get("error"),
                "result": data.get("data", {}),
                "streaming": bool(data.get("streaming", False)),
                "finalization": bool(data.get("finalization", False)),
            }
        if event.event == "finish_rejected":
            return {
                "stage": "finish_rejected",
                "turn": turn,
                "reason": data.get("reason", ""),
                "rejections": data.get("rejections", 0),
            }
        if event.event == "final":
            return {
                "stage": "final",
                "turn": turn,
                "answer": data.get("answer", ""),
                "evidence": data.get("evidence", []),
                "coverage": data.get("coverage", {}),
                "gaps": data.get("gaps", []),
                "confidence": data.get("confidence"),
                "reliability_notes": data.get("reliability_notes", []),
                "stopped_reason": data.get("stopped_reason"),
                "finalization": bool(data.get("finalization", False)),
            }
        if event.event == "error":
            return {
                "stage": "error",
                "turn": turn,
                "message": data.get("error") or data.get("message") or "",
                "type": data.get("type", "error"),
            }
        return None

    def _render_agentic_preliminary_packet(self, final_data: Dict[str, Any]) -> str:
        answer = str(final_data.get("answer", "") or "").strip()
        evidence = final_data.get("evidence", []) if isinstance(final_data.get("evidence", []), list) else []
        coverage = final_data.get("coverage", {}) if isinstance(final_data.get("coverage", {}), dict) else {}
        gaps = final_data.get("gaps", []) if isinstance(final_data.get("gaps", []), list) else []
        reliability_notes = (
            final_data.get("reliability_notes", [])
            if isinstance(final_data.get("reliability_notes", []), list)
            else []
        )
        confidence = str(final_data.get("confidence", "") or "").strip()

        lines: List[str] = ["Preview Answer:", answer or "(empty)", ""]
        lines.append("Direct Evidence:")
        if evidence:
            for item in evidence:
                if not isinstance(item, dict):
                    continue
                path = str(item.get("path", "") or "")
                location_parts = []
                if item.get("page") not in (None, ""):
                    location_parts.append(f"page {item.get('page')}")
                if item.get("line") not in (None, ""):
                    location_parts.append(f"line {item.get('line')}")
                location = f" ({', '.join(location_parts)})" if location_parts else ""
                quote = str(item.get("quote", "") or "").strip()
                why = str(item.get("why_relevant", "") or "").strip()
                lines.append(f"- {path}{location}: \"{quote}\"")
                if why:
                    lines.append(f"  Supports: {why}")
        else:
            lines.append("- None provided.")

        lines.extend(["", "Coverage:"])
        for key in ("searched_patterns", "inspected_sources", "relevant_uninspected_sources", "stopping_rationale"):
            value = coverage.get(key)
            if isinstance(value, list):
                rendered = ", ".join(str(item) for item in value) if value else "[]"
            elif value is None:
                rendered = ""
            else:
                rendered = str(value)
            lines.append(f"- {key}: {rendered}")

        lines.extend(["", "Gaps:"])
        if gaps:
            lines.extend(f"- {str(item)}" for item in gaps)
        else:
            lines.append("- None stated.")

        lines.extend(["", "Reliability Notes:"])
        if reliability_notes:
            lines.extend(f"- {str(item)}" for item in reliability_notes)
        else:
            lines.append("- None stated.")
        if confidence:
            lines.extend(["", f"Confidence: {confidence}"])
        return "\n".join(lines)

    def _simplify_agent_outputs(self, agent_outputs: Dict[str, Any]) -> List[Dict[str, Any]]:
        simplified: List[Dict[str, Any]] = []
        for agent_name, payload in agent_outputs.items():
            simplified.append(
                {
                    "agent": agent_name,
                    "sub_queries": payload.get("sub_queries", []),
                    "draft_answer": payload.get("draft_answer", ""),
                    "evidence_count": len(payload.get("evidence", [])),
                    "evidence": payload.get("evidence", []),
                    "tool_results": payload.get("tool_results", {}),
                }
            )
        return simplified

    def _build_stream_start_event(self, question: str, session_id: str, preview: bool = False) -> Dict[str, Any]:
        data = {
            "question": question,
            "session_id": session_id,
        }
        if preview:
            data["preview"] = True
        return {
            "event": "start",
            "data": data,
        }

    def _build_workflow_stream_event(
        self,
        node_name: str,
        node_output: Dict[str, Any],
        initial_state: Dict[str, Any],
    ) -> Dict[str, Any]:
        if node_name == "orchestrator":
            return {
                "event": "orchestrator",
                "data": {
                    "selected_agents": node_output.get("selected_agents", []),
                    "routing_reason": node_output.get("routing_reason", ""),
                    "rewritten_query": node_output.get("original_query", initial_state.get("original_query", "")),
                    "enable_query_decompose": node_output.get("enable_query_decompose", False),
                    "off_topic": node_output.get("off_topic", False),
                    "final_answer": node_output.get("final_answer", ""),
                },
            }
        if node_name == "agents_parallel":
            return {
                "event": "agents",
                "data": {
                    "agent_outputs": self._simplify_agent_outputs(node_output.get("agent_outputs", {})),
                },
            }
        if node_name == "synthesis":
            return {
                "event": "synthesis",
                "data": {
                    "final_answer": node_output.get("final_answer", ""),
                },
            }
        return {
            "event": node_name,
            "data": node_output,
        }

    def _build_complete_event(self, final_answer: str, session_id: str) -> Dict[str, Any]:
        return {
            "event": "complete",
            "data": {
                "final_answer": final_answer,
                "session_id": session_id,
            },
        }

    async def generate_response_async(
        self,
        question: str,
        session_id: str,
    ) -> Tuple[str, str, List[str], List[Dict]]:
        """
        统一的对外接口 (非流式)

        Args:
            question: 用户问题
            session_id: 会话 ID

        Returns:
            final_answer: 最终答案
            chat_history: 对话历史字符串
            activated_agents: 被激活的 agent 列表
            retrieved_chunks: 去重后的检索 chunk 列表
        """
        session_manager = self.get_or_create_session(session_id)
        self.cleanup_old_sessions()
        await asyncio.to_thread(session_manager.request_lock.acquire)

        logger.info(f"[Session {session_id}] Processing query: {question}")

        try:
            initial_state = self._build_agentic_initial_state(question, session_manager)

            # 执行 Workflow
            final_state = await self.workflow.ainvoke(initial_state)

            final_answer = final_state["final_answer"]
            activated_agents = final_state.get("selected_agents", [])
            retrieved_chunks = extract_retrieved_chunks(final_state)
            # 更新对话历史
            session_manager.add_exchange(question, final_answer)

            await self._persist_session_history_turn(
                session_id,
                question,
                None,
                final_answer,
                final_state.get("selected_agents") or [],
                bool(final_state.get("off_topic", False)),
            )
            # 等标题落库后再返回，避免前端立刻 GET /sessions 仍见「新对话」
            await self._summarize_and_update_title(session_id, question, final_answer)

            # 获取对话历史字符串
            chat_history = session_manager.get_chat_history_string()

            logger.info(f"[Session {session_id}] Response generated successfully")

            return final_answer, chat_history, activated_agents, retrieved_chunks

        except Exception as e:
            logger.error(f"[Session {session_id}] Error in generate_response_async: {str(e)}", exc_info=True)
            return "抱歉,处理您的问题时出现错误。", "", [], []
        finally:
            session_manager.request_lock.release()

    async def generate_response_with_preview(
        self,
        question: str,
        session_id: str,
    ) -> AsyncGenerator[Dict[str, Any], None]:
        """
        Two-phase concurrent response: general draft + full MAS run in parallel.

        Phase 1 (general agent) and Phase 2 (full MAS workflow) start simultaneously.
        A _DraftHolder bridges them: Phase 1 sets the draft once ready, and Phase 2's
        synthesis_node awaits it before generating the final answer.

        Yields:
            {"phase": "preliminary", "answer": str}   – quick draft (as soon as Phase 1 finishes)
            {"phase": "comprehensive", "answer": str, "selected_agents": list, "chat_history": str}
        """
        session_manager = self.get_or_create_session(session_id)
        self.cleanup_old_sessions()
        await asyncio.to_thread(session_manager.request_lock.acquire)
        logger.info(f"[Session {session_id}] Preview-mode (concurrent) query: {question}")

        draft_holder = _DraftHolder()
        event_queue: asyncio.Queue[Dict[str, Any]] = asyncio.Queue()
        phase2_off_topic = False
        phase1_task: asyncio.Task | None = None
        phase1_draft_box: Dict[str, str] = {"draft": ""}

        def _build_preview_draft_payload(progress_state: Dict[str, Any], stage: str, message: str = "") -> Dict[str, Any]:
            general_output = progress_state.get("agent_outputs", {}).get("general", {})
            sub_queries = general_output.get("sub_queries", progress_state.get("general_sub_queries", []))
            evidence = general_output.get("evidence", progress_state.get("general_evidence", []))
            draft_answer = general_output.get("draft_answer", progress_state.get("general_draft_answer", ""))
            tool_results = general_output.get("tool_results", {})
            return {
                "stage": stage,
                "message": message,
                "agent": "general",
                "sub_queries": sub_queries,
                "draft_answer": draft_answer,
                "evidence": evidence,
                "evidence_count": len(evidence),
                "tool_results": tool_results,
            }

        async def _emit(event: str, data: Dict[str, Any]):
            # When Phase 2 has already determined off-topic, suppress draft-side
            # preview events so non-finance queries return cleanly.
            if phase2_off_topic and event in {"preview_draft", "agentic_search", "preliminary"}:
                return
            await event_queue.put({"event": event, "data": data})

        try:
            async def _run_phase1() -> Dict[str, Any]:
                progress_state: Dict[str, Any] = {
                    "original_query": question,
                    "chat_history": session_manager.get_chat_history_copy(),
                    "session_manager": session_manager,
                    "rag": self.rag,
                    "run_id": "",
                    "log_dir": "",
                    "enable_query_decompose": bool(self.config.get("enable_ctx_decomp", False)),
                    "agent_outputs": {},
                }
                try:
                    await _emit(
                        "preview_draft",
                        _build_preview_draft_payload(progress_state, "start", "General agent 正在启动..."),
                    )
                    async for event in self.general_graph.astream(progress_state):
                        for node_name, node_output in event.items():
                            progress_state.update(node_output)
                            if node_name == "rewrite":
                                await _emit(
                                    "preview_draft",
                                    _build_preview_draft_payload(progress_state, "rewrite", "正在改写并拆解通用查询..."),
                                )
                            elif node_name == "retrieve":
                                await _emit(
                                    "preview_draft",
                                    _build_preview_draft_payload(progress_state, "retrieve", "正在检索 General 草稿证据..."),
                                )
                            elif node_name == "draft":
                                payload = _build_preview_draft_payload(progress_state, "draft", "正在生成快速草稿...")
                                if not draft_holder._event.is_set():
                                    draft_holder.set_draft(payload.get("draft_answer", ""))
                                await _emit("preview_draft", payload)
                            elif node_name == "finalize":
                                await _emit(
                                    "preview_draft",
                                    _build_preview_draft_payload(progress_state, "finalize", "General 草稿流程完成"),
                                )

                    payload = _build_preview_draft_payload(progress_state, "finalize", "General 草稿流程完成")
                    if not draft_holder._event.is_set():
                        draft_holder.set_draft(payload.get("draft_answer", ""))
                    phase1_draft_box["draft"] = payload.get("draft_answer", "") or ""
                    logger.info(
                        f"[Session {session_id}] Phase 1 done, draft_len={len(payload.get('draft_answer', ''))}"
                    )
                    await _emit(
                        "preliminary",
                        {
                            "answer": payload.get("draft_answer", ""),
                            "sub_queries": payload.get("sub_queries", []),
                            "evidence": payload.get("evidence", []),
                        },
                    )
                    return progress_state
                except asyncio.CancelledError:
                    logger.info(f"[Session {session_id}] Phase 1 cancelled (off-topic short-circuit)")
                    if not draft_holder._event.is_set():
                        draft_holder.set_error("cancelled_due_off_topic")
                    return progress_state
                except Exception as e:
                    logger.error(f"[Session {session_id}] Phase 1 failed: {e}", exc_info=True)
                    if not draft_holder._event.is_set():
                        draft_holder.set_error(str(e))
                    await _emit(
                        "preview_draft",
                        {
                            "stage": "error",
                            "message": str(e),
                            "agent": "general",
                            "sub_queries": progress_state.get("general_sub_queries", []),
                            "draft_answer": progress_state.get("general_draft_answer", ""),
                            "evidence": progress_state.get("general_evidence", []),
                            "evidence_count": len(progress_state.get("general_evidence", [])),
                        },
                    )
                    return progress_state

            async def _run_phase1_agentic() -> Dict[str, Any]:
                progress_state: Dict[str, Any] = {"original_query": question, "agent_outputs": {}}
                final_answer = ""
                final_data: Dict[str, Any] = {}
                final_evidence: List[Dict[str, Any]] = []
                try:
                    search_loop = self._build_agentic_search_loop(session_manager)
                    async for search_event in search_loop.astream_search(question):
                        mapped = self._map_agentic_search_event(search_event)
                        if mapped is not None:
                            await _emit("agentic_search", mapped)
                        if search_event.event == "final":
                            final_data = dict(search_event.data or {})
                            final_answer = str(search_event.data.get("answer", "") or "")
                            final_evidence = [
                                item for item in (search_event.data.get("evidence", []) or []) if isinstance(item, dict)
                            ]
                            progress_state["agentic_search_final"] = search_event.data
                        elif search_event.event == "error" and not draft_holder._event.is_set():
                            draft_holder.set_error(str(search_event.data.get("error", "") or "agentic_search_error"))

                    if not draft_holder._event.is_set():
                        draft_holder.set_draft(
                            self._render_agentic_preliminary_packet(final_data)
                            if final_data
                            else final_answer
                        )
                    phase1_draft_box["draft"] = final_answer
                    logger.info(f"[Session {session_id}] Agentic Search Phase 1 done, draft_len={len(final_answer)}")
                    await _emit(
                        "preliminary",
                        {
                            "answer": final_answer,
                            "sub_queries": [],
                            "evidence": final_evidence,
                            "coverage": final_data.get("coverage", {}) if final_data else {},
                            "gaps": final_data.get("gaps", []) if final_data else [],
                            "confidence": final_data.get("confidence") if final_data else None,
                            "reliability_notes": final_data.get("reliability_notes", []) if final_data else [],
                        },
                    )
                    return progress_state
                except asyncio.CancelledError:
                    logger.info(f"[Session {session_id}] Agentic Search Phase 1 cancelled")
                    if not draft_holder._event.is_set():
                        draft_holder.set_error("cancelled_due_off_topic")
                    return progress_state
                except Exception as e:
                    logger.error(f"[Session {session_id}] Agentic Search Phase 1 failed: {e}", exc_info=True)
                    if not draft_holder._event.is_set():
                        draft_holder.set_error(str(e))
                    await _emit("agentic_search", {"stage": "error", "message": str(e)})
                    return progress_state

            async def _run_phase2() -> Dict[str, Any]:
                nonlocal phase2_off_topic, phase1_task
                initial_state = self._build_agentic_initial_state(question, session_manager, draft_holder=draft_holder)

                # emit_cb bridges agents_parallel_node → event_queue so agent_completed
                # events are pushed immediately as each agent finishes, without re-implementing
                # the fan-out here.  synthesis_node awaits draft_holder internally.
                def emit_cb(ev_type: str, data: Dict[str, Any]) -> None:
                    if phase2_off_topic:
                        return
                    event_queue.put_nowait({"event": ev_type, "data": data})

                initial_state["emit_cb"] = emit_cb

                final_state: Dict[str, Any] = {}
                final_answer = ""
                selected_agents: List[str] = []

                try:
                    start_event = self._build_stream_start_event(question, session_id, preview=True)
                    await _emit(start_event["event"], start_event["data"])

                    async for chunk in self.workflow.astream(initial_state):
                        for node_name, node_output in chunk.items():
                            if node_name == "orchestrator":
                                off_topic = node_output.get("off_topic", False)
                                selected_agents = node_output.get("selected_agents", [])
                                await _emit("orchestrator", {
                                    "selected_agents": selected_agents,
                                    "routing_reason": node_output.get("routing_reason", ""),
                                    "rewritten_query": node_output.get("original_query", question),
                                    "off_topic": off_topic,
                                    "final_answer": node_output.get("final_answer", ""),
                                })
                                if off_topic:
                                    final_answer = node_output.get("final_answer", "")
                                    phase2_off_topic = True
                                    if phase1_task and not phase1_task.done():
                                        phase1_task.cancel()
                                    if not draft_holder._event.is_set():
                                        draft_holder.set_error("cancelled_due_off_topic")
                                    session_manager.add_exchange(question, final_answer)
                                    await self._persist_session_history_turn(
                                        session_id,
                                        question,
                                        None,
                                        final_answer,
                                        [],
                                        True,
                                    )
                                    await self._summarize_and_update_title(session_id, question, final_answer)
                                    await _emit("complete", {"final_answer": final_answer, "session_id": session_id})
                                    return final_state

                            elif node_name == "agents_parallel":
                                # agent_completed events already pushed via emit_cb inside the node
                                ev = self._build_workflow_stream_event(node_name, node_output, initial_state)
                                await _emit(ev["event"], ev["data"])

                            elif node_name == "synthesis":
                                final_answer = node_output.get("final_answer", "")
                                final_state.update(node_output)
                                ev = self._build_workflow_stream_event(node_name, node_output, initial_state)
                                await _emit(ev["event"], ev["data"])

                    final_state["selected_agents"] = selected_agents
                    final_state["final_answer"] = final_answer

                    if final_answer:
                        session_manager.add_exchange(question, final_answer)
                        d_pre = phase1_draft_box.get("draft", "").strip()
                        await self._persist_session_history_turn(
                            session_id,
                            question,
                            d_pre if d_pre else None,
                            final_answer,
                            selected_agents,
                            False,
                        )
                        await self._summarize_and_update_title(session_id, question, final_answer)
                    chat_history = session_manager.get_chat_history_string()

                    logger.info(f"[Session {session_id}] Phase 2 done")
                    await _emit("comprehensive", {
                        "answer": final_answer,
                        "selected_agents": selected_agents,
                        "chat_history": chat_history,
                    })
                    complete_event = self._build_complete_event(final_answer, session_id)
                    await _emit(complete_event["event"], complete_event["data"])
                    return final_state

                except Exception as e:
                    logger.error(f"[Session {session_id}] Phase 2 failed: {e}", exc_info=True)
                    await _emit("error", {"message": str(e)})
                    return final_state

            phase1_task = asyncio.create_task(_run_phase1_agentic())
            phase2_task = asyncio.create_task(_run_phase2())

            while True:
                if phase1_task.done() and phase2_task.done() and event_queue.empty():
                    break
                try:
                    item = await asyncio.wait_for(event_queue.get(), timeout=0.1)
                    yield item
                except asyncio.TimeoutError:
                    continue

            try:
                await phase1_task
            except asyncio.CancelledError:
                pass
            await phase2_task

        except Exception as e:
            logger.error(f"[Session {session_id}] Error in preview mode: {str(e)}", exc_info=True)
            if not draft_holder._event.is_set():
                draft_holder.set_error(str(e))
            yield {"event": "error", "data": {"message": "抱歉,处理您的问题时出现错误。"}}
        finally:
            session_manager.request_lock.release()

    async def generate_response_with_preview_debug(
        self,
        question: str,
        session_id: str,
    ) -> Dict[str, Any]:
        """
        Debug version of preview mode that returns a dict with all details.

        Runs both Phase 1 (general draft) and Phase 2 (full MAS) concurrently,
        then returns a single dict containing:
            - preliminary_draft: the quick draft from Phase 1
            - final_answer: the comprehensive answer from Phase 2
            - selected_agents: agents selected by orchestrator
            - agent_outputs: detailed outputs from all agents
            - retrieved_chunks: all retrieved chunks
            - chat_history: conversation history
            - timing info: preliminary_time, comprehensive_time

        Returns:
            Dict with all debug information
        """
        import time
        session_manager = self.get_or_create_session(session_id)
        self.cleanup_old_sessions()
        await asyncio.to_thread(session_manager.request_lock.acquire)
        logger.info(f"d[Session {session_id}] Preview-debug query: {question}")

        draft_holder = _DraftHolder()
        phase1_agent_outputs: List[Dict] = []  # shared slot for Phase 1 full outputs
        t0 = time.time()

        try:
            # ── Phase 1 coroutine: general agent only ──
            async def _run_phase1() -> str:
                try:
                    general_state = {
                        "original_query": question,
                        "chat_history": session_manager.get_chat_history_copy(),
                        "session_manager": session_manager,
                        "rag": self.rag,
                        "run_id": "",
                        "log_dir": "",
                        "enable_query_decompose": bool(self.config.get("enable_ctx_decomp", False)),
                        "agent_outputs": {},
                    }
                    result = await self.general_graph.ainvoke(general_state)
                    full_general_outputs = result.get("agent_outputs", {})
                    phase1_agent_outputs.append(full_general_outputs)
                    draft = full_general_outputs.get("general", {}).get("draft_answer", "")
                    draft_holder.set_draft(draft)
                    logger.info(f"[Session {session_id}] Phase 1 done, draft_len={len(draft)}")
                    return draft
                except Exception as e:
                    logger.error(f"[Session {session_id}] Phase 1 failed: {e}", exc_info=True)
                    draft_holder.set_error(str(e))
                    return ""

            # ── Phase 2 coroutine: full MAS workflow ──
            async def _run_phase2() -> Dict[str, Any]:
                initial_state = {
                    "original_query": question,
                    "chat_history": session_manager.get_chat_history_copy(),
                    "rag": self.rag,
                    "session_manager": session_manager,
                    "draft_holder": draft_holder,
                    "selected_agents": [],
                    "routing_reason": "",
                    "pending_agents": [],
                    "enable_query_decompose": bool(self.config.get("enable_ctx_decomp", False)),
                    "agent_outputs": {},
                    "merged_evidence": [],
                    "conflict_notes": [],
                    "missing_info": [],
                    "need_fact_confirmation": False,
                    "is_complete": False,
                    "preliminary_draft": "",
                    "final_answer": "",
                    "iteration": 0,
                    "max_iterations": 2,
                }
                return await self.workflow.ainvoke(initial_state)

            # Launch both concurrently
            phase1_task = asyncio.create_task(_run_phase1())
            phase2_task = asyncio.create_task(_run_phase2())

            # Wait for Phase 1 (preliminary draft)
            preliminary_draft = await phase1_task
            preliminary_time = time.time() - t0

            # Wait for Phase 2 (comprehensive answer)
            final_state = await phase2_task
            comprehensive_time = time.time() - t0

            final_answer = final_state["final_answer"]
            selected_agents = final_state.get("selected_agents", [])

            if phase1_agent_outputs:
                merged = {**phase1_agent_outputs[0], **final_state.get("agent_outputs", {})}
                final_state = {**final_state, "agent_outputs": merged}

            # Extract retrieved chunks
            retrieved_chunks = extract_retrieved_chunks(final_state)

            # Update chat history
            session_manager.add_exchange(question, final_answer)
            chat_history = session_manager.get_chat_history_string()

            logger.info(f"[Session {session_id}] Preview-debug done")

            return {
                "preliminary_draft": preliminary_draft,
                "final_answer": final_answer,
                "answer": final_answer,  # For consistency with other APIs
                "selected_agents": selected_agents,
                "activated_agents": selected_agents,  # Alias for consistency
                "routing_reason": final_state.get("routing_reason", ""),
                "enable_query_decompose": final_state.get("enable_query_decompose", False),
                "retrieved_chunks": retrieved_chunks,
                "retrieved_chunk_count": len(retrieved_chunks),
                "pre_rerank_candidates": final_state.get("merged_pre_rerank_candidates", []),
                "pre_rerank_candidate_count": len(final_state.get("merged_pre_rerank_candidates", [])),
                "agent_outputs": final_state.get("agent_outputs", {}),
                "chat_history": chat_history,
                "preliminary_time": round(preliminary_time, 3),
                "comprehensive_time": round(comprehensive_time, 3),
                "total_time": round(comprehensive_time, 3),
                "time_to_first_response": round(preliminary_time, 3),
            }

        except Exception as e:
            logger.error(f"[Session {session_id}] Error in preview-debug mode: {str(e)}", exc_info=True)
            # Ensure the holder is resolved so Phase 2 never hangs
            if not draft_holder._event.is_set():
                draft_holder.set_error(str(e))
            return {
                "preliminary_draft": "",
                "final_answer": "抱歉,处理您的问题时出现错误。",
                "answer": "抱歉,处理您的问题时出现错误。",
                "selected_agents": [],
                "activated_agents": [],
                "routing_reason": "",
                "enable_query_decompose": bool(self.config.get("enable_ctx_decomp", False)),
                "retrieved_chunks": [],
                "retrieved_chunk_count": 0,
                "pre_rerank_candidates": [],
                "pre_rerank_candidate_count": 0,
                "agent_outputs": {},
                "chat_history": "",
                "error": str(e),
            }
        finally:
            session_manager.request_lock.release()

    async def generate_response_debug_async(
        self,
        question: str,
        session_id: str,
        stop_after_retrieval: bool = False,
    ) -> Dict[str, Any]:
        """
        脚本/评测使用的调试接口。

        返回最终答案，以及跨子问题、跨 agent 去重后的 pre-rerank 候选 chunks。
        """
        import time
        session_manager = self.get_or_create_session(session_id)
        self.cleanup_old_sessions()
        await asyncio.to_thread(session_manager.request_lock.acquire)

        logger.info(f"[Session {session_id}] Processing debug query: {question}")

        try:
            t0 = time.time()
            initial_state = {
                "original_query": question,
                "user_query_raw": question,
                "chat_history": session_manager.get_chat_history_copy(),
                "rag": self.rag,
                "session_manager": session_manager,
                "config": self.config,
                "debug_stop_after_retrieval": stop_after_retrieval,
                "selected_agents": [],
                "routing_reason": "",
                "pending_agents": [],
                "enable_query_decompose": bool(self.config.get("enable_ctx_decomp", False)),
                "agent_outputs": {},
                "merged_evidence": [],
                "merged_pre_rerank_candidates": [],
                "conflict_notes": [],
                "missing_info": [],
                "need_fact_confirmation": False,
                "is_complete": False,
                "off_topic": False,
                "preliminary_draft": "",
                "final_answer": "",
                "iteration": 0,
                "max_iterations": 2,
                "request_start_time": t0,
            }

            final_state = await self.workflow.ainvoke(initial_state)
            total_time = round(time.time() - t0, 3)

            final_answer = final_state.get("final_answer", "")
            activated_agents = final_state.get("selected_agents", [])
            retrieved_chunks = extract_retrieved_chunks(final_state)
            pre_rerank_candidates = final_state.get("merged_pre_rerank_candidates", [])

            if not stop_after_retrieval:
                session_manager.add_exchange(question, final_answer)
            chat_history = session_manager.get_chat_history_string()

            return {
                "answer": final_answer,
                "chat_history": chat_history,
                "activated_agents": activated_agents,
                "routing_reason": final_state.get("routing_reason", ""),
                "enable_query_decompose": final_state.get("enable_query_decompose", False),
                "retrieved_chunks": retrieved_chunks,
                "retrieved_chunk_count": len(retrieved_chunks),
                "pre_rerank_candidates": pre_rerank_candidates,
                "pre_rerank_candidate_count": len(pre_rerank_candidates),
                "agent_outputs": final_state.get("agent_outputs", {}),
                "time_to_first_response": final_state.get("time_to_first_response", 0.0),
                "total_time": total_time,
            }
        except Exception as e:
            logger.error(f"[Session {session_id}] Error in generate_response_debug_async: {str(e)}", exc_info=True)
            return {
                "answer": "抱歉,处理您的问题时出现错误。",
                "chat_history": "",
                "activated_agents": [],
                "routing_reason": "",
                "enable_query_decompose": bool(self.config.get("enable_ctx_decomp", False)),
                "retrieved_chunks": [],
                "retrieved_chunk_count": 0,
                "pre_rerank_candidates": [],
                "pre_rerank_candidate_count": 0,
                "agent_outputs": {},
                "error": str(e),
            }
        finally:
            session_manager.request_lock.release()

    async def generate_response_moa_async(
        self,
        question: str,
        session_id: str,
    ) -> Dict[str, Any]:
        session_manager = self.get_or_create_session(session_id)
        self.cleanup_old_sessions()
        await asyncio.to_thread(session_manager.request_lock.acquire)

        logger.info(f"[Session {session_id}] Processing MoA query: {question}")

        try:
            result = await run_moa_baseline(
                question=question,
                session_manager=session_manager,
                rag=self.rag,
            )
            final_answer = result.get("answer", "")
            session_manager.add_exchange(question, final_answer)
            chat_history = session_manager.get_chat_history_string()

            logger.info(f"[Session {session_id}] MoA response generated successfully")
            return {
                "answer": final_answer,
                "chat_history": chat_history,
                "activated_agents": result.get("activated_agents", []),
                "retrieved_chunks": result.get("retrieved_chunks", []),
                "retrieved_chunk_count": result.get("retrieved_chunk_count", 0),
                "pre_rerank_candidates": result.get("pre_rerank_candidates", []),
                "pre_rerank_candidate_count": result.get("pre_rerank_candidate_count", 0),
                "translated_query": result.get("translated_query", ""),
                "round1_answers": result.get("round1_answers", {}),
                "round2_answers": result.get("round2_answers", {}),
                "agent_outputs": result.get("agent_outputs", {}),
                "token_usage": result.get("token_usage", {}),
                "llm_call_count": result.get("llm_call_count", 0),
                "llm_latency_seconds": result.get("llm_latency_seconds", 0.0),
                "moa_latency_seconds": result.get("moa_latency_seconds", 0.0),
            }
        except Exception as e:
            logger.error(f"[Session {session_id}] Error in generate_response_moa_async: {str(e)}", exc_info=True)
            return {
                "answer": "抱歉,处理您的问题时出现错误。",
                "chat_history": "",
                "activated_agents": [],
                "retrieved_chunks": [],
                "retrieved_chunk_count": 0,
                "pre_rerank_candidates": [],
                "pre_rerank_candidate_count": 0,
                "translated_query": "",
                "round1_answers": {},
                "round2_answers": {},
                "agent_outputs": {},
                "token_usage": {},
                "llm_call_count": 0,
                "llm_latency_seconds": 0.0,
                "moa_latency_seconds": 0.0,
                "error": str(e),
            }
        finally:
            session_manager.request_lock.release()

    async def generate_response_findebate_async(
        self,
        question: str,
        session_id: str,
    ) -> Dict[str, Any]:
        session_manager = self.get_or_create_session(session_id)
        self.cleanup_old_sessions()
        await asyncio.to_thread(session_manager.request_lock.acquire)

        logger.info(f"[Session {session_id}] Processing FinDebate query: {question}")

        try:
            result = await run_findebate_baseline(
                question=question,
                session_manager=session_manager,
                rag=self.rag,
            )
            final_answer = result.get("answer", "")
            session_manager.add_exchange(question, final_answer)
            chat_history = session_manager.get_chat_history_string()

            logger.info(f"[Session {session_id}] FinDebate response generated successfully")
            return {
                "answer": final_answer,
                "chat_history": chat_history,
                "activated_agents": result.get("activated_agents", []),
                "retrieved_chunks": result.get("retrieved_chunks", []),
                "retrieved_chunk_count": result.get("retrieved_chunk_count", 0),
                "pre_rerank_candidates": result.get("pre_rerank_candidates", []),
                "pre_rerank_candidate_count": result.get("pre_rerank_candidate_count", 0),
                "translated_query": result.get("translated_query", ""),
                "initial_reports": result.get("initial_reports", {}),
                "debate_logs": result.get("debate_logs", {}),
                "leader_reports": result.get("leader_reports", {}),
                "agent_outputs": result.get("agent_outputs", {}),
            }
        except Exception as e:
            logger.error(f"[Session {session_id}] Error in generate_response_findebate_async: {str(e)}", exc_info=True)
            return {
                "answer": "抱歉,处理您的问题时出现错误。",
                "chat_history": "",
                "activated_agents": [],
                "retrieved_chunks": [],
                "retrieved_chunk_count": 0,
                "pre_rerank_candidates": [],
                "pre_rerank_candidate_count": 0,
                "translated_query": "",
                "initial_reports": {},
                "debate_logs": {},
                "leader_reports": {},
                "agent_outputs": {},
                "error": str(e),
            }
        finally:
            session_manager.request_lock.release()

    async def generate_response_stream(
        self,
        question: str,
        session_id: str,
    ) -> AsyncGenerator[Dict[str, Any], None]:
        """
        流式接口 - 每个 agent 完成后立即推送 agent_completed 事件，最后推 complete。

        使用 workflow.astream() 驱动节点级事件，emit_cb 注入到 initial_state 以便
        agents_parallel_node 在每个 agent 完成时实时推送，无需在此处重复实现 fan-out。
        测试/debug 路径直接使用 workflow.ainvoke()，行为完全一致。
        """
        session_manager = self.get_or_create_session(session_id)
        self.cleanup_old_sessions()
        await asyncio.to_thread(session_manager.request_lock.acquire)
        logger.info(f"[Session {session_id}] Starting stream: {question}")

        try:
            event_queue: asyncio.Queue = asyncio.Queue()
            _SENTINEL = object()

            def emit_cb(ev_type: str, data: Dict[str, Any]) -> None:
                event_queue.put_nowait({"event": ev_type, "data": data})

            initial_state = self._build_agentic_initial_state(question, session_manager)
            initial_state["emit_cb"] = emit_cb

            yield self._build_stream_start_event(question, session_id)

            final_answer = ""
            last_off_topic = False
            last_selected_agents: List[str] = []

            async def _run_workflow() -> None:
                nonlocal final_answer, last_off_topic, last_selected_agents
                try:
                    async for chunk in self.workflow.astream(initial_state):
                        for node_name, node_output in chunk.items():
                            if node_name not in ("orchestrator", "agents_parallel", "synthesis"):
                                continue
                            if node_name == "orchestrator":
                                last_off_topic = bool(node_output.get("off_topic", False))
                                last_selected_agents = list(node_output.get("selected_agents", []) or [])
                            ev = self._build_workflow_stream_event(node_name, node_output, initial_state)
                            event_queue.put_nowait(ev)
                            if node_name == "orchestrator" and node_output.get("off_topic"):
                                final_answer = node_output.get("final_answer", "")
                            elif node_name == "synthesis":
                                final_answer = node_output.get("final_answer", "")
                except Exception as e:
                    logger.error(f"[Session {session_id}] Workflow error: {e}", exc_info=True)
                    event_queue.put_nowait({"event": "error", "data": {"message": str(e)}})
                finally:
                    event_queue.put_nowait(_SENTINEL)

            workflow_task = asyncio.create_task(_run_workflow())

            while True:
                item = await event_queue.get()
                if item is _SENTINEL:
                    break
                yield item

            await workflow_task

            if final_answer:
                session_manager.add_exchange(question, final_answer)
                if hasattr(self, 'memory') and self.memory:
                    try:
                        asyncio.ensure_future(self._async_record_memory(
                            session_id, question, final_answer,
                            last_selected_agents, last_off_topic))
                    except Exception:
                        pass
                await self._persist_session_history_turn(
                    session_id,
                    question,
                    None,
                    final_answer,
                    last_selected_agents,
                    last_off_topic,
                )
                # 先发完流式片段后再等标题落库，再发 complete，避免前端 GET /sessions 仍见默认标题
                await self._summarize_and_update_title(session_id, question, final_answer)

            yield self._build_complete_event(final_answer, session_id)
            logger.info(f"[Session {session_id}] Stream completed successfully")

        except Exception as e:
            logger.error(f"[Session {session_id}] Stream error: {str(e)}", exc_info=True)
            yield {"event": "error", "data": {"message": str(e)}}
        finally:
            session_manager.request_lock.release()

    async def _async_record_memory(self, session_id, question, answer, agents, off_topic):
        if not hasattr(self, 'memory') or not self.memory:
            return
        try:
            self.memory.record_turn(
                session_id=session_id, question=question, answer=answer,
                audit={'model_name': 'memory', 'latency_ms': 0, 'status': 'ok'})
        except Exception as e:
            import logging
            logging.getLogger(__name__).warning('Memory record failed: %s', e)

    def __del__(self):
        """清理资源"""
        try:
            logger.info("ChatService cleanup started")
            with self.sessions_lock:
                self.sessions.clear()
            logger.info("ChatService cleanup completed")
        except Exception as e:
            logger.error(f"Error during ChatService cleanup: {str(e)}")
