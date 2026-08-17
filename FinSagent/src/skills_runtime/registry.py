"""Validated runtime registry and production activation policy."""

from __future__ import annotations

from collections import Counter
from typing import Iterable

from skills_runtime.models import RegisteredSkill, SkillValidationError


class RuntimeSkillRegistry:
    def __init__(
        self,
        skills: Iterable[RegisteredSkill],
        *,
        promoted_only: bool = True,
        allow: Iterable[str] = (),
        deny: Iterable[str] = (),
    ) -> None:
        self._skills: dict[str, RegisteredSkill] = {}
        self.promoted_only = bool(promoted_only)
        self.allow = {str(item) for item in allow if str(item)}
        self.deny = {str(item) for item in deny if str(item)}
        for skill in skills:
            skill_id = skill.manifest.skill_id
            if skill_id in self._skills:
                first = self._skills[skill_id]
                raise SkillValidationError(
                    f"duplicate skill_id={skill_id!r}: {first.directory} and {skill.directory}"
                )
            self._skills[skill_id] = skill
        unknown_allowed = self.allow - set(self._skills)
        if unknown_allowed:
            raise SkillValidationError(
                f"production allowlist references missing skills: {sorted(unknown_allowed)}"
            )

    def get(self, skill_id: str) -> RegisteredSkill:
        return self._skills[skill_id]

    def all(self) -> list[RegisteredSkill]:
        return sorted(self._skills.values(), key=lambda item: item.manifest.skill_id)

    def is_enabled(self, skill: RegisteredSkill) -> bool:
        manifest = skill.manifest
        if manifest.skill_id in self.deny or manifest.status == "deprecated":
            return False
        if self.promoted_only and manifest.status != "promoted":
            return False
        if self.allow and manifest.skill_id not in self.allow:
            return False
        return True

    def enabled_for_phase(self, phase: str) -> list[RegisteredSkill]:
        return sorted(
            [
                skill for skill in self.all()
                if skill.manifest.phase == phase and self.is_enabled(skill)
            ],
            key=lambda item: (item.manifest.priority, item.manifest.skill_id),
        )

    def catalog(self, *, public_only: bool = False) -> list[dict]:
        rows = []
        for skill in self.all():
            if public_only and not skill.manifest.public:
                continue
            row = skill.manifest.catalog_dict(
                enabled=self.is_enabled(skill),
                package_hash=skill.package_hash,
            )
            if public_only:
                row.pop("package_hash", None)
                row.pop("owner", None)
            rows.append(row)
        return rows

    def summary(self) -> dict:
        skills = self.all()
        return {
            "total": len(skills),
            "enabled": sum(1 for skill in skills if self.is_enabled(skill)),
            "status_counts": dict(Counter(skill.manifest.status for skill in skills)),
            "phase_counts": dict(Counter(skill.manifest.phase for skill in skills)),
        }
