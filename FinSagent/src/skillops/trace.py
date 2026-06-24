"""Runtime trace objects emitted by auditable skills."""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any


@dataclass(frozen=True)
class SkillTrace:
    skill_id: str
    version: str
    triggered: bool
    trigger_reason: str
    input_refs: list[str] = field(default_factory=list)
    output_decision: str = ""
    confidence_delta: float | None = None
    audit_notes: list[str] = field(default_factory=list)
    metadata: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def trace_from_repair_result(
    *,
    skill_id: str,
    version: str,
    repair_result: dict[str, Any],
    input_refs: list[str] | None = None,
) -> SkillTrace:
    """Convert an existing repair-result dict into a SkillTrace."""
    applied = bool(repair_result.get("repair_applied"))
    reason = str(repair_result.get("repair_reason") or "")
    verification = repair_result.get("verification")
    notes: list[str] = []
    if verification:
        notes.append("verification_attached")
    return SkillTrace(
        skill_id=skill_id,
        version=version,
        triggered=applied,
        trigger_reason=reason,
        input_refs=input_refs or [],
        output_decision="repair_applied" if applied else "no_action",
        confidence_delta=1.0 if applied else 0.0,
        audit_notes=notes,
        metadata={key: value for key, value in repair_result.items() if key not in {"answer"}},
    )

