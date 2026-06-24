#!/usr/bin/env python3
import argparse
import json
from pathlib import Path
from typing import Any, Dict, Iterable, List, Sequence


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--gt-path",
        default="/root/autodl-tmp/cjj/FinSagent_0212/test/gt/lotus_colm_109_gt.json",
    )
    parser.add_argument(
        "--new-path",
        default="/root/autodl-tmp/cjj/FinSagent_0212/test/colm/retrieval/zeekr_bayesian_retrieve_neg_lambda_0317/lotus_run5_ret10_rer5_multi_role_bayesian_ret_ctx_decomp.jsonl",
    )
    parser.add_argument(
        "--old-path",
        default="/root/autodl-tmp/cjj/FinSagent_0212/test/colm/retrieval/lotus_fix_0316/lotus_run3_multi_role_decomp.jsonl",
    )
    parser.add_argument("--output-path", default="")
    parser.add_argument("--indent", type=int, default=2)
    return parser.parse_args()


def normalize_text(text: str) -> str:
    return " ".join((text or "").split()).strip().lower()


def chunks_match(left: str, right: str) -> bool:
    norm_left = normalize_text(left)
    norm_right = normalize_text(right)
    if not norm_left or not norm_right:
        return False
    return norm_left in norm_right or norm_right in norm_left


def load_json(path: Path) -> Any:
    with path.open("r", encoding="utf-8") as f:
        return json.load(f)


def load_jsonl(path: Path) -> List[Dict[str, Any]]:
    records: List[Dict[str, Any]] = []
    with path.open("r", encoding="utf-8") as f:
        for line_no, line in enumerate(f, 1):
            line = line.strip()
            if not line:
                continue
            try:
                payload = json.loads(line)
            except json.JSONDecodeError as exc:
                raise ValueError(f"Invalid JSONL at {path}:{line_no}: {exc}") from exc
            if isinstance(payload, dict):
                records.append(payload)
    return records


def get_question(item: Dict[str, Any]) -> str:
    return (
        item.get("question")
        or item.get("original_question")
        or item.get("text")
        or ""
    ).strip()


def unique_texts(texts: Iterable[str]) -> List[str]:
    seen = set()
    unique: List[str] = []
    for text in texts:
        if not text:
            continue
        norm = normalize_text(text)
        if not norm or norm in seen:
            continue
        seen.add(norm)
        unique.append(text)
    return unique


def extract_retrieved_texts(record: Dict[str, Any]) -> List[str]:
    texts: List[str] = []
    for agent_detail in record.get("agent_details", []) or []:
        if not isinstance(agent_detail, dict):
            continue
        for evidence in agent_detail.get("evidence_chunks", []) or []:
            if not isinstance(evidence, dict):
                continue
            for chunk in evidence.get("chunks", []) or []:
                if not isinstance(chunk, dict):
                    continue
                page_content = chunk.get("page_content")
                if isinstance(page_content, str) and page_content.strip():
                    texts.append(page_content)
    return unique_texts(texts)


def find_matching_retrieved_chunks(gt_chunk: str, retrieved_texts: Sequence[str]) -> List[str]:
    return [retrieved for retrieved in retrieved_texts if chunks_match(gt_chunk, retrieved)]


def build_question_map(records: Sequence[Dict[str, Any]], label: str) -> Dict[str, Dict[str, Any]]:
    mapping: Dict[str, Dict[str, Any]] = {}
    for record in records:
        question = get_question(record)
        if not question:
            continue
        existing = mapping.get(question)
        if existing is None:
            mapping[question] = {
                "question": question,
                "records": [record],
                "retrieved_texts": extract_retrieved_texts(record),
                "activated_agents": list(record.get("activated_agents", []) or []),
                "idxs": [record.get("idx")],
                "label": label,
            }
            continue

        existing["records"].append(record)
        existing["retrieved_texts"] = unique_texts(
            list(existing["retrieved_texts"]) + extract_retrieved_texts(record)
        )
        existing["activated_agents"] = unique_texts(
            list(existing["activated_agents"]) + list(record.get("activated_agents", []) or [])
        )
        existing["idxs"].append(record.get("idx"))
    return mapping


