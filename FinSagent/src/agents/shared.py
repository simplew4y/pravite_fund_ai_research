"""
Shared helpers for agent subgraphs.

The helpers stay lightweight so each specialist workflow can customize prompts
and sequencing while reusing common plumbing (rewrite, retrieval, tools, draft).
"""

import asyncio
import inspect
import json
import logging
import os
from pathlib import Path
from datetime import datetime
from typing import Any, Dict, List, Optional

from utils.chunk_utils import dedupe_chunks, get_chunk_source_id
from utils.prompt_budget import join_with_budget, truncate_text
from skills_runtime.integration import apply_retrieval_skills
from retrieval_control import decide_retrieval_policy, fuse_evidence
from tools.finnhub import (
    basic_financials,
    company_news,
    company_profile,
    get_ipo_info,
    get_stock_price,
)
from tools.yfinance import price_history, stock_snapshot
from tools.sec import sec_company_concept
from utils.tool_result_filter import filter_tool_results

logger = logging.getLogger(__name__)

TOOL_REGISTRY = {
    "get_stock_price": get_stock_price,
    "get_ipo_info": get_ipo_info,
    "company_profile": company_profile,
    "company_news": company_news,
    "basic_financials": basic_financials,
    "stock_snapshot": stock_snapshot,
    "price_history": price_history,
    "sec_company_concept": sec_company_concept,
}


def _load_agent_tool_allowlists() -> Dict[str, List[str]]:
    base = Path(__file__).resolve().parent
    allowlists: Dict[str, List[str]] = {}
    for desc_path in base.glob("*/description.json"):
        try:
            payload = json.loads(desc_path.read_text(encoding="utf-8"))
            allowlists[payload["name"]] = payload.get("tools_allowed", [])
        except Exception as e:
            logger.warning(f"Failed to load tool allowlist from {desc_path}: {e}")
    return allowlists


AGENT_TOOL_ALLOWLISTS = _load_agent_tool_allowlists()


def _load_ticker_symbols() -> Dict[str, Any]:
    ticker_path = Path(__file__).resolve().parents[1] / "tools" / "company_registry.json"
    try:
        return json.loads(ticker_path.read_text(encoding="utf-8"))
    except Exception as e:
        logger.warning(f"Failed to load company registry from {ticker_path}: {e}")
        return {"companies": []}


TICKER_SYMBOLS = _load_ticker_symbols()

TOOL_PLAN_PROMPT = """You are helping a specialist agent decide which external tools to call.
Current time: {nowtime}
Active agent: {agent}
Allowed tools:
{allowed_tools}

Known ticker symbol catalog:
{ticker_symbols}

Return JSON with exactly these keys:
{{
  "reason": "short explanation",
  "tool_calls": [
    {{"name": "tool_name", "arguments": {{"arg_name": "arg_value"}}}}
  ]
}}

Rules:
- Call a tool only if it will add concrete factual data missing from the user question.
- Prefer the smallest number of tools needed.
- Do not call tools for facts that should come from the internal document evidence when the tool is not clearly necessary.
- If no tool is needed, return "tool_calls": [].
- For company/tool inputs that accept a symbol, ticker, or cik, always look up the value from the known ticker symbol catalog when the user mention clearly refers to a catalog company, even if the query uses another language, abbreviation, or common name. Do not guess or invent symbol or CIK values.
- When a catalog company matches, output the exact catalog symbol or cik in the tool arguments, e.g. use "NVDA" and cik "0001045810" for NVIDIA.
- If no catalog company clearly matches and the user did not provide a clear ticker symbol, do not plan tools that require a symbol/ticker.
- If tool-relevant sub-questions are provided, infer the company subject separately for each sub-question.
- If multiple companies are mentioned, issue separate tool calls for each company instead of passing a combined phrase like "Apple and Zeekr".
- For symbol/ticker arguments, pass only the specific ticker symbol for that tool call; do not pass the entire user question.
- If the question involves recent developments, partnerships, board changes, management updates, privatization, product launches, or strategic announcements, always include company_news in tool_calls even if skip_retrieval is true.
- If the question involves partnerships, relationships, privatization, strategy, outlook, recent developments, board changes, management updates, or product launches, set skip_retrieval to false to ensure document retrieval as a fallback, and include company_news in tool_calls.
- For recent-news requests, if the user did not specify a date range, do not provide from_date/to_date. Let the tool use its default recent window.
- Be conservative. If unsure, return no tool calls.

Few-shot examples:
User: 英伟达最近的新闻？
Agent: market_researcher
Output: {{"reason": "Recent company news is directly available from company_news.", "tool_calls": [{{"name": "company_news", "arguments": {{"symbol": "NVDA"}}}}]}}

User: 公司最近有没有高管调整？
Agent: company_researcher
Output: {{"reason": "The company is underspecified, so no reliable company_news call can be planned.", "tool_calls": []}}

User: NVDA 当前股价、市值和近一个月走势
Agent: quant
Output: {{"reason": "Current market snapshot and recent price history are directly available from tools.", "tool_calls": [{{"name": "stock_snapshot", "arguments": {{"symbol": "NVDA"}}}}, {{"name": "price_history", "arguments": {{"symbol": "NVDA", "period": "1mo"}}}}]}}

User: 英伟达在 10-K 里披露了哪些治理风险？
Agent: company_researcher
Output: {{"reason": "This requires disclosure-level document evidence, not additional tools.", "tool_calls": []}}

User: 英伟达最近新闻，以及 10-K 中披露的股权结构
Agent: company_researcher
Output: {{"reason": "Recent news benefits from company_news, while the ownership-structure part should be handled by retrieval.", "tool_calls": [{{"name": "company_news", "arguments": {{"symbol": "NVDA"}}}}]}}

User: 英伟达 2024 年净利润是多少？
Agent: quant
Output: {{"reason": "Net income is directly available from SEC XBRL company concept.", "tool_calls": [{{"name": "sec_company_concept", "arguments": {{"cik": "0001045810", "concept": "NetIncomeLoss"}}}}]}}

User: 英伟达的资产负债情况？
Agent: quant
Output: {{"reason": "Assets and liabilities are directly available from SEC XBRL.", "tool_calls": [{{"name": "sec_company_concept", "arguments": {{"cik": "0001045810", "concept": "Assets"}}}}, {{"name": "sec_company_concept", "arguments": {{"cik": "0001045810", "concept": "Liabilities"}}}}]}}
"""

