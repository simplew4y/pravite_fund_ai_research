from __future__ import annotations

import re
import json
from pathlib import Path
from typing import Any


CITATION_PATTERN = re.compile(r"(?:\[[^\]]+\]|(?:p\.|page|页码?)\s*\d+)", re.IGNORECASE)
NUMBER_PATTERN = re.compile(
    r"(?<!\w)(?:[$¥€£]\s*)?-?\d[\d,.]*(?:\s*%|\s*(?:million|billion|万元|亿元))?",
    re.IGNORECASE,
)


def structural_report_score(report_path: Path, task: dict[str, Any]) -> dict[str, Any]:
    """Cheap pre-judge gate; factual scoring remains claim/evidence based."""
    text = report_path.read_text(encoding="utf-8")
    headings = [line.lstrip("#").strip().casefold() for line in text.splitlines() if line.startswith("#")]
    required = [str(x) for x in task.get("required_sections", [])]
    missing = [section for section in required if not any(section.casefold() in heading for heading in headings)]
    citations = CITATION_PATTERN.findall(text)
    numbers = NUMBER_PATTERN.findall(text)
    structure_score = 1.0 if not required else (len(required) - len(missing)) / len(required)
    citation_density = len(citations) / max(1, len(numbers))
    return {
        "task_id": task.get("task_id"),
        "valid": bool(text.strip()) and not missing and bool(citations),
        "word_count": len(text.split()),
        "required_sections": required,
        "missing_sections": missing,
        "structure_score": round(structure_score, 4),
        "citation_count": len(citations),
        "numeric_mention_count": len(numbers),
        "citation_per_numeric_mention": round(citation_density, 4),
        "note": "This is a deterministic format gate, not a correctness or evidence-faithfulness score.",
    }


def build_judge_packet(report_path: Path, task: dict[str, Any], claims: list[dict[str, Any]]) -> dict[str, Any]:
    claim_ids = set(str(x) for x in task.get("claim_ids", []))
    selected = [claim for claim in claims if str(claim.get("claim_id")) in claim_ids]
    return {
        "schema_version": "private-fund-report-judge-packet/v1",
        "task": task,
        "generated_report": report_path.read_text(encoding="utf-8"),
        "claim_rubrics": selected,
        "judge_instructions": [
            "Score every claim as supported, partially_supported, missing, contradicted, or not_applicable.",
            "A correct fact without a resolvable citation does not receive full evidence-faithfulness credit.",
            "Penalize fiscal-period leakage, cross-company source contamination, unsupported calculations, and fact/inference conflation.",
            "Also score thesis coherence, section completeness, risk balance, decision usefulness, and citation quality from 1 to 5.",
            "Return JSON with claim_results, report_scores, critical_errors, and overall_verdict.",
        ],
        "expected_output": {
            "claim_results": [{"claim_id": "...", "verdict": "supported", "evidence": [], "reason": "..."}],
            "report_scores": {
                "thesis_coherence": 1, "section_completeness": 1, "risk_balance": 1,
                "decision_usefulness": 1, "citation_quality": 1,
            },
            "critical_errors": [],
            "overall_verdict": "pass|partial|fail",
        },
    }


def load_jsonl_dicts(path: Path) -> list[dict[str, Any]]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]
