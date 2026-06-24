from datetime import datetime
from typing import Any, Dict, List, TypedDict

from langgraph.graph import StateGraph

from agents.shared import (
    draft_answer,
    execute_planned_tool_calls,
    plan_tool_calls,
    retrieve_evidence,
    rewrite_for_agent,
)
from agents.quant.prompts import REWRITE_PROMPT, ANSWER_PROMPT


class QuantState(TypedDict, total=False):
    original_query: str
    chat_history: List[Dict[str, str]]
    session_manager: Any
    rag: Any
    run_id: str
    log_dir: str
    debug_stop_after_retrieval: bool
    enable_query_decompose: bool
    agent_outputs: Dict[str, Any]
    quant_tool_plan_reason: str
    quant_planned_tool_calls: List[Dict[str, Any]]
    quant_sub_queries: List[str]
    quant_evidence: List[Any]
    quant_tool_results: Dict[str, Any]
    quant_draft_answer: str


def build_quant_subgraph() -> Any:
    async def tools_node(state: QuantState) -> Dict:
        if state.get("debug_stop_after_retrieval", False):
            return {
                "quant_tool_plan_reason": "debug_stop_after_retrieval",
                "quant_planned_tool_calls": [],
                "quant_tool_results": {},
            }
        planned = await plan_tool_calls(
            "quant",
            state["session_manager"],
            state["original_query"],
            sub_queries=state.get("quant_sub_queries", []),
            run_id=state.get("run_id", ""),
            log_dir=state.get("log_dir", ""),
        )
        planned_tool_calls = planned.get("tool_calls", [])
        tools = await execute_planned_tool_calls(
            "quant",
            planned_tool_calls,
            run_id=state.get("run_id", ""),
            log_dir=state.get("log_dir", ""),
            original_query=state["original_query"],
            sub_queries=state.get("quant_sub_queries", []),
            config=getattr(state["session_manager"], "config", {}),
        )
        return {
            "quant_tool_plan_reason": planned.get("reason", ""),
            "quant_planned_tool_calls": planned_tool_calls,
            "quant_tool_results": tools,
        }

    async def rewrite_node(state: QuantState) -> Dict:
        sub_queries = await rewrite_for_agent(
            "quant",
            state["original_query"],
            state.get("chat_history", []),
            state["session_manager"],
            REWRITE_PROMPT,
            max_sub_queries=4,
            run_id=state.get("run_id", ""),
            log_dir=state.get("log_dir", ""),
            rag=state.get("rag"),
            enable_query_decompose=state.get("enable_query_decompose"),
        )
        return {"quant_sub_queries": sub_queries}

    async def retrieve_node(state: QuantState) -> Dict:
        rag = state.get("rag")
        subs = state.get("quant_sub_queries", [state["original_query"]])

        if state.get("debug_stop_after_retrieval", False):
            evidences = await retrieve_evidence(
                rag,
                subs,
                datetime.now(),
                "quant",
                run_id=state.get("run_id", ""),
                log_dir=state.get("log_dir", ""),
            )
            return {"quant_evidence": evidences}

        evidences = await retrieve_evidence(
            rag,
            subs,
            datetime.now(),
            "quant",
            run_id=state.get("run_id", ""),
            log_dir=state.get("log_dir", ""),
        )
        return {"quant_evidence": evidences}

    async def draft_node(state: QuantState) -> Dict:
        evidences = state.get("quant_evidence", [])
        tools = state.get("quant_tool_results", {})
        draft = await draft_answer(
            "quant",
            state["original_query"],
            state.get("chat_history", []),
            evidences,
            tools,
            ANSWER_PROMPT,
            state["session_manager"],
            run_id=state.get("run_id", ""),
            log_dir=state.get("log_dir", ""),
        )
        return {"quant_draft_answer": draft}

    async def finalize_node(state: QuantState) -> Dict:
        evidences = state.get("quant_evidence", [])
        tools = state.get("quant_tool_results", {})
        outputs = state.get("agent_outputs", {}).copy()
        outputs["quant"] = {
            "agent": "quant",
            "rewritten_question": state["original_query"],
            "sub_queries": state.get("quant_sub_queries", []),
            "evidence": evidences,
            "tool_results": tools,
            "draft_answer": state.get("quant_draft_answer", ""),
            "assumptions": [],
            "risks": [],
        }
        return {"agent_outputs": outputs}

    def route_after_parallel(state: QuantState) -> str:
        return "finalize" if state.get("debug_stop_after_retrieval", False) else "draft"

    g = StateGraph(QuantState)
    g.add_node("rewrite", rewrite_node)
    g.add_node("tools", tools_node)
    g.add_node("retrieve", retrieve_node)
    g.add_node("draft", draft_node)
    g.add_node("finalize", finalize_node)
    g.set_entry_point("rewrite")
    g.add_edge("rewrite", "retrieve")
    g.add_edge("rewrite", "tools")
    g.add_conditional_edges(
        "retrieve",
        route_after_parallel,
        {
            "draft": "draft",
            "finalize": "finalize",
        },
    )
    g.add_conditional_edges(
        "tools",
        route_after_parallel,
        {
            "draft": "draft",
            "finalize": "finalize",
        },
    )
    g.add_edge("draft", "finalize")
    return g.compile()
