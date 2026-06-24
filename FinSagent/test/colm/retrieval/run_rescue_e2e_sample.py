#!/usr/bin/env python3
"""Run Zeekr E2E questions with the no-finetune PageIndex rescue config."""

import argparse
import asyncio
import json
import os
import sys
import time
from pathlib import Path
from typing import Any

PROJECT_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(PROJECT_ROOT / "src"))

from utils.profile_fact_repair import repair_profile_answer
from utils.table_answer_repair import load_reconstructed_table_chunks, repair_table_answer
from utils.exact_evidence_preview import exact_evidence_preview
from utils.period_source_conflict_repair import repair_period_source_conflict


def _parse_indices(value: str | None) -> list[int] | None:
    if not value:
        return None
    return [int(part) for part in _parse_csv_values(value)]


def _parse_csv_values(value: str | None) -> list[str]:
    if not value:
        return []
    return [part.strip() for part in value.split(",") if part.strip()]


def _load_config(args: argparse.Namespace) -> dict[str, Any]:
    try:
        import yaml
    except ModuleNotFoundError as exc:
        raise RuntimeError("PyYAML is required to load the run config. Install pyyaml or use the project conda env.") from exc

    with open(args.config, encoding="utf-8") as f:
        config = yaml.safe_load(f)

    config.update(
        {
            "persist_directory": args.persist_directory,
            "collection_name": args.collection_name,
            "gt_path": args.gt,
            "retrieve_top_k": args.retrieve_top_k,
            "rerank_top_k": args.rerank_top_k,
            "rerank_topk": args.rerank_top_k,
            "pageindex_mode": "hybrid",
            "pageindex_index_dir": args.pageindex_index_dir,
            "pageindex_top_k": args.pageindex_top_k,
            "pageindex_node_top_k": args.pageindex_node_top_k,
            "pageindex_max_chunks_per_node": args.pageindex_max_chunks_per_node,
            "pageindex_page_window": args.pageindex_page_window,
            "pageindex_final_cap": args.pageindex_final_cap,
            "pageindex_score_multiplier": args.pageindex_score_multiplier,
            "pageindex_include_node_summary": True,
            "pageindex_recency_boost": args.pageindex_recency_boost,
            "finance_table_topk": args.finance_table_topk,
            "disable_external_tools": args.disable_external_tools,
            "retrieval_date_cutoff_enabled": args.retrieval_date_cutoff_enabled,
            "retrieval_date_cutoff": args.retrieval_date_cutoff,
            "retrieval_date_cutoff_drop_undated": args.retrieval_date_cutoff_drop_undated,
            "retrieval_auto_period_cutoff_enabled": args.retrieval_auto_period_cutoff_enabled,
            "retrieval_period_cutoff_quarter_window_days": args.retrieval_period_cutoff_quarter_window_days,
            "retrieval_period_cutoff_annual_window_days": args.retrieval_period_cutoff_annual_window_days,
            "retrieval_date_cutoff_backfill_enabled": args.retrieval_date_cutoff_backfill_enabled,
            "retrieval_date_cutoff_backfill_factor": args.retrieval_date_cutoff_backfill_factor,
            "retrieval_date_cutoff_table_backfill_factor": args.retrieval_date_cutoff_table_backfill_factor,
            "retrieval_date_cutoff_min_text_candidates": args.retrieval_date_cutoff_min_text_candidates,
            "evidence_rescue_enabled": True,
            "evidence_rescue_k": args.evidence_rescue_k,
            "evidence_rescue_min_score": args.evidence_rescue_min_score,
            "evidence_rescue_min_year": args.evidence_rescue_min_year,
            "evidence_rescue_scorer_model_path": args.evidence_rescue_scorer_model_path,
            "evidence_rescue_scorer_blend_alpha": args.evidence_rescue_scorer_blend_alpha,
            "answer_self_check_enabled": False,
            "enable_ctx_decomp": False,
            "use_multi_role": True,
            "draft_llm_max_concurrency": 1,
        }
    )
    if args.agent_max_sub_queries is not None:
        config["agent_max_sub_queries"] = args.agent_max_sub_queries
    return config


