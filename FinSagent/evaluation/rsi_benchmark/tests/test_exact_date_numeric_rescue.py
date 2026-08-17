import unittest

from rsi.candidate_skills.exact_date_numeric_rescue_v1 import select_exact_date_numeric_evidence


class ExactDateNumericRescueTest(unittest.TestCase):
    def test_cross_language_exact_date_and_metric_rescue(self):
        target = {
            "page_content": "As of February 21, 2025, 24.4 billion shares of common stock were outstanding.",
            "metadata": {"doc_id": "nvidia-10k"},
        }
        result = select_exact_date_numeric_evidence(
            "截至2025年2月21日，NVIDIA有多少普通股流通在外？", [target], [],
        )
        self.assertTrue(result["rescue_applied"])
        self.assertEqual(result["rescued_candidate_indices"], [0])

    def test_date_only_chunk_is_not_rescued(self):
        target = {
            "page_content": "The filing was published on February 21, 2025.",
            "metadata": {"doc_id": "nvidia-10k"},
        }
        result = select_exact_date_numeric_evidence(
            "截至2025年2月21日，NVIDIA有多少普通股流通在外？", [target], [],
        )
        self.assertFalse(result["rescue_applied"])

    def test_non_target_metric_is_noop_and_preserves_identity(self):
        selected = [{"page_content": "existing", "metadata": {"doc_id": "z"}}]
        result = select_exact_date_numeric_evidence(
            "极氪2024年全年的销量", [], selected,
        )
        self.assertFalse(result["rescue_applied"])
        self.assertIs(result["selected_chunks"], selected)


if __name__ == "__main__":
    unittest.main()
