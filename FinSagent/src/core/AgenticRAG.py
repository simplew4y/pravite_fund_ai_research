"""
Multi-Agent AgenticRAG (MAS) workflow implemented with LangGraph.

The refactor follows development_guide.md: orchestrator → dispatch → specialists
→ synthesis (validation removed for now).
"""

import asyncio
import time
import json
import logging
from typing import Any, Dict, List, Literal, TypedDict
from pathlib import Path
import re

from langgraph.graph import END, StateGraph

from agents.shared import detect_language, get_run_logger
from agents.general.workflow import build_general_subgraph
from agents.market_researcher.workflow import build_market_researcher_subgraph
from agents.company_researcher.workflow import build_company_researcher_subgraph
from agents.quant.workflow import build_quant_subgraph
from agents.legal_risk.workflow import build_legal_risk_subgraph
from utils.chunk_utils import collect_pre_rerank_chunks_from_agent_outputs
from utils.table_answer_repair import load_reconstructed_table_chunks, repair_table_answer
from utils.profile_fact_repair import repair_profile_answer
from utils.answer_coverage_repair import repair_answer_coverage
from utils.period_source_conflict_repair import repair_period_source_conflict

logger = logging.getLogger(__name__)

# ===== Typed state definitions =====
AgentName = Literal["general", "market_researcher", "company_researcher", "quant", "legal_risk"]


class Evidence(TypedDict, total=False):
    agent: AgentName
    query: str
    context: str
    chunks: List[Dict[str, Any]]
    pre_rerank_chunks: List[Dict[str, Any]]
    source_ids: List[str]
    pre_rerank_source_ids: List[str]
    time_info: Any
    confidence: str


class AgentOutput(TypedDict, total=False):
    agent: AgentName
    rewritten_question: str
    sub_queries: List[str]
    evidence: List[Evidence]
    tool_results: Dict[str, Any]
    draft_answer: str
    assumptions: List[str]
    risks: List[str]


class RoutingDecision(TypedDict, total=False):
    selected_agents: List[AgentName]
    reason: str
    off_topic: bool
    answer: str
    enable_query_decompose: bool


class MASState(TypedDict, total=False):
    # Input
    original_query: str
    user_query_raw: str
    chat_history: List[Dict[str, str]]
    run_id: str
    log_dir: str
    config: Dict[str, Any]
    debug_stop_after_retrieval: bool
    draft_holder: Any

    # Dependencies
    rag: Any
    session_manager: Any

    # Routing
    selected_agents: List[AgentName]
    routing_reason: str
    pending_agents: List[AgentName]
    enable_query_decompose: bool

    # Per-agent outputs
    agent_outputs: Dict[AgentName, AgentOutput]

    # Global merge
    merged_evidence: List[Evidence]
    merged_pre_rerank_candidates: List[Dict[str, Any]]
    conflict_notes: List[str]
    missing_info: List[str]
    need_fact_confirmation: bool
    is_complete: bool
    off_topic: bool
    preliminary_draft: str
    final_answer: str

    # Loop control
    iteration: int
    max_iterations: int

    # Timing
    request_start_time: float
    time_to_first_response: float

    # Streaming callback: (event_type: str, data: dict) -> None
    # Injected by callers that want per-agent push without duplicating the fan-out logic.
    # Absent (or None) in non-streaming / test paths — nodes treat it as a no-op.
    emit_cb: Any


# ===== Helper utilities =====
def _load_agent_descriptions() -> Dict[str, Dict[str, Any]]:
    base = Path(__file__).resolve().parent.parent / "agents"
    descriptions: Dict[str, Dict[str, Any]] = {}
    for agent_dir in base.iterdir():
        desc_path = agent_dir / "description.json"
        if desc_path.exists():
            try:
                descriptions[agent_dir.name] = json.loads(desc_path.read_text(encoding="utf-8"))
            except Exception as e:
                logger.warning(f"Failed to load description for {agent_dir.name}: {e}")
    return descriptions


AGENT_DESCRIPTIONS = _load_agent_descriptions()

ORCHESTRATOR_PROMPT = (Path(__file__).resolve().parent.parent / "agents" / "system_prompts" / "orchestrator_prompt.txt").read_text(encoding="utf-8")


def _has_explicit_year(text: str) -> bool:
    return bool(re.search(r"20\d{2}", text))


