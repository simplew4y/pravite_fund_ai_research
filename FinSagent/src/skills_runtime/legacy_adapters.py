"""Adapters that migrate current production repairs without changing behavior."""

from __future__ import annotations

from typing import Any, Callable

from skills_runtime.models import RegisteredSkill, SkillContext, SkillResult
from utils.answer_coverage_repair import repair_answer_coverage
from utils.period_source_conflict_repair import repair_period_source_conflict
from utils.profile_fact_repair import repair_profile_answer
from utils.table_answer_repair import repair_table_answer


BuiltinHandler = Callable[[RegisteredSkill, SkillContext], SkillResult]


def execute_builtin(skill: RegisteredSkill, context: SkillContext) -> SkillResult:
    entrypoint = str(skill.manifest.implementation.get("entrypoint") or "")
    handlers: dict[str, BuiltinHandler] = {
        "table_answer_repair": _table_answer,
        "profile_fact_repair": _profile_answer,
        "answer_coverage_repair": _answer_coverage,
        "period_source_conflict_repair": _period_conflict,
        "evidence_rescue_audit": _evidence_rescue_audit,
        "period_alignment_audit": _period_alignment_audit,
        "quant_skill_hints": _quant_skill_hints,
    }
    if entrypoint not in handlers:
        return _result(skill, False, "no_action", warnings=[f"unknown_builtin:{entrypoint}"])
    return handlers[entrypoint](skill, context)


def _table_answer(skill: RegisteredSkill, context: SkillContext) -> SkillResult:
    result = repair_table_answer(context.question, context.final_answer, context.retrieved_chunks)
    return _repair_result(skill, result)


def _profile_answer(skill: RegisteredSkill, context: SkillContext) -> SkillResult:
    all_chunks = list(context.retrieved_chunks) + list(context.pre_rerank_candidates)
    result = repair_profile_answer(
        context.question,
        context.final_answer,
        all_chunks,
        allow_legacy_answer_fallback=False,
    )
    return _repair_result(skill, result)


def _answer_coverage(skill: RegisteredSkill, context: SkillContext) -> SkillResult:
    return _repair_result(skill, repair_answer_coverage(context.question, context.final_answer))


def _period_conflict(skill: RegisteredSkill, context: SkillContext) -> SkillResult:
    result = repair_period_source_conflict(
        context.question,
        context.final_answer,
        context.retrieved_chunks,
    )
    return _repair_result(skill, result)


def _evidence_rescue_audit(skill: RegisteredSkill, context: SkillContext) -> SkillResult:
    rescued = [
        chunk for chunk in context.retrieved_chunks
        if bool((chunk.get("metadata") or {}).get("evidence_rescue"))
    ]
    return _result(
        skill,
        bool(rescued),
        "applied" if rescued else "no_action",
        evidence_ids=[_chunk_id(chunk) for chunk in rescued if _chunk_id(chunk)],
        trace={"rescued_chunk_count": len(rescued)},
    )


def _period_alignment_audit(skill: RegisteredSkill, context: SkillContext) -> SkillResult:
    has_period = any(char.isdigit() for char in context.question) or any(
        token in context.question.lower() for token in ("季度", "财年", "截至", "quarter", "fiscal")
    )
    return _result(skill, has_period, "applied" if has_period else "no_action")


def _quant_skill_hints(skill: RegisteredSkill, context: SkillContext) -> SkillResult:
    from utils.quant_skill_hints import select_quant_skill_hints

    hints = select_quant_skill_hints(context.question)
    return _result(
        skill,
        bool(hints),
        "applied" if hints else "no_action",
        derived_facts=hints,
    )


def _repair_result(skill: RegisteredSkill, raw: dict[str, Any]) -> SkillResult:
    applied = bool(raw.get("repair_applied"))
    return _result(
        skill,
        applied,
        "applied" if applied else "no_action",
        answer=str(raw.get("answer")) if applied and raw.get("answer") is not None else None,
        confidence=1.0 if applied else 0.0,
        trace={key: value for key, value in raw.items() if key != "answer"},
    )


def _result(
    skill: RegisteredSkill,
    triggered: bool,
    status: str,
    *,
    answer: str | None = None,
    derived_facts: list[dict[str, Any]] | None = None,
    evidence_ids: list[str] | None = None,
    warnings: list[str] | None = None,
    confidence: float | None = None,
    trace: dict[str, Any] | None = None,
) -> SkillResult:
    return SkillResult(
        skill_id=skill.manifest.skill_id,
        version=skill.manifest.version,
        phase=skill.manifest.phase,
        triggered=triggered,
        status=status,
        answer=answer,
        derived_facts=derived_facts or [],
        evidence_ids=evidence_ids or [],
        warnings=warnings or [],
        confidence=confidence,
        trace=trace or {},
    )


def _chunk_id(chunk: dict[str, Any]) -> str:
    metadata = chunk.get("metadata") or {}
    return str(metadata.get("global_id") or metadata.get("chunk_id") or metadata.get("doc_id") or "")
