#!/usr/bin/env python3
"""
Export pre-rerank retrieved chunks for a question set.

Input format:
- JSON list of question objects, e.g. test/question_zeekr_gt.json
- If `is_tool_call_question` is true, the item is skipped.

Output additions per item:
- retrieved_chunks: List[chunk]
"""

import argparse
import asyncio
import copy
import json
import logging
import os
import sys
import time
from typing import Any, Dict, List, Optional, Sequence, Set


SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
SRC_DIR = os.path.join(SCRIPT_DIR, "src")
if os.path.isdir(SRC_DIR):
    sys.path.append(SRC_DIR)


logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    handlers=[logging.StreamHandler()],
)
logger = logging.getLogger("export_retrieved_chunks")


def load_config() -> Optional[Dict[str, Any]]:
    config_path = os.path.join(SCRIPT_DIR, "config", "production.yaml")
    try:
        import yaml

        with open(config_path, "r", encoding="utf-8") as f:
            return yaml.safe_load(f)
    except Exception as e:
        logger.error(f"Failed to load config at {config_path}: {e}")
        return None


def load_questions(input_path: str) -> List[Dict[str, Any]]:
    with open(input_path, "r", encoding="utf-8") as f:
        data = json.load(f)
    if not isinstance(data, list):
        raise ValueError("Input JSON must be a list of question objects.")
    return data


def load_existing_output(output_path: str) -> Optional[List[Dict[str, Any]]]:
    if not os.path.exists(output_path):
        return None
    with open(output_path, "r", encoding="utf-8") as f:
        data = json.load(f)
    if not isinstance(data, list):
        raise ValueError("Existing output JSON must be a list of question objects.")
    return data


def dump_questions(output_path: str, data: List[Dict[str, Any]]) -> None:
    output_dir = os.path.dirname(output_path)
    if output_dir:
        os.makedirs(output_dir, exist_ok=True)
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def get_question_text(item: Dict[str, Any]) -> str:
    return item.get("original_question") or item.get("question") or item.get("query") or ""


def build_retrieval_query(item: Dict[str, Any]) -> str:
    question = get_question_text(item)
    ground_truth_answer = (item.get("ground_truth_answer") or "").strip()
    if not ground_truth_answer:
        return question

    # Keep the question first, then append concise answer clues.
    # This preserves the original intent while injecting factual terms
    # that improve both sparse and dense retrieval recall.
    return f"Question: {question}\nAnswer: {ground_truth_answer}"


def set_retrieval_fields(item: Dict[str, Any], retrieved_chunks: List[Dict[str, Any]]) -> None:
    item.pop("num_retrieved_chunks", None)
    item.pop("retrieved_chunks", None)
    item["num_retrieved_chunks"] = len(retrieved_chunks)
    item["retrieved_chunks"] = retrieved_chunks


def get_original_question_text(item: Dict[str, Any]) -> str:
    return (item.get("original_question") or "").strip()


def get_question_index(item: Dict[str, Any], position: int) -> int:
    for key in ("idx", "index"):
        value = item.get(key)
        if isinstance(value, int):
            return value
    return position + 1


def resolve_selected_positions(
    data: Sequence[Dict[str, Any]], question_indexes: Optional[Sequence[int]]
) -> List[int]:
    if not question_indexes:
        return list(range(len(data)))

    selected_index_set: Set[int] = set(question_indexes)
    positions: List[int] = []
    matched_indexes: Set[int] = set()

    for position, item in enumerate(data):
        question_index = get_question_index(item, position)
        if question_index in selected_index_set:
            positions.append(position)
            matched_indexes.add(question_index)

    missing_indexes = sorted(selected_index_set - matched_indexes)
    if missing_indexes:
        raise ValueError(f"Question indexes not found in input: {missing_indexes}")

    return positions


async def retrieve_chunks(
    chat_service: Any,
    query: str,
    question_position: int,
    attempt_tag: str,
) -> List[Dict[str, Any]]:
    session_id = f"retrieval_export_{question_position}_{attempt_tag}_{int(time.time() * 1000)}"
    result = await chat_service.generate_response_debug_async(
        question=query,
        session_id=session_id,
        stop_after_retrieval=True,
    )
    chunks = result.get("pre_rerank_candidates", [])
    if isinstance(chunks, list):
        return chunks
    return []


