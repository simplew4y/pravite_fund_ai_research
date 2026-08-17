"""Validated, deterministic routing for production skill combinations."""

from __future__ import annotations

from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Iterable

import yaml

from skills_runtime.models import SkillContext, SkillValidationError


@dataclass(frozen=True)
class SkillCombo:
    combo_id: str
    label: str
    priority: int
    skill_ids: tuple[str, ...]
    intents: tuple[str, ...] = ()
    keywords: tuple[str, ...] = ()
    negative_keywords: tuple[str, ...] = ()


@dataclass(frozen=True)
class ComboSelection:
    combo_id: str
    label: str
    skill_ids: tuple[str, ...]
    reason_codes: tuple[str, ...]

    def to_dict(self) -> dict[str, Any]:
        row = asdict(self)
        row["skill_ids"] = list(self.skill_ids)
        row["reason_codes"] = list(self.reason_codes)
        return row

    @classmethod
    def from_dict(cls, value: dict[str, Any]) -> "ComboSelection":
        return cls(
            combo_id=str(value.get("combo_id") or ""),
            label=str(value.get("label") or ""),
            skill_ids=_strings(value.get("skill_ids")),
            reason_codes=_strings(value.get("reason_codes")),
        )


class SkillComboRouter:
    def __init__(
        self,
        combos: Iterable[SkillCombo],
        *,
        available_skill_ids: Iterable[str],
        max_skills_per_combo: int = 8,
    ) -> None:
        self.max_skills_per_combo = max(1, int(max_skills_per_combo))
        available = {str(skill_id) for skill_id in available_skill_ids}
        self._combos: list[SkillCombo] = []
        seen: set[str] = set()
        for combo in combos:
            if combo.combo_id in seen:
                raise SkillValidationError(f"duplicate skill combo: {combo.combo_id}")
            seen.add(combo.combo_id)
            if not combo.skill_ids:
                raise SkillValidationError(f"{combo.combo_id}: combo has no skills")
            if len(combo.skill_ids) > self.max_skills_per_combo:
                raise SkillValidationError(
                    f"{combo.combo_id}: {len(combo.skill_ids)} skills exceeds "
                    f"max_skills_per_combo={self.max_skills_per_combo}"
                )
            unknown = set(combo.skill_ids) - available
            if unknown:
                raise SkillValidationError(
                    f"{combo.combo_id}: combo references disabled or missing skills: {sorted(unknown)}"
                )
            if not combo.intents and not combo.keywords:
                raise SkillValidationError(f"{combo.combo_id}: combo has no routing selectors")
            self._combos.append(combo)
        self._combos.sort(key=lambda combo: (combo.priority, combo.combo_id))

    @classmethod
    def from_file(
        cls,
        path: str | Path,
        *,
        available_skill_ids: Iterable[str],
        max_skills_per_combo: int = 8,
    ) -> "SkillComboRouter":
        source = Path(path)
        try:
            payload = yaml.safe_load(source.read_text(encoding="utf-8")) or {}
        except Exception as exc:
            raise SkillValidationError(f"failed to load skill combos from {source}: {exc}") from exc
        if int(payload.get("schema_version", 0)) != 1:
            raise SkillValidationError(f"{source}: unsupported combo schema_version")
        rows = payload.get("combos")
        if not isinstance(rows, list):
            raise SkillValidationError(f"{source}: combos must be a list")
        combos = [cls._parse_combo(row, source=source) for row in rows]
        return cls(
            combos,
            available_skill_ids=available_skill_ids,
            max_skills_per_combo=max_skills_per_combo,
        )

    @staticmethod
    def _parse_combo(value: Any, *, source: Path) -> SkillCombo:
        if not isinstance(value, dict):
            raise SkillValidationError(f"{source}: combo entry must be a mapping")
        combo_id = str(value.get("combo_id") or "").strip()
        label = str(value.get("label") or "").strip()
        if not combo_id or not label:
            raise SkillValidationError(f"{source}: combo_id and label are required")
        routing = value.get("routing") if isinstance(value.get("routing"), dict) else {}
        return SkillCombo(
            combo_id=combo_id,
            label=label,
            priority=int(value.get("priority", 100)),
            skill_ids=_strings(value.get("skills")),
            intents=_strings(routing.get("intents")),
            keywords=_strings(routing.get("keywords")),
            negative_keywords=_strings(routing.get("negative_keywords")),
        )

    def select(self, context: SkillContext) -> ComboSelection | None:
        text = f"{context.original_question or context.question}\n{context.question}".lower()
        parsed_intents = {
            str(value).lower()
            for value in (
                context.parsed_query.get("intent"),
                *(context.parsed_query.get("intents") or []),
            )
            if value
        }
        for combo in self._combos:
            if any(term.lower() in text for term in combo.negative_keywords):
                continue
            intent_hits = sorted({intent.lower() for intent in combo.intents} & parsed_intents)
            keyword_hits = [term for term in combo.keywords if term.lower() in text]
            if not intent_hits and not keyword_hits:
                continue
            reasons = [*(f"INTENT:{intent}" for intent in intent_hits)]
            reasons.extend(f"KEYWORD:{keyword}" for keyword in keyword_hits[:3])
            return ComboSelection(
                combo_id=combo.combo_id,
                label=combo.label,
                skill_ids=combo.skill_ids,
                reason_codes=tuple(reasons),
            )
        return None

    def catalog(self) -> list[dict[str, Any]]:
        return [
            {
                "combo_id": combo.combo_id,
                "label": combo.label,
                "priority": combo.priority,
                "skill_ids": list(combo.skill_ids),
            }
            for combo in self._combos
        ]


def _strings(value: Any) -> tuple[str, ...]:
    if value is None:
        return ()
    if isinstance(value, (list, tuple, set)):
        return tuple(str(item).strip() for item in value if str(item).strip())
    text = str(value).strip()
    return (text,) if text else ()
