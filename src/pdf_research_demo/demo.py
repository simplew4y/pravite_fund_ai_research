"""End-to-end PDF-only QA and memo demo."""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Protocol

from .citation_gate import EvidenceCard, generate_cited_answer
from .models import Citation, Document, Evidence
from .store import PdfEvidenceStore


class ChatClient(Protocol):
    def chat(
        self,
        messages: list[dict[str, str]],
        *,
        max_tokens: int | None = None,
        temperature: float | None = None,
    ) -> str:
        ...


@dataclass(frozen=True)
class QaResult:
    question: str
    answer: str
    citations: list[Citation]
    needs_review: bool
    llm_used: bool = False
    llm_error: str = ""
    citation_gate: dict[str, object] = field(default_factory=dict)


@dataclass(frozen=True)
class MemoSection:
    section_id: str
    title: str
    content: str
    citations: list[Citation]
    needs_review: bool
    llm_used: bool = False
    llm_error: str = ""
    citation_gate: dict[str, object] = field(default_factory=dict)


@dataclass(frozen=True)
class MemoDraft:
    memo_id: str
    title: str
    sections: list[MemoSection]
    llm_used: bool = False
    llm_error: str = ""

    @property
    def citations(self) -> list[Citation]:
        out: list[Citation] = []
        for section in self.sections:
            out.extend(section.citations)
        return out

    def to_markdown(self) -> str:
        lines = [f"# {self.title}", ""]
        for section in self.sections:
            review = " _(needs review)_" if section.needs_review else ""
            lines.extend([f"## {section.title}{review}", "", section.content, ""])
            if section.citations:
                lines.append("Citations:")
                for citation in section.citations:
                    lines.append(f"- `{citation.citation_id}`: {citation.display}")
                lines.append("")
        return "\n".join(lines).strip() + "\n"