ANSWER_EVIDENCE_GUARDRAILS = """

Industrial evidence guardrails:
- Treat Evidence and Tools as the only factual sources. Do not use prior knowledge to fill gaps.
- Evidence may contain STRUCTURED DCI FACTS, KEYWORD EVIDENCE, and RAG EVIDENCE. Use them together; do not ignore a channel merely because another retriever also returned results.
- A DCI fact marked tier=candidate is retained for completeness but is not authoritative. It must not override stronger dated table or narrative evidence.
- A DCI fact marked tier=answer_grade may support a direct fact answer, but its company, period, unit, and actual/estimate status must still match the question.
- If the retrieval policy says rag_required=true, the response must use the RAG evidence for analysis and use DCI only as quantitative support.
- Preserve evidence IDs for important numeric reasoning. Never attribute a claim to an evidence ID that does not support the same company, metric, period, and actual/estimate status.
- Every date, number, percentage, entity relationship, product list item, and governance claim must be directly supported by Evidence or Tools.
- If sources conflict, report the conflict instead of choosing silently. Prefer explicitly dated, more recent evidence only when it directly answers the same metric/entity.
- For numeric or table questions, preserve units and periods exactly. Show a formula only when all inputs are present; otherwise say the calculation is not supported by provided data.
- For HTML-like tables, read the header columns and row labels literally. Do not substitute annual values for quarterly values, adjacent quarters for the asked quarter, or vehicle margin for gross margin unless the question asks for that metric.
- If table evidence contains an exact line item for the asked period, prefer that line item over narrative summaries or tool results.
- If retrieval notes provide "Detected Table Facts", treat them as extracted row/column facts from the evidence and use them before generic caveats.
- For actual-vs-pro-forma capitalization questions, compare the Actual RMB and Pro Forma RMB columns in the capitalization table; do not answer "not disclosed" if those rows are present.
- For table-derived percentages, if the user did not request decimal precision, state the rounded headline percentage first and optionally include the computed decimal in parentheses.
- For direct numeric questions, answer the requested metric first. Extra context is allowed only when it is same-period, same-scope, and directly explains the metric.
- For delivery/sales-volume questions without explicit growth intent, never mention YoY/growth percentages; strip growth wording from quoted evidence and answer only the volume/scope/period.
- For each-quarter delivery questions, if all three monthly values are present for a quarter, sum them and state the quarterly total; do not say the quarterly total is unavailable.
- For Chinese gross-margin questions ("毛利率") without decimal precision, answer with the nearest whole percentage first; put any computed one-decimal value only as supporting detail.
- For annual revenue-stream questions, include same-period YoY growth percentages and disclosed growth drivers when the evidence provides them.
- If exact row/column facts are present, do not add unsupported caveats about missing or inconsistent data.
- Do not invent an "as of" date. If the evidence has no date or is stale relative to the question, state the evidence date/cutoff and limit the answer accordingly.
- If the answer is incomplete, answer the supported part and list only the missing blocker.
Configured data cutoff: {data_latest_time}
"""
# ---------------------------------------------------------------------------
# Retrieval time tracking (module-level accumulator)
# ---------------------------------------------------------------------------
_retrieval_time_acc: float = 0.0


def reset_retrieval_timer() -> None:
    """Reset the accumulated retrieval time to zero."""
    global _retrieval_time_acc
    _retrieval_time_acc = 0.0


def get_retrieval_time() -> float:
    """Return the accumulated retrieval time (seconds) since last reset."""
    return _retrieval_time_acc


def detect_language(text: str) -> str:
    return "中文" if any("\u4e00" <= ch <= "\u9fff" for ch in text) else "English"


def _get_allowed_tools_schema(agent: str, session_manager: Any) -> List[Dict[str, Any]]:
    allowed_names = AGENT_TOOL_ALLOWLISTS.get(agent, [])
    if not allowed_names:
        return []
    return [
        tool for tool in session_manager.tools_schema
        if tool.get("function", {}).get("name") in allowed_names
    ]


def _format_allowed_tools(tools_schema: List[Dict[str, Any]]) -> str:
    lines: List[str] = []
    for tool in tools_schema:
        fn = tool.get("function", {})
        name = fn.get("name", "unknown_tool")
        desc = fn.get("description", "").strip()
        params = fn.get("parameters", {})
        params_text = json.dumps(params, ensure_ascii=False)
        if desc:
            lines.append(f"- {name}: {desc}; parameters: {params_text}")
        else:
            lines.append(f"- {name}; parameters: {params_text}")
    return "\n".join(lines) if lines else "None"


def _json_for_log(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, default=str)