PROFILE_KEYS = (
    "retrieve_top_k",
    "rerank_top_k",
    "rerank_topk",
    "pageindex_top_k",
    "pageindex_node_top_k",
    "pageindex_max_chunks_per_node",
    "pageindex_page_window",
    "pageindex_final_cap",
    "pageindex_score_multiplier",
    "pageindex_recency_boost",
    "finance_table_topk",
    "evidence_rescue_k",
)


def _base_profile(args: argparse.Namespace) -> dict[str, Any]:
    return {
        "retrieve_top_k": args.retrieve_top_k,
        "rerank_top_k": args.rerank_top_k,
        "rerank_topk": args.rerank_top_k,
        "pageindex_top_k": args.pageindex_top_k,
        "pageindex_node_top_k": args.pageindex_node_top_k,
        "pageindex_max_chunks_per_node": args.pageindex_max_chunks_per_node,
        "pageindex_page_window": args.pageindex_page_window,
        "pageindex_final_cap": args.pageindex_final_cap,
        "pageindex_score_multiplier": args.pageindex_score_multiplier,
        "pageindex_recency_boost": args.pageindex_recency_boost,
        "finance_table_topk": args.finance_table_topk,
        "evidence_rescue_k": args.evidence_rescue_k,
    }


def _slim_profile() -> dict[str, Any]:
    return {
        "retrieve_top_k": 8,
        "rerank_top_k": 6,
        "rerank_topk": 6,
        "pageindex_top_k": 18,
        "pageindex_node_top_k": 30,
        "pageindex_max_chunks_per_node": 1,
        "pageindex_page_window": 0,
        "pageindex_final_cap": 12,
        "pageindex_score_multiplier": 1.3,
        "pageindex_recency_boost": 8.0,
        "finance_table_topk": 6,
        "evidence_rescue_k": 2,
    }


def _diagnostic_meta(item: dict[str, Any]) -> dict[str, Any]:
    meta = item.get("diagnostic_meta")
    return meta if isinstance(meta, dict) else {}


def _profile_for_item(item: dict[str, Any], args: argparse.Namespace) -> tuple[str, dict[str, Any], str]:
    base = _base_profile(args)
    if args.router_profile in {"off", "none", ""}:
        return "conservative", base, "router off"

    meta = _diagnostic_meta(item)
    category = str(meta.get("category") or item.get("category") or "").lower()
    difficulty = str(meta.get("difficulty") or item.get("difficulty") or "").lower()
    focus_raw = meta.get("module_focus") or item.get("module_focus") or []
    if isinstance(focus_raw, str):
        focus = {part.strip().lower() for part in focus_raw.split(";") if part.strip()}
    else:
        focus = {str(part).lower() for part in focus_raw}

    key_points = item.get("key_points") or item.get("gt_keypoints") or []
    keypoint_count = len(key_points) if isinstance(key_points, list) else 0
    low_risk_numeric = (
        category == "periodic_numeric_metric"
        and difficulty == "easy"
        and ({"numeric_precision", "table"} & focus)
        and 0 < keypoint_count <= 1
    )
    if low_risk_numeric:
        return (
            "slim_numeric_v1",
            _slim_profile(),
            f"single-point numeric/table category={category} difficulty={difficulty} keypoints={keypoint_count}",
        )

    return "conservative", base, f"kept conservative category={category} difficulty={difficulty} keypoints={keypoint_count}"


