"""Trusted synthesis stage for an isolated retrieval-selection candidate."""

from __future__ import annotations

import argparse
import asyncio
import json
import os
from pathlib import Path
from typing import Any

import yaml

from core.SessionManager import SessionManager
from core.naiverag_helper import _build_prompt, _call_final_answer
from evaluation.rsi_benchmark.captured_retrieval_replay import (
    _canonicalize_candidate_selection,
    _read_jsonl,
)
from rsi.candidate_skills.exact_date_numeric_rescue_v1 import select_exact_date_numeric_evidence


def restore_verified_exact_annotations(
    question: str, chunks: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Recompute annotations from canonical source text; never trust candidate metadata."""
    probe = select_exact_date_numeric_evidence(question, chunks, [])
    if not probe.get("rescue_applied"):
        return chunks
    index = int(probe["rescued_candidate_indices"][0])
    restored = list(chunks)
    restored[index] = probe["selected_chunks"][0]
    return restored


def prepare_synthesis_rows(
    captures_path: Path,
    questions_path: Path,
    candidate_outputs_path: Path,
) -> list[dict[str, Any]]:
    question_rows = _read_jsonl(questions_path)
    for row in question_rows:
        if set(row) - {"case_id", "question"}:
            raise ValueError("question input must be question-only")
    questions = {row["case_id"]: row["question"] for row in question_rows}
    captures = {row["case_id"]: row for row in _read_jsonl(captures_path)}
    outputs = _read_jsonl(candidate_outputs_path)
    rows: list[dict[str, Any]] = []
    for output in outputs:
        case_id = output["case_id"]
        if case_id not in questions or case_id not in captures:
            raise ValueError(f"unmatched case_id: {case_id}")
        capture = captures[case_id]
        allowed = (capture.get("pre_rerank_candidates") or []) + (capture.get("retrieved_chunks") or [])
        if "selected_chunks" in output:
            raw_selection = output["selected_chunks"]
        elif "retrieved_chunks" in output:
            raw_selection = output["retrieved_chunks"]
        else:
            raise ValueError("candidate output has no selected_chunks or retrieved_chunks field")
        selected = _canonicalize_candidate_selection(raw_selection or [], allowed)
        if raw_selection and not selected:
            raise ValueError("non-empty candidate selection canonicalized to empty")
        selected = restore_verified_exact_annotations(questions[case_id], selected)
        rows.append({
            "case_id": case_id,
            "seed": int(output.get("seed", capture.get("seed", 0))),
            "question": questions[case_id],
            "selected_chunks": selected,
            "candidate_id": output.get("candidate_id", ""),
        })
    return rows


def format_trusted_context(chunks: list[dict[str, Any]]) -> str:
    separator = "\n" + "-" * 60 + "\n"
    formatted: list[str] = []
    for chunk in chunks:
        metadata = chunk.get("metadata") or {}
        priority = ""
        date_label = "Date Published"
        if metadata.get("exact_anchor_rescue"):
            exact_dates = ", ".join(metadata.get("exact_anchor_dates") or [])
            priority = (
                "Evidence Priority: exact query date and metric anchors matched in chunk content; "
                f"Exact Content Date Anchor(s): {exact_dates or 'N/A'}; "
            )
            date_label = "Source Date Metadata (semantic type unverified)"
        elif metadata.get("evidence_rescue"):
            priority = "Evidence Priority: recent numeric candidate; "
        formatted.append(
            f"{priority}{date_label}: {metadata.get('date_published', 'N/A')}; "
            f"Chunk Source: {metadata.get('doc_id', metadata.get('source_file', 'N/A'))}; "
            f"Chunk Content: {chunk.get('page_content', '')}"
        )
    return separator.join(formatted)


async def synthesize_rows(rows: list[dict[str, Any]], config: dict[str, Any]) -> list[dict[str, Any]]:
    generated: list[dict[str, Any]] = []
    for row in rows:
        context = format_trusted_context(row["selected_chunks"])
        prompt = _build_prompt(row["question"], context)
        session = SessionManager(f"rsi-trusted-synthesis-{row['case_id']}", config)
        answer = await _call_final_answer(
            session, [{"role": "user", "content": prompt}], temperature=0, max_tokens=4096,
        )
        generated.append({
            "qid": row["case_id"],
            "case_id": row["case_id"],
            "seed": row["seed"],
            "arm": "candidate",
            "candidate_id": row["candidate_id"],
            "answer": answer,
        })
    return generated


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--captures", type=Path, required=True)
    parser.add_argument("--questions", type=Path, required=True)
    parser.add_argument("--candidate-outputs", type=Path, required=True)
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    rows = prepare_synthesis_rows(args.captures, args.questions, args.candidate_outputs)
    config = yaml.safe_load(args.config.read_text(encoding="utf-8"))
    generated = asyncio.run(synthesize_rows(rows, config))
    args.out.parent.mkdir(parents=True, exist_ok=True)
    with args.out.open("x", encoding="utf-8") as handle:
        for row in generated:
            handle.write(json.dumps(row, ensure_ascii=False, sort_keys=True) + "\n")
    os.chmod(args.out, 0o600)
    print(len(generated))


if __name__ == "__main__":
    main()
