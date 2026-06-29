"""Lightweight, pure citation quality gate (no LLM, no DB).

A citation is "good enough" to back a core claim when it has:
  - evidence_id        (it points at a traceable evidence)
  - claim              (what it is supporting)
  - a display string, or an evidence that can be rendered into one
`quote` is optional. When a core field is missing the gate returns
needs_review=true so the caller (e.g. Memo) can mark the section.

This lives in Evidence Schema for now but is logic-self-contained: if it
later moves to the Memo module, only the file moves, not the logic.
See docs/memo_generation_design.md section 9 and ASSUMPTIONS in
test/evidence_schema/README.md (gate ownership is not yet confirmed).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional

from .display import render_citation_display
from .schema import Citation, Evidence


@dataclass
class CitationGateResult:
    """Outcome of checking a single citation."""

    ok: bool
    needs_review: bool
    missing: list[str] = field(default_factory=list)


def check_citation_quality(
    citation: Citation,
    evidence: Optional[Evidence] = None,
) -> CitationGateResult:
    """Validate one citation; missing core fields -> needs_review=true.

    `evidence` is optional: when the citation has no pre-rendered display, a
    display is derived from the evidence so a renderable location still counts.
    """
    missing: list[str] = []
    if not citation.evidence_id:
        missing.append("evidence_id")
    if not citation.claim:
        missing.append("claim")

    display = citation.display
    if not display and evidence is not None:
        try:
            display = render_citation_display(evidence)
        except Exception:  # pragma: no cover - defensive
            display = ""
    if not display:
        missing.append("display")

    ok = not missing
    return CitationGateResult(ok=ok, needs_review=not ok, missing=missing)
