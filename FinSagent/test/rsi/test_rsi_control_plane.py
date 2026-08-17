from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from rsi.archive import AppendOnlyArchive, pareto_frontier
from rsi.failure_clusterer import cluster_failures
from rsi.models import CandidatePatch, FailureRecord, MetricVector, MutationLevel
from rsi.patch_policy import validate_candidate
from rsi.proposer import propose_candidates
from rsi.trace_collector import TraceCollector


class RsiControlPlaneTest(unittest.TestCase):
    def test_trace_is_hash_chained_and_rejects_hidden_answers(self):
        with tempfile.TemporaryDirectory() as tmp:
            collector = TraceCollector(Path(tmp) / "trace.jsonl", run_id="run-1")
            collector.append("target_completed", {"case_id": "c1", "answer": "visible output"})
            collector.append("skill_trace", {"skill_id": "period_alignment", "triggered": True})
            self.assertEqual(collector.verify(), [])
            with self.assertRaises(ValueError):
                collector.append("bad", {"ground_truth_answer": "secret"})

    def test_cluster_and_multi_hypothesis_proposal(self):
        failures = [
            FailureRecord("c1", "period_mismatch", "temporal_reasoning", "synthesis", company="NVIDIA"),
            FailureRecord("c2", "period_mismatch", "temporal_reasoning", "synthesis", company="Zeekr"),
            FailureRecord("ignored", "period_mismatch", "temporal_reasoning", "synthesis", confirmed=False),
        ]
        clusters = cluster_failures(failures, min_cluster_size=2)
        self.assertEqual(len(clusters), 1)
        proposals = propose_candidates(clusters[0])
        self.assertEqual(len(proposals), 2)
        self.assertNotEqual(proposals[0].mutation_level, proposals[1].mutation_level)
        self.assertTrue(all(validate_candidate(candidate).allowed for candidate in proposals))

    def test_policy_freezes_evaluator_and_requires_l4_approval(self):
        forbidden = CandidatePatch(
            "cand-x", "cluster-x", MutationLevel.SKILL, "test", "test",
            ("evaluation/rsi_benchmark/judge_runner.py",), ("temporal",), ("period_mismatch",),
        )
        result = validate_candidate(forbidden)
        self.assertFalse(result.allowed)
        with self.assertRaises(ValueError):
            CandidatePatch(
                "cand-l4", "cluster-x", MutationLevel.WORKFLOW, "test", "test",
                ("src/core/AgenticRAG.py",), ("temporal",), ("period_mismatch",),
            )

    def test_archive_is_content_addressed_and_identity_is_immutable(self):
        with tempfile.TemporaryDirectory() as tmp:
            archive = AppendOnlyArchive(tmp)
            first = archive.put("candidate", "c1", {"value": 1})
            self.assertEqual(first, archive.put("candidate", "c1", {"value": 1}))
            with self.assertRaises(ValueError):
                archive.put("candidate", "c1", {"value": 2})

    def test_pareto_frontier_discards_dominated_candidate(self):
        rows = [
            {"candidate_id": "best", "quality": 0.9, "latency_ms": 100, "cost_units": 1.0},
            {"candidate_id": "dominated", "quality": 0.8, "latency_ms": 110, "cost_units": 1.1},
            {"candidate_id": "fast", "quality": 0.85, "latency_ms": 80, "cost_units": 0.9},
        ]
        self.assertEqual({row["candidate_id"] for row in pareto_frontier(rows)}, {"best", "fast"})


if __name__ == "__main__":
    unittest.main()
