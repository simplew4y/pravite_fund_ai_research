from __future__ import annotations

import subprocess
import tempfile
import unittest
from pathlib import Path

from evaluation.rsi_benchmark.skill_replay import SkillReplayJudgeAdapter, SkillReplayTargetAdapter
from rsi.candidate_materializer import materialize_candidate, patch_targets
from rsi.models import CandidatePatch, MutationLevel


class MaterializerReplayTest(unittest.TestCase):
    def test_materializer_applies_only_declared_target(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "repo"
            root.mkdir()
            subprocess.run(("git", "init", "-q"), cwd=root, check=True)
            subprocess.run(("git", "config", "user.email", "rsi@test.invalid"), cwd=root, check=True)
            subprocess.run(("git", "config", "user.name", "RSI Test"), cwd=root, check=True)
            source = root / "FinSagent/src/utils"
            source.mkdir(parents=True)
            (source / "sample.py").write_text("VALUE = 1\n", encoding="utf-8")
            subprocess.run(("git", "add", "."), cwd=root, check=True)
            subprocess.run(("git", "commit", "-qm", "base"), cwd=root, check=True)
            patch = Path(tmp) / "candidate.patch"
            patch.write_text(
                "diff --git a/FinSagent/src/utils/sample.py b/FinSagent/src/utils/sample.py\n"
                "--- a/FinSagent/src/utils/sample.py\n+++ b/FinSagent/src/utils/sample.py\n"
                "@@ -1 +1 @@\n-VALUE = 1\n+VALUE = 2\n", encoding="utf-8",
            )
            candidate = CandidatePatch(
                "cand-test", "fc-test", MutationLevel.SKILL, "hypothesis", "mechanism",
                ("src/utils/sample.py",), ("test",), ("test",),
            )
            worktree = Path(tmp) / "worktree"
            result = materialize_candidate(repo_root=root, baseline_ref="HEAD", workspace=worktree, candidate=candidate, patch_path=patch)
            self.assertEqual((worktree / "FinSagent/src/utils/sample.py").read_text(), "VALUE = 2\n")
            self.assertEqual(result.changed_paths, ("src/utils/sample.py",))

    def test_replay_judge_penalizes_noop_false_trigger(self):
        judge = SkillReplayJudgeAdapter()
        case = {
            "baseline_answer": "Correct answer. H20 should not be used.",
            "rubric": {"expected_trigger": False, "preserve_input_answer": True},
        }
        metric = judge.score(case, {"answer": "replacement", "repair_applied": True, "repair_reason": "bad", "latency_ms": 1})
        self.assertEqual(metric.success, 0.0)
        self.assertEqual(metric.trigger_false_positive, 1)
        self.assertEqual(metric.critical_error_count, 1)


if __name__ == "__main__":
    unittest.main()
