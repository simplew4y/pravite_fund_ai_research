"""Composition root for filesystem skills and phase-aware execution."""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

from skills_runtime.executor import SkillExecutor
from skills_runtime.loader import SkillLoader
from skills_runtime.models import PhaseExecution, SkillContext
from skills_runtime.registry import RuntimeSkillRegistry
from skills_runtime.router import SkillRouter

logger = logging.getLogger(__name__)


class SkillRuntime:
    def __init__(
        self,
        registry: RuntimeSkillRegistry,
        executor: SkillExecutor,
        *,
        enabled: bool,
        mode: str,
        load_errors: list[str] | None = None,
    ) -> None:
        self.registry = registry
        self.executor = executor
        self.enabled = bool(enabled)
        self.mode = mode
        self.load_errors = list(load_errors or [])

    @classmethod
    def from_config(cls, config: dict[str, Any], *, default_root: str | Path) -> "SkillRuntime":
        skill_cfg = config.get("skills") if isinstance(config.get("skills"), dict) else {}
        default_root_path = Path(default_root).resolve()
        configured_roots = skill_cfg.get("roots") or [str(default_root_path)]
        roots = [
            str(Path(root).expanduser())
            if Path(root).expanduser().is_absolute()
            else str((default_root_path.parent / Path(root)).resolve())
            for root in configured_roots
        ]
        loader = SkillLoader(roots, strict=bool(skill_cfg.get("strict_discovery", False)))
        discovered = loader.discover()
        registry = RuntimeSkillRegistry(
            discovered,
            promoted_only=bool(skill_cfg.get("promoted_only", True)),
            allow=skill_cfg.get("allow") or [],
            deny=skill_cfg.get("deny") or [],
        )
        mode = str(skill_cfg.get("execution_mode") or "shadow").lower()
        executor_cfg = skill_cfg.get("execution") if isinstance(skill_cfg.get("execution"), dict) else {}
        executor = SkillExecutor(
            SkillRouter(registry),
            mode=mode,
            max_skills_per_request=int(executor_cfg.get("max_skills_per_request", 8)),
            default_timeout_seconds=float(executor_cfg.get("default_timeout_seconds", 5.0)),
            max_prompt_instruction_chars=int(
                executor_cfg.get("max_prompt_instruction_chars", 12000)
            ),
            allow_python=bool((skill_cfg.get("security") or {}).get("allow_python_skills", False)),
        )
        runtime = cls(
            registry,
            executor,
            enabled=bool(skill_cfg.get("runtime_enabled", False)),
            mode=mode,
            load_errors=loader.errors,
        )
        logger.info("Skill runtime initialized: %s", runtime.status())
        return runtime

    async def execute_phase(
        self,
        phase: str,
        context: SkillContext,
        *,
        explicit_skill_ids: list[str] | None = None,
    ) -> PhaseExecution:
        if not self.enabled:
            return PhaseExecution(context=context, results=[], selected_skill_ids=[])
        return await self.executor.execute_phase(
            phase,
            context,
            explicit_skill_ids=explicit_skill_ids,
        )

    def catalog(self, *, public_only: bool = False) -> list[dict]:
        return self.registry.catalog(public_only=public_only)

    def status(self) -> dict:
        return {
            "runtime_enabled": self.enabled,
            "execution_mode": self.mode,
            "registry": self.registry.summary(),
            "load_errors": list(self.load_errors),
        }
