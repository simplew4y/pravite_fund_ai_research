import json
import tempfile
import unittest
from pathlib import Path

from evaluation.rsi_benchmark.captured_retrieval_replay import replay_captured_retrieval


class CapturedRetrievalReplayTest(unittest.TestCase):
    def test_replays_without_evaluator_fields(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            module = root / "candidate.py"
            module.write_text(
                "def select(q, pre, selected):\n"
                "    return {'selected_chunks': pre[:1] + selected, "
                "'rescue_applied': True, 'rescue_reason': 'exact anchors', "
                "'rescued_candidate_indices': [0]}\n"
            )
            captures = root / "captures.jsonl"
            captures.write_text(json.dumps({
                "case_id": "c1", "seed": 11,
                "pre_rerank_candidates": [{"page_content": "target", "metadata": {}}],
                "retrieved_chunks": [], "answer": "not exposed",
            }) + "\n")
            questions = root / "questions.jsonl"
            questions.write_text(json.dumps({"case_id": "c1", "question": "q"}) + "\n")
            output = root / "candidate.jsonl"

            count = replay_captured_retrieval(
                captures_path=captures, questions_path=questions, module_path=module,
                function_name="select", out_path=output, candidate_id="cand-1",
            )
            row = json.loads(output.read_text())
            self.assertEqual(count, 1)
            self.assertEqual(row["rescued_candidate_indices"], [0])
            self.assertNotIn("answer", row)
            self.assertNotIn("ground_truth_answer", row)

    def test_rejects_question_rows_with_hidden_fields(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            module = root / "candidate.py"
            module.write_text("def select(q, pre, selected): return {}\n")
            captures = root / "captures.jsonl"
            captures.write_text(json.dumps({"case_id": "c1"}) + "\n")
            questions = root / "questions.jsonl"
            questions.write_text(json.dumps({
                "case_id": "c1", "question": "q", "ground_truth_answer": "secret",
            }) + "\n")
            with self.assertRaisesRegex(ValueError, "forbidden fields"):
                replay_captured_retrieval(
                    captures_path=captures, questions_path=questions, module_path=module,
                    function_name="select", out_path=root / "out.jsonl", candidate_id="cand-1",
                )

    def test_rejects_candidate_chunk_injection(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            module = root / "candidate.py"
            module.write_text(
                "def select(q, pre, selected):\n"
                "    return {'selected_chunks': [{'page_content': 'forged', 'metadata': {}}]}\n"
            )
            captures = root / "captures.jsonl"
            captures.write_text(json.dumps({
                "case_id": "c1", "pre_rerank_candidates": [
                    {"page_content": "real", "metadata": {}}
                ], "retrieved_chunks": [],
            }) + "\n")
            questions = root / "questions.jsonl"
            questions.write_text(json.dumps({"case_id": "c1", "question": "q"}) + "\n")
            with self.assertRaisesRegex(ValueError, "not in the captured baseline evidence"):
                replay_captured_retrieval(
                    captures_path=captures, questions_path=questions, module_path=module,
                    function_name="select", out_path=root / "out.jsonl", candidate_id="cand-1",
                )


if __name__ == "__main__":
    unittest.main()