class PdfResearchDemo:
    """Minimal PDF research loop: ingest -> QA -> memo -> provenance trace."""

    def __init__(self, llm_client: ChatClient | None = None) -> None:
        self.store = PdfEvidenceStore()
        self.llm_client = llm_client

    def ingest_pdf(self, pdf_path: str | Path, text_path: str | Path | None = None) -> Document:
        return self.store.ingest_pdf(pdf_path, text_path)

    def answer_question(self, question: str, top_k: int = 3) -> QaResult:
        evidence = self.store.search(question, top_k=top_k)
        if not evidence:
            return QaResult(
                question=question,
                answer="No supporting PDF evidence was found. This answer needs review.",
                citations=[],
                needs_review=True,
            )

        source_id = f"qa_{abs(hash(question)) & 0xffffffff:x}"
        citations = [
            self.store.cite(
                item,
                source_type="qa_answer",
                source_id=source_id,
                claim=question,
            )
            for item in evidence
        ]
        llm_used = False
        llm_error = ""
        citation_gate: dict[str, object] = {}
        needs_review = any(c.needs_review for c in citations)
        if self.llm_client:
            try:
                answer, citation_issue, citation_gate = self._llm_answer(
                    question, evidence, citations
                )
                llm_used = True
                needs_review = needs_review or citation_issue
            except Exception as exc:  # noqa: BLE001 - surface LLM failures without breaking provenance fallback.
                answer = self._extractive_answer(evidence, citations)
                llm_error = str(exc)
                needs_review = True
        else:
            answer = self._extractive_answer(evidence, citations)
        return QaResult(
            question=question,
            answer=answer,
            citations=citations,
            needs_review=needs_review,
            llm_used=llm_used,
            llm_error=llm_error,
            citation_gate=citation_gate,
        )

    def generate_memo(self, company_name: str, ticker: str) -> MemoDraft:
        memo_id = f"memo_{ticker.lower()}_pdf_demo"
        section_specs = [
            ("overview", "Company Overview", f"{company_name} business products services"),
            ("thesis", "Core Thesis", "Robotaxi FSD energy storage growth strategy"),
            (
                "financials",
                "Financial Performance",
                "revenue operating income cash flow capital expenditures",
            ),
            ("risks", "Risks", "risk factors competition supply demand regulatory Robotaxi"),
        ]

        sections: list[MemoSection] = []
        for section_key, title, query in section_specs:
            source_id = f"{memo_id}_{section_key}"
            evidence = self.store.search(query, top_k=2)
            citations = [
                self.store.cite(
                    item,
                    source_type="memo_section",
                    source_id=source_id,
                    claim=title,
                )
                for item in evidence
            ]
            llm_used = False
            llm_error = ""
            citation_gate: dict[str, object] = {}
            if evidence:
                needs_review = any(citation.needs_review for citation in citations)
                if self.llm_client:
                    try:
                        content, citation_issue, citation_gate = self._llm_memo_section(
                            title, evidence, citations
                        )
                        needs_review = needs_review or citation_issue
                        llm_used = True
                    except Exception as exc:  # noqa: BLE001
                        content = self._memo_section_text(evidence, citations)
                        llm_error = str(exc)
                        needs_review = True
                else:
                    content = self._memo_section_text(evidence, citations)
            else:
                content = "No supporting PDF evidence was found for this section."
                needs_review = True
            sections.append(
                MemoSection(
                    section_id=source_id,
                    title=title,
                    content=content,
                    citations=citations,
                    needs_review=needs_review,
                    llm_used=llm_used,
                    llm_error=llm_error,
                    citation_gate=citation_gate,
                )
            )
        llm_errors = [section.llm_error for section in sections if section.llm_error]
        return MemoDraft(
            memo_id=memo_id,
            title=f"{company_name} ({ticker}) PDF Evidence Memo",
            sections=sections,
            llm_used=any(section.llm_used for section in sections),
            llm_error="; ".join(llm_errors),
        )

    def trace_citation(self, citation_id: str) -> dict[str, object]:
        return self.store.trace_citation(citation_id)

    @staticmethod
    def _sentence(evidence: Evidence, max_chars: int = 360) -> str:
        text = evidence.content_text.strip()
        text = re.sub(r"^(Table of Contents\s*)+", "", text, flags=re.IGNORECASE).strip()
        text = re.sub(r"^PART\s+[IVX]+\s+", "", text, flags=re.IGNORECASE).strip()
        text = re.sub(r"^ITEM\s+\d+[A-Z]?\.\s+[A-Z][A-Z\s]+\s+", "", text).strip()
        text = re.sub(r"^Overview\s+", "", text, flags=re.IGNORECASE).strip()
        for separator in (". ", "; ", "\n"):
            if separator in text[:max_chars]:
                return text[: text.find(separator) + 1].strip()
        return text[:max_chars].rstrip() + ("..." if len(text) > max_chars else "")

    def _extractive_answer(self, evidence: list[Evidence], citations: list[Citation]) -> str:
        lead = self._sentence(evidence[0])
        citation_marks = " ".join(f"[{citation.citation_id}]" for citation in citations)
        return (
            f"Based on the retrieved PDF evidence, the strongest support is: "
            f"{lead} {citation_marks}"
        )

    def _memo_section_text(
        self,
        evidence: list[Evidence],
        citations: list[Citation],
    ) -> str:
        lines = []
        for item, citation in zip(evidence, citations, strict=True):
            lines.append(f"- {self._sentence(item, max_chars=260)} [{citation.citation_id}]")
        return "\n".join(lines)

    def _llm_answer(
        self,
        question: str,
        evidence: list[Evidence],
        citations: list[Citation],
    ) -> tuple[str, bool, dict[str, object]]:
        if not self.llm_client:
            return self._extractive_answer(evidence, citations), False, {}
        result = generate_cited_answer(
            self.llm_client,
            question=question,
            evidence_cards=self._citation_gate_cards(evidence, citations),
            max_tokens=512,
            retry_once=True,
            same_language=True,
        )
        return result.markdown, result.needs_review, result.safe_audit()

    def _llm_memo_section(
        self,
        title: str,
        evidence: list[Evidence],
        citations: list[Citation],
    ) -> tuple[str, bool, dict[str, object]]:
        if not self.llm_client:
            return self._memo_section_text(evidence, citations), False, {}
        result = generate_cited_answer(
            self.llm_client,
            question=f"Section title: {title}. Write 2 to 4 concise memo claims.",
            evidence_cards=self._citation_gate_cards(evidence, citations),
            max_tokens=650,
            retry_once=True,
            same_language=False,
        )
        markdown = "\n".join(
            f"- {line}" for line in result.markdown.splitlines() if line.strip()
        )
        return markdown, result.needs_review, result.safe_audit()

    @staticmethod
    def _citation_gate_cards(
        evidence: list[Evidence], citations: list[Citation]
    ) -> list[EvidenceCard]:
        return [
            EvidenceCard(
                evidence_id=citation.citation_id,
                excerpt=item.content_text,
                markdown_citation=f"[{citation.citation_id}]",
                source_label=citation.display,
            )
            for item, citation in zip(evidence, citations, strict=True)
        ]