def compare(gt_items: Sequence[Dict[str, Any]], old_records: Sequence[Dict[str, Any]], new_records: Sequence[Dict[str, Any]]) -> Dict[str, Any]:
    old_by_question = build_question_map(old_records, "old results")
    new_by_question = build_question_map(new_records, "new results")

    regressions: List[Dict[str, Any]] = []
    missing_chunks: List[Dict[str, Any]] = []
    missing_in_old: List[str] = []
    missing_in_new: List[str] = []
    questions_compared = 0

    for index, gt_item in enumerate(gt_items, 1):
        question = get_question(gt_item)
        gt_chunks = unique_texts(gt_item.get("content", []) or [])
        if not question or not gt_chunks:
            continue

        old_record = old_by_question.get(question)
        new_record = new_by_question.get(question)
        if old_record is None:
            missing_in_old.append(question)
            continue
        if new_record is None:
            missing_in_new.append(question)
            continue

        questions_compared += 1
        old_retrieved = list(old_record.get("retrieved_texts", []))
        new_retrieved = list(new_record.get("retrieved_texts", []))

        old_hit_count = 0
        new_hit_count = 0
        regressed_chunks: List[Dict[str, Any]] = []
        missing_gt_chunks_in_old: List[Dict[str, Any]] = []
        missing_gt_chunks_in_new: List[Dict[str, Any]] = []

        for gt_chunk in gt_chunks:
            old_matches = find_matching_retrieved_chunks(gt_chunk, old_retrieved)
            new_matches = find_matching_retrieved_chunks(gt_chunk, new_retrieved)
            if old_matches:
                old_hit_count += 1
            if new_matches:
                new_hit_count += 1
            if not old_matches and new_matches:
                missing_gt_chunks_in_old.append({"gt_chunk": gt_chunk})
            if not new_matches and old_matches:
                missing_gt_chunks_in_new.append({"gt_chunk": gt_chunk})
            if old_matches and not new_matches:
                regressed_chunks.append({"gt_chunk": gt_chunk})

        if missing_gt_chunks_in_old or missing_gt_chunks_in_new:
            missing_chunks.append(
                {
                    "idx": gt_item.get("idx", index),
                    "question": question,
                    "gt_chunk_count": len(gt_chunks),
                    "old_hit_count": old_hit_count,
                    "new_hit_count": new_hit_count,
                    "old_total_retrieved": len(old_retrieved),
                    "new_total_retrieved": len(new_retrieved),
                    "old_record_idxs": old_record.get("idxs", []),
                    "new_record_idxs": new_record.get("idxs", []),
                    "old_activated_agents": old_record.get("activated_agents", []),
                    "new_activated_agents": new_record.get("activated_agents", []),
                    "missing_gt_chunks_in_old": missing_gt_chunks_in_old,
                    "missing_gt_chunks_in_new": missing_gt_chunks_in_new,
                }
            )

        if regressed_chunks:
            regressions.append(
                {
                    "idx": gt_item.get("idx", index),
                    "question": question,
                    "gt_chunk_count": len(gt_chunks),
                    "old_hit_count": old_hit_count,
                    "new_hit_count": new_hit_count,
                    "old_total_retrieved": len(old_retrieved),
                    "new_total_retrieved": len(new_retrieved),
                    "old_record_idxs": old_record.get("idxs", []),
                    "new_record_idxs": new_record.get("idxs", []),
                    "old_activated_agents": old_record.get("activated_agents", []),
                    "new_activated_agents": new_record.get("activated_agents", []),
                    "regressed_gt_chunks": regressed_chunks,
                }
            )

    return {
        "summary": {
            "gt_questions": len([item for item in gt_items if get_question(item) and item.get("content")]),
            "old_records": len(old_records),
            "new_records": len(new_records),
            "questions_compared": questions_compared,
            "questions_with_regressions": len(regressions),
            "regressed_gt_chunk_count": sum(len(item["regressed_gt_chunks"]) for item in regressions),
            "questions_with_missing_chunks_in_old": sum(
                1 for item in missing_chunks if item["missing_gt_chunks_in_old"]
            ),
            "questions_with_missing_chunks_in_new": sum(
                1 for item in missing_chunks if item["missing_gt_chunks_in_new"]
            ),
            "missing_gt_chunk_count_in_old": sum(
                len(item["missing_gt_chunks_in_old"]) for item in missing_chunks
            ),
            "missing_gt_chunk_count_in_new": sum(
                len(item["missing_gt_chunks_in_new"]) for item in missing_chunks
            ),
            "missing_questions_in_old": missing_in_old,
            "missing_questions_in_new": missing_in_new,
        },
        "missing_chunks": missing_chunks,
        "regressions": regressions,
    }


def main() -> None:
    args = parse_args()

    gt_path = Path(args.gt_path)
    old_path = Path(args.old_path)
    new_path = Path(args.new_path)

    gt_items = load_json(gt_path)
    if not isinstance(gt_items, list):
        raise ValueError(f"GT file must contain a list: {gt_path}")

    old_records = load_jsonl(old_path)
    new_records = load_jsonl(new_path)

    report = compare(gt_items, old_records, new_records)
    output = json.dumps(report, ensure_ascii=False, indent=args.indent)

    if args.output_path:
        output_path = Path(args.output_path)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text(output + "\n", encoding="utf-8")
        print(f"Wrote report to {output_path}")

    print(output)


if __name__ == "__main__":
    main()