async def run(input_path: str, output_path: str, question_indexes: Optional[Sequence[int]]) -> None:
    config = load_config()
    if not config:
        raise RuntimeError("Config load failed. Ensure ./config/production.yaml exists.")

    try:
        from core.ChatService import ChatService
        from core.RAGManager import RAGManager
    except Exception as e:
        raise RuntimeError(f"Failed to import ChatService/RAGManager: {e}")

    logger.info("Initializing RAGManager ...")
    rag_manager = RAGManager(config, collections={"zeekr": 10})

    logger.info("Initializing ChatService ...")
    chat_service = ChatService(config=config, rag_manager=rag_manager, rerank_topk=5)

    input_data = load_questions(input_path)
    logger.info(f"Loaded {len(input_data)} questions from {input_path}")

    existing_output = load_existing_output(output_path)
    if existing_output is not None:
        if len(existing_output) != len(input_data):
            raise ValueError(
                f"Existing output length {len(existing_output)} does not match input length {len(input_data)}."
            )
        data = existing_output
        logger.info(f"Loaded existing output from {output_path}; unchanged entries will be preserved")
    else:
        data = copy.deepcopy(input_data)

    selected_positions = resolve_selected_positions(input_data, question_indexes)
    logger.info(f"Selected {len(selected_positions)} question(s) for retrieval")

    for run_idx, position in enumerate(selected_positions, start=1):
        source_item = input_data[position]
        item = copy.deepcopy(source_item)
        question = get_question_text(item)
        retrieval_query = build_retrieval_query(item)
        original_question = get_original_question_text(item)
        is_tool_call_question = bool(item.get("is_tool_call_question", False))
        question_index = get_question_index(source_item, position)

        if is_tool_call_question:
            set_retrieval_fields(item, [])
            item.pop("activated_agents", None)
            data[position] = item
            dump_questions(output_path, data)
            logger.info(f"[{run_idx}/{len(selected_positions)}] Skipped tool-call question idx={question_index}")
            continue

        if not question:
            set_retrieval_fields(item, [])
            item.pop("activated_agents", None)
            item["retrieval_error"] = "Missing question text"
            data[position] = item
            dump_questions(output_path, data)
            logger.warning(f"[{run_idx}/{len(selected_positions)}] Missing question text idx={question_index}")
            continue

        logger.info(
            f"[{run_idx}/{len(selected_positions)}] Processing question idx={question_index} "
            f"(list_position={position}): {question}"
        )

        try:
            retrieved_chunks = await retrieve_chunks(
                chat_service=chat_service,
                query=retrieval_query,
                question_position=position,
                attempt_tag="qa",
            )
            if not retrieved_chunks and original_question and retrieval_query != original_question:
                logger.info(
                    f"[{run_idx}/{len(selected_positions)}] No chunks from question+answer for idx={question_index}; "
                    "retrying with original question only"
                )
                retrieved_chunks = await retrieve_chunks(
                    chat_service=chat_service,
                    query=original_question,
                    question_position=position,
                    attempt_tag="question_only",
                )

            set_retrieval_fields(item, retrieved_chunks)
            item.pop("activated_agents", None)
            if "retrieval_error" in item:
                del item["retrieval_error"]
        except Exception as e:
            set_retrieval_fields(item, [])
            item.pop("activated_agents", None)
            item["retrieval_error"] = str(e)
            logger.exception(f"[{run_idx}/{len(selected_positions)}] Failed to process question idx={question_index}")

        data[position] = item
        dump_questions(output_path, data)

    logger.info(f"Done. Wrote results to {output_path}")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Export pre-rerank retrieved chunks for a question set.")
    parser.add_argument("input_path", help="Path to the input JSON question list.")
    parser.add_argument("output_path", help="Path to write the output JSON.")
    parser.add_argument(
        "--question-indexes",
        nargs="+",
        type=int,
        help="Only process these question indexes. Matches `idx`, then `index`, otherwise 1-based list position.",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    asyncio.run(run(args.input_path, args.output_path, args.question_indexes))


if __name__ == "__main__":
    main()
