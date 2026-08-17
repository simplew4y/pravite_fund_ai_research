"""Shared, fail-closed retrieval scope primitives.

``None`` is reserved for legacy callers that intentionally request an
unscoped search.  An empty scope is a valid deny-all scope and must never be
coerced back to ``None``.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Iterable, Mapping, Sequence


@dataclass(frozen=True)
class RetrievalScope:
    """Document boundary resolved once from the original user question."""

    source_query: str
    source_doc_ids: tuple[str, ...]
    explicit_company: bool = False
    dataset_id: str = ""

    @classmethod
    def from_doc_ids(
        cls,
        source_query: str,
        source_doc_ids: Sequence[str],
        *,
        explicit_company: bool = False,
        dataset_id: str = "",
    ) -> "RetrievalScope":
        unique_ids = tuple(dict.fromkeys(str(value) for value in source_doc_ids if value))
        return cls(
            source_query=source_query,
            source_doc_ids=unique_ids,
            explicit_company=explicit_company,
            dataset_id=dataset_id,
        )

    def as_set(self) -> set[str]:
        return set(self.source_doc_ids)


def metadata_source_doc_id(metadata: Mapping[str, Any] | None) -> str:
    """Return the ingestion document id; never confuse it with a chunk id."""

    return str((metadata or {}).get("source_doc_id") or "")


def filter_chunks_to_scope(
    chunks: Iterable[Mapping[str, Any]],
    allowed_source_doc_ids: set[str] | None,
) -> list[dict[str, Any]]:
    """Apply a defensive document boundary to materialized retrieval chunks.

    ``None`` preserves the legacy unscoped behaviour.  ``set()`` deliberately
    returns no chunks.  Chunks without ``source_doc_id`` are rejected whenever
    a scope was supplied because legacy ``doc_id`` commonly identifies the
    chunk rather than the source document.
    """

    materialized = [dict(chunk) for chunk in chunks]
    if allowed_source_doc_ids is None:
        return materialized
    return [
        chunk
        for chunk in materialized
        if metadata_source_doc_id(chunk.get("metadata")) in allowed_source_doc_ids
    ]
