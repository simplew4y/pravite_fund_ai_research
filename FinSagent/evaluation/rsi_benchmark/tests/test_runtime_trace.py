import unittest

from skillops.runtime_trace import build_skill_trace


class RuntimeTraceTest(unittest.TestCase):
    def test_trace_uses_hashes_and_metadata_without_answer_or_content(self):
        trace = build_skill_trace(
            skill_id="period_source_conflict_repair",
            skill_version="1.0.0",
            input_answer="secret input answer",
            output_answer="secret output answer",
            result={"repair_applied": True, "repair_reason": "period conflict"},
            evidence_chunks=[{
                "page_content": "private evidence body",
                "metadata": {"filename": "filing.pdf", "page": 17, "date": "2025-03-01"},
            }],
            latency_ms=1.25,
        )

        encoded = repr(trace)
        self.assertEqual(trace["status"], "applied")
        self.assertTrue(trace["answer_changed"])
        self.assertNotIn("secret input answer", encoded)
        self.assertNotIn("secret output answer", encoded)
        self.assertNotIn("private evidence body", encoded)
        self.assertEqual(trace["evidence_refs"][0]["page"], 17)


if __name__ == "__main__":
    unittest.main()
