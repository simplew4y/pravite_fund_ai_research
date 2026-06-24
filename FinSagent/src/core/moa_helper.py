import asyncio
import logging
import time
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List

from agents.company_researcher.prompts import ANSWER_PROMPT as COMPANY_ANSWER_PROMPT
from agents.legal_risk.prompts import ANSWER_PROMPT as LEGAL_ANSWER_PROMPT
from agents.market_researcher.prompts import ANSWER_PROMPT as MARKET_ANSWER_PROMPT
from agents.shared import detect_language
from agents.quant.prompts import ANSWER_PROMPT as QUANT_ANSWER_PROMPT
from utils.chunk_utils import get_chunk_source_id

logger = logging.getLogger(__name__)

AGENT_ORDER = [
    "market_researcher",
    "company_researcher",
    "quant",
    "legal_risk",
]

AGENT_PROMPTS = {
    "market_researcher": MARKET_ANSWER_PROMPT,
    "company_researcher": COMPANY_ANSWER_PROMPT,
    "quant": QUANT_ANSWER_PROMPT,
    "legal_risk": LEGAL_ANSWER_PROMPT,
}

SYNTHESIS_PROMPT = (
    Path(__file__).resolve().parent.parent / "agents" / "system_prompts" / "synthesis_prompt.txt"
).read_text(encoding="utf-8")


def _extract_content(response: Any) -> str:
    try:
        return (response.choices[0].message.content or "").strip()
    except Exception:
        return ""


def _strip_code_fences(text: str) -> str:
    cleaned = (text or "").strip()
    if cleaned.startswith("```"):
        cleaned = cleaned.strip("` \n")
        if "\n" in cleaned:
            cleaned = cleaned.split("\n", 1)[1]
    return cleaned.strip()


def _extract_usage(response: Any) -> Dict[str, int]:
    usage = getattr(response, "usage", None)
    if usage is None:
        return {
            "prompt_tokens": 0,
            "completion_tokens": 0,
            "total_tokens": 0,
        }
    if isinstance(usage, dict):
        return {
            "prompt_tokens": int(usage.get("prompt_tokens") or 0),
            "completion_tokens": int(usage.get("completion_tokens") or 0),
            "total_tokens": int(usage.get("total_tokens") or 0),
        }
    return {
        "prompt_tokens": int(getattr(usage, "prompt_tokens", 0) or 0),
        "completion_tokens": int(getattr(usage, "completion_tokens", 0) or 0),
        "total_tokens": int(getattr(usage, "total_tokens", 0) or 0),
    }


def _record_metrics(metrics: Dict[str, Any], usage: Dict[str, int], latency_seconds: float) -> None:
    token_usage = metrics.setdefault(
        "token_usage",
        {
            "prompt_tokens": 0,
            "completion_tokens": 0,
            "total_tokens": 0,
        },
    )
    token_usage["prompt_tokens"] += int(usage.get("prompt_tokens") or 0)
    token_usage["completion_tokens"] += int(usage.get("completion_tokens") or 0)
    token_usage["total_tokens"] += int(usage.get("total_tokens") or 0)
    metrics["llm_call_count"] = int(metrics.get("llm_call_count") or 0) + 1
    metrics["llm_latency_seconds"] = round(float(metrics.get("llm_latency_seconds") or 0.0) + latency_seconds, 3)


async def _call_llm_text_with_retry(
    session_manager: Any,
    messages: List[Dict[str, str]],
    temperature: float = 0,
    max_tokens: int = 4096,
    metrics: Dict[str, Any] | None = None,
    **kwargs,
) -> str:
    config = getattr(session_manager, "config", {}) or {}
    wait_seconds = float(config.get("moa_llm_retry_delay_seconds", 5))
    attempt = 0
    while True:
        attempt += 1
        try:
            started_at = time.perf_counter()
            response = await session_manager.call_llm_async(
                messages,
                temperature=temperature,
                max_tokens=max_tokens,
                **kwargs,
            )
            latency_seconds = time.perf_counter() - started_at
            if metrics is not None:
                _record_metrics(metrics, _extract_usage(response), latency_seconds)
            content = _extract_content(response)
            if content:
                return _strip_code_fences(content)
        except Exception as e:
            logger.warning(
                f"[Session {getattr(session_manager, 'session_id', 'unknown')}] "
                f"MoA LLM call failed on attempt {attempt}, retrying after wait: {e}",
                exc_info=True,
            )
        await asyncio.sleep(wait_seconds)


