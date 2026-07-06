"""PDF evidence ingestion, retrieval, and citation trace."""

from __future__ import annotations

import hashlib
import re
import shutil
import subprocess
from pathlib import Path
from typing import Iterable

from .models import Citation, Document, DocumentVersion, Evidence, EvidenceLocation


def _sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _stable_id(prefix: str, *parts: object, length: int = 16) -> str:
    raw = "\0".join(str(part) for part in parts)
    digest = hashlib.sha256(raw.encode("utf-8")).hexdigest()[:length]
    return f"{prefix}_{digest}"


def _clean_text(text: str) -> str:
    return re.sub(r"\s+", " ", text or "").strip()


_STOPWORDS = {
    "about",
    "and",
    "are",
    "company",
    "does",
    "for",
    "from",
    "how",
    "inc",
    "pdf",
    "say",
    "says",
    "tesla",
    "the",
    "what",
    "when",
    "where",
    "which",
    "with",
}

_QUERY_EXPANSIONS = {
    "特斯拉": "tesla electric vehicles energy storage full self-driving fsd robotaxi ai robots optimus",
    "投资逻辑": "business overview strategy growth revenue operating income cash flow ai fsd robotaxi energy storage risks competition demand",
    "核心投资逻辑": "business overview strategy growth revenue operating income cash flow ai fsd robotaxi energy storage risks competition demand",
    "投资亮点": "business overview strategy growth revenue operating income cash flow ai fsd robotaxi energy storage",
    "商业模式": "business overview products services direct sales energy storage software services",
    "增长": "growth revenue deliveries deployments production capacity services energy storage",
    "财务": "revenue gross profit operating income net income operating cash flow capital expenditures liquidity",
    "盈利": "gross profit operating income net income margin profitability",
    "现金流": "operating cash flow free cash flow capital expenditures liquidity",
    "估值": "valuation revenue growth profitability cash flow risk",
    "风险": "risk factors competition regulatory uncertainty supply demand macroeconomic",
    "催化": "catalysts robotaxi fsd energy storage production capacity launch growth",
    "自动驾驶": "full self-driving fsd robotaxi autonomous autonomy",
    "机器人": "ai robots bots optimus",
    "储能": "energy generation storage deployments megapack powerwall",
    "能源": "energy generation storage deployments megapack powerwall",
}


def _query_terms(query: str) -> list[str]:
    lowered = query.lower()
    expanded = [lowered]
    for phrase, expansion in _QUERY_EXPANSIONS.items():
        if phrase in lowered:
            expanded.append(expansion)
    lowered = " ".join(expanded)
    terms = re.findall(r"[a-z0-9][a-z0-9._%/-]*", lowered)
    terms.extend(re.findall(r"[\u4e00-\u9fff]{2,}", lowered))
    return [term for term in terms if len(term) >= 2 and term not in _STOPWORDS]


def _split_paragraphs(page_text: str) -> list[str]:
    blocks = [block.strip() for block in re.split(r"\n\s*\n+", page_text) if block.strip()]
    if len(blocks) <= 1:
        blocks = [line.strip() for line in page_text.splitlines() if line.strip()]

    paragraphs: list[str] = []
    buffer: list[str] = []
    for block in blocks:
        text = _clean_text(block)
        if not text:
            continue
        buffer.append(text)
        if sum(len(item) for item in buffer) >= 700:
            paragraphs.append(_clean_text(" ".join(buffer)))
            buffer = []
    if buffer:
        paragraphs.append(_clean_text(" ".join(buffer)))
    return paragraphs


def _split_pages(raw_text: str) -> list[str]:
    pages = raw_text.replace("\r\n", "\n").replace("\r", "\n").split("\f")
    while pages and not pages[-1].strip():
        pages.pop()
    return pages or [raw_text]


def _extract_pages_with_pdftotext(pdf: Path) -> list[str]:
    binary = shutil.which("pdftotext")
    if not binary:
        return []
    proc = subprocess.run(
        [binary, "-layout", "-enc", "UTF-8", str(pdf), "-"],
        capture_output=True,
        text=True,
        check=False,
    )
    if proc.returncode != 0:
        return []
    return _split_pages(proc.stdout)


def _extract_pages_with_pypdf(pdf: Path) -> list[str]:
    try:
        from pypdf import PdfReader
    except Exception:
        return []
    try:
        reader = PdfReader(str(pdf))
        return [(page.extract_text() or "") for page in reader.pages]
    except Exception:
        return []


def _extract_pdf_pages(pdf: Path) -> tuple[list[str], str]:
    """Extract native PDF text without building a persistent chunk/index."""
    pages = _extract_pages_with_pdftotext(pdf)
    if any(page.strip() for page in pages):
        return pages, "pdftotext"

    pages = _extract_pages_with_pypdf(pdf)
    if any(page.strip() for page in pages):
        return pages, "pypdf"

    raise RuntimeError(
        "Could not extract text from PDF. Install Poppler pdftotext or pypdf, "
        "or provide a cached text_path for this file."
    )


