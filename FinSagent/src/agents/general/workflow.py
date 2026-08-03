from datetime import datetime
from typing import Any, Dict, List, TypedDict

from langgraph.graph import StateGraph

from agents.shared import draft_answer, retrieve_evidence, rewrite_for_agent, get_run_logger
from agents.general.prompts import REWRITE_PROMPT, ANSWER_PROMPT


class GeneralState(TypedDict, total=False):
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
    general_sub_queries: List[str]
    general_evidence: List[Any]
    general_draft_answer: str


def build_general_subgraph() -> Any:
    """
    General agent: minimal path rewrite -> (optional) retrieval -> draft.
    """

    async def rewrite_node(state: GeneralState) -> Dict:
        sub_queries = await rewrite_for_agent(
            "general",
            state["original_query"],
            state.get("chat_history", []),
            state["session_manager"],
            REWRITE_PROMPT,
            max_sub_queries=3,
            run_id=state.get("run_id", ""),
            log_dir=state.get("log_dir", ""),
            rag=state.get("rag"),
            enable_query_decompose=state.get("enable_query_decompose"),
        )
        return {"general_sub_queries": sub_queries}

    async def retrieve_node(state: GeneralState) -> Dict:
        rag = state.get("rag")
        subs = state.get("general_sub_queries", [state["original_query"]])
        evidences = await retrieve_evidence(
            rag,
            subs,
            datetime.now(),
            "general",
            run_id=state.get("run_id", ""),
            log_dir=state.get("log_dir", ""),
            scope_query=state.get("user_query_raw") or state["original_query"],
        )
        return {"general_evidence": evidences}

    async def draft_node(state: GeneralState) -> Dict:
        evidences = state.get("general_evidence", [])
        draft = await draft_answer(
            "general",
            state["original_query"],
            state.get("chat_history", []),
            evidences,
            {},
            ANSWER_PROMPT,
            state["session_manager"],
            run_id=state.get("run_id", ""),
            log_dir=state.get("log_dir", ""),
        )
        return {"general_draft_answer": draft}

    async def finalize_node(state: GeneralState) -> Dict:
        evidences = state.get("general_evidence", [])
        outputs = state.get("agent_outputs", {}).copy()
        outputs["general"] = {
            "agent": "general",
            "rewritten_question": state["original_query"],
            "sub_queries": state.get("general_sub_queries", []),
            "evidence": evidences,
            "tool_results": {},
            "draft_answer": state.get("general_draft_answer", ""),
            "assumptions": [],
            "risks": [],
        }
        return {"agent_outputs": outputs}

    def route_after_retrieve(state: GeneralState) -> str:
        return "finalize" if state.get("debug_stop_after_retrieval", False) else "draft"

    g = StateGraph(GeneralState)
    g.add_node("rewrite", rewrite_node)
    g.add_node("retrieve", retrieve_node)
    g.add_node("draft", draft_node)
    g.add_node("finalize", finalize_node)
    g.set_entry_point("rewrite")
    g.add_edge("rewrite", "retrieve")
    g.add_conditional_edges(
        "retrieve",
        route_after_retrieve,
        {
            "draft": "draft",
            "finalize": "finalize",
        },
    )
    g.add_edge("draft", "finalize")
    return g.compile()
