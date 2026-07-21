from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "src"))

from pdf_research_demo.citation_gate import (
    EvidenceCard,
    gate_markdown,
    generate_cited_answer,
)


class FakeJsonClient:
    def __init__(self, *outputs: dict[str, object] | str) -> None:
        self.outputs = list(outputs)
        self.calls: list[list[dict[str, str]]] = []

    def chat_json(
        self,
        messages: list[dict[str, str]],
        **_options: object,
    ) -> str:
        self.calls.append(messages)
        output = self.outputs.pop(0)
        return output if isinstance(output, str) else json.dumps(output, ensure_ascii=False)

    def chat(
        self,
        messages: list[dict[str, str]],
        **options: object,
    ) -> str:
        return self.chat_json(messages, **options)


def _card(evidence_id: str = "fact:revenue-2025") -> EvidenceCard:
    return EvidenceCard(
        evidence_id=evidence_id,
        excerpt="2025 年收入同比增长 17.4%。",
        markdown_citation=f"[财报 Sheet1!B2](#source?evidence_id={evidence_id})",
        source_label="财报 Sheet1!B2",
        dataset_id="demo",
        company_name="星河公司",
    )


def test_first_pass_structured_claim_is_rendered_by_service() -> None:
    client = FakeJsonClient(
        {
            "claims": [
                {
                    "claim_id": "claim-1",
                    "text": "2025 年收入同比增长 17.4%。",
                    "status": "supported",
                    "evidence_ids": ["fact:revenue-2025"],
                }
            ]
        }
    )

    result = generate_cited_answer(
        client,
        question="收入增长是多少？",
        evidence_cards=[_card()],
    )

    assert result.status == "passed"
    assert result.attempt_count == 1
    assert result.needs_review is False
    assert "[财报 Sheet1!B2](#source?evidence_id=fact:revenue-2025)" in result.markdown
    assert len(client.calls) == 1


def test_missing_evidence_is_repaired_once_without_rewriting_contract() -> None:
    client = FakeJsonClient(
        {
            "claims": [
                {
                    "claim_id": "claim-1",
                    "text": "2025 年收入同比增长 17.4%。",
                    "status": "supported",
                    "evidence_ids": [],
                }
            ]
        },
        {
            "repairs": [
                {
                    "claim_id": "claim-1",
                    "status": "supported",
                    "evidence_ids": ["fact:revenue-2025"],
                }
            ]
        },
    )

    result = generate_cited_answer(
        client,
        question="收入增长是多少？",
        evidence_cards=[_card()],
    )

    assert result.status == "repaired"
    assert result.repaired is True
    assert result.attempt_count == 2
    assert not result.violations
    assert result.claims[0].text == "2025 年收入同比增长 17.4%。"


def test_invalid_retry_degrades_claim_to_needs_review() -> None:
    invalid = {
        "claims": [
            {
                "claim_id": "claim-1",
                "text": "收入增长 99%。",
                "status": "supported",
                "evidence_ids": ["fact:invented"],
            }
        ]
    }
    client = FakeJsonClient(
        invalid,
        {
            "repairs": [
                {
                    "claim_id": "claim-1",
                    "status": "supported",
                    "evidence_ids": ["fact:invented"],
                }
            ]
        },
    )

    result = generate_cited_answer(
        client,
        question="收入增长是多少？",
        evidence_cards=[_card()],
    )

    assert result.status == "needs_review"
    assert result.needs_review is True
    assert "待复核" in result.markdown
    assert "fact:invented" not in result.markdown


def test_citation_syntax_inside_structured_text_is_blocked_and_removed() -> None:
    invalid = {
        "claims": [
            {
                "claim_id": "claim-1",
                "text": "收入同比增长 17.4%。[fact:invented]",
                "status": "supported",
                "evidence_ids": ["fact:revenue-2025"],
            }
        ]
    }
    client = FakeJsonClient(
        invalid,
        {
            "repairs": [
                {
                    "claim_id": "claim-1",
                    "status": "supported",
                    "evidence_ids": ["fact:revenue-2025"],
                }
            ]
        },
    )

    result = generate_cited_answer(
        client,
        question="收入增长是多少？",
        evidence_cards=[_card()],
    )

    assert result.status == "needs_review"
    assert "待复核" in result.markdown
    assert "fact:invented" not in result.markdown


def test_no_evidence_returns_not_covered_without_model_call() -> None:
    client = FakeJsonClient()

    result = generate_cited_answer(
        client,
        question="未知问题",
        evidence_cards=[],
    )

    assert result.status == "not_covered"
    assert result.markdown == "资料未覆盖"
    assert not client.calls


def test_existing_markdown_canonicalizes_malformed_id_and_renders_source() -> None:
    result = gate_markdown(
        "- 收入同比增长 17.4%。[evidence_id:fact:revenue-2025]",
        evidence_cards=[_card()],
    )

    assert result.status == "passed"
    assert "[财报 Sheet1!B2](#source?evidence_id=fact:revenue-2025)" in result.markdown
    assert "[evidence_id:" not in result.markdown


def test_existing_markdown_repairs_only_missing_line_mapping() -> None:
    client = FakeJsonClient(
        {
            "repairs": [
                {
                    "line_index": 0,
                    "status": "supported",
                    "evidence_ids": ["fact:revenue-2025"],
                }
            ]
        }
    )

    result = gate_markdown(
        "- 收入同比增长 17.4%。",
        evidence_cards=[_card()],
        repair_client=client,
    )

    assert result.status == "repaired"
    assert result.attempt_count == 1
    assert "待复核" not in result.markdown
    assert "财报 Sheet1!B2" in result.markdown


def test_mixed_valid_and_invented_ids_cannot_bypass_gate() -> None:
    result = gate_markdown(
        "- 收入同比增长 17.4%。[fact:revenue-2025] [fact:invented]",
        evidence_cards=[_card()],
    )

    assert result.status == "needs_review"
    assert "待复核" in result.markdown
    assert "fact:invented" not in result.markdown


def test_mixed_valid_and_invented_ids_can_be_repaired_with_valid_mapping() -> None:
    client = FakeJsonClient(
        {
            "repairs": [
                {
                    "line_index": 0,
                    "status": "supported",
                    "evidence_ids": ["fact:revenue-2025"],
                }
            ]
        }
    )

    result = gate_markdown(
        "- 收入同比增长 17.4%。[fact:revenue-2025] [fact:invented]",
        evidence_cards=[_card()],
        repair_client=client,
    )

    assert result.status == "repaired"
    assert "待复核" not in result.markdown
    assert "fact:invented" not in result.markdown
    assert result.claims[0].evidence_ids == ("fact:revenue-2025",)
