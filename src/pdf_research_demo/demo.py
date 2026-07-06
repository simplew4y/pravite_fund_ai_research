"""End-to-end PDF-only QA and memo demo."""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

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


@dataclass(frozen=True)
class MemoSection:
    section_id: str
    title: str
    content: str
    citations: list[Citation]
    needs_review: bool
    llm_used: bool = False
    llm_error: str = ""


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
        needs_review = any(c.needs_review for c in citations)
        if self.llm_client:
            try:
                answer, citation_issue = self._llm_answer(question, evidence, citations)
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
        )

    def generate_memo(self, company_name: str, ticker: str) -> MemoDraft:
        memo_id = f"memo_{ticker.lower()}_pdf_demo"
        section_specs = [
            ("overview", "Company Overview", f"{company_name} business products services"),
            ("thesis", "Core Thesis", "Robotaxi FSD energy storage growth strategy"),
            ("financials", "Financial Performance", "revenue operating income cash flow capital expenditures"),
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
            if evidence:
                needs_review = any(citation.needs_review for citation in citations)
                if self.llm_client:
                    try:
                        content, citation_issue = self._llm_memo_section(title, evidence, citations)
                        needs_review = needs_review or citation_issue
                        llm_used = True
                    except Exception as exc:  # noqa: BLE001
                        content = self._memo_section_text(title, evidence, citations)
                        llm_error = str(exc)
                        needs_review = True
                else:
                    content = self._memo_section_text(title, evidence, citations)
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

    def _memo_section_text(self, title: str, evidence: list[Evidence], citations: list[Citation]) -> str:
        lines = []
        for item, citation in zip(evidence, citations):
            lines.append(f"- {self._sentence(item, max_chars=260)} [{citation.citation_id}]")
        return "\n".join(lines)

    def _llm_answer(
        self,
        question: str,
        evidence: list[Evidence],
        citations: list[Citation],
    ) -> tuple[str, bool]:
        if not self.llm_client:
            return self._extractive_answer(evidence, citations), False
        context = self._evidence_context(evidence, citations)
        messages = [
            {
                "role": "system",
                "content": (
                    "You are an evidence-backed financial research assistant. "
                    "Use only the supplied PDF evidence. Do not invent facts, files, page numbers, or citation ids. "
                    "Every material claim must include one of the provided citation ids in square brackets. "
                    "If the evidence is weak or incomplete, say what still needs review."
                ),
            },
            {
                "role": "user",
                "content": (
                    f"Question:\n{question}\n\n"
                    f"PDF evidence:\n{context}\n\n"
                    "Write a concise answer in the same language as the question. "
                    "Use citation ids exactly as provided."
                ),
            },
        ]
        text = self.llm_client.chat(messages, max_tokens=700, temperature=0.1)
        return self._finalize_cited_text(text, citations)

    def _llm_memo_section(
        self,
        title: str,
        evidence: list[Evidence],
        citations: list[Citation],
    ) -> tuple[str, bool]:
        if not self.llm_client:
            return self._memo_section_text(title, evidence, citations), False
        context = self._evidence_context(evidence, citations)
        messages = [
            {
                "role": "system",
                "content": (
                    "You write private-fund investment memo sections from local PDF evidence. "
                    "Use only the supplied evidence. Do not add unsupported outside knowledge. "
                    "Each bullet must end with at least one provided citation id in square brackets."
                ),
            },
            {
                "role": "user",
                "content": (
                    f"Section title: {title}\n\n"
                    f"PDF evidence:\n{context}\n\n"
                    "Write 2 to 4 concise memo bullets. Use citation ids exactly as provided."
                ),
            },
        ]
        text = self.llm_client.chat(messages, max_tokens=650, temperature=0.2)
        return self._finalize_cited_text(text, citations)

    def _evidence_context(self, evidence: list[Evidence], citations: list[Citation], max_chars: int = 1100) -> str:
        blocks = []
        for index, (item, citation) in enumerate(zip(evidence, citations), start=1):
            text = item.content_text.strip()
            if len(text) > max_chars:
                text = text[:max_chars].rstrip() + "..."
            blocks.append(
                "\n".join(
                    [
                        f"Evidence {index}",
                        f"citation_id: {citation.citation_id}",
                        f"location: {citation.display}",
                        f"quote: {text}",
                    ]
                )
            )
        return "\n\n".join(blocks)

    @staticmethod
    def _finalize_cited_text(text: str, citations: list[Citation]) -> tuple[str, bool]:
        allowed = {citation.citation_id for citation in citations}
        mentioned = set(re.findall(r"\bcit_[a-f0-9]{16}\b", text))
        unknown = bool(mentioned - allowed)
        missing_allowed = not bool(mentioned & allowed)
        if missing_allowed and citations:
            citation_marks = " ".join(f"[{citation.citation_id}]" for citation in citations)
            text = f"{text.rstrip()} {citation_marks}"
        return text.strip(), unknown or missing_allowed
