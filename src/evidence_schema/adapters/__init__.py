"""Per-type evidence adapters."""

from __future__ import annotations

from .base import AdapterContext, BaseEvidenceAdapter
from .excel_adapter import ExcelEvidenceAdapter
from .pdf_adapter import PdfEvidenceAdapter

ADAPTER_REGISTRY: dict[str, type[BaseEvidenceAdapter]] = {
    "pdf": PdfEvidenceAdapter,
    "excel": ExcelEvidenceAdapter,
}

__all__ = [
    "AdapterContext",
    "BaseEvidenceAdapter",
    "PdfEvidenceAdapter",
    "ExcelEvidenceAdapter",
    "ADAPTER_REGISTRY",
]