def _apply_retrieval_profile(config: dict[str, Any], chat_service: Any, profile: dict[str, Any]) -> None:
    for key in PROFILE_KEYS:
        if key in profile:
            config[key] = profile[key]

    chat_service.rag.top_k = int(profile["rerank_top_k"])
    retrievers = getattr(chat_service.rag.rag_manager, "_retrievers", [])
    if not retrievers:
        return
    retriever = retrievers[0]
    retriever.faiss_k = int(profile["retrieve_top_k"])
    retriever.bm25_k = int(profile["retrieve_top_k"])
    retriever.faiss_ts_k = int(profile["retrieve_top_k"])
    retriever.table_k = int(profile["finance_table_topk"])
    retriever.pageindex_k = int(profile["pageindex_top_k"])
    retriever.pageindex_max_chunks_per_node = int(profile["pageindex_max_chunks_per_node"])
    retriever.pageindex_page_window = int(profile["pageindex_page_window"])
    pageindex_retriever = getattr(retriever, "pageindex_retriever", None)
    if pageindex_retriever is not None:
        pageindex_retriever.node_top_k = int(profile["pageindex_node_top_k"])
        pageindex_retriever.recency_boost = float(profile["pageindex_recency_boost"])


def _get_nested_value(payload: dict[str, Any], dotted_path: str | None) -> Any:
    if not dotted_path:
        return None
    current: Any = payload
    for part in dotted_path.split("."):
        if not isinstance(current, dict):
            return None
        current = current.get(part)
    return current


def _select_items(gt_data: list[dict[str, Any]], args: argparse.Namespace) -> list[dict[str, Any]]:
    raw_indices = _parse_csv_values(args.indices)
    if raw_indices:
        if args.indices_match_field == "index":
            indices = [int(index) for index in raw_indices]
            wanted = {str(index) for index in indices}
            selected = [item for item in gt_data if str(item.get("index")) in wanted]
            missing = wanted - {str(item.get("index")) for item in selected}
            if missing:
                raise ValueError(f"No GT rows found for index values: {sorted(missing)}")
            return selected
        if args.indices_match_field == "qid":
            wanted_qids = set(raw_indices)
            selected = [item for item in gt_data if str(item.get("qid")) in wanted_qids]
            missing = wanted_qids - {str(item.get("qid")) for item in selected}
            if missing:
                raise ValueError(f"No GT rows found for qid values: {sorted(missing)}")
            return selected
        indices = [int(index) for index in raw_indices]
        return [gt_data[index - 1] for index in indices]

    start_index = max(1, args.start_index)
    end_index = args.end_index if args.end_index is not None else args.max_examples
    if end_index is None:
        end_index = len(gt_data)
    end_index = min(len(gt_data), end_index)
    return gt_data[start_index - 1 : end_index]


def _load_existing_rows(output_path: Path) -> list[dict[str, Any]]:
    if not output_path.exists():
        return []
    with open(output_path, encoding="utf-8") as f:
        rows = json.load(f)
    if not isinstance(rows, list):
        raise ValueError(f"Existing output is not a JSON list: {output_path}")
    return rows


def _resume_key(row: dict[str, Any]) -> str:
    if row.get("index") is not None:
        return f"index:{row.get('index')}"
    if row.get("qid") is not None:
        return f"qid:{row.get('qid')}"
    question = str(row.get("question") or row.get("original_question") or "").strip()
    return f"question:{question}"


def _write_outputs(output_path: Path, rows: list[dict[str, Any]]) -> None:
    tmp_path = output_path.with_suffix(output_path.suffix + ".tmp")
    with open(tmp_path, "w", encoding="utf-8") as f:
        json.dump(rows, f, ensure_ascii=False, indent=2)
    tmp_path.replace(output_path)

    jsonl_path = output_path.with_suffix(".jsonl")
    with open(jsonl_path, "w", encoding="utf-8") as f:
        for row in rows:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")


def _answer_from_result(result: dict[str, Any]) -> str:
    return str(result.get("answer") or "")


def _looks_uncertain(answer: str) -> bool:
    lowered = answer.lower()
    uncertainty_markers = (
        "\u672a\u62ab\u9732",
        "\u6ca1\u6709\u62ab\u9732",
        "\u65e0\u6cd5\u786e\u8ba4",
        "\u65e0\u6cd5\u786e\u5b9a",
        "\u4e0d\u80fd\u786e\u5b9a",
        "\u4e0d\u77e5\u9053",
        "\u4e0d\u6e05\u695a",
        "\u5c1a\u65e0\u6cd5",
        "not disclosed",
        "cannot determine",
        "cannot confirm",
        "unknown",
    )
    return any(marker in lowered for marker in uncertainty_markers)


