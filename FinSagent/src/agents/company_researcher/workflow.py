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
from agents.company_researcher.prompts import REWRITE_PROMPT, ANSWER_PROMPT


class CompanyResearcherState(TypedDict, total=False):
    original_query: str
    user_query_raw: str
    chat_history: List[Dict[str, str]]
    session_manager: Any
    rag: Any
    run_id: str
    log_dir: str
    debug_stop_after_retrieval: bool
    enable_query_decompose: bool
    agent_outputs: Dict[str, Any]
    company_tool_plan_reason: str
    company_planned_tool_calls: List[Dict[str, Any]]
    company_sub_queries: List[str]
    company_evidence: List[Any]
    company_tool_results: Dict[str, Any]
    company_draft_answer: str


def build_company_researcher_subgraph() -> Any:
    async def tools_node(state: CompanyResearcherState) -> Dict:
        if state.get("debug_stop_after_retrieval", False):
            return {
                "company_tool_plan_reason": "debug_stop_after_retrieval",
                "company_planned_tool_calls": [],
                "company_tool_results": {},
            }
        planned = await plan_tool_calls(
            "company_researcher",
            state["session_manager"],
            state["original_query"],
            sub_queries=state.get("company_sub_queries", []),
            run_id=state.get("run_id", ""),
            log_dir=state.get("log_dir", ""),
        )
        planned_tool_calls = planned.get("tool_calls", [])
        tools = await execute_planned_tool_calls(
            "company_researcher",
            planned_tool_calls,
            run_id=state.get("run_id", ""),
            log_dir=state.get("log_dir", ""),
            original_query=state["original_query"],
            sub_queries=state.get("company_sub_queries", []),
            config=getattr(state["session_manager"], "config", {}),
        )
        return {
            "company_tool_plan_reason": planned.get("reason", ""),
            "company_planned_tool_calls": planned_tool_calls,
            "company_tool_results": tools,
        }

    async def rewrite_node(state: CompanyResearcherState) -> Dict:
        sub_queries = await rewrite_for_agent(
            "company_researcher",
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
        return {"company_sub_queries": sub_queries}

    async def retrieve_node(state: CompanyResearcherState) -> Dict:
        rag = state.get("rag")
        subs = state.get("company_sub_queries", [state["original_query"]])

        if state.get("debug_stop_after_retrieval", False):
            evidences = await retrieve_evidence(
                rag,
                subs,
                datetime.now(),
                "company_researcher",
                run_id=state.get("run_id", ""),
                log_dir=state.get("log_dir", ""),
                scope_query=state.get("user_query_raw") or state["original_query"],
                scope_history=state.get("chat_history", []),
            )
            return {"company_evidence": evidences}

        evidences = await retrieve_evidence(
            rag,
            subs,
            datetime.now(),
            "company_researcher",
            run_id=state.get("run_id", ""),
            log_dir=state.get("log_dir", ""),
            scope_query=state.get("user_query_raw") or state["original_query"],
            scope_history=state.get("chat_history", []),
        )
        return {"company_evidence": evidences}

    async def draft_node(state: CompanyResearcherState) -> Dict:
        evidences = state.get("company_evidence", [])
        tools = state.get("company_tool_results", {})
        draft = await draft_answer(
            "company_researcher",
            state["original_query"],
            state.get("chat_history", []),
            evidences,
            tools,
            ANSWER_PROMPT,
            state["session_manager"],
            run_id=state.get("run_id", ""),
            log_dir=state.get("log_dir", ""),
        )
        return {"company_draft_answer": draft}

    async def finalize_node(state: CompanyResearcherState) -> Dict:
        evidences = state.get("company_evidence", [])
        tools = state.get("company_tool_results", {})
        outputs = state.get("agent_outputs", {}).copy()
        outputs["company_researcher"] = {
            "agent": "company_researcher",
            "rewritten_question": state["original_query"],
            "sub_queries": state.get("company_sub_queries", []),
            "evidence": evidences,
            "tool_results": tools,
            "draft_answer": state.get("company_draft_answer", ""),
            "assumptions": [],
            "risks": [],
        }
        return {"agent_outputs": outputs}

    def route_after_parallel(state: CompanyResearcherState) -> str:
        return "finalize" if state.get("debug_stop_after_retrieval", False) else "draft"

    g = StateGraph(CompanyResearcherState)
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
