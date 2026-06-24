#!/usr/bin/env python3
"""Render a skill registry manifest into a compact promotion report."""

from __future__ import annotations

import argparse
import json
from collections import Counter
from pathlib import Path
from typing import Any


def _load_json(path: Path) -> dict[str, Any]:
    with open(path, encoding="utf-8") as f:
        payload = json.load(f)
    if not isinstance(payload, dict):
        raise ValueError("manifest must be a JSON object")
    return payload


def _status_label(status: str) -> str:
    labels = {
        "frozen_baseline": "Frozen baseline",
        "promoted_guarded": "Promoted guarded",
        "candidate_promote": "Candidate promote",
        "offline_candidate": "Offline candidate",
        "backlog": "Backlog",
    }
    return labels.get(status, status.replace("_", " ").title())


def _exists_mark(root: Path, artifact: str) -> str:
    if not artifact:
        return ""
    return "ok" if (root / artifact).exists() else "missing"


def _artifact_line(root: Path, artifact: str) -> str:
    return f"- `{artifact}` ({_exists_mark(root, artifact)})"


def _render_list(values: list[str]) -> list[str]:
    return [f"- {value}" for value in values]


def _skill_summary_row(skill: dict[str, Any]) -> str:
    return (
        f"| {skill.get('id', '')} | {_status_label(str(skill.get('status', '')))} | "
        f"{skill.get('risk', '')} | {skill.get('auto_approval', '')} | "
        f"{skill.get('type', '')} |"
    )


def _render_skill_detail(root: Path, skill: dict[str, Any]) -> list[str]:
    lines = [
        f"### {skill.get('id', '')}",
        "",
        f"- Name: {skill.get('name', '')}",
        f"- Status: {_status_label(str(skill.get('status', '')))}",
        f"- Risk: {skill.get('risk', '')}",
        f"- Auto approval: {skill.get('auto_approval', '')}",
        f"- Goal: {skill.get('goal', '')}",
        f"- Boundary: {skill.get('boundary', '')}",
        "",
        "Trigger conditions:",
    ]
    lines.extend(_render_list(list(skill.get("trigger_conditions") or [])) or ["- None"])
    lines.extend(["", "Primary files:"])
    lines.extend(_render_list([f"`{item}`" for item in skill.get("primary_files") or []]) or ["- None"])
    lines.extend(["", "Evidence artifacts:"])
    artifacts = list(skill.get("evidence_artifacts") or [])
    lines.extend([_artifact_line(root, artifact) for artifact in artifacts] or ["- None"])
    lines.extend(["", "Promotion evidence:"])
    lines.extend(_render_list(list(skill.get("promotion_evidence") or [])) or ["- None"])
    lines.append("")
    return lines


def render_report(manifest: dict[str, Any], root: Path) -> str:
    skills = list(manifest.get("skills") or [])
    status_counts = Counter(str(skill.get("status", "")) for skill in skills)
    risk_counts = Counter(str(skill.get("risk", "")) for skill in skills)

    lines: list[str] = [
        "# Skill Registry",
        "",
        f"Registry version: `{manifest.get('registry_version', '')}`",
        "",
        str(manifest.get("purpose", "")),
        "",
        "## Executive Summary",
        "",
        f"- Total skills tracked: {len(skills)}",
        "- Status counts: "
        + ", ".join(f"{_status_label(status)}={count}" for status, count in sorted(status_counts.items())),
        "- Risk counts: " + ", ".join(f"{risk}={count}" for risk, count in sorted(risk_counts.items())),
        "",
        "## Boundary Policy",
        "",
    ]
    policy = dict(manifest.get("global_boundary_policy") or {})
    lines.append(f"- Default iteration budget per skill: {policy.get('default_iteration_budget_per_skill')}")
    lines.extend(["", "Promotion requirements:"])
    lines.extend(_render_list(list(policy.get("promotion_requirements") or [])))
    lines.extend(["", "Stop conditions:"])
    lines.extend(_render_list(list(policy.get("stop_conditions") or [])))
    lines.extend(["", "Auto approval policy:"])
    for key, value in dict(policy.get("auto_approval_policy") or {}).items():
        lines.append(f"- {key}: {value}")

    lines.extend(["", "## Validation Sets", ""])
    for key, validation in dict(manifest.get("validation_sets") or {}).items():
        artifact = str(validation.get("path") or "")
        lines.append(f"### {key}")
        lines.append(f"- Name: {validation.get('name', '')}")
        lines.append(f"- Path: `{artifact}` ({_exists_mark(root, artifact)})")
        lines.append(f"- Role: {validation.get('role', '')}")
        lines.append("")

    lines.extend(
        [
            "## Skill Summary",
            "",
            "| skill | status | risk | auto approval | type |",
            "| --- | --- | --- | --- | --- |",
        ]
    )
    lines.extend(_skill_summary_row(skill) for skill in skills)
    lines.extend(["", "## Skill Details", ""])
    for skill in skills:
        lines.extend(_render_skill_detail(root, skill))

    next_steps = list(manifest.get("next_recommended_steps") or [])
    lines.extend(["## Next Recommended Steps", ""])
    for step in next_steps:
        lines.append(
            f"- {step.get('priority', '')}: {step.get('step', '')} "
            f"Exit: {step.get('exit_criteria', '')}"
        )
    lines.append("")
    return "\n".join(lines)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--manifest",
        default="test/colm/retrieval/skill_registry_manifest_20260603.json",
    )
    parser.add_argument(
        "--out_md",
        default="test/colm/retrieval/SKILL_REGISTRY_20260603.md",
    )
    args = parser.parse_args()

    root = Path.cwd()
    manifest_path = Path(args.manifest)
    out_path = Path(args.out_md)
    manifest = _load_json(manifest_path)
    report = render_report(manifest, root)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(report, encoding="utf-8")
    print(
        json.dumps(
            {
                "manifest": str(manifest_path),
                "out_md": str(out_path),
                "skill_count": len(manifest.get("skills") or []),
            },
            ensure_ascii=False,
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
