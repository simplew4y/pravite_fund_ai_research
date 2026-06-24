#!/usr/bin/env python3
"""Apply Skill Candidate Card decisions to a copied registry manifest.

This script is deliberately conservative:
- it never mutates the source manifest in place;
- dry-run is the default mode;
- automatic promotion is limited to low-risk deterministic candidates whose
  cards report clean gates and no missing evidence.
"""

from __future__ import annotations

import argparse
import copy
import json
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


def _cards_by_skill(cards: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    return {str(card.get("skill_id") or ""): card for card in cards}


def _is_guarded_promotion_eligible(card: dict[str, Any], allow_without_gate: bool) -> tuple[bool, str]:
    if card.get("recommended_action") != "approve_guarded":
        return False, "card action is not approve_guarded"
    if card.get("approval_mode") != "low_risk_auto_eligible":
        return False, "card is not low-risk auto eligible"
    if card.get("risk") != "low":
        return False, "risk is not low"
    if card.get("proposed_next_status") != "promoted_guarded":
        return False, "proposed next status is not promoted_guarded"
    if card.get("missing_paths"):
        return False, "card has missing evidence or primary files"
    if not allow_without_gate and card.get("gate_flow_status") != "PASS":
        return False, "gate flow is not PASS"
    return True, "eligible low-risk guarded promotion"


def _should_apply(
    mode: str,
    skill_id: str,
    card: dict[str, Any],
    explicit_approvals: set[str],
    allow_without_gate: bool,
) -> tuple[bool, str]:
    eligible, reason = _is_guarded_promotion_eligible(card, allow_without_gate)
    if mode == "dry_run":
        return False, f"dry-run only; {reason}"
    if mode == "auto_guarded":
        return eligible, reason
    if mode == "explicit":
        if skill_id not in explicit_approvals:
            return False, "not in explicit approval list"
        return eligible, reason
    return False, f"unsupported mode: {mode}"


def _append_decision(skill: dict[str, Any], decision: dict[str, Any]) -> None:
    history = list(skill.get("decision_history") or [])
    history.append(decision)
    skill["decision_history"] = history[-20:]
    skill["last_decision"] = decision


def _apply_decisions(
    manifest: dict[str, Any],
    cards: list[dict[str, Any]],
    mode: str,
    explicit_approvals: set[str],
    allow_without_gate: bool,
) -> tuple[dict[str, Any], dict[str, Any]]:
    next_manifest = copy.deepcopy(manifest)
    card_by_skill = _cards_by_skill(cards)
    generated_at = datetime.now().isoformat(timespec="seconds")
    applied: list[dict[str, Any]] = []
    skipped: list[dict[str, Any]] = []
    blocked: list[dict[str, Any]] = []

    for skill in next_manifest.get("skills") or []:
        skill_id = str(skill.get("id") or "")
        card = card_by_skill.get(skill_id)
        if not card:
            skipped.append({"skill_id": skill_id, "reason": "no card found"})
            continue

        should_apply, reason = _should_apply(mode, skill_id, card, explicit_approvals, allow_without_gate)
        from_status = str(skill.get("status") or "")
        to_status = str(card.get("proposed_next_status") or from_status)
        record = {
            "skill_id": skill_id,
            "from_status": from_status,
            "to_status": to_status,
            "mode": mode,
            "reason": reason,
            "card_id": card.get("card_id"),
            "recommended_action": card.get("recommended_action"),
            "approval_mode": card.get("approval_mode"),
            "gate_flow_status": card.get("gate_flow_status"),
        }

        if should_apply:
            skill["status"] = to_status
            decision = {
                "applied_at": generated_at,
                "mode": mode,
                "from_status": from_status,
                "to_status": to_status,
                "source_card_id": card.get("card_id"),
                "reason": reason,
                "gate_flow_status": card.get("gate_flow_status"),
            }
            _append_decision(skill, decision)
            applied.append(record)
        elif card.get("recommended_action") == "approve_guarded" and mode != "dry_run":
            blocked.append(record)
        else:
            skipped.append(record)

    summary = {
        "generated_at": generated_at,
        "mode": mode,
        "allow_without_gate": allow_without_gate,
        "explicit_approvals": sorted(explicit_approvals),
        "counts": {
            "applied": len(applied),
            "blocked": len(blocked),
            "skipped": len(skipped),
        },
        "applied": applied,
        "blocked": blocked,
        "skipped": skipped,
    }
    return next_manifest, summary


def _render_report(summary: dict[str, Any], args: argparse.Namespace) -> str:
    lines = [
        "# Skill Card Decision Report",
        "",
        f"Generated: {summary.get('generated_at')}",
        f"Mode: `{summary.get('mode')}`",
        f"Manifest: `{args.manifest}`",
        f"Cards: `{args.cards}`",
        f"Output manifest: `{args.out_manifest}`",
        f"Allow without gate: `{summary.get('allow_without_gate')}`",
        "",
        "## Counts",
        "",
    ]
    counts = dict(summary.get("counts") or {})
    for key in ("applied", "blocked", "skipped"):
        lines.append(f"- {key}: {counts.get(key, 0)}")

    def add_table(title: str, rows: list[dict[str, Any]]) -> None:
        lines.extend(["", f"## {title}", ""])
        if not rows:
            lines.append("- None")
            return
        lines.extend(
            [
                "| skill | from -> to | action | approval | gate | reason |",
                "| --- | --- | --- | --- | --- | --- |",
            ]
        )
        for row in rows:
            lines.append(
                f"| {row.get('skill_id')} | {row.get('from_status')} -> {row.get('to_status')} | "
                f"{row.get('recommended_action')} | {row.get('approval_mode')} | "
                f"{row.get('gate_flow_status')} | {row.get('reason')} |"
            )

    add_table("Applied", list(summary.get("applied") or []))
    add_table("Blocked", list(summary.get("blocked") or []))
    add_table("Skipped", list(summary.get("skipped") or []))
    lines.extend(
        [
            "",
            "## Boundary",
            "",
            "- This report is a manifest-copy decision only; it does not change production code or runtime config.",
            "- Automatic application only covers low-risk guarded promotions with clean gates.",
            "- Medium/high-risk retrieval, cutoff, fact registry, and composition changes remain manual-review items.",
            "",
        ]
    )
    return "\n".join(lines)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", default="test/colm/retrieval/skill_registry_manifest_20260603.json")
    parser.add_argument("--cards", required=True)
    parser.add_argument("--out_manifest", default=None)
    parser.add_argument("--out_report", default=None)
    parser.add_argument("--mode", choices=["dry_run", "auto_guarded", "explicit"], default="dry_run")
    parser.add_argument("--approve_skill", action="append", default=[])
    parser.add_argument("--allow_without_gate", action="store_true")
    args = parser.parse_args()

    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    out_manifest = Path(args.out_manifest or f"test/colm/retrieval/skill_registry_manifest_decision_{stamp}.json")
    out_report = Path(args.out_report or out_manifest.with_suffix(".md"))
    args.out_manifest = str(out_manifest)

    manifest = _load_json(Path(args.manifest))
    cards = _load_json(Path(args.cards))
    if not isinstance(cards, list):
        raise ValueError("--cards must point to a JSON list")

    next_manifest, summary = _apply_decisions(
        manifest=manifest,
        cards=cards,
        mode=args.mode,
        explicit_approvals=set(args.approve_skill or []),
        allow_without_gate=bool(args.allow_without_gate),
    )
    _write_json(out_manifest, next_manifest)
    out_report.parent.mkdir(parents=True, exist_ok=True)
    out_report.write_text(_render_report(summary, args), encoding="utf-8")
    print(
        json.dumps(
            {
                "out_manifest": str(out_manifest),
                "out_report": str(out_report),
                "counts": summary["counts"],
                "mode": args.mode,
            },
            ensure_ascii=False,
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
