from __future__ import annotations

import unittest

from evaluation.rsi_benchmark.production_curation import validate_frozen_cases


class ProductionCurationTest(unittest.TestCase):
    def test_validator_rejects_duplicate_and_wrong_counts(self):
        case = {
            "case_id": "c1", "suite": "fresh_internal", "capability": "period_source_control",
            "company": "Acme", "target": {"question": "What happened in fiscal year 2025?"},
            "rubric": {"ground_truth_answer": "x", "key_points": ["x"], "critical_errors": []},
            "evidence_refs": [{"content_sha256": "x"}], "provenance": {},
        }
        report = validate_frozen_cases([case, dict(case)])
        self.assertFalse(report["valid"])
        self.assertIn("duplicate case ids", report["errors"])


if __name__ == "__main__":
    unittest.main()