async def _translate_query(question: str, session_manager: Any, metrics: Dict[str, Any] | None = None) -> str:
    if detect_language(question) == "English":
        return question.strip()
    prompt = (
        "Translate the user question into concise English for financial retrieval. "
        "Return only the translated English question.\n\n"
        f"User question: {question}"
    )
    translated = await _call_llm_text_with_retry(
        session_manager,
        [{"role": "user", "content": prompt}],
        temperature=0,
        max_tokens=512,
        metrics=metrics,
    )
    return translated or question.strip()


async def _retrieve_shared_context(rag: Any, translated_query: str) -> Dict[str, Any]:
    loop = asyncio.get_running_loop()

    def _run() -> Dict[str, Any]:
        try:
            result = rag.retrieve(translated_query, datetime.now())
            if isinstance(result, dict):
                return {
                    "rag_context": result.get("rag_context", ""),
                    "final_chunks": result.get("final_chunks", []),
                    "time_info": result.get("time_info", []),
                    "pre_rerank_chunks": result.get("pre_rerank_chunks", []),
                }
            context, chunks, time_info = result
            return {
                "rag_context": context,
                "final_chunks": chunks,
                "time_info": time_info,
                "pre_rerank_chunks": chunks,
            }
        except Exception as e:
            logger.warning(f"MoA retrieval failed for query '{translated_query}': {e}", exc_info=True)
            return {
                "rag_context": "",
                "final_chunks": [],
                "time_info": [],
                "pre_rerank_chunks": [],
            }

    return await loop.run_in_executor(None, _run)


def _build_shared_evidence(translated_query: str, retrieval_result: Dict[str, Any]) -> List[Dict[str, Any]]:
    final_chunks = retrieval_result.get("final_chunks", [])
    pre_rerank_chunks = retrieval_result.get("pre_rerank_chunks", [])
    return [
        {
            "agent": "moa_shared",
            "query": translated_query,
            "context": retrieval_result.get("rag_context", ""),
            "chunks": final_chunks,
            "source_ids": [get_chunk_source_id(chunk) for chunk in final_chunks],
            "time_info": retrieval_result.get("time_info", []),
            "pre_rerank_chunks": pre_rerank_chunks,
            "pre_rerank_source_ids": [get_chunk_source_id(chunk) for chunk in pre_rerank_chunks],
        }
    ]


def _build_question_block(question: str, translated_query: str, round_idx: int) -> str:
    if round_idx == 1:
        return (
            f"Original user question: {question}\n"
            f"English retrieval query: {translated_query}\n"
            "MoA round 1 task: produce your initial specialist answer using only the shared retrieved evidence. "
            "Do not perform additional retrieval."
        )
    return (
        f"Original user question: {question}\n"
        f"English retrieval query: {translated_query}\n"
        "MoA round 2 task: refine your answer using the shared retrieved evidence and the first-round answers from all agents. "
        "Correct mistakes, incorporate useful details from other agents when supported, and stay within your specialist scope. "
        "Do not perform additional retrieval."
    )


def _build_peer_answers_text(agent_answers: Dict[str, str]) -> str:
    parts = []
    for agent in AGENT_ORDER:
        answer = (agent_answers.get(agent) or "").strip() or "No answer generated."
        parts.append(f"[{agent}]\n{answer}")
    return "\n\n".join(parts)


async def _generate_agent_answer(
    agent: str,
    question: str,
    translated_query: str,
    shared_context: str,
    session_manager: Any,
    round_idx: int,
    peer_answers_text: str = "",
    metrics: Dict[str, Any] | None = None,
) -> str:
    history_text = ""
    if peer_answers_text:
        history_text = f"MoA first-round answers:\n{peer_answers_text}"
    prompt = AGENT_PROMPTS[agent].format(
        question=_build_question_block(question, translated_query, round_idx),
        history=history_text or "None",
        evidence=shared_context or "None",
        tools="None",
    )
    return await _call_llm_text_with_retry(
        session_manager,
        [{"role": "user", "content": prompt}],
        temperature=0,
        metrics=metrics,
    )


