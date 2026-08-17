import json
import tempfile
import unittest
from pathlib import Path

from evaluation.rsi_benchmark.source_aligned_targets import build_source_aligned_targets


class SourceAlignedTargetsTest(unittest.TestCase):
    def test_exports_only_question_fields_and_splits_company(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            private = root / "private.jsonl"
            private.write_text("\n".join(json.dumps({
                "case_id": f"c{i}", "company": company,
                "target": {"question": f"q{i}"},
                "rubric": {"ground_truth_answer": "hidden", "key_points": ["hidden"]},
            }) for i, company in enumerate(("lotus", "nvidia"), 1)) + "\n")
            out = root / "targets"
            manifest = build_source_aligned_targets(private, out)
            exported = (out / "lotus.questions.jsonl").read_text()
            self.assertEqual(manifest["case_count"], 2)
            self.assertNotIn("hidden", exported)
            self.assertEqual(set(json.loads(exported)), {"case_id", "question"})
            self.assertEqual(oct(out.stat().st_mode & 0o777), "0o700")


if __name__ == "__main__":
    unittest.main()
