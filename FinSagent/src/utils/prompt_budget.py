"""Deterministic character budgets for prompts sent to finite-context LLMs."""

from __future__ import annotations

from collections.abc import Iterable


TRUNCATION_MARKER = "\n[... content truncated to fit the model context ...]\n"


def truncate_text(text: str, max_chars: int, *, marker: str = TRUNCATION_MARKER) -> str:
    """Keep the highest-priority prefix of *text* within ``max_chars``.

    Retrieval results are already ordered by relevance and RAG context notes are
    prepended, so prefix-preserving truncation is intentional here.
    """
    value = str(text or "")
    limit = max(0, int(max_chars))
    if len(value) <= limit:
        return value
    if limit == 0:
        return ""
    if limit <= len(marker):
        return value[:limit]
    return value[: limit - len(marker)] + marker


def join_with_budget(parts: Iterable[str], max_chars: int, separator: str = "\n\n") -> str:
    """Join ordered text parts without exceeding a deterministic character budget."""
    values = [str(part) for part in parts if part]
    if not values:
        return ""
    return truncate_text(separator.join(values), max_chars)