def _apply_table_repair_to_row(
    row: dict[str, Any],
    args: argparse.Namespace,
    fallback_table_chunks: list[dict[str, Any]],
) -> dict[str, Any]:
    if not args.deterministic_table_repair_enabled:
        return row
    repaired = repair_table_answer(
        str(row.get("question") or row.get("original_question") or ""),
        str(row.get("generated_answer") or row.get("answer") or ""),
        row.get("retrieved_chunks") or [],
        canonicalize_supported=args.canonicalize_supported_table_answers,
        fallback_table_chunks=fallback_table_chunks,
    )
    out = dict(row)
    out["original_generated_answer"] = str(row.get("generated_answer") or row.get("answer") or "")
    out["generated_answer"] = repaired["answer"]
    out["answer"] = repaired["answer"]
    out["table_repair_applied"] = repaired["repair_applied"]
    out["table_repair_reason"] = repaired["repair_reason"]
    verification = repaired.get("verification") or {}
    out["table_verifier_status"] = verification.get("status")
    out["table_verifier_fact_types"] = sorted({str(check.get("fact_type") or "") for check in verification.get("checks") or []})
    return out


def _apply_profile_repair_to_row(row: dict[str, Any], args: argparse.Namespace) -> dict[str, Any]:
    if not args.deterministic_profile_repair_enabled:
        return row
    repaired = repair_profile_answer(
        str(row.get("question") or row.get("original_question") or ""),
        str(row.get("generated_answer") or row.get("answer") or ""),
        [
            *(row.get("retrieved_chunks") or []),
            *(row.get("pre_rerank_candidates") or []),
        ],
        allow_legacy_answer_fallback=args.deterministic_profile_repair_legacy_answer_fallback,
    )
    out = dict(row)
    out["original_profile_generated_answer"] = str(row.get("generated_answer") or row.get("answer") or "")
    if repaired["repair_applied"]:
        out["generated_answer"] = repaired["answer"]
        out["answer"] = repaired["answer"]
        if isinstance(out.get("final_answer"), dict):
            out["final_answer"] = dict(out["final_answer"])
            out["final_answer"]["answer"] = repaired["answer"]
    out["profile_repair_applied"] = repaired["repair_applied"]
    out["profile_repair_reason"] = repaired["repair_reason"]
    out["profile_repair_fact"] = repaired.get("profile_fact")
    return out


def _apply_period_source_conflict_repair_to_row(row: dict[str, Any], args: argparse.Namespace) -> dict[str, Any]:
    if not args.period_source_conflict_repair_enabled:
        return row
    repaired = repair_period_source_conflict(
        str(row.get("question") or row.get("original_question") or ""),
        str(row.get("generated_answer") or row.get("answer") or ""),
        row.get("retrieved_chunks") or [],
    )
    out = dict(row)
    out["period_source_conflict_repair_applied"] = repaired["repair_applied"]
    out["period_source_conflict_repair_reason"] = repaired["repair_reason"]
    if repaired["repair_applied"]:
        out["original_period_conflict_generated_answer"] = str(row.get("generated_answer") or row.get("answer") or "")
        out["generated_answer"] = repaired["answer"]
        out["answer"] = repaired["answer"]
        out["period_source_conflict_supporting_source"] = repaired.get("supporting_source")
        if isinstance(out.get("final_answer"), dict):
            out["final_answer"] = dict(out["final_answer"])
            out["final_answer"]["answer"] = repaired["answer"]
    return out


