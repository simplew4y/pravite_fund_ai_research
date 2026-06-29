#!/usr/bin/env python3
"""Step 2: classify workbook family to pick chunking strategy."""

from __future__ import annotations

import argparse
from pathlib import Path
from typing import Any

from common import dump_json, load_json, normalize_text, text_contains_any


FINANCIAL_SUPPLEMENT_WORDS = (
    "earnings supplement",
    "financial supplement",
    "earnings release",
    "quarterly supplement",
    "page(s)",
    "jpmorgan chase",
    "supplemental",
)

VALUATION_MODEL_WORDS = (
    "assumption",
    "driver",
    "scenario",
    "income statement",
    "balance sheet",
    "cash flow",
    "dcf",
    "wacc",
    "terminal value",
    "sensitivity",
    "comparable",
    "comps",
    "ev/ebitda",
    "估值",
    "假设",
    "利润表",
    "资产负债表",
    "现金流",
)


def _joined_manifest_text(manifest: dict[str, Any], limit: int = 20000) -> str:
    parts: list[str] = [str(manifest.get("source_filename") or "")]
    parts.extend(str(name) for name in manifest.get("workbook", {}).get("sheet_names", []))
    for sheet in manifest.get("sheets", []):
        parts.append(str(sheet.get("sheet_name") or ""))
        parts.extend(str(item) for item in sheet.get("sample_text", [])[:80])
    return normalize_text(" ".join(parts))[:limit]


def classify_workbook(manifest_path: str | Path) -> dict[str, Any]:
    manifest = load_json(manifest_path)
    sheets = manifest.get("sheets", [])
    text = _joined_manifest_text(manifest).lower()
    sheet_names = [str(item.get("sheet_name") or "") for item in sheets]
    page_like_sheets = sum(1 for name in sheet_names if name.lower().startswith("page "))
    visible_sheets = sum(1 for item in sheets if item.get("sheet_state") == "visible")
    formula_count = sum(int(item.get("formula_count") or 0) for item in sheets)
    non_empty_count = sum(int(item.get("non_empty_cell_count") or 0) for item in sheets)
    formula_density = formula_count / max(1, non_empty_count)

    scores = {
        "financial_supplement": 0,
        "valuation_model": 0,
        "simple_table": 0,
        "unknown": 0,
    }
    signals: list[str] = []

    if page_like_sheets >= max(3, len(sheet_names) // 3):
        scores["financial_supplement"] += 4
        signals.append(f"{page_like_sheets} page-like sheets")
    if text_contains_any(text, FINANCIAL_SUPPLEMENT_WORDS):
        scores["financial_supplement"] += 4
        signals.append("financial supplement keywords")
    if visible_sheets >= 8 and formula_density < 0.08:
        scores["financial_supplement"] += 1
        signals.append("many low-formula visible sheets")

    valuation_hits = sum(1 for word in VALUATION_MODEL_WORDS if word.lower() in text)
    if valuation_hits >= 3:
        scores["valuation_model"] += 4
        signals.append(f"{valuation_hits} valuation/model keywords")
    if formula_density >= 0.15 or formula_count >= 100:
        scores["valuation_model"] += 3
        signals.append(f"formula density {formula_density:.2%}, formulas {formula_count}")

    if visible_sheets <= 3 and formula_density < 0.1 and non_empty_count > 0:
        scores["simple_table"] += 2
        signals.append("few low-formula sheets")

    workbook_type = max(scores, key=scores.get)
    if scores[workbook_type] <= 0:
        workbook_type = "unknown"

    return {
        "source_filename": manifest.get("source_filename"),
        "workbook_type": workbook_type,
        "scores": scores,
        "signals": signals,
        "sheet_count": len(sheet_names),
        "visible_sheet_count": visible_sheets,
        "page_like_sheet_count": page_like_sheets,
        "formula_count": formula_count,
        "non_empty_cell_count": non_empty_count,
        "formula_density": round(formula_density, 4),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Classify workbook type.")
    parser.add_argument("--manifest", required=True, help="Path to workbook_manifest.json")
    parser.add_argument("--output", required=True, help="Path to classification.json")
    args = parser.parse_args()
    dump_json(classify_workbook(args.manifest), args.output)


if __name__ == "__main__":
    main()
