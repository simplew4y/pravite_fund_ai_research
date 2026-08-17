from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from dataclasses import replace

from evaluation.rsi_benchmark.curation import assign_splits, deduplicate, review_proposals, validate_suite
from evaluation.rsi_benchmark.importers import import_dataset
from evaluation.rsi_benchmark.models import Provenance


class RsiBenchmarkTest(unittest.TestCase):
    def test_import_split_and_public_redaction(self):
        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / "qa.json"
            source.write_text(json.dumps([{
                "qid": "q1",
                "question": "What was Acme revenue growth in fiscal year 2025?",
                "ground_truth_answer": "Revenue grew 20%.",
                "key_points": ["20% growth"],
                "diagnostic_meta": {"company": "Acme", "evidence_cutoff": "2025-12-31"},
            }]), encoding="utf-8")
            item = assign_splits(import_dataset(source), public_ratio=1.0)[0]
            self.assertEqual(item.company, "Acme")
            self.assertIn("numeric_reasoning", item.capabilities)
            self.assertNotIn("answer_key", item.to_dict(public=True))
            self.assertTrue(validate_suite([item])["valid"])

    def test_near_duplicates_are_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / "qa.json"
            row = {
                "question": "What was Acme revenue growth in 2025?",
                "ground_truth_answer": "20%", "key_points": ["20%"],
                "diagnostic_meta": {"company": "Acme"},
            }
            source.write_text(json.dumps([row, row]), encoding="utf-8")
            kept, rejected = deduplicate(import_dataset(source))
            self.assertEqual(len(kept), 1)
            self.assertEqual(rejected[0]["reason"], "near_duplicate")

    def test_proposal_gate_requires_novel_agent_provenance(self):
        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / "qa.json"
            source.write_text(json.dumps([{
                "question": "What was Acme revenue growth in 2025?",
                "ground_truth_answer": "20%", "key_points": ["20%"],
                "diagnostic_meta": {"company": "Acme"},
            }]), encoding="utf-8")
            frozen = import_dataset(source)
            duplicate = replace(
                frozen[0], item_id="proposal-1",
                provenance=Provenance(origin="agent_generated", generation_round=1, generator="question-agent-v1"),
            )
            accepted, rejected = review_proposals(frozen, [duplicate])
            self.assertFalse(accepted)
            self.assertIn("not novel enough", " ".join(rejected[0]["reasons"]))


if __name__ == "__main__":
    unittest.main()