def _needs_conservative_fallback(row: dict[str, Any], profile_name: str) -> tuple[bool, str]:
    if not profile_name.startswith("slim"):
        return False, "not a slim profile"
    verifier_status = str(row.get("table_verifier_status") or "")
    answer = str(row.get("generated_answer") or row.get("answer") or "")
    if verifier_status == "NO_TABLE_FACTS" and _looks_uncertain(answer):
        return True, "slim answer is uncertain and has no supported table facts"
    return False, "slim answer passed fallback guard"


def _row_from_result(
    item: dict[str, Any],
    result: dict[str, Any],
    profile_name: str,
    profile_reason: str,
    retrieval_profile: dict[str, Any],
    args: argparse.Namespace,
    fallback_table_chunks: list[dict[str, Any]],
) -> dict[str, Any]:
    answer = _answer_from_result(result)
    row = dict(item)
    row.update(
        {
            "generated_answer": answer,
            "answer": answer,
            "activated_agents": result.get("activated_agents", []),
            "retrieved_chunk_count": result.get("retrieved_chunk_count"),
            "pre_rerank_candidate_count": result.get("pre_rerank_candidate_count"),
            "total_time": result.get("total_time"),
            "retrieval_profile_name": profile_name,
            "retrieval_profile_reason": profile_reason,
            "retrieval_profile": retrieval_profile,
        }
    )
    if args.store_debug_chunks:
        row["retrieved_chunks"] = result.get("retrieved_chunks", [])
        row["pre_rerank_candidates"] = result.get("pre_rerank_candidates", [])
    row = _apply_table_repair_to_row(row, args, fallback_table_chunks)
    row = _apply_profile_repair_to_row(row, args)
    row = _apply_period_source_conflict_repair_to_row(row, args)
    if args.exact_evidence_preview_enabled:
        row["exact_evidence_preview"] = exact_evidence_preview(
            str(row.get("question") or row.get("original_question") or ""),
            roots=_parse_csv_values(args.exact_evidence_preview_roots),
            max_hits=args.exact_evidence_preview_max_hits,
            max_terms=args.exact_evidence_preview_max_terms,
            max_file_bytes=args.exact_evidence_preview_max_file_bytes,
            context_chars=args.exact_evidence_preview_context_chars,
        )
    return row


