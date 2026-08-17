import unittest

from evaluation.rsi_benchmark.strict_private_judge import build_messages, extract_json_object, validate_judgment


class StrictPrivateJudgeTest(unittest.TestCase):
    def payload(self):
        return {
            "analysis": "ok",
            "key_points": [{"index": 1, "status": "PRESENT", "reason": "covered"}],
            "scores": {"coverage": 5, "reasoning": 4, "factual_consistency": 5, "clarity": 4, "analytical_depth": 4},
            "primary_error": "NONE", "critical_errors": [], "verdict": "CORRECT",
        }

    def test_extracts_fenced_json(self):
        self.assertEqual(extract_json_object('```json\n{"verdict":"PARTIAL"}\n```')["verdict"], "PARTIAL")

    def test_validates_complete_correct_payload(self):
        self.assertTrue(validate_judgment(self.payload(), 1)["passed"])

    def test_rejects_correct_with_missing_key_point(self):
        value = self.payload()
        value["key_points"][0]["status"] = "MISSING"
        with self.assertRaises(ValueError):
            validate_judgment(value, 1)

    def test_rejects_key_point_count_mismatch(self):
        with self.assertRaises(ValueError):
            validate_judgment(self.payload(), 2)

    def test_qwen_prompt_explicitly_disables_thinking(self):
        messages = build_messages({
            "question": "q", "ground_truth_answer": "a", "key_points": ["k"],
            "generated_answer": "g",
        })
        self.assertIn("/no_think", messages[0]["content"])
        self.assertIn("integer from 1 through 5", messages[0]["content"])


if __name__ == "__main__":
    unittest.main()
