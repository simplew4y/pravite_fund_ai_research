from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from evaluation.rsi_benchmark.report_builder import build_tasks, import_claims
from evaluation.rsi_benchmark.report_eval import build_judge_packet, structural_report_score


class ReportBenchmarkTest(unittest.TestCase):
    def test_questions_become_hidden_claims_inside_report_task(self):
        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / "financebench.json"
            source.write_text(json.dumps({
                "dataset": "financebench", "entries": [
                    {
                        "uid": f"q{i}", "question": f"What was Acme revenue metric {i} in 2025?",
                        "ground_truth": f"{i} million", "status": "found",
                        "extra": {"company": "Acme"},
                        "source_pdfs": [{"path": "/server/acme.pdf", "pages": [str(i)]}],
                    }
                    for i in range(3)
                ],
            }), encoding="utf-8")
            dataset, claims = import_claims(source)
            tasks, unassigned = build_tasks(dataset, claims)
            self.assertEqual(len(tasks), 1)
            self.assertFalse(unassigned)
            self.assertEqual(len(tasks[0].claim_ids), 3)
            self.assertNotIn("claim_ids", tasks[0].to_dict(hidden=False))
            self.assertNotIn("expected_answer", claims[0].to_dict(hidden=False))

    def test_report_structure_gate(self):
        with tempfile.TemporaryDirectory() as tmp:
            report = Path(tmp) / "report.md"
            report.write_text(
                "# Executive Summary\nAcme revenue was $10 million [acme.pdf p. 2].\n"
                "# Historical Financial Performance\nDetails.\n# Key Drivers\nDetails.\n"
                "# Investment View\nDetails.\n# Sources\n- acme.pdf\n",
                encoding="utf-8",
            )
            task = {"task_id": "r1", "required_sections": [
                "Executive Summary", "Historical Financial Performance", "Key Drivers", "Investment View", "Sources"
            ]}
            result = structural_report_score(report, task)
            self.assertTrue(result["valid"])
            self.assertEqual(result["structure_score"], 1.0)

    def test_judge_packet_selects_only_task_claims(self):
        with tempfile.TemporaryDirectory() as tmp:
            report = Path(tmp) / "report.md"
            report.write_text("# Report\nEvidence [doc-1 p. 2].", encoding="utf-8")
            packet = build_judge_packet(
                report,
                {"task_id": "r1", "claim_ids": ["c2"]},
                [{"claim_id": "c1", "expected_answer": "one"}, {"claim_id": "c2", "expected_answer": "two"}],
            )
            self.assertEqual([x["claim_id"] for x in packet["claim_rubrics"]], ["c2"])
            self.assertIn("generated_report", packet)


if __name__ == "__main__":
    unittest.main()
