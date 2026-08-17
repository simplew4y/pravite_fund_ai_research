import json
import tempfile
import unittest
from pathlib import Path

from evaluation.rsi_benchmark.trusted_retrieval_synthesis import prepare_synthesis_rows


class TrustedRetrievalSynthesisTest(unittest.TestCase):
    def _files(self, root: Path, selected):
        chunk = {"page_content": "real", "metadata": {"doc_id": "d1"}}
        captures = root / "captures.jsonl"
        captures.write_text(json.dumps({
            "case_id": "c1", "pre_rerank_candidates": [chunk], "retrieved_chunks": [],
        }) + "\n")
        questions = root / "questions.jsonl"
        questions.write_text(json.dumps({"case_id": "c1", "question": "q"}) + "\n")
        outputs = root / "outputs.jsonl"
        outputs.write_text(json.dumps({
            "case_id": "c1", "seed": 29, "candidate_id": "cand", "selected_chunks": selected,
        }) + "\n")
        return captures, questions, outputs, chunk

    def test_prepares_only_canonical_captured_evidence(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            captures, questions, outputs, chunk = self._files(
                root, [{"page_content": "real", "metadata": {"doc_id": "d1"}}],
            )
            rows = prepare_synthesis_rows(captures, questions, outputs)
            self.assertEqual(rows[0]["selected_chunks"], [chunk])
            self.assertEqual(rows[0]["seed"], 29)

    def test_rejects_forged_candidate_evidence(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            captures, questions, outputs, _ = self._files(
                root, [{"page_content": "forged", "metadata": {"doc_id": "d1"}}],
            )
            with self.assertRaisesRegex(ValueError, "not in the captured baseline evidence"):
                prepare_synthesis_rows(captures, questions, outputs)


if __name__ == "__main__":
    unittest.main()