async def _run_round(
    question: str,
    translated_query: str,
    shared_context: str,
    session_manager: Any,
    round_idx: int,
    peer_answers_text: str = "",
    metrics: Dict[str, Any] | None = None,
) -> Dict[str, str]:
    tasks = [
        _generate_agent_answer(
            agent=agent,
            question=question,
            translated_query=translated_query,
            shared_context=shared_context,
            session_manager=session_manager,
            round_idx=round_idx,
            peer_answers_text=peer_answers_text,
            metrics=metrics,
        )
        for agent in AGENT_ORDER
    ]
    results = await asyncio.gather(*tasks, return_exceptions=True)
    answers: Dict[str, str] = {}
    for agent, result in zip(AGENT_ORDER, results):
        if isinstance(result, Exception):
            logger.warning(f"MoA round {round_idx} failed for agent {agent}: {result}", exc_info=True)
            answers[agent] = ""
        else:
            answers[agent] = (result or "").strip()
    return answers


async def _synthesize_final_answer(
    question: str,
    round2_answers: Dict[str, str],
    session_manager: Any,
    metrics: Dict[str, Any] | None = None,
) -> str:
    sub_answers = "\n\n".join(
        f"[{agent}] Draft:\n{(round2_answers.get(agent) or '').strip() or 'No answer generated.'}"
        for agent in AGENT_ORDER
    )
    lang = detect_language(question)
    prompt = SYNTHESIS_PROMPT.format(question=question, sub_answers=sub_answers, lang=lang)
    final_answer = await _call_llm_text_with_retry(
        session_manager,
        [{"role": "user", "content": prompt}],
        temperature=0,
        metrics=metrics,
    )
    if final_answer:
        return final_answer
    fallback = [text.strip() for text in round2_answers.values() if (text or "").strip()]
    return "\n\n".join(fallback[:2]) if fallback else "抱歉，未能生成答案。"


async def run_moa_baseline(
    question: str,
    session_manager: Any,
    rag: Any,
) -> Dict[str, Any]:
    started_at = time.perf_counter()
    metrics: Dict[str, Any] = {
        "token_usage": {
            "prompt_tokens": 0,
            "completion_tokens": 0,
            "total_tokens": 0,
        },
        "llm_call_count": 0,
        "llm_latency_seconds": 0.0,
    }
    translated_query = await _translate_query(question, session_manager, metrics=metrics)
    retrieval_result = await _retrieve_shared_context(rag, translated_query)
    shared_context = retrieval_result.get("rag_context", "")
    shared_evidence = _build_shared_evidence(translated_query, retrieval_result)
    round1_answers = await _run_round(
        question=question,
        translated_query=translated_query,
        shared_context=shared_context,
        session_manager=session_manager,
        round_idx=1,
        metrics=metrics,
    )
    peer_answers_text = _build_peer_answers_text(round1_answers)
    round2_answers = await _run_round(
        question=question,
        translated_query=translated_query,
        shared_context=shared_context,
        session_manager=session_manager,
        round_idx=2,
        peer_answers_text=peer_answers_text,
        metrics=metrics,
    )
    final_answer = await _synthesize_final_answer(question, round2_answers, session_manager, metrics=metrics)
    moa_latency_seconds = round(time.perf_counter() - started_at, 3)
    agent_outputs: Dict[str, Dict[str, Any]] = {}
    for agent in AGENT_ORDER:
        agent_outputs[agent] = {
            "agent": agent,
            "rewritten_question": translated_query,
            "sub_queries": [translated_query],
            "evidence": shared_evidence,
            "tool_results": {},
            "first_round_answer": round1_answers.get(agent, ""),
            "draft_answer": round2_answers.get(agent, ""),
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
        "round1_answers": round1_answers,
        "round2_answers": round2_answers,
        "token_usage": metrics.get("token_usage", {}),
        "llm_call_count": metrics.get("llm_call_count", 0),
        "llm_latency_seconds": metrics.get("llm_latency_seconds", 0.0),
        "moa_latency_seconds": moa_latency_seconds,
    }
