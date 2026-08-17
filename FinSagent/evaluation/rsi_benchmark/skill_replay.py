"""Real-code replay target and deterministic hidden-rubric judge for Skill RSI."""

from __future__ import annotations

import hashlib
import importlib.util
import time
from pathlib import Path
from typing import Any

from rsi.models import MetricVector


class SkillReplayTargetAdapter:
    def __init__(self, baseline_root: str | Path, candidate_root: str | Path, module_path: str, function_name: str) -> None:
        self.baseline_root = Path(baseline_root)
        self.candidate_root = Path(candidate_root)
        self.module_path = module_path
        self.function_name = function_name
        self._functions: dict[str, Any] = {}

    def run(self, case: dict[str, Any], *, seed: int, candidate_id: str | None) -> dict[str, Any]:
        arm = "candidate" if candidate_id else "baseline"
        function = self._function(arm)
        started = time.perf_counter()
        result = function(
            str(case["question"]),
            str(case["baseline_answer"]),
            list(case.get("retrieved_chunks") or []),
        )
        elapsed_ms = (time.perf_counter() - started) * 1000.0
        return {
            "answer": str(result.get("answer") or ""),
            "repair_applied": bool(result.get("repair_applied")),
            "repair_reason": str(result.get("repair_reason") or ""),
            "supporting_source": result.get("supporting_source"),
            "latency_ms": elapsed_ms,
            "cost_units": 0.0,
            "seed": seed,
        }

    def _function(self, arm: str):
        if arm in self._functions:
            return self._functions[arm]
        root = self.candidate_root if arm == "candidate" else self.baseline_root
        path = root / self.module_path
        name = "rsi_replay_" + hashlib.sha256(f"{arm}:{path}".encode()).hexdigest()[:12]
        spec = importlib.util.spec_from_file_location(name, path)
        if spec is None or spec.loader is None:
            raise ImportError(f"cannot load candidate module: {path}")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        function = getattr(module, self.function_name)
        self._functions[arm] = function
        return function


class SkillReplayJudgeAdapter:
    def score(self, case: dict[str, Any], target_output: dict[str, Any]) -> MetricVector:
        rubric = dict(case.get("rubric") or {})
        answer = str(target_output.get("answer") or "")
        folded = answer.casefold()
        atoms = list(rubric.get("required_atoms") or [])
        atom_hits = [any(str(term).casefold() in folded for term in atom.get("any_of", [])) for atom in atoms]
        atomic = sum(atom_hits) / len(atom_hits) if atom_hits else 1.0
        forbidden_hit = any(str(term).casefold() in folded for term in rubric.get("forbidden_phrases", []))
        expected_trigger = bool(rubric.get("expected_trigger"))
        actual_trigger = bool(target_output.get("repair_applied"))
        trigger_ok = expected_trigger == actual_trigger
        preserve_ok = not rubric.get("preserve_input_answer") or answer == str(case.get("baseline_answer") or "")
        expected_reason = str(rubric.get("expected_reason_contains") or "")
        reason_ok = not expected_reason or expected_reason in str(target_output.get("repair_reason") or "")
        citation_support = 1.0 if not expected_trigger else float(bool(target_output.get("supporting_source")))
        critical = int(forbidden_hit or not preserve_ok or not trigger_ok)
        success = float(atomic == 1.0 and not forbidden_hit and trigger_ok and preserve_ok and reason_ok)
        return MetricVector(
            success=success,
            atomic_correctness=atomic,
            citation_support=citation_support,
            scope_control=float(trigger_ok and preserve_ok),
            refusal_quality=1.0,
            latency_ms=float(target_output.get("latency_ms", 0.0)),
            cost_units=float(target_output.get("cost_units", 0.0)),
            critical_error_count=critical,
            trigger_true_positive=int(expected_trigger and actual_trigger),
            trigger_false_positive=int(not expected_trigger and actual_trigger),
            mechanism_attributed=bool(trigger_ok and reason_ok),
        )
