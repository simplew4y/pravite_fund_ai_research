from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from evaluation.rsi_benchmark.debug_batch_worker import apply_retrieval_overrides, load_target_questions


class DebugAdapterTest(unittest.TestCase):
    def test_target_loader_rejects_hidden_fields(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "questions.jsonl"
            path.write_text(json.dumps({"case_id": "c1", "question": "A valid financial question?", "rubric": {}}) + "\n")
            with self.assertRaises(ValueError):
                load_target_questions(path)

    def test_target_loader_accepts_question_only(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "questions.jsonl"
            path.write_text(json.dumps({"case_id": "c1", "question": "A valid financial question?"}) + "\n")
            self.assertEqual(load_target_questions(path)[0]["case_id"], "c1")

    def test_retrieval_overrides_do_not_mutate_source_config(self):
        source = {"persist_directory": "/old", "collection_name": "old"}
        resolved = apply_retrieval_overrides(
            source, persist_directory="/tmp/new", collection_name="lotus",
        )
        self.assertEqual(source["collection_name"], "old")
        self.assertEqual(resolved["collection_name"], "lotus")
        self.assertEqual(resolved["persist_directory"], "/tmp/new")


if __name__ == "__main__":
    unittest.main()