async def _run(args: argparse.Namespace) -> None:
    from core.ChatService import ChatService
    from core.RAGManager import RAGManager

    os.environ["ENABLE_TITLE_SUMMARIES"] = "0"
    with open(args.gt, encoding="utf-8") as f:
        gt_data = json.load(f)

    items = _select_items(gt_data, args)

    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    rows = _load_existing_rows(output_path) if args.resume else []
    done_keys = {_resume_key(row) for row in rows}

    config = _load_config(args)
    base_cutoff_enabled = config.get("retrieval_date_cutoff_enabled", False)
    base_cutoff = config.get("retrieval_date_cutoff")
    rag_manager = RAGManager(config, collections={args.collection_name: args.retrieve_top_k})
    chat_service = ChatService(
        config=config,
        rag_manager=rag_manager,
        rerank_topk=args.rerank_top_k,
    )
    fallback_table_chunks = load_reconstructed_table_chunks(args.reconstructed_table_dir)

    for item in items:
        question = item.get("question") or item.get("original_question") or ""
        idx = item.get("index")
        item_key = _resume_key(item)
        if args.resume and item_key in done_keys:
            print(f"SKIP id={item_key} question={question}", flush=True)
            continue
        print(f"RUN id={item_key} question={question}", flush=True)
        item_cutoff = _get_nested_value(item, args.item_cutoff_field) if args.use_item_cutoff else None
        if item_cutoff:
            config["retrieval_date_cutoff_enabled"] = True
            config["retrieval_date_cutoff"] = item_cutoff
        else:
            config["retrieval_date_cutoff_enabled"] = base_cutoff_enabled
            config["retrieval_date_cutoff"] = base_cutoff
        profile_name, retrieval_profile, profile_reason = _profile_for_item(item, args)
        _apply_retrieval_profile(config, chat_service, retrieval_profile)
        print(
            f"PROFILE idx={idx} name={profile_name} reason={profile_reason} "
            f"retrieve_top_k={retrieval_profile['retrieve_top_k']} "
            f"rerank_top_k={retrieval_profile['rerank_top_k']} "
            f"pageindex_top_k={retrieval_profile['pageindex_top_k']} "
            f"final_cap={retrieval_profile['pageindex_final_cap']}",
            flush=True,
        )
        t0 = time.time()
        result = await chat_service.generate_response_debug_async(
            question,
            f"rescue_e2e_{idx}_{int(time.time() * 1000)}",
        )
        row = _row_from_result(item, result, profile_name, profile_reason, retrieval_profile, args, fallback_table_chunks)
        row["total_time"] = result.get("total_time", round(time.time() - t0, 3))
        if args.adaptive_slim_fallback:
            should_fallback, fallback_reason = _needs_conservative_fallback(row, profile_name)
            row["adaptive_fallback_checked"] = True
            row["adaptive_fallback_reason"] = fallback_reason
            if should_fallback:
                fallback_profile = _base_profile(args)
                _apply_retrieval_profile(config, chat_service, fallback_profile)
                print(f"FALLBACK idx={idx} reason={fallback_reason}", flush=True)
                fallback_t0 = time.time()
                fallback_result = await chat_service.generate_response_debug_async(
                    question,
                    f"rescue_e2e_{idx}_fallback_{int(time.time() * 1000)}",
                )
                fallback_row = _row_from_result(
                    item,
                    fallback_result,
                    "conservative_fallback",
                    fallback_reason,
                    fallback_profile,
                    args,
                    fallback_table_chunks,
                )
                fallback_row["initial_retrieval_profile_name"] = profile_name
                fallback_row["initial_generated_answer"] = row.get("generated_answer")
                fallback_row["initial_total_time"] = row.get("total_time")
                fallback_row["fallback_total_time"] = fallback_result.get("total_time", round(time.time() - fallback_t0, 3))
                fallback_row["total_time"] = round(time.time() - t0, 3)
                fallback_row["adaptive_fallback_checked"] = True
                fallback_row["adaptive_fallback_applied"] = True
                fallback_row["adaptive_fallback_reason"] = fallback_reason
                row = fallback_row
            else:
                row["adaptive_fallback_applied"] = False
        rows.append(row)
        done_keys.add(item_key)
        _write_outputs(output_path, rows)
        print(f"DONE id={item_key} seconds={round(time.time() - t0, 2)}", flush=True)

    print(f"SAVED {output_path}", flush=True)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", default=str(PROJECT_ROOT / "config" / "production_pageindex_fast.yaml"))
    parser.add_argument("--gt", default="/root/autodl-tmp/dir_myz/FinSagent/test/zeekr_colm_e2e_gt_with_key_pts_0330_for_judge.json")
    parser.add_argument("--output", default=str(PROJECT_ROOT / "test" / "colm" / "retrieval" / "e2e_rescue_sample.json"))
    parser.add_argument("--persist_directory", default="/root/autodl-tmp/RAG_Agent_data/Zeekr/20250729/database_zeekr")
    parser.add_argument("--pageindex_index_dir", default="/root/autodl-tmp/RAG_Agent_data/Zeekr/20250729/database_zeekr/pageindex")
    parser.add_argument("--collection_name", default="zeekr")
    parser.add_argument("--max_examples", type=int, default=None)
    parser.add_argument("--indices", default=None)
    parser.add_argument("--indices_match_field", choices=["position", "index", "qid"], default="position")
    parser.add_argument("--start_index", type=int, default=1)
    parser.add_argument("--end_index", type=int, default=None)
    parser.add_argument("--resume", action=argparse.BooleanOptionalAction, default=True)
    parser.add_argument("--store_debug_chunks", action=argparse.BooleanOptionalAction, default=True)
    parser.add_argument("--retrieve_top_k", type=int, default=10)
    parser.add_argument("--rerank_top_k", type=int, default=8)
    parser.add_argument("--pageindex_top_k", type=int, default=30)
    parser.add_argument("--pageindex_node_top_k", type=int, default=50)
    parser.add_argument("--pageindex_max_chunks_per_node", type=int, default=1)
    parser.add_argument("--pageindex_page_window", type=int, default=0)
    parser.add_argument("--pageindex_final_cap", type=int, default=20)
    parser.add_argument("--pageindex_score_multiplier", type=float, default=1.5)
    parser.add_argument("--pageindex_recency_boost", type=float, default=12.0)
    parser.add_argument("--finance_table_topk", type=int, default=8)
    parser.add_argument("--disable_external_tools", action=argparse.BooleanOptionalAction, default=True)
    parser.add_argument("--retrieval_date_cutoff_enabled", action=argparse.BooleanOptionalAction, default=False)
    parser.add_argument("--retrieval_date_cutoff", default=None)
    parser.add_argument("--retrieval_date_cutoff_drop_undated", action=argparse.BooleanOptionalAction, default=False)
    parser.add_argument("--retrieval_auto_period_cutoff_enabled", action=argparse.BooleanOptionalAction, default=False)
    parser.add_argument("--retrieval_period_cutoff_quarter_window_days", type=int, default=180)
    parser.add_argument("--retrieval_period_cutoff_annual_window_days", type=int, default=120)
    parser.add_argument("--retrieval_date_cutoff_backfill_enabled", action=argparse.BooleanOptionalAction, default=True)
    parser.add_argument("--retrieval_date_cutoff_backfill_factor", type=int, default=3)
    parser.add_argument("--retrieval_date_cutoff_table_backfill_factor", type=int, default=3)
    parser.add_argument("--retrieval_date_cutoff_min_text_candidates", type=int, default=None)
    parser.add_argument("--use_item_cutoff", action=argparse.BooleanOptionalAction, default=True)
    parser.add_argument("--item_cutoff_field", default="diagnostic_meta.evidence_cutoff")
    parser.add_argument("--evidence_rescue_k", type=int, default=3)
    parser.add_argument("--evidence_rescue_min_score", type=float, default=0.45)
    parser.add_argument("--evidence_rescue_min_year", type=int, default=2024)
    parser.add_argument("--evidence_rescue_scorer_model_path", default=None)
    parser.add_argument("--evidence_rescue_scorer_blend_alpha", type=float, default=0.7)
    parser.add_argument("--router_profile", choices=["off", "numeric_slim_v1"], default="off")
    parser.add_argument("--agent_max_sub_queries", type=int, default=None)
    parser.add_argument("--deterministic_table_repair_enabled", action=argparse.BooleanOptionalAction, default=False)
    parser.add_argument("--deterministic_profile_repair_enabled", action=argparse.BooleanOptionalAction, default=False)
    parser.add_argument(
        "--deterministic_profile_repair_legacy_answer_fallback",
        action=argparse.BooleanOptionalAction,
        default=True,
    )
    parser.add_argument("--period_source_conflict_repair_enabled", action=argparse.BooleanOptionalAction, default=False)
    parser.add_argument("--canonicalize_supported_table_answers", action=argparse.BooleanOptionalAction, default=False)
    parser.add_argument("--adaptive_slim_fallback", action=argparse.BooleanOptionalAction, default=False)
    parser.add_argument("--reconstructed_table_dir", default=None)
    parser.add_argument("--exact_evidence_preview_enabled", action=argparse.BooleanOptionalAction, default=False)
    parser.add_argument("--exact_evidence_preview_roots", default=None)
    parser.add_argument("--exact_evidence_preview_max_hits", type=int, default=5)
    parser.add_argument("--exact_evidence_preview_max_terms", type=int, default=12)
    parser.add_argument("--exact_evidence_preview_max_file_bytes", type=int, default=5_000_000)
    parser.add_argument("--exact_evidence_preview_context_chars", type=int, default=500)
    args = parser.parse_args()
    asyncio.run(_run(args))


if __name__ == "__main__":
    main()