class PdfEvidenceStore:
    """In-memory PDF evidence store.

    The demo accepts a PDF path plus an optional text extraction path. Without
    text_path it extracts native PDF text directly with Poppler pdftotext or
    pypdf. No persistent retrieval chunk/index is built; page paragraphs become
    temporary citable evidence units.
    """

    def __init__(self) -> None:
        self.documents: dict[str, Document] = {}
        self.versions: dict[str, DocumentVersion] = {}
        self.evidence: dict[str, Evidence] = {}
        self.citations: dict[str, Citation] = {}

    def ingest_pdf(self, pdf_path: str | Path, text_path: str | Path | None = None) -> Document:
        pdf = Path(pdf_path).expanduser().resolve()
        if not pdf.is_file():
            raise FileNotFoundError(f"PDF not found: {pdf}")
        if pdf.suffix.lower() != ".pdf":
            raise ValueError(f"Expected a PDF file, got: {pdf}")

        checksum = _sha256_bytes(pdf.read_bytes())
        doc_id = _stable_id("doc", pdf.name, checksum)
        version_id = _stable_id("ver", doc_id, checksum)
        document = Document(
            doc_id=doc_id,
            file_name=pdf.name,
            file_path=str(pdf),
            checksum=checksum,
        )
        version = DocumentVersion(
            version_id=version_id,
            doc_id=doc_id,
            file_path=str(pdf),
            checksum=checksum,
            parser_name="pending",
        )
        self.documents[doc_id] = document

        text_file = Path(text_path).expanduser().resolve() if text_path else None
        if text_file is not None:
            if not text_file.is_file():
                raise FileNotFoundError(f"PDF text cache not found: {text_file}")
            pages = _split_pages(text_file.read_text(encoding="utf-8", errors="replace"))
            parser_name = "cached_pdf_text"
        else:
            pages, parser_name = _extract_pdf_pages(pdf)
        self.versions[version_id] = DocumentVersion(
            version_id=version.version_id,
            doc_id=version.doc_id,
            file_path=version.file_path,
            checksum=version.checksum,
            parser_name=parser_name,
            version_no=version.version_no,
        )

        # Re-ingesting the same file version should refresh its evidence.
        for evidence_id, evidence in list(self.evidence.items()):
            if evidence.version_id == version_id:
                self.evidence.pop(evidence_id, None)

        for page_index, page_text in enumerate(pages, start=1):
            for paragraph_index, paragraph in enumerate(_split_paragraphs(page_text), start=1):
                if len(paragraph) < 40:
                    continue
                evidence_id = _stable_id("ev", version_id, page_index, paragraph_index, paragraph[:120])
                location = EvidenceLocation(
                    file_name=pdf.name,
                    file_path=str(pdf),
                    page_no=page_index,
                    paragraph_no=paragraph_index,
                )
                self.evidence[evidence_id] = Evidence(
                    evidence_id=evidence_id,
                    doc_id=doc_id,
                    version_id=version_id,
                    evidence_type="pdf_page_paragraph",
                    content_text=paragraph,
                    location=location,
                    metadata={
                        "parser_name": parser_name,
                        **({"text_path": str(text_file)} if text_file is not None else {}),
                    },
                )
        return document

    def search(self, query: str, top_k: int = 5) -> list[Evidence]:
        terms = _query_terms(query)
        if not terms:
            return []
        scored: list[tuple[float, Evidence]] = []
        for item in self.evidence.values():
            text = item.content_text.lower()
            score = 0.0
            for term in terms:
                count = text.count(term)
                if count:
                    score += 3.0 + count
            if score:
                score += min(len(item.content_text), 1200) / 5000
                scored.append((score, item))
        scored.sort(key=lambda pair: (-pair[0], pair[1].location.page_no, pair[1].evidence_id))
        return [item for _, item in scored[:top_k]]

    def cite(
        self,
        evidence: Evidence,
        *,
        source_type: str,
        source_id: str,
        claim: str,
        quote: str | None = None,
    ) -> Citation:
        snippet = _clean_text(quote or evidence.content_text[:260])
        citation_id = _stable_id("cit", source_type, source_id, evidence.evidence_id, claim)
        citation = Citation(
            citation_id=citation_id,
            source_type=source_type,
            source_id=source_id,
            evidence_id=evidence.evidence_id,
            doc_id=evidence.doc_id,
            claim=claim,
            quote=snippet,
            display=evidence.display(),
            needs_review=not bool(evidence.evidence_id and claim and evidence.display()),
        )
        self.citations[citation_id] = citation
        return citation

    def trace_citation(self, citation_id: str) -> dict[str, object]:
        citation = self.citations.get(citation_id)
        if citation is None:
            return {}
        evidence = self.evidence.get(citation.evidence_id)
        document = self.documents.get(evidence.doc_id) if evidence else None
        version = self.versions.get(evidence.version_id) if evidence else None
        return {
            "citation": citation,
            "evidence": evidence,
            "document": document,
            "version": version,
            "location": evidence.location if evidence else None,
            "original_file": version.file_path if version else "",
        }

    def trace_all(self, citation_ids: Iterable[str]) -> list[dict[str, object]]:
        return [trace for cid in citation_ids if (trace := self.trace_citation(cid))]
