"""Phase-aware execution for prompt, formula, Python, and migrated built-in skills."""

from __future__ import annotations

import asyncio
import importlib.util
import inspect
import time
from pathlib import Path
from typing import Any

from skills_runtime.evidence_contract import validate_evidence_contract
from skills_runtime.formula_engine import FormulaError, evaluate_formula
from skills_runtime.legacy_adapters import execute_builtin
from skills_runtime.models import PhaseExecution, RegisteredSkill, SkillContext, SkillResult
from skills_runtime.router import SkillRouter


class SkillExecutor:
    def __init__(
        self,
        router: SkillRouter,
        *,
        mode: str = "shadow",
        max_skills_per_request: int = 8,
        default_timeout_seconds: float = 5.0,
        max_prompt_instruction_chars: int = 12000,
        allow_python: bool = False,
    ) -> None:
        if mode not in {"shadow", "active"}:
            raise ValueError(f"invalid skill execution mode: {mode}")
        self.router = router
        self.mode = mode
        self.max_skills_per_request = max(1, int(max_skills_per_request))
        self.default_timeout_seconds = max(0.1, float(default_timeout_seconds))
        self.max_prompt_instruction_chars = max(1000, int(max_prompt_instruction_chars))
        self.allow_python = bool(allow_python)

    async def execute_phase(
        self,
        phase: str,
        context: SkillContext,
        *,
        explicit_skill_ids: list[str] | None = None,
    ) -> PhaseExecution:
        selected = self.router.select(
            phase,
            context,
            explicit_skill_ids=explicit_skill_ids,
        )[: self.max_skills_per_request]
        results: list[SkillResult] = []
        for skill in selected:
            result = await self._execute_one(skill, context)
            results.append(result)
            context.prior_skill_results.append(result)
            if self.mode == "active":
                self._apply_result(context, result)
        return PhaseExecution(
            context=context,
            results=results,
            selected_skill_ids=[skill.manifest.skill_id for skill in selected],
        )

    async def _execute_one(self, skill: RegisteredSkill, context: SkillContext) -> SkillResult:
        started = time.perf_counter()
        try:
            decision = validate_evidence_contract(skill.manifest.evidence_contract, context)
            # Prompt and early-query skills do not need source evidence yet.
            needs_evidence_now = skill.manifest.phase in {
                "post_retrieval", "calculation", "pre_answer", "post_answer"
            }
            if needs_evidence_now and not decision.valid:
                return self._timed(
                    SkillResult(
                        skill_id=skill.manifest.skill_id,
                        version=skill.manifest.version,
                        phase=skill.manifest.phase,
                        triggered=True,
                        status="insufficient_evidence",
                        warnings=decision.errors,
                    ),
                    started,
                )
            result = await asyncio.wait_for(
                self._dispatch(skill, context),
                timeout=self.default_timeout_seconds,
            )
            return self._timed(result, started)
        except asyncio.TimeoutError:
            return self._timed(self._failure(skill, "timeout"), started)
        except Exception as exc:
            return self._timed(
                self._failure(skill, f"{exc.__class__.__name__}: {exc}"),
                started,
            )

    async def _dispatch(self, skill: RegisteredSkill, context: SkillContext) -> SkillResult:
        kind = skill.manifest.kind
        if kind == "prompt":
            instruction = self._bounded_prompt_instruction(skill)
            return SkillResult(
                skill_id=skill.manifest.skill_id,
                version=skill.manifest.version,
                phase=skill.manifest.phase,
                triggered=True,
                status="applied",
                trace={
                    "instruction": instruction,
                    "instruction_chars": len(instruction),
                    "instruction_truncated": len(instruction) < len(skill.instruction),
                },
            )
        if kind == "formula":
            return self._execute_formula(skill, context)
        if kind == "builtin":
            return await asyncio.to_thread(execute_builtin, skill, context)
        if kind == "python":
            if not self.allow_python:
                return self._failure(skill, "python_skills_disabled", status="blocked")
            return await self._execute_python(skill, context)
        return self._failure(skill, f"unsupported_kind:{kind}")

    def _bounded_prompt_instruction(self, skill: RegisteredSkill) -> str:
        per_skill_limit = int(
            skill.manifest.implementation.get("max_instruction_chars")
            or self.max_prompt_instruction_chars
        )
        limit = max(1000, min(per_skill_limit, self.max_prompt_instruction_chars))
        instruction = skill.instruction
        if len(instruction) <= limit:
            return instruction
        boundary = instruction.rfind("\n", 0, limit)
        if boundary < limit // 2:
            boundary = limit
        return instruction[:boundary].rstrip() + "\n\n[Instruction truncated by FinSagent prompt budget.]"

    def _execute_formula(self, skill: RegisteredSkill, context: SkillContext) -> SkillResult:
        expression = str(skill.manifest.implementation.get("expression") or "")
        variables = self._formula_variables(skill, context)
        try:
            value = evaluate_formula(expression, variables)
        except FormulaError as exc:
            return self._failure(skill, str(exc), status="insufficient_evidence")
        evidence_ids = [
            str(fact.get("evidence_id") or fact.get("fact_id") or "")
            for fact in context.metric_facts
            if fact.get("evidence_id") or fact.get("fact_id")
        ]
        derived = {
            "metric": str(skill.manifest.implementation.get("output_metric") or skill.manifest.skill_id),
            "value": value,
            "unit": str(skill.manifest.implementation.get("output_unit") or ""),
            "formula": expression,
            "variables": variables,
            "evidence_ids": evidence_ids,
        }
        return SkillResult(
            skill_id=skill.manifest.skill_id,
            version=skill.manifest.version,
            phase=skill.manifest.phase,
            triggered=True,
            status="applied",
            derived_facts=[derived],
            evidence_ids=evidence_ids,
            confidence=1.0,
            trace={"formula": expression, "variables": variables},
        )

    @staticmethod
    def _formula_variables(skill: RegisteredSkill, context: SkillContext) -> dict[str, Any]:
        variables = dict(context.variables)
        operand_map = skill.manifest.implementation.get("operands") or {}
        if isinstance(operand_map, dict):
            for variable_name, metric_name in operand_map.items():
                if variable_name in variables:
                    continue
                matching = [
                    fact for fact in context.metric_facts
                    if str(fact.get("metric") or fact.get("metric_id") or fact.get("metric_name") or "")
                    == str(metric_name)
                ]
                if len(matching) == 1:
                    variables[str(variable_name)] = matching[0].get("value")
        return variables

    async def _execute_python(self, skill: RegisteredSkill, context: SkillContext) -> SkillResult:
        if skill.manifest.permissions.network or skill.manifest.permissions.filesystem_write:
            return self._failure(skill, "forbidden_python_permissions", status="blocked")
        filename = str(skill.manifest.implementation.get("module") or "handler.py")
        class_name = str(skill.manifest.implementation.get("class") or "Skill")
        module_path = (skill.directory / filename).resolve()
        if skill.directory.resolve() not in module_path.parents or module_path.is_symlink():
            return self._failure(skill, "python_module_outside_package", status="blocked")
        if not module_path.is_file():
            return self._failure(skill, "python_module_missing", status="blocked")
        module_name = f"finsagent_skill_{skill.manifest.skill_id}_{skill.package_hash[:12]}"
        spec = importlib.util.spec_from_file_location(module_name, module_path)
        if spec is None or spec.loader is None:
            return self._failure(skill, "python_module_load_failed")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        handler_class = getattr(module, class_name)
        handler = handler_class()
        raw = handler.execute(context)
        if inspect.isawaitable(raw):
            raw = await raw
        if isinstance(raw, SkillResult):
            return raw
        if not isinstance(raw, dict):
            return self._failure(skill, "python_skill_returned_invalid_type")
        return SkillResult(
            skill_id=skill.manifest.skill_id,
            version=skill.manifest.version,
            phase=skill.manifest.phase,
            triggered=bool(raw.get("triggered", True)),
            status=str(raw.get("status") or "applied"),
            answer=raw.get("answer"),
            derived_facts=list(raw.get("derived_facts") or []),
            answer_fragments=list(raw.get("answer_fragments") or []),
            evidence_ids=list(raw.get("evidence_ids") or []),
            warnings=list(raw.get("warnings") or []),
            confidence=raw.get("confidence"),
            trace=dict(raw.get("trace") or {}),
        )

    @staticmethod
    def _apply_result(context: SkillContext, result: SkillResult) -> None:
        if result.status != "applied":
            return
        if result.answer is not None:
            context.final_answer = result.answer
        context.derived_facts.extend(result.derived_facts)
        instruction = result.trace.get("instruction")
        if instruction:
            context.prompt_instructions.append(
                {"skill_id": result.skill_id, "instruction": str(instruction)}
            )

    @staticmethod
    def _failure(skill: RegisteredSkill, warning: str, *, status: str = "failed") -> SkillResult:
        return SkillResult(
            skill_id=skill.manifest.skill_id,
            version=skill.manifest.version,
            phase=skill.manifest.phase,
            triggered=True,
            status=status,
            warnings=[warning],
        )

    @staticmethod
    def _timed(result: SkillResult, started: float) -> SkillResult:
        result.duration_ms = round((time.perf_counter() - started) * 1000, 3)
        return result
