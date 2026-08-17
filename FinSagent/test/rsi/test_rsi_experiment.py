from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from evaluation.rsi_benchmark.judge_runner import CallableJudgeAdapter
from evaluation.rsi_benchmark.paired_compare import compare_candidate
from evaluation.rsi_benchmark.target_adapter import CallableTargetAdapter
from rsi.models import CandidatePatch, MutationLevel
from rsi.promotion import decide_promotion
from rsi.registry import PromotionRegistry


class FakeTarget:
    def __init__(self):
        self.seen_cases = []

    def __call__(self, case, seed, candidate_id):
        self.seen_cases.append(case)
        improved = candidate_id is not None
        return {"answer": "supported" if improved else "partial", "latency_ms": 105 if improved else 100, "cost_units": 1.05 if improved else 1.0}


def fake_score(case, output):
    improved = output["answer"] == "supported"
    return {
        "success": 1.0 if improved else 0.0,
        "atomic_correctness": 1.0 if improved else 0.5,
        "citation_support": 1.0 if improved else 0.8,
        "scope_control": 1.0,
        "refusal_quality": 1.0,
        "latency_ms": output["latency_ms"],
        "cost_units": output["cost_units"],
        "mechanism_attributed": improved,
    }


class RsiExperimentTest(unittest.TestCase):
    def setUp(self):
        self.candidate = CandidatePatch(
            "cand-good", "fc-1", MutationLevel.SKILL,
            "Period guard improves compatible-source selection.",
            "Evidence-scoped period arbitration.",
            ("src/utils/period_source_conflict_repair.py",),
            ("temporal_reasoning",), ("period_mismatch",),
        )

    def test_paired_runner_hides_answers_and_emits_review_eligibility(self):
        target_callable = FakeTarget()
        target = CallableTargetAdapter(target_callable)
        judge = CallableJudgeAdapter(fake_score)
        cases = [
            *[
                {"case_id": f"t{i}", "question": "q", "answer_key": "secret", "suite": "fresh_internal", "capability": "temporal_reasoning"}
                for i in range(5)
            ],
            {"case_id": "p1", "question": "q", "answer_key": "secret", "suite": "protected", "capability": "temporal_reasoning"},
        ]
        payload = compare_candidate(self.candidate, cases, target=target, judge=judge, seeds=(1, 2, 3))
        self.assertTrue(all("answer_key" not in case for case in target_callable.seen_cases))
        self.assertEqual(payload["promotion_decision"]["decision"], "eligible_for_human_review")
        self.assertEqual(payload["summary"]["observation_count"], 18)

    def test_registry_requires_human_identity_and_ticket(self):
        target = CallableTargetAdapter(FakeTarget())
        judge = CallableJudgeAdapter(fake_score)
        payload = compare_candidate(
            self.candidate,
            [
                {"case_id": f"t{i}", "question": "q", "suite": "fresh_internal", "capability": "temporal_reasoning"}
                for i in range(5)
            ],
            target=target, judge=judge, seeds=(1, 2, 3),
        )
        decision = decide_promotion(self.candidate, payload["summary"])
        with tempfile.TemporaryDirectory() as tmp:
            registry = PromotionRegistry(Path(tmp) / "promotions.jsonl")
            with self.assertRaises(ValueError):
                registry.promote(self.candidate, decision, reviewer="", approval_ticket="")
            entry = registry.promote(self.candidate, decision, reviewer="human", approval_ticket="RSI-1")
            self.assertEqual(entry["status"], "promoted")


if __name__ == "__main__":
    unittest.main()
