import json
import tempfile
import unittest
from pathlib import Path

from evaluation.rsi_benchmark.captured_skill_replay import replay_captured_skill


class CapturedSkillReplayTest(unittest.TestCase):
    def test_replays_candidate_from_capture_without_evaluator_fields(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            module = root / "candidate.py"
            module.write_text(
                "def repair(q, a, chunks):\n"
                "    return {'answer': a + ' fixed', 'repair_applied': True, 'repair_reason': 'guard'}\n"
            )
            captures = root / "captures.jsonl"
            captures.write_text(json.dumps({
                "case_id": "c1", "seed": 11,
                "skill_replay_inputs": [{
                    "skill_id": "period", "question": "q", "input_answer": "draft",
                    "retrieved_chunks": [], "baseline_result": {},
                }],
            }) + "\n")
            output = root / "candidate.jsonl"

            count = replay_captured_skill(
                captures_path=captures, module_path=module, function_name="repair",
                skill_id="period", out_path=output, candidate_id="cand-1",
            )
            row = json.loads(output.read_text())
            self.assertEqual(count, 1)
            self.assertEqual(row["answer"], "draft fixed")
            self.assertNotIn("ground_truth_answer", row)


if __name__ == "__main__":
    unittest.main()