def get_run_logger(run_id: str, log_dir: str, name: str) -> logging.Logger:
    """
    Return a logger bound to a specific run_id and component name.
    Each logger writes to its own file under log_dir to avoid contention.
    """
    logger_name = f"mas.{run_id}.{name}"
    lg = logging.getLogger(logger_name)
    lg.setLevel(logging.INFO)
    if not any(isinstance(h, logging.FileHandler) and h.baseFilename.endswith(f"{name}.log") for h in lg.handlers):
        Path(log_dir).mkdir(parents=True, exist_ok=True)
        fh = logging.FileHandler(Path(log_dir) / f"{name}.log", encoding="utf-8")
        fh.setLevel(logging.INFO)
        fmt = logging.Formatter("%(asctime)s [%(levelname)s] %(message)s")
        fh.setFormatter(fmt)
        lg.addHandler(fh)
    return lg


def _retrieve_title_summaries(rag: Any, question: str, top_k: int = 10) -> List[str]:
    """
    Use the title-summary FAISS index to fetch the most relevant document
    title summaries for *question*.  Returns an empty list when the RAG
    instance is unavailable or has no title-summary retriever.
    """
    try:
        retriever = rag.rag_manager._retrievers[0]
        ts_retriever = getattr(retriever, "title_summary_faiss_retriever", None)
        ts_docs = getattr(retriever, "title_summaries", None)
        if ts_retriever is None or ts_docs is None:
            return []
        indices, scores = ts_retriever.invoke([question], top_k)
        indices, scores = indices[0], scores[0]
        summaries = []
        for idx, score in zip(indices, scores):
            if 0 <= idx < len(ts_docs):
                summaries.append(ts_docs[idx])
        return summaries
    except Exception as e:
        logger.warning(f"[title_summary] retrieval failed: {e}")
        return []


async def _retrieve_title_summaries_async(rag: Any, question: str, top_k: int = 10) -> List[str]:
    """
    Async version of _retrieve_title_summaries that runs the lock+retrieval in a thread pool
    to avoid blocking the event loop when using multiple workers.
    """
    try:
        retriever = rag.rag_manager._retrievers[0]
        ts_retriever = getattr(retriever, "title_summary_faiss_retriever", None)
        ts_docs = getattr(retriever, "title_summaries", None)
        if ts_retriever is None or ts_docs is None:
            return []

        def _sync_retrieve():
            return ts_retriever.invoke([question], top_k)

        indices, scores = await asyncio.to_thread(_sync_retrieve)
        indices, scores = indices[0], scores[0]
        summaries = []
        for idx, score in zip(indices, scores):
            if 0 <= idx < len(ts_docs):
                summaries.append(ts_docs[idx])
        return summaries
    except Exception as e:
        logger.warning(f"[title_summary] retrieval failed: {e}")
        return []


async def rewrite_for_agent(
    agent: str,
    question: str,
    chat_history: List[Dict[str, str]],
    session_manager: Any,
    prompt_template: str,
    max_sub_queries: int = 10,
    run_id: str = "",
    log_dir: str = "",
    rag: Any = None,
    title_summary_top_k: int = 30,
    enable_query_decompose: bool | None = None,
    skill_context: Any = None,
) -> List[str]:
    """
    Agent-specific rewrite/decompose.
    prompt_template should contain {question}, {history}, and {title_summaries}.
    Expect LLM to return JSON array; fallback to [question] on errors.
    """
    history_snippet = "\n".join([f"{m['role']}: {m['content']}" for m in chat_history[-6:]])
    title_summaries_text = "None"
    lg = get_run_logger(run_id, log_dir, agent) if run_id and log_dir else logger
    cfg = getattr(session_manager, "config", None) or getattr(session_manager, "_config", None) or {}
    configured_cap = cfg.get("agent_max_sub_queries")
    if configured_cap not in (None, "", "null", "none", "None"):
        try:
            max_sub_queries = max(1, min(max_sub_queries, int(configured_cap)))
        except (TypeError, ValueError):
            lg.warning("Ignoring invalid agent_max_sub_queries=%r", configured_cap)
    # preserve_entities_instruction = (
    #     "\nIMPORTANT ENTITY PRESERVATION RULES:\n"
    #     "- If the user question contains a ticker symbol, keep that exact ticker symbol and company name in every rewritten sub-query.\n"
    #     "- If the user question contains a company name, keep that exact company name in every rewritten sub-query whenever it is relevant.\n"
    #     "- Do not replace the ticker or company name with pronouns, generic descriptions, or a different company.\n"
    #     "- Do not broaden the query in a way that drops the original company or ticker anchor.\n"
    # )
    enable_ts = enable_query_decompose
    if enable_ts is None:
        enable_ts = os.environ.get("ENABLE_TITLE_SUMMARIES", "1") == "1"
    if enable_ts and rag is not None:
        summaries = await _retrieve_title_summaries_async(rag, question, top_k=title_summary_top_k)
        if summaries:
            title_summaries_text = "\n".join(f"- {s}" for s in summaries)
    prompt = prompt_template.format(question=question, history=history_snippet, title_summaries=title_summaries_text)
    if skill_context is not None and getattr(skill_context, "prompt_instructions", None):
        skill_text = "\n\n".join(
            f"[{item.get('skill_id', '')}]\n{item.get('instruction', '')}"
            for item in skill_context.prompt_instructions
        )
        prompt = f"{prompt.rstrip()}\n\nACTIVE SKILL INSTRUCTIONS:\n{skill_text}"
    prompt = f"""{prompt.rstrip()}

MANDATORY LOSSLESS REWRITE RULES:
- Every rewritten sub-query must retain the original company/entity/ticker, time period, metric scope, business segment, exclusions, adjustments and qualifiers that apply to it.
- Never simplify a qualified metric into its generic parent. For example, keep the full phrase “剔除阶段性影响因素后的实际毛利率”; do not rewrite it as only “毛利率”.
- Do not introduce a company, document or metric absent from the original question.
- Include the original question verbatim as the first sub-query.
"""
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
        if isinstance(parsed, dict):
            parsed = parsed.get("sub_queries", []) or parsed.get("queries", [])
        if isinstance(parsed, list) and parsed:
            subqs = [str(q).strip() for q in parsed if isinstance(q, str) and str(q).strip()]
            if question not in subqs:
                subqs = [question, *subqs]
            subqs = subqs[:max_sub_queries]
            lg.info(f"[rewrite] sub_queries={subqs} title_summaries_used={title_summaries_text != 'None'}")
            return subqs
    except Exception as e:
        lg.warning(f"[{agent}] rewrite fallback: {e}")
    return [question]


