from datetime import datetime
from typing import Any, Dict, List, TypedDict

from langgraph.graph import StateGraph

from agents.shared import apply_retrieval_skills, draft_answer, retrieve_evidence, rewrite_for_agent
from agents.legal_risk.prompts import REWRITE_PROMPT, ANSWER_PROMPT


class LegalRiskState(TypedDict, total=False):
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
    skill_runtime: Any
    legal_risk_skill_traces: List[Dict[str, Any]]
    legal_risk_sub_queries: List[str]
    legal_risk_evidence: List[Any]
    legal_risk_draft_answer: str


def build_legal_risk_subgraph() -> Any:
    async def rewrite_node(state: LegalRiskState) -> Dict:
        sub_queries = await rewrite_for_agent(
            "legal_risk",
            state["original_query"],
            state.get("chat_history", []),
            state["session_manager"],
            REWRITE_PROMPT,
            max_sub_queries=4,
            run_id=state.get("run_id", ""),
            log_dir=state.get("log_dir", ""),
            rag=state.get("rag"),
            enable_query_decompose=state.get("enable_query_decompose"),
            skill_context=state.get("skill_context"),
        )
        return {"legal_risk_sub_queries": sub_queries}

    async def retrieve_node(state: LegalRiskState) -> Dict:
        rag = state.get("rag")
        subs = state.get("legal_risk_sub_queries", [state["original_query"]])
        evidences = await retrieve_evidence(
            rag,
            subs,
            datetime.now(),
            "legal_risk",
            run_id=state.get("run_id", ""),
            log_dir=state.get("log_dir", ""),
            scope_query=state.get("user_query_raw") or state["original_query"],
            scope_history=state.get("chat_history", []),
        )
        evidences, traces = await apply_retrieval_skills(
            runtime=state.get("skill_runtime"),
            question=state["original_query"],
            agent="legal_risk",
            evidences=evidences,
            request_id=state.get("run_id", ""),
        )
        return {"legal_risk_evidence": evidences, "legal_risk_skill_traces": traces}

    async def draft_node(state: LegalRiskState) -> Dict:
        evidences = state.get("legal_risk_evidence", [])
        draft = await draft_answer(
            "legal_risk",
            state["original_query"],
            state.get("chat_history", []),
            evidences,
            {},
            ANSWER_PROMPT,
            state["session_manager"],
            run_id=state.get("run_id", ""),
            log_dir=state.get("log_dir", ""),
        )
        return {"legal_risk_draft_answer": draft}

    async def finalize_node(state: LegalRiskState) -> Dict:
        evidences = state.get("legal_risk_evidence", [])
        outputs = state.get("agent_outputs", {}).copy()
        outputs["legal_risk"] = {
            "agent": "legal_risk",
            "rewritten_question": state["original_query"],
            "sub_queries": state.get("legal_risk_sub_queries", []),
            "evidence": evidences,
            "tool_results": {},
            "draft_answer": state.get("legal_risk_draft_answer", ""),
            "assumptions": [],
            "risks": [],
            "skill_traces": state.get("legal_risk_skill_traces", []),
        }
        return {"agent_outputs": outputs}

    def route_after_retrieve(state: LegalRiskState) -> str:
        return "finalize" if state.get("debug_stop_after_retrieval", False) else "draft"

    g = StateGraph(LegalRiskState)
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
