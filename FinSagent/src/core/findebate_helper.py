import asyncio
import importlib.util
import logging
from pathlib import Path
from typing import Any, Dict, List, Tuple

from core.moa_helper import (
    _build_shared_evidence,
    _call_llm_text_with_retry,
    _retrieve_shared_context,
    _translate_query,
)

PROJECT_ROOT = Path(__file__).resolve().parents[2]
PROMPTS_DIR = PROJECT_ROOT / "test" / "colm" / "baseline" / "findebate" / "prompts"


def _load_prompt(module_name: str) -> str:
    module_path = PROMPTS_DIR / f"{module_name}.py"
    spec = importlib.util.spec_from_file_location(f"findebate_{module_name}", module_path)
    if spec is None or spec.loader is None:
        raise ImportError(f"Unable to load FinDebate prompt module: {module_path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    prompt = getattr(module, "PROMPT", "")
    if not isinstance(prompt, str):
        raise ValueError(f"FinDebate prompt module missing string PROMPT: {module_path}")
    return prompt


LEADER_PROMPT = _load_prompt("agent_leader")
SKEPTIC_PROMPT = _load_prompt("agent_skeptic")
TRUST_PROMPT = _load_prompt("agent_trust")
EARNINGS_ANALYST_PROMPT = _load_prompt("earnings_analyst")
MARKET_PREDICTOR_PROMPT = _load_prompt("market_predictor")
RISK_ANALYST_PROMPT = _load_prompt("risk_analyst")
SENTIMENT_ANALYST_PROMPT = _load_prompt("sentiment_analyst")
SYNTHESIZER_PROMPT = _load_prompt("synthesizer")
VALUATION_ANALYST_PROMPT = _load_prompt("valuation_analyst")

logger = logging.getLogger(__name__)

AGENT_ORDER = [
    "earnings_analyst",
    "market_predictor",
    "risk_analyst",
    "sentiment_analyst",
    "valuation_analyst",
]

SPECIALIST_PROMPTS = {
    "earnings_analyst": EARNINGS_ANALYST_PROMPT,
    "market_predictor": MARKET_PREDICTOR_PROMPT,
    "risk_analyst": RISK_ANALYST_PROMPT,
    "sentiment_analyst": SENTIMENT_ANALYST_PROMPT,
    "valuation_analyst": VALUATION_ANALYST_PROMPT,
}

SPECIALIST_TITLES = {
    "earnings_analyst": "Earnings Analyst",
    "market_predictor": "Market Predictor",
    "risk_analyst": "Risk Analyst",
    "sentiment_analyst": "Sentiment Analyst",
    "valuation_analyst": "Valuation Analyst",
}


def _build_initial_report_prompt(
    agent: str,
    question: str,
    translated_query: str,
    shared_context: str,
) -> str:
    evidence_text = shared_context or "None"
    role_prompt = SPECIALIST_PROMPTS[agent].strip()
    return (
        f"{role_prompt}\n\n"
        "User Question:\n"
        f"{question}\n\n"
        "English Retrieval Query:\n"
        f"{translated_query}\n\n"
        "Retrieved Evidence:\n"
        f"{evidence_text}\n\n"
        "Task:\n"
        "Write the initial specialist investment analysis report using only the retrieved evidence. "
        "Ground all factual claims in the provided evidence. If evidence is missing, state that clearly."
    )


async def _generate_initial_report(
    agent: str,
    question: str,
    translated_query: str,
    shared_context: str,
    session_manager: Any,
) -> str:
    prompt = _build_initial_report_prompt(
        agent=agent,
        question=question,
        translated_query=translated_query,
        shared_context=shared_context,
    )
    return await _call_llm_text_with_retry(
        session_manager,
        [{"role": "user", "content": prompt}],
        temperature=0,
    )


async def _run_initial_reports(
    question: str,
    translated_query: str,
    shared_context: str,
    session_manager: Any,
) -> Dict[str, str]:
    tasks = [
        _generate_initial_report(
            agent=agent,
            question=question,
            translated_query=translated_query,
            shared_context=shared_context,
            session_manager=session_manager,
        )
        for agent in AGENT_ORDER
    ]
    results = await asyncio.gather(*tasks, return_exceptions=True)
    reports: Dict[str, str] = {}
    for agent, result in zip(AGENT_ORDER, results):
        if isinstance(result, Exception):
            logger.warning(f"FinDebate initial report failed for agent {agent}: {result}", exc_info=True)
            reports[agent] = ""
        else:
            reports[agent] = (result or "").strip()
    return reports


async def _run_debate_stage(
    stage_name: str,
    stage_prompt: str,
    question: str,
    translated_query: str,
    report_text: str,
    shared_context: str,
    session_manager: Any,
    prior_stage_text: str = "",
) -> str:
    pieces = [stage_prompt.strip()]
    pieces.extend(
        [
            "",
            "Original User Question:",
            question,
            "",
            "English Retrieval Query:",
            translated_query,
            "",
            "Current Report:",
            report_text or "None",
        ]
    )
    if prior_stage_text:
        pieces.extend([
            "",
            "Prior Debate Context:",
            prior_stage_text,
        ])
    pieces.extend(
        [
            "",
            "Retrieved Evidence:",
            shared_context or "None",
            "",
            f"Task: Perform the {stage_name} phase for this report. Preserve factual grounding in the retrieved evidence and return only the refined report text.",
        ]
    )
    prompt = "\n".join(pieces)
    return await _call_llm_text_with_retry(
        session_manager,
        [{"role": "user", "content": prompt}],
        temperature=0,
    )


async def _run_specialist_debate(
    agent: str,
    question: str,
    translated_query: str,
    initial_report: str,
    shared_context: str,
    session_manager: Any,
) -> Tuple[Dict[str, str], str]:
    trust_report = await _run_debate_stage(
        stage_name="Trust",
        stage_prompt=TRUST_PROMPT,
        question=question,
        translated_query=translated_query,
        report_text=initial_report,
        shared_context=shared_context,
        session_manager=session_manager,
    )
    skeptic_report = await _run_debate_stage(
        stage_name="Skeptic",
        stage_prompt=SKEPTIC_PROMPT,
        question=question,
        translated_query=translated_query,
        report_text=trust_report or initial_report,
        shared_context=shared_context,
        session_manager=session_manager,
        prior_stage_text=f"Initial report:\n{initial_report or 'None'}",
    )
    leader_input = (
        f"Initial report:\n{initial_report or 'None'}\n\n"
        f"Trust report:\n{trust_report or 'None'}\n\n"
        f"Skeptic report:\n{skeptic_report or 'None'}"
    )
    leader_report = await _run_debate_stage(
        stage_name="Leader",
        stage_prompt=LEADER_PROMPT,
        question=question,
        translated_query=translated_query,
        report_text=leader_input,
        shared_context=shared_context,
        session_manager=session_manager,
    )
    debate_log = {
        "initial": initial_report or "",
        "trust": trust_report or "",
        "skeptic": skeptic_report or "",
        "leader": leader_report or "",
    }
    return debate_log, (leader_report or "").strip()


async def _run_all_specialist_debates(
    question: str,
    translated_query: str,
    initial_reports: Dict[str, str],
    shared_context: str,
    session_manager: Any,
) -> Tuple[Dict[str, Dict[str, str]], Dict[str, str]]:
    tasks = [
        _run_specialist_debate(
            agent=agent,
            question=question,
            translated_query=translated_query,
            initial_report=initial_reports.get(agent, ""),
            shared_context=shared_context,
            session_manager=session_manager,
        )
        for agent in AGENT_ORDER
    ]
    results = await asyncio.gather(*tasks, return_exceptions=True)
    debate_logs: Dict[str, Dict[str, str]] = {}
    leader_reports: Dict[str, str] = {}
    for agent, result in zip(AGENT_ORDER, results):
        if isinstance(result, Exception):
            logger.warning(f"FinDebate debate failed for agent {agent}: {result}", exc_info=True)
            debate_logs[agent] = {
                "initial": initial_reports.get(agent, ""),
                "trust": "",
                "skeptic": "",
                "leader": "",
            }
            leader_reports[agent] = ""
        else:
            debate_log, leader_report = result
            debate_logs[agent] = debate_log
            leader_reports[agent] = leader_report
    return debate_logs, leader_reports


async def _synthesize_final_answer(
    question: str,
    translated_query: str,
    leader_reports: Dict[str, str],
    shared_context: str,
    session_manager: Any,
) -> str:
    specialist_sections = "\n\n".join(
        f"[{SPECIALIST_TITLES[agent]}]\n{(leader_reports.get(agent) or '').strip() or 'No report generated.'}"
        for agent in AGENT_ORDER
    )
    prompt = "\n\n".join(
        [
            SYNTHESIZER_PROMPT.strip(),
            f"User Question:\n{question}",
            f"English Retrieval Query:\n{translated_query}",
            f"Specialist Leader Reports:\n{specialist_sections}",
            f"Retrieved Evidence:\n{shared_context or 'None'}",
            "Task: Synthesize the specialist leader reports into one final institutional investment report. Use only supported claims from the reports and retrieved evidence.",
        ]
    )
    final_answer = await _call_llm_text_with_retry(
        session_manager,
        [{"role": "user", "content": prompt}],
        temperature=0,
    )
    if final_answer:
        return final_answer
    fallback = [text.strip() for text in leader_reports.values() if (text or "").strip()]
    return "\n\n".join(fallback[:2]) if fallback else "抱歉，未能生成答案。"


async def run_findebate_baseline(
    question: str,
    session_manager: Any,
    rag: Any,
) -> Dict[str, Any]:
    translated_query = await _translate_query(question, session_manager)
    retrieval_result = await _retrieve_shared_context(rag, translated_query)
    shared_context = retrieval_result.get("rag_context", "")
    shared_evidence = _build_shared_evidence(translated_query, retrieval_result)

    initial_reports = await _run_initial_reports(
        question=question,
        translated_query=translated_query,
        shared_context=shared_context,
        session_manager=session_manager,
    )
    debate_logs, leader_reports = await _run_all_specialist_debates(
        question=question,
        translated_query=translated_query,
        initial_reports=initial_reports,
        shared_context=shared_context,
        session_manager=session_manager,
    )
    final_answer = await _synthesize_final_answer(
        question=question,
        translated_query=translated_query,
        leader_reports=leader_reports,
        shared_context=shared_context,
        session_manager=session_manager,
    )

    agent_outputs: Dict[str, Dict[str, Any]] = {}
    for agent in AGENT_ORDER:
        agent_outputs[agent] = {
            "agent": agent,
            "rewritten_question": translated_query,
            "sub_queries": [translated_query],
            "evidence": shared_evidence,
            "tool_results": {},
            "initial_report": initial_reports.get(agent, ""),
            "trust_report": debate_logs.get(agent, {}).get("trust", ""),
            "skeptic_report": debate_logs.get(agent, {}).get("skeptic", ""),
            "leader_report": debate_logs.get(agent, {}).get("leader", ""),
            "assumptions": [],
            "risks": [],
        }

    return {
        "answer": final_answer,
        "translated_query": translated_query,
        "activated_agents": AGENT_ORDER.copy(),
        "retrieved_chunks": retrieval_result.get("final_chunks", []),
        "retrieved_chunk_count": len(retrieval_result.get("final_chunks", [])),
        "pre_rerank_candidates": retrieval_result.get("pre_rerank_chunks", []),
        "pre_rerank_candidate_count": len(retrieval_result.get("pre_rerank_chunks", [])),
        "shared_context": shared_context,
        "agent_outputs": agent_outputs,
        "initial_reports": initial_reports,
        "debate_logs": debate_logs,
        "leader_reports": leader_reports,
    }
