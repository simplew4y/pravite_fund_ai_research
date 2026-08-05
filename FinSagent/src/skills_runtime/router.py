"""Deterministic-first skill selection."""

from __future__ import annotations

from skills_runtime.models import RegisteredSkill, SkillContext
from skills_runtime.registry import RuntimeSkillRegistry


class SkillRouter:
    def __init__(self, registry: RuntimeSkillRegistry) -> None:
        self.registry = registry

    def select(
        self,
        phase: str,
        context: SkillContext,
        *,
        explicit_skill_ids: list[str] | None = None,
    ) -> list[RegisteredSkill]:
        candidates = self.registry.enabled_for_phase(phase)
        if explicit_skill_ids is not None:
            requested = {str(skill_id) for skill_id in explicit_skill_ids}
            return [skill for skill in candidates if skill.manifest.skill_id in requested]
        return [skill for skill in candidates if self._matches(skill, context)]

    @staticmethod
    def _matches(skill: RegisteredSkill, context: SkillContext) -> bool:
        manifest = skill.manifest
        if manifest.agents and context.agent and context.agent not in manifest.agents:
            return False
        text = f"{context.original_question or context.question}\n{context.question}".lower()
        rule = manifest.routing
        if any(term.lower() in text for term in rule.negative_keywords):
            return False
        parsed_intents = {
            str(value).lower()
            for value in (
                context.parsed_query.get("intent"),
                *(context.parsed_query.get("intents") or []),
            )
            if value
        }
        intent_match = bool({intent.lower() for intent in rule.intents} & parsed_intents)
        keyword_match = any(term.lower() in text for term in rule.keywords)
        # A skill without routing selectors is an always-on safety/verification hook.
        return intent_match or keyword_match or (not rule.intents and not rule.keywords)