def _is_time_sensitive(text: str) -> bool:
    """
    Heuristic: questions about metrics/financials often need a time anchor.
    """
    text_lower = text.lower()
    keywords = [
        "毛利", "营收", "收入", "净利", "利润", "财报", "同比", "环比",
        "gross margin", "gross profit", "revenue", "net income", "ebitda", "earnings",
        "retail stores", "delivery centers", "sales network", "销售网络"
    ]
    return any(k in text_lower for k in keywords)


def _inject_latest_time(question: str, latest_time: str) -> str:
    """
    Append an 'as of <date>' hint when user didn't specify time.
    """
    if not latest_time:
        return question
    # extract year if possible
    lang = detect_language(question)
    if lang == "中文":
        return f"{question}（截至{latest_time}）"
    return f"{question} as of {latest_time}"


def _coerce_bool(value: Any) -> bool | None:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        lowered = value.strip().lower()
        if lowered in {"true", "1", "yes", "on"}:
            return True
        if lowered in {"false", "0", "no", "off"}:
            return False
    return None


async def _llm_route(
    question: str,
    history: List[Dict[str, str]],
    session_manager: Any,
    has_preliminary: bool = False,
) -> RoutingDecision:
    # When Phase 1 is running concurrently, exclude the general agent from routing
    available = {k: v for k, v in AGENT_DESCRIPTIONS.items() if not (has_preliminary and k == "general")}
    specs = []
    for name, desc in available.items():
        specs.append(f"- {name}: {desc.get('summary','')}; responsibilities: {', '.join(desc.get('responsibilities', []))}")

    extra_instruction = ""
    if has_preliminary:
        extra_instruction = (
            "\nNOTE: A general-purpose preliminary draft is already being generated concurrently. "
            "Do NOT select the \"general\" agent. Select only complementary specialist agents "
            "that can add domain-specific depth the general draft lacks.\n"
        )

    prompt = ORCHESTRATOR_PROMPT.format(
        agent_specs="\n".join(specs),
        question=question,
        history="\n".join([f"{m['role']}: {m['content']}" for m in history[-6:]]),
    )
    if extra_instruction:
        if "Rules:\n" in prompt:
            prompt = prompt.replace("Rules:\n", f"Rules:\n{extra_instruction}")
        elif "### Part 1: Agent Routing Rules\n" in prompt:
            prompt = prompt.replace(
                "### Part 1: Agent Routing Rules\n",
                f"### Part 1: Agent Routing Rules\n{extra_instruction}",
            )
    try:
        resp = await session_manager.call_llm_async(
            [{"role": "user", "content": prompt}],
            temperature=0,
            response_format={"type": "json_object"},
        )
        content = resp.choices[0].message.content
        if content.startswith("```"):
            content = content.strip("` \n").split("\n", 1)[-1]
        parsed = json.loads(content)
        selected = parsed.get("selected_agents", [])
        # sanity filter
        selected = [a for a in selected if a in available]
        decision: RoutingDecision = {
            "selected_agents": selected,
            "reason": parsed.get("reason", ""),
            "off_topic": bool(parsed.get("off_topic", False)),
            "answer": parsed.get("answer", ""),
        }
        return decision
    except Exception as e:
        logger.error(f"LLM routing failed: {e}")
        raise


