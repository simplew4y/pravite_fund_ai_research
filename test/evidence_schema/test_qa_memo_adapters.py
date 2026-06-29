"""QA / Memo parsed blocks -> unified, citable evidence."""

from __future__ import annotations

from evidence_schema import (
    AdapterContext,
    MemoEvidenceAdapter,
    QaEvidenceAdapter,
    build_citation,
    normalize_many,
    render_citation_display,
)


def _ctx(doc_id: str, file_name: str = ""):
    return AdapterContext(doc_id=doc_id, version_id="ver_001", file_name=file_name)


# --- QA adapter --------------------------------------------------------------


def test_qa_blocks_become_unified_evidence(qa_blocks):
    evidences = normalize_many(QaEvidenceAdapter().adapt(qa_blocks, _ctx("qa_doc")))
    assert len(evidences) == 2  # blank message dropped
    e = next(e for e in evidences if e.location.location_json["message_id"] == "msg_002")
    assert e.evidence_type == "qa_message"
    assert e.location.location_json["session_id"] == "session_001"
    assert e.location.location_json["role"] == "assistant"
    assert e.metadata_json["citation_ids"] == ["cit_demo"]
    assert render_citation_display(e) == "session_001, assistant message msg_002"


def test_qa_message_aliases_map_to_canonical():
    block = {"session": "s9", "msg_id": "m9", "role": "user", "body": "问题"}
    e = normalize_many(QaEvidenceAdapter().adapt([block], _ctx("qa_doc")))[0]
    assert e.location.location_json["session_id"] == "s9"
    assert e.location.location_json["message_id"] == "m9"
    assert render_citation_display(e) == "s9, user message m9"


def test_qa_citation_ids_top_level_takes_precedence():
    block = {
        "session_id": "s1",
        "message_id": "m1",
        "role": "assistant",
        "content": "答案",
        "citation_ids": ["cit_top"],
        "metadata_json": {"citation_ids": ["cit_nested"]},
    }
    e = normalize_many(QaEvidenceAdapter().adapt([block], _ctx("qa_doc")))[0]
    assert e.metadata_json["citation_ids"] == ["cit_top"]


def test_qa_citation_ids_nested_metadata_still_supported():
    block = {
        "session_id": "s1",
        "message_id": "m1",
        "role": "assistant",
        "content": "答案",
        "metadata_json": {"citation_ids": ["cit_nested"]},
    }
    e = normalize_many(QaEvidenceAdapter().adapt([block], _ctx("qa_doc")))[0]
    assert e.metadata_json["citation_ids"] == ["cit_nested"]


# --- Memo adapter ------------------------------------------------------------


def test_memo_blocks_become_unified_evidence(memo_blocks):
    evidences = normalize_many(MemoEvidenceAdapter().adapt(memo_blocks, _ctx("memo_001")))
    assert len(evidences) == 2  # blank section dropped
    e = next(e for e in evidences if e.location.location_json["section_id"] == "thesis")
    assert e.evidence_type == "memo_section"
    assert e.location.location_json["memo_id"] == "memo_001"
    assert e.location.heading == "核心观点"
    assert e.metadata_json["section_type"] == "thesis"
    # display prefers the human-readable heading over the raw section_id.
    assert render_citation_display(e) == "memo_001, section 核心观点"


def test_memo_evidence_is_consumable_by_build_citation(memo_blocks):
    e = next(
        ev
        for ev in MemoEvidenceAdapter().adapt(memo_blocks, _ctx("memo_001"))
        if ev.location.location_json["section_id"] == "thesis"
    )
    citation = build_citation(
        e, "memo_section", "thesis", claim="极氪长期毛利率有上行空间。"
    )
    assert citation.evidence_id == e.evidence_id
    assert citation.source_type == "memo_section"
    assert citation.claim
    assert citation.display == "memo_001, section 核心观点"


def test_memo_display_falls_back_to_section_id_without_heading():
    """When no readable heading/section exists, display uses the section id."""
    block = {"memo_id": "memo_001", "section_id": "thesis", "content": "结论。"}
    e = normalize_many(MemoEvidenceAdapter().adapt([block], _ctx("memo_001")))[0]
    assert e.location.heading is None
    assert render_citation_display(e) == "memo_001, section thesis"


def test_qa_memo_evidence_ids_are_deterministic(qa_blocks, memo_blocks):
    qa1 = QaEvidenceAdapter().adapt(qa_blocks, _ctx("qa_doc"))
    qa2 = QaEvidenceAdapter().adapt(qa_blocks, _ctx("qa_doc"))
    assert [e.evidence_id for e in qa1] == [e.evidence_id for e in qa2]
    m1 = MemoEvidenceAdapter().adapt(memo_blocks, _ctx("memo_001"))
    m2 = MemoEvidenceAdapter().adapt(memo_blocks, _ctx("memo_001"))
    assert [e.evidence_id for e in m1] == [e.evidence_id for e in m2]