def _cascade_to_evidence(
    query: str, cascade_result: dict, agent: str,
) -> tuple:
    """Convert a legacy CascadeRetriever result into the internal result tuple."""
    chunks = cascade_result.get("chunks", [])
    route = cascade_result.get("type", "dci_unknown")
    ctx_types = [c.get("metadata", {}).get("content_type", "") for c in chunks[:3]]
    logger.info(
        "[retrieve_route] route=%s query=%s agent=%s chunks=%d types=%s",
        route, query, agent, len(chunks), ctx_types,
    )
    context_lines = []
    for c in chunks:
        src = c.get("metadata", {}).get("source_ref", "")
        ct = c.get("metadata", {}).get("content_type", "")
        label = f"[{ct}] {src}" if src else f"[{ct}]"
        context_lines.append(f"{label}: {c.get('page_content', '')}")
    context = "\n".join(context_lines)
    return (
        query, context, chunks, [], chunks, True,
        {
            "policy": {
                "mode": "legacy_cascade",
                "query_type": "unknown",
                "run_rag": False,
                "rag_required": False,
                "reason_codes": ["LEGACY_DCI_SHORT_CIRCUIT"],
            },
            "conflicts": [],
            "retrieval_trace": [],
            "rag_executed": False,
            "rag_succeeded": False,
        },
    )


