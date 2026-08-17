from __future__ import annotations

from collections import Counter
from pathlib import Path

from .io_utils import read_json, write_json, write_jsonl
from .models import BenchmarkItem


def build_generation_briefs(items: list[BenchmarkItem], results_path: Path | None, round_no: int) -> list[dict]:
    results = read_json(results_path) if results_path else []
    if isinstance(results, dict):
        results = results.get("results", [])
    by_id = {item.item_id: item for item in items}
    briefs: list[dict] = []
    for row in results:
        passed = row.get("passed") is True or str(row.get("judge_verdict", "")).upper() == "CORRECT"
        item_id = str(row.get("item_id") or row.get("qid") or "")
        if passed or item_id not in by_id:
            continue
        parent = by_id[item_id]
        briefs.append({
            "brief_id": f"round-{round_no}-failure-{item_id}",
            "kind": "failure_neighbor",
            "parent_ids": [item_id],
            "company": parent.company,
            "capabilities": list(parent.capabilities),
            "failure_signal": row.get("error_primary_subtype") or row.get("judge_analysis") or "incorrect answer",
            "instruction": "Generate a new evidence-grounded question that tests the same transferable capability with different facts, wording, and answer. Do not paraphrase the parent question.",
        })
    coverage = Counter(capability for item in items for capability in item.capabilities)
    if coverage:
        target = max(coverage.values())
        for capability, count in sorted(coverage.items(), key=lambda pair: (pair[1], pair[0])):
            if count < target:
                briefs.append({
                    "brief_id": f"round-{round_no}-gap-{capability}",
                    "kind": "coverage_gap",
                    "parent_ids": [],
                    "capabilities": [capability],
                    "requested_count": min(3, target - count),
                    "instruction": "Generate grounded questions for this under-covered capability across companies not already dominant in the suite.",
                })
    return briefs


def write_agent_packet(path: Path, briefs: list[dict], round_no: int) -> None:
    write_json(path, {
        "schema_version": "rsi-generation-packet/v1",
        "generation_round": round_no,
        "rules": [
            "Every proposal must include question, answer_key, key_points, company, capabilities, and evidence references.",
            "Evidence must resolve to an allowed corpus source and support every key point.",
            "Do not expose or imitate internal questions; use only the supplied abstract failure signal.",
            "Reject questions answerable from unstable live facts unless an explicit as-of time is present.",
            "Generate capability neighbors, not lexical paraphrases of parent questions.",
        ],
        "briefs": briefs,
    })


def export_release(out_dir: Path, items: list[BenchmarkItem], manifest: dict) -> None:
    public = [item.to_dict(public=True) for item in items if item.split == "public"]
    internal = [item.to_dict(public=False) for item in items if item.split == "internal"]
    canonical = [item.to_dict(public=False) for item in items]
    write_jsonl(out_dir / "canonical.jsonl", canonical)
    write_jsonl(out_dir / "public" / "questions.jsonl", public)
    write_jsonl(out_dir / "internal" / "answer_key.jsonl", internal)
    write_json(out_dir / "manifest.json", manifest)
