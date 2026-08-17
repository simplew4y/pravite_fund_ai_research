"""Execute one bounded, real-code Skill RSI cycle and persist every artifact."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from typing import Any

from evaluation.rsi_benchmark.paired_compare import compare_candidate
from evaluation.rsi_benchmark.skill_replay import SkillReplayJudgeAdapter, SkillReplayTargetAdapter

from .archive import AppendOnlyArchive
from .candidate_materializer import materialize_candidate
from .models import CandidatePatch, MutationLevel
from .trace_collector import TraceCollector


def load_json(path: str | Path) -> Any:
    return json.loads(Path(path).read_text(encoding="utf-8"))


def load_jsonl(path: str | Path) -> list[dict[str, Any]]:
    return [json.loads(line) for line in Path(path).read_text(encoding="utf-8").splitlines() if line.strip()]


def candidate_from_manifest(value: dict[str, Any]) -> CandidatePatch:
    return CandidatePatch(
        candidate_id=str(value["candidate_id"]), cluster_id=str(value["cluster_id"]),
        mutation_level=MutationLevel.parse(value["mutation_level"]), hypothesis=str(value["hypothesis"]),
        expected_mechanism=str(value["expected_mechanism"]), target_paths=tuple(value["target_paths"]),
        target_capabilities=tuple(value.get("target_capabilities", [])),
        target_failure_types=tuple(value.get("target_failure_types", [])),
        patch_payload=dict(value.get("patch_payload") or {}),
        requires_human_approval=bool(value.get("requires_human_approval", False)),
    )


def run_cycle(*, manifest_path: str | Path, evaluator_cases: str | Path, out_dir: str | Path) -> dict[str, Any]:
    manifest_path = Path(manifest_path).resolve()
    manifest = load_json(manifest_path)
    candidate = candidate_from_manifest(manifest["candidate"])
    repo_root = Path(manifest["repo_root"]).resolve()
    output = Path(out_dir).resolve()
    output.mkdir(parents=True, exist_ok=True)
    trace = TraceCollector(output / "cycle_trace.jsonl", run_id=str(manifest["cycle_id"]))
    trace.append("cycle_started", {"candidate_id": candidate.candidate_id, "manifest": str(manifest_path)})

    patch_path = (manifest_path.parent / manifest["patch_file"]).resolve()
    workspace = Path(manifest["workspace_root"]).resolve() / candidate.candidate_id
    materialized = materialize_candidate(
        repo_root=repo_root, baseline_ref=str(manifest["baseline_ref"]), workspace=workspace,
        candidate=candidate, patch_path=patch_path,
    )
    trace.append("candidate_materialized", materialized.to_dict())
    baseline_finsagent = repo_root / "FinSagent"
    candidate_finsagent = Path(materialized.worktree) / "FinSagent"
    target = SkillReplayTargetAdapter(
        baseline_finsagent, candidate_finsagent,
        str(manifest["target"]["module_path"]), str(manifest["target"]["function_name"]),
    )
    cases = load_jsonl(evaluator_cases)
    evaluator_snapshot = {
        "schema_version": "rsi-evaluator-snapshot/v1",
        "cycle_id": str(manifest["cycle_id"]),
        "sha256": hashlib.sha256(Path(evaluator_cases).read_bytes()).hexdigest(),
        "case_count": len(cases),
        "content_embedded": False,
    }
    trace.append("evaluator_snapshot_attached", evaluator_snapshot)
    seeds = tuple(int(seed) for seed in manifest.get("seeds", [11, 29, 47]))
    payload = compare_candidate(candidate, cases, target=target, judge=SkillReplayJudgeAdapter(), seeds=seeds, out_dir=output / "paired")
    trace.append("paired_evaluation_completed", {
        "candidate_id": candidate.candidate_id,
        "observation_count": payload["summary"]["observation_count"],
        "decision": payload["promotion_decision"]["decision"],
    })
    archive = AppendOnlyArchive(output / "archive")
    archive.put("candidate", candidate.candidate_id, candidate.to_dict())
    archive.put("evaluator_snapshot", str(manifest["cycle_id"]), evaluator_snapshot)
    archive.put("experiment", str(manifest["cycle_id"]), payload)
    summary = {
        "cycle_id": manifest["cycle_id"],
        "candidate_id": candidate.candidate_id,
        "baseline_commit": materialized.base_commit,
        "patch_sha256": materialized.patch_sha256,
        "case_count": len(cases),
        "seed_count": len(seeds),
        "decision": payload["promotion_decision"]["decision"],
        "reasons": payload["promotion_decision"]["reasons"],
        "metrics": payload["summary"],
        "worktree": materialized.worktree,
        "evaluator_snapshot": evaluator_snapshot,
    }
    (output / "cycle_summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return summary


def main() -> None:
    parser = argparse.ArgumentParser(description="Run one bounded FinSagent Skill RSI cycle")
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--evaluator-cases", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    print(json.dumps(run_cycle(manifest_path=args.manifest, evaluator_cases=args.evaluator_cases, out_dir=args.out), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
