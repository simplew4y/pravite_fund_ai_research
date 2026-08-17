from __future__ import annotations

import argparse
import sys
from pathlib import Path

from .curation import assign_splits, deduplicate, review_proposals, validate_suite
from .cycle import build_generation_briefs, export_release, write_agent_packet
from .importers import import_dataset
from .io_utils import load_items, read_json, sha256_file, write_json, write_jsonl
from .report_builder import bootstrap_report_benchmark
from .report_eval import build_judge_packet, load_jsonl_dicts, structural_report_score


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(description="Private Fund AI recursive benchmark toolkit")
    commands = root.add_subparsers(dest="command", required=True)
    bootstrap = commands.add_parser("bootstrap", help="Import, curate, split, and freeze seed datasets")
    bootstrap.add_argument("--source", action="append", required=True, help="PATH or COMPANY=PATH")
    bootstrap.add_argument("--out", type=Path, required=True)
    bootstrap.add_argument("--public-ratio", type=float, default=0.4)
    bootstrap.add_argument("--salt", default="private-fund-rsi-v1")
    validate = commands.add_parser("validate", help="Validate a canonical JSONL suite")
    validate.add_argument("dataset", type=Path)
    validate.add_argument("--allow-ungrounded", action="store_true")
    next_round = commands.add_parser("next-round", help="Build agent briefs from failures and coverage gaps")
    next_round.add_argument("dataset", type=Path)
    next_round.add_argument("--results", type=Path)
    next_round.add_argument("--round", type=int, required=True)
    next_round.add_argument("--out", type=Path, required=True)
    review = commands.add_parser("review-proposals", help="Apply deterministic schema, grounding, and novelty gates")
    review.add_argument("--frozen", type=Path, required=True)
    review.add_argument("--proposals", type=Path, required=True)
    review.add_argument("--accepted", type=Path, required=True)
    review.add_argument("--report", type=Path, required=True)
    review.add_argument("--novelty-threshold", type=float, default=0.88)
    prepare = commands.add_parser("prepare-run", help="Materialize target questions and a separate judge key")
    prepare.add_argument("dataset", type=Path)
    prepare.add_argument("--split", choices=("public", "internal"), required=True)
    prepare.add_argument("--questions", type=Path, required=True)
    prepare.add_argument("--judge-key", type=Path, required=True)
    report_bootstrap = commands.add_parser("bootstrap-reports", help="Build report tasks and hidden claim rubrics")
    report_bootstrap.add_argument("--source", action="append", type=Path, required=True)
    report_bootstrap.add_argument("--out", type=Path, required=True)
    report_check = commands.add_parser("check-report", help="Run the deterministic report structure/citation gate")
    report_check.add_argument("--task", type=Path, required=True, help="One task JSON object")
    report_check.add_argument("--report", type=Path, required=True, help="Generated Markdown report")
    report_check.add_argument("--out", type=Path, required=True)
    judge_packet = commands.add_parser("prepare-report-judge", help="Join one report with its hidden task and claim rubrics")
    judge_packet.add_argument("--task-id", required=True)
    judge_packet.add_argument("--tasks", type=Path, required=True)
    judge_packet.add_argument("--claims", type=Path, required=True)
    judge_packet.add_argument("--report", type=Path, required=True)
    judge_packet.add_argument("--out", type=Path, required=True)
    return root


def _source(value: str) -> tuple[str, Path]:
    if "=" in value:
        company, raw_path = value.split("=", 1)
        return company.strip(), Path(raw_path)
    return "", Path(value)


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    if args.command == "bootstrap":
        if not 0 <= args.public_ratio <= 1:
            raise ValueError("--public-ratio must be between 0 and 1")
        items = []
        sources = []
        for raw_source in args.source:
            company, path = _source(raw_source)
            imported = import_dataset(path, company)
            items.extend(imported)
            sources.append({"path": str(path), "sha256": sha256_file(path), "imported": len(imported)})
        items, rejected = deduplicate(items)
        items = assign_splits(items, args.public_ratio, args.salt)
        validation = validate_suite(items)
        manifest = {
            "schema_version": "rsi-benchmark-manifest/v1",
            "split_policy": {"public_ratio": args.public_ratio, "salt_id": args.salt},
            "sources": sources,
            "rejected": rejected,
            "validation": validation,
            "leakage_policy": "public export excludes answer_key, key_points, evidence and private source locators",
        }
        export_release(args.out, items, manifest)
        print(f"wrote {len(items)} items to {args.out}; valid={validation['valid']}")
        return 0 if validation["valid"] else 2
    if args.command == "validate":
        report = validate_suite(load_items(args.dataset), require_grounding=not args.allow_ungrounded)
        print_report = args.dataset.with_suffix(".validation.json")
        write_json(print_report, report)
        print(f"valid={report['valid']} items={report['item_count']} report={print_report}")
        return 0 if report["valid"] else 2
    if args.command == "next-round":
        items = load_items(args.dataset)
        briefs = build_generation_briefs(items, args.results, args.round)
        write_agent_packet(args.out, briefs, args.round)
        print(f"wrote {len(briefs)} generation briefs to {args.out}")
        return 0
    if args.command == "review-proposals":
        accepted, rejected = review_proposals(
            load_items(args.frozen), load_items(args.proposals), args.novelty_threshold
        )
        write_jsonl(args.accepted, [item.to_dict() for item in accepted])
        write_json(args.report, {
            "accepted": len(accepted), "rejected": len(rejected), "rejections": rejected,
            "note": "Accepted here means deterministic pre-review only; independent evidence/model review is still required before freeze.",
        })
        print(f"accepted={len(accepted)} rejected={len(rejected)} report={args.report}")
        return 0 if not rejected else 2
    if args.command == "prepare-run":
        selected = [item for item in load_items(args.dataset) if item.split == args.split]
        target_rows = [
            {"index": item.item_id, "qid": item.item_id, "question": item.question}
            for item in selected
        ]
        judge_rows = [
            {
                "index": item.item_id, "qid": item.item_id, "question": item.question,
                "ground_truth_answer": item.answer_key, "key_points": list(item.key_points),
                "diagnostic_meta": {
                    "company": item.company, "capabilities": list(item.capabilities),
                    "split": item.split, "temporal_scope": item.temporal_scope,
                },
            }
            for item in selected
        ]
        write_json(args.questions, target_rows)
        write_json(args.judge_key, judge_rows)
        print(f"prepared {len(selected)} {args.split} questions; keep {args.judge_key} away from the target agent")
        return 0
    if args.command == "bootstrap-reports":
        manifest = bootstrap_report_benchmark(args.source, args.out)
        print(
            f"wrote report benchmark to {args.out}; tasks={manifest['counts']['tasks']} "
            f"claims={manifest['counts']['claims']}"
        )
        return 0
    if args.command == "check-report":
        task = read_json(args.task)
        report = structural_report_score(args.report, task)
        write_json(args.out, report)
        print(f"valid={report['valid']} structure={report['structure_score']} report={args.out}")
        return 0 if report["valid"] else 2
    if args.command == "prepare-report-judge":
        task = next((row for row in load_jsonl_dicts(args.tasks) if row.get("task_id") == args.task_id), None)
        if task is None:
            raise ValueError(f"Unknown task_id: {args.task_id}")
        packet = build_judge_packet(args.report, task, load_jsonl_dicts(args.claims))
        write_json(args.out, packet)
        print(f"wrote judge packet with {len(packet['claim_rubrics'])} claims to {args.out}")
        return 0
    return 1


if __name__ == "__main__":
    sys.exit(main())