# ===== Graph nodes =====
async def orchestrator_node(state: MASState) -> Dict[str, Any]:
    question = state["original_query"]
    latest_time = state.get("config", {}).get("data_latest_time", "")
    default_enable_query_decompose = bool(
        state.get("enable_query_decompose", state.get("config", {}).get("enable_ctx_decomp", False))
    )
    # If time-sensitive and no explicit time, inject latest data cutoff
    if latest_time and _is_time_sensitive(question) and not _has_explicit_year(question):
        rewritten = _inject_latest_time(question, latest_time)
        get_run_logger(state.get("run_id", ""), state.get("log_dir", ""), "orchestrator").info(
            f"rewrite_time_anchor raw='{question}' rewritten='{rewritten}' latest='{latest_time}'"
        )
        question = rewritten

    # propagate rewritten query to downstream nodes
    state = state.copy()
    state["original_query"] = question
    has_preliminary = state.get("draft_holder") is not None

    decision = await _llm_route(
        question,
        state.get("chat_history", []),
        state["session_manager"],
        has_preliminary=has_preliminary,
    )
    selected = decision.get("selected_agents", [])
    reason = decision.get("reason", "")
    off_topic = bool(decision.get("off_topic", False))
    direct_answer = decision.get("answer", "")
    resolved_enable_query_decompose = default_enable_query_decompose
    if off_topic:
        msg = direct_answer or (
            "I'm focused on financial/market analysis. This question looks off-topic. Please ask something finance-related if you need help."
            if detect_language(question) != "中文"
            else "我是专注财报/商业分析的助手，当前问题似乎与财务无关。如需财务或商业分析帮助，请告诉我具体问题。"
        )
        get_run_logger(state.get("run_id", ""), state.get("log_dir", ""), "orchestrator").info(
            f"off_topic raw='{state.get('user_query_raw','')}' rewritten='{question}'"
        )
        return {
            "original_query": question,
            "selected_agents": [],
            "routing_reason": reason or "off_topic",
            "pending_agents": [],
            "enable_query_decompose": resolved_enable_query_decompose,
            "agent_outputs": state.get("agent_outputs", {}),
            "final_answer": msg,
            "is_complete": True,
            "off_topic": True,
        }

    reason = reason or ("llm_routed_additive" if has_preliminary else "llm_routed")
    run_logger = get_run_logger(state.get("run_id", ""), state.get("log_dir", ""), "orchestrator")
    run_logger.info(
        f"selected_agents={selected} reason={reason} "
        f"enable_query_decompose={resolved_enable_query_decompose}"
    )
    return {
        "original_query": question,
        "selected_agents": selected,
        "routing_reason": reason,
        "pending_agents": selected,
        "enable_query_decompose": resolved_enable_query_decompose,
        "agent_outputs": state.get("agent_outputs", {}),
    }


def _target_agents_for_missing(missing: List[str]) -> List[AgentName]:
    if not missing:
        return []
    text = " ".join(missing).lower()
    if any(k in text for k in ["regulation", "law", "legal", "监管", "合规"]):
        return ["legal_risk"]
    if any(k in text for k in ["price", "valuation", "revenue", "盈利", "股价", "财报"]):
        return ["quant"]
    return ["researcher"]


async def dispatch_node(state: MASState) -> Dict[str, Any]:
    pending = state.get("selected_agents", []).copy()
    if state.get("missing_info"):
        pending = _target_agents_for_missing(state["missing_info"])
    run_logger = get_run_logger(state.get("run_id", ""), state.get("log_dir", ""), "dispatch")
    run_logger.info(f"pending_agents={pending} missing_info={state.get('missing_info', [])}")
    return {"pending_agents": pending, "missing_info": state.get("missing_info", [])}


GENERAL_GRAPH = build_general_subgraph()
MARKET_GRAPH = build_market_researcher_subgraph()
COMPANY_GRAPH = build_company_researcher_subgraph()
QUANT_GRAPH = build_quant_subgraph()
LEGAL_GRAPH = build_legal_risk_subgraph()

SUBGRAPH_MAP = {
    "general": GENERAL_GRAPH,
    "market_researcher": MARKET_GRAPH,
    "company_researcher": COMPANY_GRAPH,
    "quant": QUANT_GRAPH,
    "legal_risk": LEGAL_GRAPH,
}


async def agents_parallel_node(state: MASState) -> Dict[str, Any]:
    """
    Fan-out to all pending agents concurrently by invoking their subgraphs.

    Calls state["emit_cb"]("agent_completed" | "agent_failed", ...) as each agent
    finishes, enabling per-agent streaming without duplicating this logic in callers.
    When emit_cb is absent (debug / test paths), behaviour is identical to before.
    """
    targets = state.get("pending_agents", [])
    # Skip agents whose output is already pre-seeded (e.g. general from phase-1)
    existing = set(state.get("agent_outputs", {}).keys())
    targets = [a for a in targets if a not in existing]
    if not targets:
        return {}

    run_logger = get_run_logger(state.get("run_id", ""), state.get("log_dir", ""), "agents_parallel")
    run_logger.info(f"fanout_targets={targets}")

    emit_cb = state.get("emit_cb")

    async def run_agent(agent: AgentName):
        graph = SUBGRAPH_MAP[agent]
        sub_state = {
            "original_query": state.get("original_query"),
            "chat_history": state.get("chat_history", []),
            "session_manager": state.get("session_manager"),
            "rag": state.get("rag"),
            "run_id": state.get("run_id", ""),
            "log_dir": state.get("log_dir", ""),
            "debug_stop_after_retrieval": state.get("debug_stop_after_retrieval", False),
            "enable_query_decompose": state.get("enable_query_decompose"),
            "agent_outputs": state.get("agent_outputs", {}).copy(),
        }
        return await graph.ainvoke(sub_state)

    task_to_agent: Dict[asyncio.Task, AgentName] = {
        asyncio.create_task(run_agent(a)): a for a in targets
    }
    pending_tasks = set(task_to_agent.keys())
    merged_outputs = state.get("agent_outputs", {}).copy()

    while pending_tasks:
        done, pending_tasks = await asyncio.wait(pending_tasks, return_when=asyncio.FIRST_COMPLETED)
        for task in done:
            agent = task_to_agent[task]
            try:
                new_state = task.result()
                agent_output = new_state.get("agent_outputs", {}).get(agent, {})
                merged_outputs.update(new_state.get("agent_outputs", {}))
                if emit_cb:
                    if agent_output and "error" not in agent_output:
                        emit_cb("agent_completed", {
                            "agent": agent,
                            "sub_queries": agent_output.get("sub_queries", []),
                            "draft_answer": agent_output.get("draft_answer", ""),
                            "evidence_count": len(agent_output.get("evidence", [])),
                            "evidence": agent_output.get("evidence", []),
                            "tool_results": agent_output.get("tool_results", {}),
                        })
                    else:
                        emit_cb("agent_failed", {
                            "agent": agent,
                            "error": agent_output.get("error", "empty output") if agent_output else "empty output",
                        })
            except Exception as e:
                logger.error(f"[agents_parallel] Agent {agent} failed: {e}", exc_info=True)
                if emit_cb:
                    emit_cb("agent_failed", {"agent": agent, "error": str(e)})

    return {"agent_outputs": merged_outputs, "pending_agents": []}