async def retrieve_evidence(
    rag: Any, sub_queries: List[str], query_time: datetime, agent: str,
    run_id: str = "", log_dir: str = "",
    collection_db: str = "",
    scope_query: str = "",
    scope_history: Optional[List[Dict[str, str]]] = None,
) -> List[Dict[str, Any]]:
    """
    Run retrieval concurrently and produce Evidence-like dicts.

    ``scope_query`` must be the original, entity-bearing user question.  Its
    resolved document boundary is inherited by every rewritten sub-query so a
    lossy rewrite cannot silently widen retrieval to another company.

    When *collection_db* points at a valid collection.sqlite3 the function
    applies a **cascade** — DCI metric / keyword grep → RAG — so simple
    numeric queries skip the expensive embedding round‑trip.

    If *collection_db* is not passed, it is auto-derived from the rag
    config's ``datasets.root_dir`` + ``datasets.active_dataset``:
      ``{root_dir}/{active_dataset}/meta/collection.sqlite3``
    """
    loop = asyncio.get_event_loop()
    lg = get_run_logger(run_id, log_dir, agent) if run_id and log_dir else logger

    if not getattr(rag, "retrieve", None):
        raise ValueError("RAG instance missing in state; retrieval cannot proceed.")

    # ── Auto-derive collection_db from rag config ──────────────────
    if not collection_db:
        lg.info("[cascade] auto-derive: rag type=%s has_config=%s",
                type(rag).__name__, hasattr(rag, "config"))
        datasets_cfg = getattr(getattr(rag, "rag_manager", None), "_config", {}).get("datasets", {})
        root_dir = datasets_cfg.get("root_dir", "")
        active = datasets_cfg.get("active_dataset", "")
        lg.info("[cascade] auto-derive: root_dir=%s active=%s", root_dir, active)
        if root_dir and active:
            candidate = os.path.join(root_dir, active, "meta", "collection.sqlite3")
            lg.info("[cascade] auto-derive: candidate=%s exists=%s",
                    candidate, os.path.exists(candidate))
            if os.path.exists(candidate):
                collection_db = candidate

    lg.info("[retrieve_evidence] agent=%s db=%s", agent, collection_db or "(none)")

    # Cascade helper — only created when a valid db is available
    from utils.cascade_retriever import CascadeRetriever, should_skip_rag
    _c: Optional["CascadeRetriever"] = None
    rag_config = getattr(getattr(rag, "rag_manager", None), "_config", {}) or {}
    if collection_db and os.path.exists(collection_db):
        _c = CascadeRetriever(
            collection_db,
            company_aliases=rag_config.get("retrieval_company_aliases", {}),
        )

    datasets_cfg = rag_config.get("datasets", {}) or {}
    active_dataset = str(datasets_cfg.get("active_dataset") or "")
    scope_required = bool(rag_config.get("retrieval_scope_required", False))
    scope = None
    if _c is not None:
        effective_scope_query = scope_query or (sub_queries[0] if sub_queries else "")
        prior_user_queries = [
            str(message.get("content") or "")
            for message in (scope_history or [])
            if str(message.get("role") or "").lower() == "user"
        ]
        scope = _c.resolve_scope_with_history(
            effective_scope_query,
            prior_user_queries,
            dataset_id=active_dataset,
        )
        lg.info(
            "[retrieval_scope] dataset=%s explicit_company=%s source_query=%r source_doc_ids=%s",
            scope.dataset_id,
            scope.explicit_company,
            scope.source_query,
            list(scope.source_doc_ids),
        )

    if scope_required and scope is None:
        lg.error(
            "[retrieval_scope] required scope unavailable; refusing unscoped retrieval "
            "dataset=%s db=%s",
            active_dataset,
            collection_db or "(none)",
        )
        return []

    if scope_required and scope is not None and not scope.source_doc_ids:
        lg.error(
            "[retrieval_scope] dataset=%s resolved no documents; refusing retrieval",
            active_dataset,
        )
        return []

    def _run(query: str):
        nonlocal _c, scope

        # Read retrieval mode from config
        _mode = getattr(getattr(rag, "rag_manager", None), "_config", {}).get(
            "retrieval_mode", "dci_rag_cascade"
        )

        # ── DCI retrieval ────────────────────────────────────────────
        r1 = None
        r2 = None
        if _c is not None:
            allowed_doc_ids = list(scope.source_doc_ids) if scope is not None else []
            scope_explicit = bool(scope and scope.explicit_company)
            r1 = _c.search_metric(
                query,
                allowed_doc_ids=allowed_doc_ids,
                scope_explicit=scope_explicit,
                confidence_query=scope_query or query,
            )
            r2 = _c.search_keyword(
                query,
                allowed_doc_ids=allowed_doc_ids,
                scope_explicit=scope_explicit,
            )

        # ── Evidence fusion: DCI is always retained ─────────────────
        if _mode in {"evidence_fusion", "dci_only"}:
            policy = decide_retrieval_policy(
                original_question=scope_query or query,
                agent=agent,
                metric_result=r1,
                keyword_result=r2,
                mode=_mode,
            )
            rag_result = None
            rag_succeeded = False
            if policy.run_rag:
                allowed_doc_ids = list(scope.source_doc_ids) if scope is not None else None
                try:
                    rag_result = rag.retrieve(
                        query,
                        query_time,
                        agent=agent,
                        allowed_source_doc_ids=allowed_doc_ids,
                    )
                    rag_succeeded = True
                except Exception as e:
                    # A failed semantic fallback must not erase structured DCI evidence.
                    lg.error(
                        "[%s] evidence-fusion RAG failed for %r; retaining DCI: %s",
                        agent, query, e, exc_info=True,
                    )
            fused = fuse_evidence(
                query=query,
                policy=policy,
                metric_result=r1,
                keyword_result=r2,
                rag_result=rag_result,
                rag_executed=policy.run_rag,
                rag_succeeded=rag_succeeded,
                config=(rag_config.get("retrieval_control") or {}),
            )
            lg.info(
                "[evidence_fusion] query=%r type=%s reasons=%s dci_metric=%d "
                "dci_keyword=%d rag_executed=%s rag_succeeded=%s final=%d conflicts=%d",
                query,
                policy.query_type,
                list(policy.reason_codes),
                len((r1 or {}).get("chunks", [])),
                len((r2 or {}).get("chunks", [])),
                fused.rag_executed,
                fused.rag_succeeded,
                len(fused.final_chunks),
                len(fused.conflicts),
            )
            return (
                query,
                fused.context,
                fused.final_chunks,
                fused.time_info,
                fused.pre_rerank_chunks,
                True,
                fused.metadata(),
            )

        # ── Legacy DCI cascade (rollback compatibility) ─────────────
        if _c is not None:
            if r1 is not None:
                if _mode == "dci_only":
                    if should_skip_rag(r1, agent):
                        lg.info("[cascade] dci_only mode — returning scoped metric hit for '%s'", query)
                        return _cascade_to_evidence(query, r1, agent)
                    lg.info("[cascade] dci_only mode — rejecting low-confidence metric hit for '%s'", query)
                if should_skip_rag(r1, agent):
                    lg.info("[cascade] DCI metric hit for '%s' — skipping RAG", query)
                    return _cascade_to_evidence(query, r1, agent)

            if r2 is not None:
                if _mode == "dci_only":
                    if should_skip_rag(r2, agent):
                        lg.info("[cascade] dci_only mode — returning scoped keyword hit for '%s'", query)
                        return _cascade_to_evidence(query, r2, agent)
                    lg.info("[cascade] dci_only mode — rejecting low-confidence keyword hit for '%s'", query)
                if should_skip_rag(r2, agent):
                    lg.info("[cascade] DCI keyword hit for '%s' — skipping RAG", query)
                    return _cascade_to_evidence(query, r2, agent)

        # ── dci_only: no more fallback ───────────────────────────────
        if _mode == "dci_only":
            lg.info("[cascade] dci_only mode — no DCI hits for '%s', returning empty", query)
            return query, "", [], [], [], True, {}

        # ── Step 3 — full RAG (existing logic) ───────────────────────
        try:
            retrieve_kwargs = {}
            allowed_doc_ids = list(scope.source_doc_ids) if scope is not None else None
            # if agent == "general":
            #     retrieve_kwargs = {
            #         "rerank_topk": rag.top_k * 5,
            #         "table_topk": getattr(rag.rag_manager._retrievers[0], "table_k", 0) * 5,
            #     }
            retrieval_result = rag.retrieve(
                query,
                query_time,
                agent=agent,
                allowed_source_doc_ids=allowed_doc_ids,
                **retrieve_kwargs,
            )

            if isinstance(retrieval_result, dict):
                context = retrieval_result.get("rag_context", "")
                chunks = retrieval_result.get("final_chunks", [])
                time_info = retrieval_result.get("time_info", [])
                pre_rerank_chunks = retrieval_result.get("pre_rerank_chunks", [])
            else:
                context, chunks, time_info = retrieval_result
                pre_rerank_chunks = chunks
            return (
                query,
                context,
                chunks,
                time_info,
                dedupe_chunks(pre_rerank_chunks),
                True,
                {
                    "policy": {
                        "mode": _mode,
                        "query_type": "unknown",
                        "run_rag": True,
                        "rag_required": False,
                        "reason_codes": ["LEGACY_RAG_FALLBACK"],
                    },
                    "conflicts": [],
                    "retrieval_trace": [],
                    "rag_executed": True,
                    "rag_succeeded": True,
                },
            )
        except Exception as e:
            lg.error(f"[{agent}] retrieval failed for '{query}': {e}", exc_info=True)
            return query, "", [], [], [], False, {}

    import time as _time
    _t0 = _time.perf_counter()
    tasks = [loop.run_in_executor(None, _run, q) for q in sub_queries]
    results = await asyncio.gather(*tasks)
    global _retrieval_time_acc
    _retrieval_time_acc += _time.perf_counter() - _t0
    evidences: List[Dict[str, Any]] = []
    for query, context, chunks, time_info, pre_rerank_chunks, ok, retrieval_metadata in results:
        if not ok:
            continue
        evidences.append(
            {
                "agent": agent,
                "query": query,
                "context": context,
                "chunks": chunks,
                "source_ids": [get_chunk_source_id(c) for c in chunks],
                "time_info": time_info,
                "pre_rerank_chunks": pre_rerank_chunks,
                "pre_rerank_source_ids": [get_chunk_source_id(c) for c in pre_rerank_chunks],
                "retrieval_scope": {
                    "dataset_id": scope.dataset_id if scope is not None else "",
                    "source_doc_ids": list(scope.source_doc_ids) if scope is not None else [],
                    "explicit_company": bool(scope and scope.explicit_company),
                },
                "retrieval_policy": retrieval_metadata.get("policy", {}),
                "evidence_conflicts": retrieval_metadata.get("conflicts", []),
                "retrieval_trace": retrieval_metadata.get("retrieval_trace", []),
                "rag_executed": bool(retrieval_metadata.get("rag_executed", False)),
                "rag_succeeded": bool(retrieval_metadata.get("rag_succeeded", False)),
            }
        )
        lg.info(
            f"[retrieve] query='{query}' final_chunks={len(chunks)} "
            f"pre_rerank_candidates={len(pre_rerank_chunks)}"
        )

    return evidences


