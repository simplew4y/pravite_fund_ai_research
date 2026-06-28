"""Per-type evidence adapters."""

from __future__ import annotations

from .base import AdapterContext, BaseEvidenceAdapter
from .excel_adapter import ExcelEvidenceAdapter
from .markdown_adapter import MarkdownEvidenceAdapter
from .memo_adapter import MemoEvidenceAdapter
from .pdf_adapter import PdfEvidenceAdapter
from .ppt_adapter import PptEvidenceAdapter
from .qa_adapter import QaEvidenceAdapter
from .word_adapter import WordEvidenceAdapter

ADAPTER_REGISTRY: dict[str, type[BaseEvidenceAdapter]] = {
    "pdf": PdfEvidenceAdapter,
    "excel": ExcelEvidenceAdapter,
    "ppt": PptEvidenceAdapter,
    "word": WordEvidenceAdapter,
    "markdown": MarkdownEvidenceAdapter,
    "qa": QaEvidenceAdapter,
    "memo": MemoEvidenceAdapter,
}

__all__ = [
    "AdapterContext",
    "BaseEvidenceAdapter",
    "PdfEvidenceAdapter",
    "ExcelEvidenceAdapter",
    "PptEvidenceAdapter",
    "WordEvidenceAdapter",
    "MarkdownEvidenceAdapter",
    "QaEvidenceAdapter",
    "MemoEvidenceAdapter",
    "ADAPTER_REGISTRY",
]