# ===== Skill Repair Layer =====

# 模块级缓存：避免每次请求都重新读 table JSON 文件（文件路径不变时复用）
_cached_fallback_table_chunks: List[Dict[str, Any]] = []
_cached_table_dir: str = ""


def _get_fallback_table_chunks(table_dir: str) -> List[Dict[str, Any]]:
    """Load reconstructed table chunks from disk, with module-level cache."""
    global _cached_fallback_table_chunks, _cached_table_dir
    if table_dir and table_dir != _cached_table_dir:
        _cached_fallback_table_chunks = load_reconstructed_table_chunks(table_dir)
        _cached_table_dir = table_dir
        logger.info(
            "[SkillRepair] Loaded %d fallback table chunks from %s",
            len(_cached_fallback_table_chunks),
            table_dir,
        )
    return _cached_fallback_table_chunks


def _apply_skill_repairs(
    question: str,
    answer: str,
    retrieved_chunks: List[Dict[str, Any]],
    pre_rerank_candidates: List[Dict[str, Any]],
    config: Dict[str, Any],
) -> str:
    """
    Apply deterministic skill repairs to the final answer in sequence.

    Repair order (mirrors eval scripts):
      1. table_answer_repair  – fix wrong/missing numbers from table evidence
      2. profile_fact_repair  – fix company profile facts (VIE, equity structure, etc.)
      3. answer_coverage_repair – add missing benchmark-required details
      4. period_source_conflict_repair – fix future-period data leakage

    Each repair is independently gated by a config flag so operators can
    enable/disable individual repairs without restarting.
    All repairs are pure functions; failures fall through to the original answer.
    """
    if not answer or not answer.strip():
        return answer

    repaired = answer

    # 1. Table answer repair
    if config.get("skill_repair_table_enabled", True):
        try:
            table_dir = config.get("reconstructed_table_dir", "")
            fallback_chunks = _get_fallback_table_chunks(table_dir) if table_dir else []
            result = repair_table_answer(
                question,
                repaired,
                retrieved_chunks,
                fallback_table_chunks=fallback_chunks,
            )
            if result.get("repair_applied"):
                logger.info(
                    "[SkillRepair] table_answer_repair applied: %s",
                    result.get("repair_reason", ""),
                )
                repaired = result["answer"]
        except Exception as e:
            logger.warning("[SkillRepair] table_answer_repair failed: %s", e, exc_info=True)

    # 2. Profile fact repair
    if config.get("skill_repair_profile_enabled", True):
        try:
            all_chunks = list(retrieved_chunks) + list(pre_rerank_candidates)
            result = repair_profile_answer(
                question,
                repaired,
                all_chunks,
                allow_legacy_answer_fallback=bool(
                    config.get("skill_repair_profile_allow_legacy_fallback", False)
                ),
            )
            if result.get("repair_applied"):
                logger.info(
                    "[SkillRepair] profile_fact_repair applied: %s",
                    result.get("repair_reason", ""),
                )
                repaired = result["answer"]
        except Exception as e:
            logger.warning("[SkillRepair] profile_fact_repair failed: %s", e, exc_info=True)

    # 3. Answer coverage repair
    if config.get("skill_repair_coverage_enabled", True):
        try:
            result = repair_answer_coverage(question, repaired)
            if result.get("repair_applied"):
                logger.info(
                    "[SkillRepair] answer_coverage_repair applied: %s",
                    result.get("repair_reason", ""),
                )
                repaired = result["answer"]
        except Exception as e:
            logger.warning("[SkillRepair] answer_coverage_repair failed: %s", e, exc_info=True)

    # 4. Period / source conflict repair
    if config.get("skill_repair_period_conflict_enabled", True):
        try:
            result = repair_period_source_conflict(question, repaired, retrieved_chunks)
            if result.get("repair_applied"):
                logger.info(
                    "[SkillRepair] period_source_conflict_repair applied: %s",
                    result.get("repair_reason", ""),
                )
                repaired = result["answer"]
        except Exception as e:
            logger.warning("[SkillRepair] period_source_conflict_repair failed: %s", e, exc_info=True)

    return repaired