def _format_tool_request(original_query: str, sub_queries: List[str] = None) -> str:
    if not sub_queries:
        return original_query
    formatted_sub_queries = "\n".join(f"- {query}" for query in sub_queries if query)
    if not formatted_sub_queries:
        return original_query
    return (
        f"Original user query:\n{original_query}\n\n"
        f"Tool-relevant sub-questions:\n{formatted_sub_queries}"
    )


async def plan_tool_calls(
    agent: str,
    session_manager: Any,
    original_query: str,
    sub_queries: List[str] = None,
    run_id: str = "",
    log_dir: str = "",
) -> Dict[str, Any]:
    """Plan tool calls in one JSON LLM call."""
    tools_schema = _get_allowed_tools_schema(agent, session_manager)
    if not tools_schema:
        return {"reason": "no_allowed_tools", "tool_calls": []}
    cfg = getattr(session_manager, "config", None) or getattr(session_manager, "_config", None) or {}
    disable_tools = os.environ.get("DISABLE_EXTERNAL_TOOLS", cfg.get("disable_external_tools", False))
    if isinstance(disable_tools, bool):
        tools_disabled = disable_tools
    else:
        tools_disabled = str(disable_tools).strip().lower() in {"1", "true", "yes", "y", "on"}
    if tools_disabled:
        return {"reason": "external_tools_disabled", "tool_calls": []}

    nowtime = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    lg = get_run_logger(run_id, log_dir, agent) if run_id and log_dir else logger
    allowed_tools_text = _format_allowed_tools(tools_schema)
    ticker_symbols_text = json.dumps(TICKER_SYMBOLS, ensure_ascii=False, indent=2)
    messages = [{
        "role": "system",
        "content": TOOL_PLAN_PROMPT.format(
            nowtime=nowtime,
            agent=agent,
            allowed_tools=allowed_tools_text,
            ticker_symbols=ticker_symbols_text,
        ),
    }]
    messages.append({"role": "user", "content": _format_tool_request(original_query, sub_queries)})
    lg.info(
        f"[tool_plan_context] question='{original_query}' sub_queries={sub_queries or []} "
        f"allowed_tools={allowed_tools_text} ticker_symbols={ticker_symbols_text}"
    )

    try:
        response = await session_manager.call_llm_async(
            messages,
            temperature=0,
            response_format={"type": "json_object"},
        )
        content = response.choices[0].message.content
        lg.info(f"[tool_plan_raw_response] question='{original_query}' raw_response={content}")
        if content.startswith("```"):
            content = content.strip("` \n").split("\n", 1)[-1]
        parsed = json.loads(content)

        allowed_names = {tool.get("function", {}).get("name") for tool in tools_schema}
        raw_calls = parsed.get("tool_calls", []) or []
        planned_calls = []
        if isinstance(raw_calls, list):
            for call in raw_calls:
                if not isinstance(call, dict):
                    continue
                fn_name = call.get("name")
                args = call.get("arguments", {}) or {}
                if fn_name in allowed_names and isinstance(args, dict):
                    planned_calls.append({"name": fn_name, "arguments": args})

        plan = {
            "reason": str(parsed.get("reason", "")).strip(),
            "tool_calls": planned_calls,
        }
        lg.info(f"[tool_plan] question='{original_query}' plan={plan}")
        return plan
    except Exception as e:
        lg.error(f"[{agent}] tool planning failed: {e}", exc_info=True)
        return {"reason": "tool_planning_failed", "tool_calls": []}


