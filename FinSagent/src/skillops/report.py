"""Generate Markdown reports from the SkillOps registry."""

from __future__ import annotations

import argparse
from pathlib import Path

from skillops.registry import load_skill_registry


def render_skill_registry_report(skill_card_dir: str | Path = "skills") -> str:
    registry = load_skill_registry(skill_card_dir)
    lines: list[str] = [
        "# SkillOps Registry Report",
        "",
        "This report lists governed SEC QA skills currently represented as skill cards.",
        "",
        "## Summary",
        "",
        f"- Total skill cards: {len(registry.all())}",
        f"- Status counts: {registry.status_counts()}",
        f"- Failure-type coverage: {registry.failure_type_counts()}",
        "",
        "## Skill Cards",
        "",
        "| Skill | Status | Failure Types | Scope | Implementation |",
        "| --- | --- | --- | --- | --- |",
    ]
    for card in registry.all():
        impl = "<br>".join(card.implementation_refs) if card.implementation_refs else ""
        lines.append(
            "| "
            + " | ".join(
                [
                    f"`{card.skill_id}` v{card.version}",
                    card.status,
                    ", ".join(card.failure_types),
                    _compact(card.scope, 110),
                    impl,
                ]
            )
            + " |"
        )
    lines.extend(["", "## Audit Notes", ""])
    for card in registry.all():
        lines.extend(
            [
                f"### {card.skill_id}",
                "",
                f"- Trigger: {card.trigger}",
                f"- Inputs: {', '.join(card.inputs)}",
                f"- Outputs: {', '.join(card.outputs)}",
                f"- Risks: {', '.join(card.risks)}",
                f"- Eval sets: {', '.join(card.eval_sets)}",
                f"- Last reviewed: {card.last_reviewed}",
                "",
            ]
        )
        if card.notes:
            lines.extend([card.notes, ""])
    return "\n".join(lines).rstrip() + "\n"


def _compact(value: str, max_chars: int) -> str:
    if len(value) <= max_chars:
        return value
    return value[: max_chars - 3].rstrip() + "..."


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--skill_card_dir", default="skills")
    parser.add_argument("--out", default="reports/skill_registry_report.md")
    args = parser.parse_args()
    output = Path(args.out)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(render_skill_registry_report(args.skill_card_dir), encoding="utf-8")
    print(output)


if __name__ == "__main__":
    main()
