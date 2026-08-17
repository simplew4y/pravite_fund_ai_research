import json
import tempfile
import unittest
from pathlib import Path

from evaluation.rsi_benchmark.private_full_agent_judge import build_private_judge_inputs


class PrivateFullAgentJudgeTest(unittest.TestCase):
    def test_hidden_rubric_is_joined_only_after_target_execution(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            cases = root / "cases.jsonl"
            outputs = root / "outputs.jsonl"
            cases.write_text(json.dumps({
                "case_id": "c1", "suite": "targeted", "capability": "period", "company": "Lotus",
                "target": {"question": "question"},
                "rubric": {"ground_truth_answer": "hidden answer", "key_points": ["hidden key"],
                           "critical_errors": [], "expected_period_markers": ["2025"],
                           "expected_skill_trigger": True},
            }) + "\n")
            outputs.write_text(json.dumps({"case_id": "c1", "seed": 11, "answer": "model answer", "arm": "baseline"}) + "\n")
            out = root / "private"

            manifest = build_private_judge_inputs(cases, outputs, out)
            self.assertEqual(manifest["row_count"], 1)
            self.assertNotIn("hidden answer", (out / "manifest.json").read_text())
            self.assertIn("hidden answer", (out / "judge_key.private.jsonl").read_text())
            self.assertEqual(oct(out.stat().st_mode & 0o777), "0o700")
            self.assertEqual(oct((out / "judge_key.private.jsonl").stat().st_mode & 0o777), "0o600")


if __name__ == "__main__":
    unittest.main()
