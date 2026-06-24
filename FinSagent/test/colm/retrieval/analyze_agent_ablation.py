#!/usr/bin/env python3
import argparse
import json
import re
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any, Dict, Iterable, List, Sequence


DEFAULT_RESULTS_PATH = Path(
    "/root/autodl-tmp/cjj/FinSagent_0212/test/e2e/0322_force_general_lightgbm_new_calibrate_ts10_fb_table_rerun/secque_run5_ret10_rer5_multi_role_chunkrisk_percentile_ctx_decomp.jsonl"
)
DEFAULT_RESULTS_ROOT = Path(
    "/root/autodl-tmp/cjj/FinSagent_0212/test/e2e/0322_force_general_lightgbm_new_calibrate_ts10_fb_table_rerun"
)
DEFAULT_GT_PATH = Path(
    "/root/autodl-tmp/cjj/FinSagent_0212/test/gt/secque_sample_100_retrieval_gt.json"
)
DEFAULT_GT_ROOT = Path(
    "/root/autodl-tmp/cjj/FinSagent_0212/test/gt"
)
DEFAULT_DATASETS = ("zeekr", "lotus", "secque", "finder", "financebench")
DEFAULT_RUNS = (2, 3, 4, 5)
DATASET_GT_FILENAMES = {
    "financebench": "financebench_145_gt.json",
    "finder": "finder_sampled_71_gt.json",
    "lotus": "lotus_108_dedup_gt.json",
    "secque": "secque_sample_100_retrieval_gt.json",
    "zeekr": "zeekr_134_dedup_gt.json",
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--results-path", type=Path, default=DEFAULT_RESULTS_PATH)
    parser.add_argument("--gt-path", type=Path, default=DEFAULT_GT_PATH)
    parser.add_argument("--results-root", type=Path, default=None)
    parser.add_argument("--gt-root", type=Path, default=DEFAULT_GT_ROOT)
    parser.add_argument("--datasets", nargs="+", default=list(DEFAULT_DATASETS))
    parser.add_argument("--runs", nargs="+", type=int, default=list(DEFAULT_RUNS))
    parser.add_argument("--batch", action="store_true")
    parser.add_argument("--output-path", type=Path, default=None)
    parser.add_argument("--indent", type=int, default=2)
    return parser.parse_args()


def normalize_text(text: str) -> str:
    return " ".join((text or "").split()).strip().lower()


def make_preview(text: str, limit: int = 220) -> str:
    normalized = " ".join((text or "").split()).strip()
    if len(normalized) <= limit:
        return normalized
    return normalized[: limit - 3] + "..."


def unique_values(values: Iterable[Any]) -> List[Any]:
    seen = set()
    unique: List[Any] = []
    for value in values:
        if value in seen:
            continue
        seen.add(value)
        unique.append(value)
    return unique


def unique_texts(texts: Iterable[str]) -> List[str]:
    seen = set()
    unique: List[str] = []
    for text in texts:
        if not isinstance(text, str):
            continue
        normalized = normalize_text(text)
        if not normalized or normalized in seen:
            continue
        seen.add(normalized)
        unique.append(text)
    return unique


def chunks_match(left: str, right: str) -> bool:
    normalized_left = normalize_text(left)
    normalized_right = normalize_text(right)
    if not normalized_left or not normalized_right:
        return False
    return normalized_left in normalized_right or normalized_right in normalized_left


def load_json(path: Path) -> Any:
    with path.open("r", encoding="utf-8") as f:
        return json.load(f)


def load_jsonl(path: Path) -> List[Dict[str, Any]]:
    records: List[Dict[str, Any]] = []
    with path.open("r", encoding="utf-8") as f:
        for line_no, line in enumerate(f, 1):
            payload = line.strip()
            if not payload:
                continue
            try:
                item = json.loads(payload)
            except json.JSONDecodeError as exc:
                raise ValueError(f"Invalid JSONL at {path}:{line_no}: {exc}") from exc
            if isinstance(item, dict):
                records.append(item)
    return records


def get_question(item: Dict[str, Any]) -> str:
    return (
        item.get("question")
        or item.get("original_question")
        or item.get("text")
        or ""
    ).strip()


def extract_gt_chunks(item: Dict[str, Any]) -> List[Dict[str, Any]]:
    chunks: List[Dict[str, Any]] = []
    content = item.get("content") or []
    for index, text in enumerate(content, 1):
        if isinstance(text, str) and normalize_text(text):
            chunks.append(
                {
                    "chunk_id": None,
                    "chunk_index": index,
                    "text": text,
                }
            )
    if chunks:
        return dedupe_gt_chunks(chunks)

    positives = item.get("positives") or []
    for index, positive in enumerate(positives, 1):
        if not isinstance(positive, dict):
            continue
        text = positive.get("chunk")
        if not isinstance(text, str) or not normalize_text(text):
            continue
        chunks.append(
            {
                "chunk_id": positive.get("chunk_id"),
                "chunk_index": index,
                "text": text,
            }
        )
    return dedupe_gt_chunks(chunks)


def dedupe_gt_chunks(chunks: Sequence[Dict[str, Any]]) -> List[Dict[str, Any]]:
    seen = set()
    unique: List[Dict[str, Any]] = []
    for chunk in chunks:
        text = chunk.get("text", "")
        normalized = normalize_text(text)
        if not normalized or normalized in seen:
            continue
        seen.add(normalized)
        unique.append(chunk)
    return unique


def extract_agent_texts(record: Dict[str, Any]) -> Dict[str, List[str]]:
    per_agent_texts: Dict[str, List[str]] = defaultdict(list)
    for agent_detail in record.get("agent_details", []) or []:
        if not isinstance(agent_detail, dict):
            continue
        agent_name = agent_detail.get("agent")
        if not isinstance(agent_name, str) or not agent_name.strip():
            continue
        for evidence in agent_detail.get("evidence_chunks", []) or []:
            if not isinstance(evidence, dict):
                continue
            chunk_added = False
            for chunk in evidence.get("chunks", []) or []:
                if not isinstance(chunk, dict):
                    continue
                page_content = chunk.get("page_content")
                if isinstance(page_content, str) and normalize_text(page_content):
                    per_agent_texts[agent_name].append(page_content)
                    chunk_added = True
            if chunk_added:
                continue
            context = evidence.get("context")
            if isinstance(context, str) and normalize_text(context):
                per_agent_texts[agent_name].append(context)
    return {
        agent_name: unique_texts(texts)
        for agent_name, texts in per_agent_texts.items()
        if unique_texts(texts)
    }


def merge_agent_text_maps(
    base: Dict[str, List[str]],
    incoming: Dict[str, List[str]],
) -> Dict[str, List[str]]:
    merged = {agent_name: list(texts) for agent_name, texts in base.items()}
    for agent_name, texts in incoming.items():
        merged[agent_name] = unique_texts(list(merged.get(agent_name, [])) + list(texts))
    return merged


def flatten_agent_texts(per_agent_texts: Dict[str, List[str]]) -> List[str]:
    merged: List[str] = []
    for texts in per_agent_texts.values():
        merged.extend(texts)
    return unique_texts(merged)


def flatten_except_agent(per_agent_texts: Dict[str, List[str]], excluded_agent: str) -> List[str]:
    merged: List[str] = []
    for agent_name, texts in per_agent_texts.items():
        if agent_name == excluded_agent:
            continue
        merged.extend(texts)
    return unique_texts(merged)


def build_question_map(records: Sequence[Dict[str, Any]]) -> Dict[str, Dict[str, Any]]:
    mapping: Dict[str, Dict[str, Any]] = {}
    for record in records:
        question = get_question(record)
        if not question:
            continue
        per_agent_texts = extract_agent_texts(record)
        activated_agents = [
            agent_name
            for agent_name in record.get("activated_agents", []) or []
            if isinstance(agent_name, str) and agent_name.strip()
        ]
        entry = mapping.get(question)
        if entry is None:
            mapping[question] = {
                "question": question,
                "idxs": [record.get("idx")],
                "activated_agents": unique_values(activated_agents),
                "per_agent_texts": per_agent_texts,
            }
            continue
        entry["idxs"] = unique_values(list(entry.get("idxs", [])) + [record.get("idx")])
        entry["activated_agents"] = unique_values(
            list(entry.get("activated_agents", [])) + activated_agents
        )
        entry["per_agent_texts"] = merge_agent_text_maps(
            entry.get("per_agent_texts", {}),
            per_agent_texts,
        )
    return mapping


def evaluate_matches(gt_chunks: Sequence[Dict[str, Any]], retrieved_texts: Sequence[str]) -> Dict[str, Any]:
    matched_retrieved_by_gt: List[List[str]] = []
    hit_count = 0
    for gt_chunk in gt_chunks:
        matches = [
            retrieved_text
            for retrieved_text in retrieved_texts
            if chunks_match(gt_chunk.get("text", ""), retrieved_text)
        ]
        if matches:
            hit_count += 1
        matched_retrieved_by_gt.append(matches)
    total_gt = len(gt_chunks)
    recall = hit_count / total_gt if total_gt else 0.0
    return {
        "hit_count": hit_count,
        "total_gt": total_gt,
        "recall": recall,
        "matched_retrieved_by_gt": matched_retrieved_by_gt,
    }


def build_match_details(
    gt_chunks: Sequence[Dict[str, Any]],
    matched_retrieved_by_gt: Sequence[Sequence[str]],
) -> List[Dict[str, Any]]:
    details: List[Dict[str, Any]] = []
    for gt_position, matches in enumerate(matched_retrieved_by_gt):
        if not matches:
            continue
        gt_chunk = gt_chunks[gt_position]
        details.append(
            {
                "gt_chunk_index": gt_chunk.get("chunk_index", gt_position + 1),
                "gt_chunk_id": gt_chunk.get("chunk_id"),
                "gt_preview": make_preview(gt_chunk.get("text", "")),
                "matched_retrieved_count": len(matches),
                "matched_retrieved_preview": make_preview(matches[0]),
            }
        )
    return details


def build_gt_subset_details(
    gt_chunks: Sequence[Dict[str, Any]],
    indices: Sequence[int],
) -> List[Dict[str, Any]]:
    details: List[Dict[str, Any]] = []
    for index in indices:
        gt_chunk = gt_chunks[index]
        details.append(
            {
                "gt_chunk_index": gt_chunk.get("chunk_index", index + 1),
                "gt_chunk_id": gt_chunk.get("chunk_id"),
                "gt_preview": make_preview(gt_chunk.get("text", "")),
            }
        )
    return details


def safe_divide(numerator: float, denominator: float) -> float:
    if not denominator:
        return 0.0
    return numerator / denominator


def build_agent_stats() -> Dict[str, Any]:
    return {
        "activated_questions": 0,
        "total_gt_chunks_on_activated_questions": 0,
        "baseline_hit_sum_on_activated_questions": 0,
        "baseline_recall_sum_on_activated_questions": 0.0,
        "agent_only_hit_sum_all_questions": 0,
        "agent_only_recall_sum_all_questions": 0.0,
        "agent_only_hit_sum_on_activated_questions": 0,
        "agent_only_recall_sum_on_activated_questions": 0.0,
        "without_agent_hit_sum_all_questions": 0,
        "without_agent_recall_sum_all_questions": 0.0,
        "without_agent_hit_sum_on_activated_questions": 0,
        "without_agent_recall_sum_on_activated_questions": 0.0,
        "retrieved_chunk_count_sum_on_activated_questions": 0,
        "questions_with_any_agent_match": 0,
        "questions_with_unique_contribution": 0,
        "unique_gt_chunks_contributed": 0,
    }


def analyze(gt_items: Sequence[Dict[str, Any]], result_records: Sequence[Dict[str, Any]]) -> Dict[str, Any]:
    results_by_question = build_question_map(result_records)

    agent_counter = Counter()
    combination_counter = Counter()
    all_agents = set()
    for result_entry in results_by_question.values():
        activated_agents = unique_values(
            list(result_entry.get("activated_agents", []))
            + list(result_entry.get("per_agent_texts", {}).keys())
        )
        for agent_name in activated_agents:
            agent_counter[agent_name] += 1
            all_agents.add(agent_name)
        combination_counter[tuple(sorted(activated_agents))] += 1

    agent_names = sorted(all_agents)
    agent_stats = {agent_name: build_agent_stats() for agent_name in agent_names}

    per_question: List[Dict[str, Any]] = []
    missing_questions_in_results: List[str] = []
    questions_compared = 0
    total_gt_chunks = 0
    baseline_hit_sum = 0
    baseline_recall_sum = 0.0

    for fallback_idx, gt_item in enumerate(gt_items, 1):
        question = get_question(gt_item)
        gt_chunks = extract_gt_chunks(gt_item)
        if not question or not gt_chunks:
            continue

        result_entry = results_by_question.get(question)
        if result_entry is None:
            missing_questions_in_results.append(question)
            continue

        questions_compared += 1
        total_gt_chunks += len(gt_chunks)
        activated_agents = unique_values(
            list(result_entry.get("activated_agents", []))
            + list(result_entry.get("per_agent_texts", {}).keys())
        )
        per_agent_texts = result_entry.get("per_agent_texts", {})
        baseline_texts = flatten_agent_texts(per_agent_texts)
        baseline_eval = evaluate_matches(gt_chunks, baseline_texts)
        baseline_hit_sum += baseline_eval["hit_count"]
        baseline_recall_sum += baseline_eval["recall"]

        question_agents: Dict[str, Any] = {}
        for agent_name in agent_names:
            agent_texts = per_agent_texts.get(agent_name, [])
            without_agent_texts = flatten_except_agent(per_agent_texts, agent_name)
            agent_only_eval = evaluate_matches(gt_chunks, agent_texts)
            without_agent_eval = evaluate_matches(gt_chunks, without_agent_texts)
            lost_indices = [
                index
                for index, baseline_matches in enumerate(baseline_eval["matched_retrieved_by_gt"])
                if baseline_matches and not without_agent_eval["matched_retrieved_by_gt"][index]
            ]
            is_activated = agent_name in activated_agents

            stats = agent_stats[agent_name]
            stats["agent_only_hit_sum_all_questions"] += agent_only_eval["hit_count"]
            stats["agent_only_recall_sum_all_questions"] += agent_only_eval["recall"]
            stats["without_agent_hit_sum_all_questions"] += without_agent_eval["hit_count"]
            stats["without_agent_recall_sum_all_questions"] += without_agent_eval["recall"]
            if agent_only_eval["hit_count"] > 0:
                stats["questions_with_any_agent_match"] += 1
            if lost_indices:
                stats["questions_with_unique_contribution"] += 1
                stats["unique_gt_chunks_contributed"] += len(lost_indices)
            if is_activated:
                stats["activated_questions"] += 1
                stats["total_gt_chunks_on_activated_questions"] += len(gt_chunks)
                stats["baseline_hit_sum_on_activated_questions"] += baseline_eval["hit_count"]
                stats["baseline_recall_sum_on_activated_questions"] += baseline_eval["recall"]
                stats["agent_only_hit_sum_on_activated_questions"] += agent_only_eval["hit_count"]
                stats["agent_only_recall_sum_on_activated_questions"] += agent_only_eval["recall"]
                stats["without_agent_hit_sum_on_activated_questions"] += without_agent_eval["hit_count"]
                stats["without_agent_recall_sum_on_activated_questions"] += without_agent_eval["recall"]
                stats["retrieved_chunk_count_sum_on_activated_questions"] += len(agent_texts)

            if is_activated:
                question_agents[agent_name] = {
                    "activated": True,
                    "retrieved_chunk_count": len(agent_texts),
                    "agent_only_hit_count": agent_only_eval["hit_count"],
                    "agent_only_recall": round(agent_only_eval["recall"], 4),
                    "matched_gt_chunks": build_match_details(
                        gt_chunks,
                        agent_only_eval["matched_retrieved_by_gt"],
                    ),
                    "without_agent_hit_count": without_agent_eval["hit_count"],
                    "without_agent_recall": round(without_agent_eval["recall"], 4),
                    "lost_gt_chunks_without_agent": build_gt_subset_details(gt_chunks, lost_indices),
                }

        per_question.append(
            {
                "idx": gt_item.get("idx", fallback_idx),
                "result_record_idxs": result_entry.get("idxs", []),
                "question": question,
                "gt_chunk_count": len(gt_chunks),
                "baseline_total_retrieved": len(baseline_texts),
                "baseline_hit_count": baseline_eval["hit_count"],
                "baseline_recall": round(baseline_eval["recall"], 4),
                "activated_agents": activated_agents,
                "agent_analysis": question_agents,
            }
        )

    baseline_micro_recall = safe_divide(baseline_hit_sum, total_gt_chunks)
    baseline_macro_recall = safe_divide(baseline_recall_sum, questions_compared)

    agent_reports: List[Dict[str, Any]] = []
    for agent_name in sorted(
        agent_names,
        key=lambda name: (-agent_counter[name], name),
    ):
        stats = agent_stats[agent_name]
        activated_questions = stats["activated_questions"]
        total_activated_gt = stats["total_gt_chunks_on_activated_questions"]
        baseline_micro_on_activated = safe_divide(
            stats["baseline_hit_sum_on_activated_questions"],
            total_activated_gt,
        )
        baseline_macro_on_activated = safe_divide(
            stats["baseline_recall_sum_on_activated_questions"],
            activated_questions,
        )
        without_micro_all = safe_divide(
            stats["without_agent_hit_sum_all_questions"],
            total_gt_chunks,
        )
        without_macro_all = safe_divide(
            stats["without_agent_recall_sum_all_questions"],
            questions_compared,
        )
        without_micro_on_activated = safe_divide(
            stats["without_agent_hit_sum_on_activated_questions"],
            total_activated_gt,
        )
        without_macro_on_activated = safe_divide(
            stats["without_agent_recall_sum_on_activated_questions"],
            activated_questions,
        )
        agent_only_micro_all = safe_divide(
            stats["agent_only_hit_sum_all_questions"],
            total_gt_chunks,
        )
        agent_only_macro_all = safe_divide(
            stats["agent_only_recall_sum_all_questions"],
            questions_compared,
        )
        agent_only_micro_on_activated = safe_divide(
            stats["agent_only_hit_sum_on_activated_questions"],
            total_activated_gt,
        )
        agent_only_macro_on_activated = safe_divide(
            stats["agent_only_recall_sum_on_activated_questions"],
            activated_questions,
        )

        agent_reports.append(
            {
                "agent": agent_name,
                "activated_questions": activated_questions,
                "activated_ratio": round(safe_divide(activated_questions, questions_compared), 4),
                "average_retrieved_chunks_when_activated": round(
                    safe_divide(
                        stats["retrieved_chunk_count_sum_on_activated_questions"],
                        activated_questions,
                    ),
                    4,
                ),
                "questions_with_any_agent_match": stats["questions_with_any_agent_match"],
                "questions_with_unique_contribution": stats["questions_with_unique_contribution"],
                "unique_gt_chunks_contributed": stats["unique_gt_chunks_contributed"],
                "agent_only_micro_recall_all_questions": round(agent_only_micro_all, 4),
                "agent_only_macro_recall_all_questions": round(agent_only_macro_all, 4),
                "agent_only_micro_recall_on_activated_questions": round(agent_only_micro_on_activated, 4),
                "agent_only_macro_recall_on_activated_questions": round(agent_only_macro_on_activated, 4),
                "without_agent_micro_recall_all_questions": round(without_micro_all, 4),
                "without_agent_macro_recall_all_questions": round(without_macro_all, 4),
                "without_agent_micro_recall_on_activated_questions": round(without_micro_on_activated, 4),
                "without_agent_macro_recall_on_activated_questions": round(without_macro_on_activated, 4),
                "delta_micro_recall_all_questions": round(without_micro_all - baseline_micro_recall, 4),
                "delta_macro_recall_all_questions": round(without_macro_all - baseline_macro_recall, 4),
                "baseline_micro_recall_on_activated_questions": round(baseline_micro_on_activated, 4),
                "baseline_macro_recall_on_activated_questions": round(baseline_macro_on_activated, 4),
                "delta_micro_recall_on_activated_questions": round(
                    without_micro_on_activated - baseline_micro_on_activated,
                    4,
                ),
                "delta_macro_recall_on_activated_questions": round(
                    without_macro_on_activated - baseline_macro_on_activated,
                    4,
                ),
            }
        )

    report = {
        "summary": {
            "gt_questions_with_evidence": len(
                [item for item in gt_items if get_question(item) and extract_gt_chunks(item)]
            ),
            "result_records": len(result_records),
            "questions_compared": questions_compared,
            "missing_questions_in_results": missing_questions_in_results,
            "baseline_micro_recall": round(baseline_micro_recall, 4),
            "baseline_macro_recall": round(baseline_macro_recall, 4),
            "baseline_total_hits": baseline_hit_sum,
            "baseline_total_gt_chunks": total_gt_chunks,
        },
        "activated_agent_distribution": {
            "individual": [
                {
                    "agent": agent_name,
                    "question_count": agent_counter[agent_name],
                    "question_ratio": round(safe_divide(agent_counter[agent_name], questions_compared), 4),
                }
                for agent_name in sorted(agent_names, key=lambda name: (-agent_counter[name], name))
            ],
            "combinations": [
                {
                    "agents": list(agent_combo),
                    "question_count": count,
                    "question_ratio": round(safe_divide(count, questions_compared), 4),
                }
                for agent_combo, count in sorted(
                    combination_counter.items(),
                    key=lambda item: (-item[1], item[0]),
                )
            ],
        },
        "agent_ablations": agent_reports,
        "per_question": per_question,
    }
    return report


def compact_report(report: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "summary": report.get("summary", {}),
        "activated_agent_distribution": report.get("activated_agent_distribution", {}),
        "agent_ablations": report.get("agent_ablations", []),
    }


def get_gt_path(gt_root: Path, dataset: str) -> Path:
    filename = DATASET_GT_FILENAMES.get(dataset)
    if filename is None:
        raise ValueError(f"Unsupported dataset: {dataset}")
    return gt_root / filename


def find_result_path(results_root: Path, dataset: str, run_number: int) -> Path | None:
    matches = sorted(results_root.glob(f"{dataset}_run{run_number}_*.jsonl"))
    if not matches:
        return None
    return matches[0]


def analyze_single_pair(gt_path: Path, results_path: Path) -> Dict[str, Any]:
    gt_items = load_json(gt_path)
    if not isinstance(gt_items, list):
        raise ValueError(f"GT file must contain a list: {gt_path}")
    result_records = load_jsonl(results_path)
    return analyze(gt_items, result_records)


def analyze_batch(
    results_root: Path,
    gt_root: Path,
    datasets: Sequence[str],
    runs: Sequence[int],
) -> Dict[str, Any]:
    batch_report: Dict[str, Any] = {
        "results_root": str(results_root),
        "gt_root": str(gt_root),
        "datasets": {},
        "flat_metrics": [],
        "missing": {
            "gt_files": [],
            "result_files": [],
        },
    }

    for dataset in datasets:
        gt_path = get_gt_path(gt_root, dataset)
        dataset_entry: Dict[str, Any] = {
            "gt_path": str(gt_path),
            "runs": {},
        }
        batch_report["datasets"][dataset] = dataset_entry

        if not gt_path.exists():
            batch_report["missing"]["gt_files"].append(str(gt_path))
            continue

        gt_items = load_json(gt_path)
        if not isinstance(gt_items, list):
            raise ValueError(f"GT file must contain a list: {gt_path}")

        for run_number in runs:
            result_path = find_result_path(results_root, dataset, run_number)
            if result_path is None:
                batch_report["missing"]["result_files"].append(
                    f"{dataset}_run{run_number}_*.jsonl"
                )
                continue

            result_records = load_jsonl(result_path)
            full_report = analyze(gt_items, result_records)
            run_report = compact_report(full_report)
            run_report["run_name"] = result_path.stem
            run_report["results_path"] = str(result_path)
            dataset_entry["runs"][f"run{run_number}"] = run_report
            batch_report["flat_metrics"].append(
                {
                    "dataset": dataset,
                    "run": run_number,
                    "run_name": result_path.stem,
                    "results_path": str(result_path),
                    **run_report["summary"],
                }
            )

    batch_report["flat_metrics"] = sorted(
        batch_report["flat_metrics"],
        key=lambda item: (item["dataset"], item["run"]),
    )
    return batch_report


def resolve_output_path(
    results_path: Path | None,
    output_path: Path | None,
    batch: bool = False,
    results_root: Path | None = None,
) -> Path:
    if output_path is not None:
        return output_path
    if batch:
        if results_root is None:
            raise ValueError("results_root is required for batch output path resolution")
        return results_root / "_agent_ablation_metrics.json"
    if results_path is None:
        raise ValueError("results_path is required for single-run output path resolution")
    return results_path.with_name(results_path.stem + "_agent_ablation.json")


def print_summary(report: Dict[str, Any], title: str = "AGENT ABLATION SUMMARY") -> None:
    summary = report.get("summary", {})
    distribution = report.get("activated_agent_distribution", {})
    print("=" * 72)
    print(title)
    print("=" * 72)
    print(f"Questions compared: {summary.get('questions_compared', 0)}")
    print(f"Baseline micro-recall: {summary.get('baseline_micro_recall', 0.0):.4f}")
    print(f"Baseline macro-recall: {summary.get('baseline_macro_recall', 0.0):.4f}")
    print()
    print("Activated agent distribution:")
    for item in distribution.get("individual", []):
        print(
            f"  - {item['agent']}: {item['question_count']} questions "
            f"({item['question_ratio']:.4f})"
        )
    print()
    print("Activated agent combinations:")
    for item in distribution.get("combinations", []):
        label = ", ".join(item["agents"]) if item["agents"] else "<none>"
        print(
            f"  - [{label}]: {item['question_count']} questions "
            f"({item['question_ratio']:.4f})"
        )
    print()
    print("Leave-one-agent-out and agent-only recall:")
    for item in report.get("agent_ablations", []):
        print(
            f"  - {item['agent']}: activated={item['activated_questions']}, "
            f"without_micro={item['without_agent_micro_recall_all_questions']:.4f}, "
            f"without_macro={item['without_agent_macro_recall_all_questions']:.4f}, "
            f"delta_micro={item['delta_micro_recall_all_questions']:.4f}, "
            f"delta_macro={item['delta_macro_recall_all_questions']:.4f}, "
            f"agent_only_micro={item['agent_only_micro_recall_all_questions']:.4f}, "
            f"agent_only_macro={item['agent_only_macro_recall_all_questions']:.4f}, "
            f"unique_gt_chunks={item['unique_gt_chunks_contributed']}"
        )


def print_batch_summary(report: Dict[str, Any]) -> None:
    print("=" * 72)
    print("MULTI-DATASET AGENT ABLATION METRICS")
    print("=" * 72)
    for item in report.get("flat_metrics", []):
        print(
            f"{item['dataset']} run{item['run']}: "
            f"micro={item.get('baseline_micro_recall', 0.0):.4f}, "
            f"macro={item.get('baseline_macro_recall', 0.0):.4f}, "
            f"questions={item.get('questions_compared', 0)}"
        )
    missing = report.get("missing", {})
    missing_gt = missing.get("gt_files", [])
    missing_results = missing.get("result_files", [])
    if missing_gt or missing_results:
        print()
        print("Missing inputs:")
        for path in missing_gt:
            print(f"  - missing gt: {path}")
        for pattern in missing_results:
            print(f"  - missing result: {pattern}")


def main() -> None:
    args = parse_args()
    batch_mode = args.batch or args.results_root is not None
    if batch_mode:
        results_root = args.results_root or DEFAULT_RESULTS_ROOT
        report = analyze_batch(
            results_root=results_root,
            gt_root=args.gt_root,
            datasets=args.datasets,
            runs=args.runs,
        )
        output_path = resolve_output_path(
            results_path=None,
            output_path=args.output_path,
            batch=True,
            results_root=results_root,
        )
    else:
        report = analyze_single_pair(args.gt_path, args.results_path)
        output_path = resolve_output_path(
            results_path=args.results_path,
            output_path=args.output_path,
        )
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(
        json.dumps(report, ensure_ascii=False, indent=args.indent) + "\n",
        encoding="utf-8",
    )
    if batch_mode:
        print_batch_summary(report)
    else:
        print_summary(report)
    print()
    print(f"Wrote report to {output_path}")


if __name__ == "__main__":
    main()