async def execute_planned_tool_calls(
    agent: str,
    planned_tool_calls: List[Dict[str, Any]],
    run_id: str = "",
    log_dir: str = "",
    original_query: str = "",
    sub_queries: List[str] | None = None,
    config: Dict[str, Any] | None = None,
) -> Dict[str, Any]:
    """Execute planned tool calls."""
    if not planned_tool_calls:
        return {}

    lg = get_run_logger(run_id, log_dir, agent) if run_id and log_dir else logger
    lg.info(f"[tool_execute_plan] planned_tool_calls={_json_for_log(planned_tool_calls)}")

    def _execute() -> Dict[str, Any]:
        results: Dict[str, Any] = {}
        for call in planned_tool_calls:
            fn_name = call.get("name")
            fn = TOOL_REGISTRY.get(fn_name)
            if not fn:
                lg.warning(f"[tool_execute_skip] unknown_tool={fn_name} call={_json_for_log(call)}")
                continue
            raw_args = call.get("arguments", {}) or {}
            allowed_args = set(inspect.signature(fn).parameters)
            args = {key: value for key, value in raw_args.items() if key in allowed_args}
            dropped_args = {key: value for key, value in raw_args.items() if key not in allowed_args}
            lg.info(
                f"[tool_execute_call] tool={fn_name} raw_args={_json_for_log(raw_args)} "
                f"args={_json_for_log(args)} dropped_args={_json_for_log(dropped_args)}"
            )
            try:
                result = fn(**args)
            except Exception as e:
                lg.error(f"[{agent}] tool '{fn_name}' failed: {e}", exc_info=True)
                result = {"error": f"Tool {fn_name} failed: {e}"}
            lg.info(f"[tool_execute_result] tool={fn_name} result={_json_for_log(result)}")

            if fn_name in results:
                existing = results[fn_name]
                if isinstance(existing, list):
                    existing.append(result)
                else:
                    results[fn_name] = [existing, result]
            else:
                results[fn_name] = result
        if results:
            lg.info(f"[{agent}] tool_results={_json_for_log(results)}")
        return results

    loop = asyncio.get_event_loop()
    raw_results = await loop.run_in_executor(None, _execute)
    filtered_results = await filter_tool_results(
        raw_results,
        original_query=original_query,
        agent=agent,
        sub_queries=sub_queries or [],
        config=config,
    )
    if filtered_results != raw_results:
        lg.info(
            f"[tool_filter] original_tools={list(raw_results.keys())} "
            f"filtered_tools={list(filtered_results.keys())}"
        )
    return filtered_results