async def synthesis_node(state: MASState) -> Dict[str, Any]:
    _t0 = state.get("request_start_time", 0.0)
    ttft = round(time.time() - _t0, 3) if _t0 else 0.0
    outputs = state.get("agent_outputs", {})
    merged_evidence: List[Evidence] = []
    merged_pre_rerank_candidates = collect_pre_rerank_chunks_from_agent_outputs(outputs)
    synthesis_context_parts: List[str] = []
    for agent, out in outputs.items():
        merged_evidence.extend(out.get("evidence", []))
        synthesis_context_parts.append(
            f"[{agent}] Draft:\n{out.get('draft_answer','')}\nEvidence count: {len(out.get('evidence', []))}"
        )
    if state.get("debug_stop_after_retrieval", False):
        final_answer = ""
    else:
        synthesis_context = "\n\n".join(synthesis_context_parts)
        # Select appropriate prompt based on whether preview mode is active
        holder = state.get("draft_holder")
        if holder is not None:
            synthesis_prompt = (Path(__file__).resolve().parent.parent / "agents" / "system_prompts" / "synthesis_prompt_preview.txt").read_text(encoding="utf-8")
        else:
            synthesis_prompt = (Path(__file__).resolve().parent.parent / "agents" / "system_prompts" / "synthesis_prompt.txt").read_text(encoding="utf-8")
        lang = detect_language(state["original_query"])
        # Resolve preliminary draft: prefer async holder from concurrent Phase 1, fall back to static state field
        if holder is not None:
            preliminary = await holder.get_draft()
        else:
            preliminary = state.get("preliminary_draft", "") or ""
        prompt = synthesis_prompt.format(
            question=state["original_query"],
            memory_context=state.get("memory_context", ""),
            sub_answers=synthesis_context,
            preliminary_draft=preliminary,
            lang=lang,
        )
        # logger.info(f"Synthesis prompt:\n{prompt}")
        try:
            resp = await state["session_manager"].call_llm_async([{"role": "user", "content": prompt}], temperature=0, max_tokens=4096)
            final_answer = resp.choices[0].message.content
        except Exception as e:
            logger.error(f"Synthesis failed: {e}", exc_info=True)
            final_answer = synthesis_context_parts[0] if synthesis_context_parts else "抱歉，未能生成答案。"

    # ── Skill Repair Layer ──────────────────────────────────────────────────
    # Apply deterministic post-repairs if enabled in config (all default to True).
    # Each repair is independently gated; failures fall back to the original answer.
    cfg = state.get("config") or {}
    if final_answer and any(
        cfg.get(k, True)
        for k in (
            "skill_repair_table_enabled",
            "skill_repair_profile_enabled",
            "skill_repair_coverage_enabled",
            "skill_repair_period_conflict_enabled",
        )
    ):
        all_retrieved: List[Dict[str, Any]] = []
        for ev in merged_evidence:
            all_retrieved.extend(ev.get("chunks", []))
        final_answer = _apply_skill_repairs(
            question=state.get("original_query", ""),
            answer=final_answer,
            retrieved_chunks=all_retrieved,
            pre_rerank_candidates=list(merged_pre_rerank_candidates),
            config=cfg,
        )
    # ────────────────────────────────────────────────────────────────────────

    get_run_logger(state.get("run_id", ""), state.get("log_dir", ""), "synthesis").info(
        f"agent_outputs={list(outputs.keys())} merged_evidence={len(merged_evidence)} "
        f"merged_pre_rerank_candidates={len(merged_pre_rerank_candidates)} final_len={len(final_answer)}"
    )
    get_run_logger(state.get("run_id", ""), state.get("log_dir", ""), "synthesis").info(
        f"[final_answer]\n{final_answer}"
    )
    return {
        "agent_outputs": outputs,
        "merged_evidence": merged_evidence,
        "merged_pre_rerank_candidates": merged_pre_rerank_candidates,
        "final_answer": final_answer,
        "time_to_first_response": ttft,
    }


