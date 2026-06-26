"""Evidence Schema / Citation / Provenance.

Parsing may be per-type, but citation must be unified:
    citation -> evidence -> (document, version, location) -> original file.
"""

from __future__ import annotations

from .adapters import (
    ADAPTER_REGISTRY,
    AdapterContext,
    BaseEvidenceAdapter,
    ExcelEvidenceAdapter,
    PdfEvidenceAdapter,
)
from .display import render_citation_display
from .ids import make_citation_id, make_evidence_id, make_location_id, now_iso
from .normalizer import (
    EvidenceValidationError,
    normalize_evidence,
    normalize_many,
    validate_evidence,
)
from .repository import (
    EvidenceRepository,
    InMemoryEvidenceRepository,
    build_citation,
)
from .schema import (
    Citation,
    Document,
    DocumentVersion,
    Evidence,
    EvidenceLocation,
    EvidenceType,
    SourceType,
    VersionStatus,
)

__all__ = [
    # schema
    "Document",
    "DocumentVersion",
    "Evidence",
    "EvidenceLocation",
    "Citation",
    "EvidenceType",
    "SourceType",
    "VersionStatus",
    # ids
    "make_evidence_id",
    "make_location_id",
    "make_citation_id",
    "now_iso",
    # adapters
    "AdapterContext",
    "BaseEvidenceAdapter",
    "PdfEvidenceAdapter",
    "ExcelEvidenceAdapter",
    "ADAPTER_REGISTRY",
    # normalizer
    "validate_evidence",
    "normalize_evidence",
    "normalize_many",
    "EvidenceValidationError",
    # display + repository
    "render_citation_display",
    "build_citation",
    "EvidenceRepository",
    "InMemoryEvidenceRepository",
]