async def draft_answer(
    agent: str,
    question: str,
    history: List[Dict[str, str]],
    evidences: List[Dict[str, Any]],
    tool_results: Dict[str, Any],
    answer_prompt: str,
    session_manager: Any,
    run_id: str = "",
    log_dir: str = "",
) -> str:
    """
    Use agent-specific answer prompt; generate per-subquery answers then summarize.
    """
    lg = get_run_logger(run_id, log_dir, agent) if run_id and log_dir else logger
    # Group evidences by sub_query to generate per-subquery answers
    evidence_by_query: Dict[str, List[str]] = {}
    for ev in evidences:
        q = ev.get("query", "unknown")
        evidence_by_query.setdefault(q, []).append(ev.get("context", ""))

    sub_answers = []

    cfg = getattr(session_manager, "config", None) or getattr(session_manager, "_config", None) or {}

    def _cfg_int(name: str, default: int) -> int:
        try:
            return int(os.environ.get(name) or cfg.get(name, default) or default)
        except Exception:
            return default

    def _cfg_float(name: str, default: float) -> float:
        try:
            return float(os.environ.get(name) or cfg.get(name, default) or default)
        except Exception:
            return default

    def _cfg_bool(name: str, default: bool = False) -> bool:
        raw = os.environ.get(name)
        if raw is None:
            raw = cfg.get(name, default)
        if isinstance(raw, bool):
            return raw
        return str(raw).strip().lower() in {"1", "true", "yes", "y", "on"}

    draft_llm_max_retries = max(1, _cfg_int("draft_llm_max_retries", 3))
    draft_llm_backoff = max(0.1, _cfg_float("draft_llm_retry_backoff_seconds", 2.0))
    draft_llm_max_backoff = max(draft_llm_backoff, _cfg_float("draft_llm_retry_max_backoff_seconds", 30.0))
    draft_llm_max_concurrency = max(1, _cfg_int("draft_llm_max_concurrency", 1))
    draft_evidence_max_chars = max(4000, _cfg_int("draft_evidence_max_chars", 24000))
    draft_history_max_chars = max(1000, _cfg_int("draft_history_max_chars", 6000))
    draft_tools_max_chars = max(1000, _cfg_int("draft_tools_max_chars", 6000))
    draft_summary_max_chars = max(4000, _cfg_int("draft_summary_max_chars", 16000))
    data_latest_time = str(cfg.get("data_latest_time") or cfg.get("data_cutoff") or "unknown")
    draft_sem = asyncio.Semaphore(draft_llm_max_concurrency)
    raw_tools_text = json.dumps(tool_results, ensure_ascii=False) if tool_results else "None"
    tools_text = truncate_text(raw_tools_text, draft_tools_max_chars)
    raw_history_text = "\n".join([f"{m['role']}: {m['content']}" for m in history[-6:]])
    history_text = truncate_text(raw_history_text, draft_history_max_chars)

    async def gen_for_sub(sub_q: str, ctx_list: List[str]):
        evidence_text = join_with_budget(ctx_list, draft_evidence_max_chars) or "None"
        # Inject original/root question to encourage cross-use of facts relevant to the main ask
        question_for_prompt = f"{sub_q}\n(Original question for broader context: {question})"
        prompt_filled = answer_prompt.format(
            question=question_for_prompt,
            history=history_text,
            evidence=evidence_text,
            tools=tools_text,
        )
        prompt_filled = (
            f"{prompt_filled.rstrip()}\n"
            f"{ANSWER_EVIDENCE_GUARDRAILS.format(data_latest_time=data_latest_time)}"
        )
        messages = [{"role": "user", "content": prompt_filled}]
        lg.info(
            "[draft_prompt] sub_q=%r prompt_length=%d evidence_chars=%d history_chars=%d tools_chars=%d",
            sub_q,
            len(prompt_filled),
            len(evidence_text),
            len(history_text),
            len(tools_text),
        )
        # lg.info(f"[draft_prompt] sub_q='{sub_q}' prompt_length={len(prompt_filled)}\n{prompt_filled}")
        non_retryable = ("Authentication", "Permission", "BadRequest", "NotFound", "Unprocessable")
        for attempt in range(1, draft_llm_max_retries + 1):
            try:
                async with draft_sem:
                    resp = await session_manager.call_llm_async(messages, temperature=0)
                ans = resp.choices[0].message.content or ""
                lg.info(f"[draft] sub_q_len={len(sub_q)} answer_length={len(ans)}")
                lg.info(f"[draft_sub_answer] sub_q={sub_q}\n{ans}")
                return {"sub_q": sub_q, "answer": ans}
            except Exception as e:
                err_name = e.__class__.__name__
                should_stop = any(marker in err_name for marker in non_retryable) or attempt >= draft_llm_max_retries
                if should_stop:
                    lg.error(
                        f"[{agent}] draft failed for sub_q='{sub_q}' after {attempt}/{draft_llm_max_retries} attempts: {e}",
                        exc_info=True,
                    )
                    return {"sub_q": sub_q, "answer": "生成失败"}

                sleep_s = min(draft_llm_backoff * (2 ** (attempt - 1)), draft_llm_max_backoff)
                lg.warning(
                    f"[{agent}] draft retry {attempt}/{draft_llm_max_retries} for sub_q='{sub_q}' "
                    f"after {err_name}: {e}; sleeping {sleep_s:.1f}s"
                )
                await asyncio.sleep(sleep_s)

    if evidence_by_query:
        tasks = [gen_for_sub(sub_q, ctx_list) for sub_q, ctx_list in evidence_by_query.items()]
    elif tool_results:
        # Tool-only path has no retrieved evidence, so answer the original question directly.
        tasks = [gen_for_sub(question, [])]
    else:
        tasks = []
    sub_answers = await asyncio.gather(*tasks)

    if not sub_answers:
        final_text = "无答案生成"
        lg.info(f"[draft_content]\n{final_text}")
        return final_text

    # Summarize sub-answers into a concise natural-language draft without heavy omission
    user_language = detect_language(question)
    sub_answers_text = "\n\n".join([f"Sub-question: {sa['sub_q']}\nAnswer: {sa['answer']}" for sa in sub_answers])
    sub_answers_text = truncate_text(sub_answers_text, draft_summary_max_chars)
    summary_prompt = (
        "You will be given multiple sub-answers derived from the same user question.\n"
        "Write a fluent, natural-language response that combines them without losing important details.\n"
        "Do not add new factual claims, dates, numbers, entity relationships, or interpretations that are absent from the sub-answers.\n"
        "If the sub-answers contain uncertainty, missing evidence, or source conflicts, preserve those caveats in the final response.\n"
        "For numeric claims, preserve the exact units, periods, and formulas from the sub-answers; do not recompute silently.\n"
        "If a sub-answer contains Detected Table Facts or an exact row/column extraction, preserve that extracted fact over generic missing-data caveats.\n"
        "For direct numeric questions, lead with the requested metric and avoid unrelated extra figures.\n"
        "Do not use bullet lists or markdown unless the sub-answers require a compact list; keep it concise but include key specifics.\n"
        f"IMPORTANT: Respond in {user_language}.\n\n"
        f"User question: {question}\n\n"
        f"Sub-answers:\n{sub_answers_text}\n\n"
        "Combined answer:"
    )
    try:
        resp = await session_manager.call_llm_async([{"role": "user", "content": summary_prompt}], temperature=0)
        combined = resp.choices[0].message.content
    except Exception as e:
        lg.error(f"[{agent}] combine failed: {e}", exc_info=True)
        combined = sub_answers_text

    if _cfg_bool("answer_self_check_enabled", False):
        max_check_chars = max(1000, _cfg_int("answer_self_check_max_chars", 12000))
        evidence_context_for_check = "\n\n".join(
            f"Sub-question: {sub_q}\nEvidence:\n{ctx}"
            for sub_q, ctx_list in evidence_by_query.items()
            for ctx in ctx_list
            if ctx
        )
        check_material = (
            f"User question:\n{question}\n\n"
            f"Evidence excerpts:\n{evidence_context_for_check[:max_check_chars] or 'None'}\n\n"
            f"Tools:\n{tools_text[:max_check_chars]}\n\n"
            f"Draft answer:\n{combined}\n\n"
            f"Required language: {user_language}\n"
        )
        check_prompt = (
            "You are a strict evidence verifier for financial RAG answers.\n"
            "Rewrite the draft answer so that every factual claim is directly supported by the evidence excerpts or tools.\n"
            "Remove unsupported dates, numbers, product names, entity relationships, and causal claims.\n"
            "If evidence is insufficient or conflicting, say so clearly and answer only the supported part.\n"
            "Do not add citations, markdown tables, or new facts. Keep the answer concise.\n\n"
            f"{check_material}\n"
            "Verified answer:"
        )
        try:
            resp = await session_manager.call_llm_async(
                [{"role": "user", "content": check_prompt}],
                temperature=0,
            )
            verified = resp.choices[0].message.content or ""
            if verified.strip():
                combined = verified
                lg.info("[answer_self_check] applied strict evidence rewrite")
        except Exception as e:
            lg.error(f"[{agent}] answer self-check failed: {e}", exc_info=True)

    lg.info(f"[draft_content]\n{combined}")
    return combined
