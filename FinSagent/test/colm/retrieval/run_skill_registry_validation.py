#!/usr/bin/env python3
"""Run the lightweight Skill Registry validation flow.

This runner intentionally avoids expensive generation/judge work by default.
It checks registry evidence, renders a compact validation report, and can run
the deterministic table repair/gate flow when ``--run_gates`` is passed.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path
from typing import Any


def _load_json(path: Path) -> Any:
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def _write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)


def _rel_exists(root: Path, rel_path: str) -> bool:
    return bool(rel_path) and (root / rel_path).exists()


def _collect_artifact_checks(root: Path, manifest: dict[str, Any]) -> list[dict[str, Any]]:
    checks: list[dict[str, Any]] = []
    for key, validation in dict(manifest.get("validation_sets") or {}).items():
        path = str(validation.get("path") or "")
        checks.append(
            {
                "kind": "validation_set",
                "owner": key,
                "path": path,
                "exists": _rel_exists(root, path),
            }
        )
    for skill in manifest.get("skills") or []:
        skill_id = str(skill.get("id") or "")
        for path in skill.get("evidence_artifacts") or []:
            checks.append(
                {
                    "kind": "evidence_artifact",
                    "owner": skill_id,
                    "path": str(path),
                    "exists": _rel_exists(root, str(path)),
                }
            )
        for path in skill.get("primary_files") or []:
            checks.append(
                {
                    "kind": "primary_file",
                    "owner": skill_id,
                    "path": str(path),
                    "exists": _rel_exists(root, str(path)),
                }
            )
    return checks


def _run_command(command: list[str], cwd: Path) -> dict[str, Any]:
    started = time.time()
    completed = subprocess.run(
        command,
        cwd=str(cwd),
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    elapsed = time.time() - started
    return {
        "command": command,
        "returncode": completed.returncode,
        "elapsed_sec": round(elapsed, 3),
        "stdout_tail": completed.stdout[-4000:],
        "stderr_tail": completed.stderr[-4000:],
    }


def _gate_summary(path: Path) -> dict[str, Any]:
    payload = _load_json(path)
    if not isinstance(payload, dict):
        return {"path": str(path), "status": "invalid", "reason": "not a JSON object"}
    decision_counts = dict(payload.get("gate_decision_counts") or {})
    status_counts = dict(payload.get("verifier_status_counts") or {})
    row_count = int(payload.get("row_count") or 0)
    blocked = int(decision_counts.get("BLOCK") or 0)
    review = int(decision_counts.get("REVIEW") or 0)
    allowed = int(decision_counts.get("ALLOW") or 0)
    pass_gate = row_count > 0 and blocked == 0 and review == 0 and allowed == row_count
    return {
        "path": str(path),
        "status": "PASS" if pass_gate else "REVIEW",
        "row_count": row_count,
        "gate_decision_counts": decision_counts,
        "verifier_status_counts": status_counts,
    }


def _run_lightweight_gates(
    root: Path,
    manifest: dict[str, Any],
    out_dir: Path,
    zeekr_table_dir: str,
    nvidia_table_dir: str,
) -> dict[str, Any]:
    validation_sets = dict(manifest.get("validation_sets") or {})
    protected = str(validation_sets["protected_regression"]["path"])
    diagnostic = str(validation_sets["development_diagnostic"]["path"])
    cross_company = str(validation_sets["cross_company_sanity"]["path"])

    outputs = {
        "diagnostic_repaired": out_dir / "development_diagnostic_table_repaired.json",
        "diagnostic_gate": out_dir / "development_diagnostic_gate.json",
        "protected_gate": out_dir / "protected_small30_gate.json",
        "cross_company_gate": out_dir / "cross_company_nvidia_mini10_gate.json",
    }
    commands = [
        [
            sys.executable,
            "test/colm/retrieval/apply_table_answer_repair.py",
            "--generated_answers_json",
            diagnostic,
            "--out_json",
            str(outputs["diagnostic_repaired"]),
            "--reconstructed_table_dir",
            zeekr_table_dir,
        ],
        [
            sys.executable,
            "test/colm/retrieval/apply_table_answer_gate.py",
            "--generated_answers_json",
            str(outputs["diagnostic_repaired"]),
            "--out_json",
            str(outputs["diagnostic_gate"]),
            "--reconstructed_table_dir",
            zeekr_table_dir,
        ],
        [
            sys.executable,
            "test/colm/retrieval/apply_table_answer_gate.py",
            "--generated_answers_json",
            protected,
            "--out_json",
            str(outputs["protected_gate"]),
            "--reconstructed_table_dir",
            zeekr_table_dir,
        ],
        [
            sys.executable,
            "test/colm/retrieval/apply_table_answer_gate.py",
            "--generated_answers_json",
            cross_company,
            "--out_json",
            str(outputs["cross_company_gate"]),
            "--reconstructed_table_dir",
            nvidia_table_dir,
        ],
    ]

    command_results = []
    for command in commands:
        result = _run_command(command, root)
        command_results.append(result)
        if result["returncode"] != 0:
            break

    gate_summaries = {}
    for key in ("diagnostic_gate", "protected_gate", "cross_company_gate"):
        path = outputs[key]
        gate_summaries[key] = _gate_summary(path) if path.exists() else {"path": str(path), "status": "MISSING"}

    all_commands_passed = all(result["returncode"] == 0 for result in command_results)
    protected_pass = gate_summaries["protected_gate"].get("status") == "PASS"
    cross_pass = gate_summaries["cross_company_gate"].get("status") == "PASS"
    diagnostic_pass = gate_summaries["diagnostic_gate"].get("status") == "PASS"
    return {
        "commands": command_results,
        "outputs": {key: str(value) for key, value in outputs.items()},
        "gate_summaries": gate_summaries,
        "overall_status": "PASS" if all_commands_passed and protected_pass and cross_pass and diagnostic_pass else "REVIEW",
    }


def _skill_recommendations(
    manifest: dict[str, Any],
    artifact_checks: list[dict[str, Any]],
    gate_flow: dict[str, Any] | None,
) -> list[dict[str, Any]]:
    missing_by_owner: dict[str, list[str]] = {}
    for check in artifact_checks:
        if not check.get("exists"):
            missing_by_owner.setdefault(str(check.get("owner")), []).append(str(check.get("path")))
    gates_passed = gate_flow is not None and gate_flow.get("overall_status") == "PASS"
    recommendations: list[dict[str, Any]] = []
    for skill in manifest.get("skills") or []:
        skill_id = str(skill.get("id") or "")
        status = str(skill.get("status") or "")
        risk = str(skill.get("risk") or "")
        auto_approval = str(skill.get("auto_approval") or "")
        missing = missing_by_owner.get(skill_id, [])
        if missing:
            decision = "needs_evidence"
            reason = "registered artifacts or primary files are missing"
        elif status == "candidate_promote" and risk == "low" and auto_approval == "eligible" and gates_passed:
            decision = "eligible_for_guarded_promotion"
            reason = "low-risk candidate with clean lightweight gates"
        elif status == "candidate_promote":
            decision = "candidate_review"
            reason = "candidate needs manual review or a gate run"
        elif status in {"promoted_guarded", "frozen_baseline"}:
            decision = "keep_guarded"
            reason = "already part of the guarded chain"
        elif status == "offline_candidate":
            decision = "keep_offline"
            reason = "not ready for online promotion"
        else:
            decision = "backlog"
            reason = "not part of the current optimization loop"
        recommendations.append(
            {
                "skill_id": skill_id,
                "status": status,
                "risk": risk,
                "auto_approval": auto_approval,
                "decision": decision,
                "reason": reason,
                "missing_paths": missing,
            }
        )
    return recommendations


def _recommendation_by_skill(recommendations: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    return {str(rec.get("skill_id") or ""): rec for rec in recommendations}


def _card_action(decision: str) -> tuple[str, str]:
    if decision == "eligible_for_guarded_promotion":
        return "approve_guarded", "Can be approved into guarded mode after human acknowledgement."
    if decision == "candidate_review":
        return "review", "Needs manual review before promotion."
    if decision == "keep_guarded":
        return "keep", "Already guarded; keep monitoring."
    if decision == "keep_offline":
        return "keep_offline", "Keep offline until stronger validation exists."
    if decision == "needs_evidence":
        return "fix_evidence", "Fix missing evidence paths before any decision."
    return "backlog", "Do not work on this in the current loop."


def _approval_mode(skill: dict[str, Any], rec: dict[str, Any]) -> str:
    if rec.get("decision") == "eligible_for_guarded_promotion":
        return "low_risk_auto_eligible"
    if skill.get("auto_approval") == "review_required":
        return "manual_review_required"
    if rec.get("decision") in {"keep_guarded", "keep_offline", "backlog"}:
        return "no_action"
    return "manual_review_required"


def _build_candidate_cards(
    manifest: dict[str, Any],
    recommendations: list[dict[str, Any]],
    gate_flow: dict[str, Any] | None,
) -> list[dict[str, Any]]:
    rec_by_skill = _recommendation_by_skill(recommendations)
    gate_summaries = dict((gate_flow or {}).get("gate_summaries") or {})
    cards: list[dict[str, Any]] = []
    for skill in manifest.get("skills") or []:
        skill_id = str(skill.get("id") or "")
        rec = rec_by_skill.get(skill_id, {})
        decision = str(rec.get("decision") or "unknown")
        action, action_label = _card_action(decision)
        next_state = (
            "promoted_guarded"
            if decision == "eligible_for_guarded_promotion"
            else skill.get("status")
        )
        cards.append(
            {
                "card_id": f"skill-card::{skill_id}",
                "skill_id": skill_id,
                "name": skill.get("name"),
                "type": skill.get("type"),
                "current_status": skill.get("status"),
                "proposed_next_status": next_state,
                "risk": skill.get("risk"),
                "auto_approval": skill.get("auto_approval"),
                "approval_mode": _approval_mode(skill, rec),
                "recommended_action": action,
                "recommended_action_label": action_label,
                "decision": decision,
                "decision_reason": rec.get("reason"),
                "goal": skill.get("goal"),
                "trigger_conditions": list(skill.get("trigger_conditions") or []),
                "evidence_artifacts": list(skill.get("evidence_artifacts") or []),
                "primary_files": list(skill.get("primary_files") or []),
                "boundary": skill.get("boundary"),
                "missing_paths": list(rec.get("missing_paths") or []),
                "gate_flow_status": (gate_flow or {}).get("overall_status", "not_run"),
                "gate_summaries": gate_summaries,
                "rollback_note": "Disable this skill or revert its primary files; rerun protected and cross-company gates.",
            }
        )
    return cards


def _render_cards_markdown(cards: list[dict[str, Any]]) -> str:
    lines = [
        "# Skill Candidate Cards",
        "",
        "| skill | action | status -> next | risk | approval | reason |",
        "| --- | --- | --- | --- | --- | --- |",
    ]
    for card in cards:
        lines.append(
            f"| {card.get('skill_id')} | {card.get('recommended_action')} | "
            f"{card.get('current_status')} -> {card.get('proposed_next_status')} | "
            f"{card.get('risk')} | {card.get('approval_mode')} | {card.get('decision_reason')} |"
        )
    lines.extend(["", "## Details", ""])
    for card in cards:
        lines.extend(
            [
                f"### {card.get('skill_id')}",
                "",
                f"- Name: {card.get('name')}",
                f"- Action: {card.get('recommended_action')} ({card.get('recommended_action_label')})",
                f"- Status: {card.get('current_status')} -> {card.get('proposed_next_status')}",
                f"- Risk: {card.get('risk')}",
                f"- Approval mode: {card.get('approval_mode')}",
                f"- Goal: {card.get('goal')}",
                f"- Boundary: {card.get('boundary')}",
                f"- Rollback: {card.get('rollback_note')}",
                "",
                "Evidence:",
            ]
        )
        evidence = list(card.get("evidence_artifacts") or [])
        lines.extend([f"- `{path}`" for path in evidence] or ["- None"])
        missing = list(card.get("missing_paths") or [])
        lines.extend(["", "Missing paths:"])
        lines.extend([f"- `{path}`" for path in missing] or ["- None"])
        lines.append("")
    return "\n".join(lines)


def _render_markdown(summary: dict[str, Any]) -> str:
    lines = [
        "# Skill Registry Validation",
        "",
        f"Generated: {summary.get('generated_at', '')}",
        "",
        f"Manifest: `{summary.get('manifest', '')}`",
        f"Output dir: `{summary.get('out_dir', '')}`",
        "",
        "## Summary",
        "",
        f"- Artifact checks: {summary['artifact_check_counts']}",
        f"- Gate flow: {summary.get('gate_flow_status', 'not_run')}",
        "",
        "## Gate Summaries",
        "",
    ]
    gate_flow = summary.get("gate_flow") or {}
    gate_summaries = gate_flow.get("gate_summaries") or {}
    if not gate_summaries:
        lines.append("- Not run. Use `--run_gates` for lightweight deterministic gates.")
    else:
        for key, value in gate_summaries.items():
            lines.append(
                f"- {key}: {value.get('status')} rows={value.get('row_count')} "
                f"decisions={value.get('gate_decision_counts')}"
            )
    lines.extend(["", "## Skill Recommendations", ""])
    lines.extend(
        [
            "| skill | status | risk | decision | reason |",
            "| --- | --- | --- | --- | --- |",
        ]
    )
    for rec in summary.get("skill_recommendations") or []:
        lines.append(
            f"| {rec['skill_id']} | {rec['status']} | {rec['risk']} | "
            f"{rec['decision']} | {rec['reason']} |"
        )
    cards = list(summary.get("candidate_cards") or [])
    action_counts: dict[str, int] = {}
    for card in cards:
        action = str(card.get("recommended_action") or "")
        action_counts[action] = action_counts.get(action, 0) + 1
    lines.extend(["", "## Candidate Cards", ""])
    if not cards:
        lines.append("- Not generated")
    else:
        lines.append(f"- Card count: {len(cards)}")
        lines.append(f"- Action counts: {action_counts}")
        lines.append("- See `skill_candidate_cards.json` and `SKILL_CANDIDATE_CARDS.md`.")
    missing = [check for check in summary.get("artifact_checks") or [] if not check.get("exists")]
    lines.extend(["", "## Missing Paths", ""])
    if not missing:
        lines.append("- None")
    else:
        for check in missing:
            lines.append(f"- {check.get('owner')}: `{check.get('path')}`")
    lines.extend(["", "## Boundary Reminder", ""])
    for stop in summary.get("stop_conditions") or []:
        lines.append(f"- {stop}")
    lines.append("")
    return "\n".join(lines)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", default="test/colm/retrieval/skill_registry_manifest_20260603.json")
    parser.add_argument("--out_dir", default=None)
    parser.add_argument("--run_gates", action="store_true")
    parser.add_argument("--zeekr_table_dir", default="/root/autodl-tmp/RAG_Agent_data/Zeekr/20250729/tables")
    parser.add_argument("--nvidia_table_dir", default="/root/autodl-tmp/RAG_Agent_data/nvidia/20260425/4_processed_table")
    args = parser.parse_args()

    root = Path.cwd()
    manifest_path = Path(args.manifest)
    manifest = _load_json(manifest_path)
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    out_dir = Path(args.out_dir or f"test/colm/retrieval/skill_registry_validation_{stamp}")
    out_dir.mkdir(parents=True, exist_ok=True)

    artifact_checks = _collect_artifact_checks(root, manifest)
    artifact_check_counts = {
        "total": len(artifact_checks),
        "ok": sum(1 for check in artifact_checks if check.get("exists")),
        "missing": sum(1 for check in artifact_checks if not check.get("exists")),
    }
    gate_flow = None
    if args.run_gates:
        gate_flow = _run_lightweight_gates(root, manifest, out_dir, args.zeekr_table_dir, args.nvidia_table_dir)

    recommendations = _skill_recommendations(manifest, artifact_checks, gate_flow)
    candidate_cards = _build_candidate_cards(manifest, recommendations, gate_flow)
    summary = {
        "generated_at": datetime.now().isoformat(timespec="seconds"),
        "manifest": str(manifest_path),
        "out_dir": str(out_dir),
        "artifact_check_counts": artifact_check_counts,
        "artifact_checks": artifact_checks,
        "gate_flow_status": (gate_flow or {}).get("overall_status", "not_run"),
        "gate_flow": gate_flow,
        "skill_recommendations": recommendations,
        "candidate_cards": candidate_cards,
        "stop_conditions": list((manifest.get("global_boundary_policy") or {}).get("stop_conditions") or []),
    }

    summary_path = out_dir / "skill_registry_validation_summary.json"
    report_path = out_dir / "SKILL_REGISTRY_VALIDATION.md"
    cards_path = out_dir / "skill_candidate_cards.json"
    cards_md_path = out_dir / "SKILL_CANDIDATE_CARDS.md"
    _write_json(summary_path, summary)
    _write_json(cards_path, candidate_cards)
    report_path.write_text(_render_markdown(summary), encoding="utf-8")
    cards_md_path.write_text(_render_cards_markdown(candidate_cards), encoding="utf-8")
    print(
        json.dumps(
            {
                "summary": str(summary_path),
                "report": str(report_path),
                "candidate_cards": str(cards_path),
                "candidate_cards_md": str(cards_md_path),
                "artifact_check_counts": artifact_check_counts,
                "gate_flow_status": summary["gate_flow_status"],
            },
            ensure_ascii=False,
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
