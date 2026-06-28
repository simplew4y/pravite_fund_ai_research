"""Excel parsed cells -> excel_cell evidence.

Excel is special: it is NOT plain-chunked. Evidence may also be produced
dynamically at retrieval time (the agent emits a cell dict). Each evidence
keeps sheet / cell / range / value / formula; upstream / number_format are
optional enhancements.

Expected block (canonical, matches the retrieval-time evidence chain):
    {
      "file": "Tesla_valuation_model.xlsx",   # or "file_name"
      "sheet": "DCF",                          # or "sheet_name"
      "range": "B10:H20",                      # or "cell_range"
      "cell": "E12",
      "value": "16.5%",
      "formula": "=E11/E10",
      "number_format": "0.0%",                 # optional
      "upstream_cells": ["E10", "E11"]         # optional, never required
    }

Upstream field names are not finalized, so each field is read through a set
of aliases (see ASSUMPTIONS in test/evidence_schema/README.md).
"""

from __future__ import annotations

from typing import Any

from ..schema import Evidence, EvidenceLocation, EvidenceType
from .base import AdapterContext, BaseEvidenceAdapter, pick


class ExcelEvidenceAdapter(BaseEvidenceAdapter):
    evidence_type = EvidenceType.EXCEL_CELL.value

    def adapt(
        self,
        parsed_blocks: list[dict[str, Any]],
        ctx: AdapterContext,
    ) -> list[Evidence]:
        evidences: list[Evidence] = []
        for block in parsed_blocks:
            sheet = pick(block, "sheet", "sheet_name")
            cell = pick(block, "cell")
            value = pick(block, "value")
            formula = pick(block, "formula")
            content_text = self._content_text(sheet, cell, value, formula)
            content_json: dict[str, Any] = {
                "value": value,
                "formula": formula,
            }
            number_format = pick(block, "number_format")
            if number_format is not None:
                content_json["number_format"] = number_format
            upstream_cells = pick(block, "upstream_cells")
            if upstream_cells:
                content_json["upstream_cells"] = upstream_cells
            location = EvidenceLocation(
                evidence_id="",
                file_name=pick(block, "file", "file_name") or ctx.file_name,
                sheet_name=sheet,
                cell=cell,
                cell_range=pick(block, "range", "cell_range"),
                formula=formula,
                location_json={"value": value} if value is not None else {},
            )
            evidences.append(
                self._build_evidence(
                    ctx, content_text, location, content_json=content_json
                )
            )
        return evidences

    @staticmethod
    def _content_text(
        sheet: Any, cell: Any, value: Any, formula: Any
    ) -> str:
        head = f"{sheet}!{cell}" if sheet and cell else (cell or sheet or "")
        text = head
        if value is not None:
            text = f"{head} = {value}" if head else str(value)
        if formula:
            text = f"{text}, formula = {str(formula).lstrip('=')}"
        return text
