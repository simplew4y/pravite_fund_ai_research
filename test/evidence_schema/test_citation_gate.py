"""Pure citation quality gate: missing core fields -> needs_review."""

from __future__ import annotations

from evidence_schema import (
    AdapterContext,
    Citation,
    MemoEvidenceAdapter,
    check_citation_quality,
)


def _citation(**overrides):
    base = dict(
        citation_id="cit_x",
        source_type="memo_section",
        source_id="thesis",
        evidence_id="ev_1",
        claim="极氪长期毛利率有上行空间。",
        quote="",
        display="memo_001, section thesis",
    )
    base.update(overrides)
    return Citation(**base)


def test_full_citation_passes():
    result = check_citation_quality(_citation())
    assert result.ok is True
    assert result.needs_review is False
    assert result.missing == []


def test_missing_claim_needs_review():
    result = check_citation_quality(_citation(claim=""))
    assert result.needs_review is True
    assert "claim" in result.missing


def test_missing_evidence_id_needs_review():
    result = check_citation_quality(_citation(evidence_id=""))
    assert result.needs_review is True
    assert "evidence_id" in result.missing


def test_missing_display_needs_review():
    result = check_citation_quality(_citation(display=""))
    assert result.needs_review is True
    assert "display" in result.missing


def test_renderable_evidence_substitutes_for_empty_display():
    block = {
        "memo_id": "memo_001",
        "section_id": "thesis",
        "heading": "核心观点",
        "content": "极氪具备规模化降本能力。",
    }
    evidence = MemoEvidenceAdapter().adapt(
        [block], AdapterContext(doc_id="memo_001", version_id="ver_001")
    )[0]
    result = check_citation_quality(_citation(display=""), evidence=evidence)
    assert result.ok is True
    assert result.missing == []


def test_quote_is_optional():
    result = check_citation_quality(_citation(quote=""))
    assert result.ok is True
