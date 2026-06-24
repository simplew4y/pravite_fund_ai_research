"""Skill card schema for human-governed SEC QA skills."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


_REQUIRED_FIELDS = {
    "skill_id",
    "version",
    "name",
    "scope",
    "failure_types",
    "trigger",
    "inputs",
    "outputs",
    "risks",
    "eval_sets",
    "status",
    "owner",
    "last_reviewed",
}


@dataclass(frozen=True)
class SkillCard:
    skill_id: str
    version: str
    name: str
    scope: str
    failure_types: list[str]
    trigger: str
    inputs: list[str]
    outputs: list[str]
    risks: list[str]
    eval_sets: list[str]
    status: str
    owner: str
    last_reviewed: str
    implementation_refs: list[str] = field(default_factory=list)
    notes: str = ""

    @classmethod
    def from_dict(cls, data: dict[str, Any], *, source_path: str = "") -> "SkillCard":
        missing = sorted(_REQUIRED_FIELDS - set(data))
        if missing:
            prefix = f"{source_path}: " if source_path else ""
            raise ValueError(f"{prefix}missing required skill-card fields: {', '.join(missing)}")
        return cls(
            skill_id=str(data["skill_id"]),
            version=str(data["version"]),
            name=str(data["name"]),
            scope=str(data["scope"]),
            failure_types=_as_str_list(data["failure_types"]),
            trigger=str(data["trigger"]),
            inputs=_as_str_list(data["inputs"]),
            outputs=_as_str_list(data["outputs"]),
            risks=_as_str_list(data["risks"]),
            eval_sets=_as_str_list(data["eval_sets"]),
            status=str(data["status"]),
            owner=str(data["owner"]),
            last_reviewed=str(data["last_reviewed"]),
            implementation_refs=_as_str_list(data.get("implementation_refs", [])),
            notes=str(data.get("notes", "")),
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "skill_id": self.skill_id,
            "version": self.version,
            "name": self.name,
            "scope": self.scope,
            "failure_types": list(self.failure_types),
            "trigger": self.trigger,
            "inputs": list(self.inputs),
            "outputs": list(self.outputs),
            "risks": list(self.risks),
            "eval_sets": list(self.eval_sets),
            "status": self.status,
            "owner": self.owner,
            "last_reviewed": self.last_reviewed,
            "implementation_refs": list(self.implementation_refs),
            "notes": self.notes,
        }


def _as_str_list(value: Any) -> list[str]:
    if value is None:
        return []
    if isinstance(value, list):
        return [str(item) for item in value]
    return [str(value)]

