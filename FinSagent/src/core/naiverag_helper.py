import asyncio
import importlib.util
import logging
from pathlib import Path
from typing import Any, Dict, List

from agents.shared import detect_language
from utils.chunk_utils import sanitize_chunks_for_output

logger = logging.getLogger(__name__)
PROJECT_ROOT = Path(__file__).resolve().parents[2]
PROMPTS_DIR = PROJECT_ROOT / "test" / "colm" / "baseline" / "naiverag" / "prompts"


def _load_prompt(module_name: str) -> str:
    module_path = PROMPTS_DIR / f"{module_name}.py"
    spec = importlib.util.spec_from_file_location(f"naiverag_{module_name}", module_path)
    if spec is None or spec.loader is None:
        raise ImportError(f"Unable to load NaiveRAG prompt module: {module_path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    prompt = getattr(module, "PROMPT", "")
    if not isinstance(prompt, str):
        raise ValueError(f"NaiveRAG prompt module missing string PROMPT: {module_path}")
    return prompt


DIRECT_ANSWER_PROMPT = _load_prompt("direct_answer")


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


async def _call_final_answer(
    session_manager: Any,
    messages: List[Dict[str, str]],
    temperature: float = 0,
    max_tokens: int = 4096,
) -> str:
    config = getattr(session_manager, "config", {}) or {}
    wait_seconds = float(config.get("naiverag_llm_retry_delay_seconds", 5))
    attempt = 0
    while True:
        attempt += 1
        try:
            response = await session_manager.call_llm_async(
                messages,
                temperature=temperature,
                max_tokens=max_tokens,
            )
            content = _extract_content(response)
            if content:
                return _strip_code_fences(content)
        except Exception as e:
            logger.warning(
                f"[Session {getattr(session_manager, 'session_id', 'unknown')}] "
                f"NaiveRAG final answer call failed on attempt {attempt}, retrying after wait: {e}",
                exc_info=True,
            )
        await asyncio.sleep(wait_seconds)


def _format_context(chunks: List[Dict[str, Any]]) -> str:
    separator = "\n" + "-" * 60 + "\n"
    formatted_chunks: List[str] = []
    for chunk in chunks:
        formatted_chunks.append(
            f"Date Published: {chunk['metadata'].get('date_published', 'N/A')}; "
            f"Chunk Source: {chunk['metadata'].get('doc_id', chunk['metadata'].get('source_file', 'N/A'))}; "
            f"Chunk Content: {chunk['page_content']}"
        )
    return separator.join(formatted_chunks)


def _build_prompt(question: str, rag_context: str) -> str:
    lang = detect_language(question)
    return "\n\n".join(
        [
            DIRECT_ANSWER_PROMPT.strip(),
            f"Answer Language: {lang}",
            f"User Question:\n{question}",
            f"Retrieved Evidence:\n{rag_context or 'None'}",
            "Task: Answer the user question directly using only the retrieved evidence.",
        ]
    )


def prepare_naive_rag_request(
    question: str,
    rag_manager: Any,
    retrieve_top_k: int = 30,
) -> Dict[str, Any]:
    retriever = rag_manager._retrievers[0]
    retrieved_chunks = retriever.retrieve_faiss_only(question, k=retrieve_top_k)
    retrieved_chunks = retrieved_chunks[:retrieve_top_k]
    sanitized_chunks = sanitize_chunks_for_output(retrieved_chunks)
    rag_context = _format_context(sanitized_chunks)
    prompt = _build_prompt(question, rag_context)
    return {
        "prompt": prompt,
        "rag_context": rag_context,
        "retrieved_chunks": sanitized_chunks,
        "pre_rerank_chunks": sanitized_chunks,
        "retrieved_chunk_count": len(sanitized_chunks),
        "pre_rerank_candidate_count": len(sanitized_chunks),
    }


async def run_naive_rag(
    question: str,
    session_manager: Any,
    rag_manager: Any,
    retrieve_top_k: int = 30,
) -> Dict[str, Any]:
    request_payload = prepare_naive_rag_request(
        question=question,
        rag_manager=rag_manager,
        retrieve_top_k=retrieve_top_k,
    )
    answer = await _call_final_answer(
        session_manager,
        [{"role": "user", "content": request_payload["prompt"]}],
        temperature=0,
        max_tokens=4096,
    )
    return {
        "answer": answer,
        "translated_query": "",
        "activated_agents": [],
        "rag_context": request_payload["rag_context"],
        "retrieved_chunks": request_payload["retrieved_chunks"],
        "pre_rerank_chunks": request_payload["pre_rerank_chunks"],
        "retrieved_chunk_count": request_payload["retrieved_chunk_count"],
        "pre_rerank_candidate_count": request_payload["pre_rerank_candidate_count"],
    }