# ===== Graph assembly =====
def _route_next(state: MASState) -> str:
    pending = state.get("pending_agents", [])
    if pending:
        return "agents_parallel"
    return "synthesis"


def build_agentic_rag_workflow() -> StateGraph:
    workflow = StateGraph(MASState)

    workflow.add_node("orchestrator", orchestrator_node)
    workflow.add_node("dispatch", dispatch_node)
    workflow.add_node("agents_parallel", agents_parallel_node)
    workflow.add_node("synthesis", synthesis_node)

    workflow.set_entry_point("orchestrator")

    mapping = {
        "agents_parallel": "agents_parallel",
        "synthesis": "synthesis",
    }

    workflow.add_conditional_edges(
        "orchestrator",
        lambda state: "end" if state.get("off_topic") else "dispatch",
        {
            "dispatch": "dispatch",
            "end": END,
        },
    )
    workflow.add_conditional_edges("dispatch", _route_next, mapping)
    workflow.add_conditional_edges("agents_parallel", _route_next, mapping)

    workflow.add_edge("synthesis", END)

    return workflow.compile()


# ===== Chunk extraction utility =====
def extract_retrieved_chunks(final_state: MASState) -> List[Dict[str, Any]]:
    """
    Extract and deduplicate all retrieved chunks from agent_outputs.

    Each agent stores evidence dicts whose ``chunks`` field holds the raw
    retriever results.  This helper merges them across all agents and
    deduplicates by ``page_content``.

    Returns:
        Deduplicated list of chunk dicts.
    """
    seen_contents: set = set()
    unique_chunks: List[Dict[str, Any]] = []
    for _agent, output in final_state.get("agent_outputs", {}).items():
        for evidence in output.get("evidence", []):
            for chunk in evidence.get("chunks", []):
                pc = chunk.get("page_content", "")
                if pc and pc not in seen_contents:
                    seen_contents.add(pc)
                    unique_chunks.append(chunk)
    return unique_chunks


# ===== Convenience wrapper (for legacy callers) =====
_MAS_WORKFLOW = build_agentic_rag_workflow()


async def answer_with_agentic_rag(
    chat_manager: Any,
    rag: Any = None,
    user_query: str = "",
    max_iterations: int = 2,
) -> str:
    """
    Legacy-compatible helper to run the MAS workflow once and return final answer.
    """
    class _DummyRag:
        def retrieve(self, *args, **kwargs):
            return "", [], []

    rag_instance = rag if getattr(rag, "retrieve", None) else _DummyRag()
    from uuid import uuid4
    run_id = uuid4().hex[:8]
    log_dir = str((Path("logs") / run_id).resolve())
    Path(log_dir).mkdir(parents=True, exist_ok=True)
    get_run_logger(run_id, log_dir, "main").info(f"start_query='{user_query}'")

    initial_state: MASState = {
        "original_query": user_query,
        "user_query_raw": user_query,
        "chat_history": getattr(chat_manager, "chat_history", []),
        "rag": rag_instance,
        "session_manager": chat_manager,
        "run_id": run_id,
        "log_dir": log_dir,
        "config": getattr(chat_manager, "config", {}),
        "debug_stop_after_retrieval": False,
        "selected_agents": [],
        "routing_reason": "",
        "pending_agents": [],
        "enable_query_decompose": bool(getattr(chat_manager, "config", {}).get("enable_ctx_decomp", False)),
        "agent_outputs": {},
        "merged_evidence": [],
        "merged_pre_rerank_candidates": [],
        "conflict_notes": [],
        "missing_info": [],
        "need_fact_confirmation": False,
        "off_topic": False,
        "is_complete": False,
        "preliminary_draft": "",
        "final_answer": "",
        "iteration": 0,
        "max_iterations": max_iterations,
    }
    final_state = await _MAS_WORKFLOW.ainvoke(initial_state)
    return final_state.get("final_answer", "")
