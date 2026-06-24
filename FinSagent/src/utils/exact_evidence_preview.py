"""Lightweight exact-match evidence preview for SEC QA runs.

This module is intentionally a side-channel: it does not replace hybrid
retrieval or decide answers. It provides grep-style snippets for audit,
preview, and rescue experiments when a question contains concrete terms.
"""

from __future__ import annotations

import json
import re
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Iterable


_TOKEN_RE = re.compile(r"[A-Za-z][A-Za-z0-9&./-]{2,}|\d[\d,.$%/-]*")
_STOPWORDS = {
    "about",
    "after",
    "also",
    "and",
    "are",
    "between",
    "company",
    "compare",
    "compared",
    "did",
    "does",
    "for",
    "from",
    "had",
    "has",
    "how",
    "its",
    "mean",
    "report",
    "reported",
    "say",
    "same",
    "the",
    "their",
    "through",
    "was",
    "were",
    "what",
    "when",
    "where",
    "which",
    "with",
    "year",
}


@dataclass(frozen=True)
class ExactEvidenceHit:
    path: str
    matched_terms: list[str]
    score: float
    snippet: str

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def extract_exact_terms(question: str, max_terms: int = 12) -> list[str]:
    """Extract concrete grep-friendly terms from a question."""
    terms: list[str] = []
    seen: set[str] = set()
    for match in _TOKEN_RE.finditer(question or ""):
        raw = match.group(0).strip(".,;:()[]{}")
        if not raw:
            continue
        lowered = raw.lower()
        if lowered in _STOPWORDS:
            continue
        if len(raw) < 3 and not raw.isdigit():
            continue
        key = lowered.replace(",", "")
        if key in seen:
            continue
        seen.add(key)
        terms.append(raw)
        if len(terms) >= max_terms:
            break
    return terms


def _iter_candidate_files(roots: Iterable[str], max_file_bytes: int) -> Iterable[Path]:
    suffixes = {".json", ".jsonl", ".txt", ".md", ".csv"}
    for root in roots:
        root_path = Path(root).expanduser()
        if root_path.is_file():
            candidates = [root_path]
        elif root_path.is_dir():
            candidates = (p for p in root_path.rglob("*") if p.is_file())
        else:
            continue
        for path in candidates:
            if path.suffix.lower() not in suffixes:
                continue
            try:
                if path.stat().st_size > max_file_bytes:
                    continue
            except OSError:
                continue
            yield path


def _read_text(path: Path) -> str:
    raw = path.read_text(encoding="utf-8", errors="ignore")
    if path.suffix.lower() == ".json":
        try:
            return json.dumps(json.loads(raw), ensure_ascii=False)
        except Exception:
            return raw
    return raw


def _compact(value: str, max_chars: int) -> str:
    text = re.sub(r"\s+", " ", value or "").strip()
    if len(text) <= max_chars:
        return text
    return text[: max_chars - 3].rstrip() + "..."


def _best_snippet(text: str, terms: list[str], context_chars: int) -> tuple[list[str], str]:
    lowered = text.lower()
    matches: list[tuple[int, str]] = []
    for term in terms:
        term_lower = term.lower()
        start = 0
        while True:
            pos = lowered.find(term_lower, start)
            if pos < 0:
                break
            matches.append((pos, term))
            start = pos + max(1, len(term_lower))
            if len(matches) > 200:
                break
    if not matches:
        return [], ""
    matches.sort()
    best_start = 0
    best_terms: list[str] = []
    best_score = -1
    window_chars = max(200, context_chars * 2)
    for pos, _ in matches:
        start = max(0, pos - context_chars // 2)
        end = min(len(text), start + window_chars)
        window = lowered[start:end]
        window_terms = [term for term in terms if term.lower() in window]
        unique_count = len({term.lower() for term in window_terms})
        score = unique_count * 100 - len(window)
        if score > best_score:
            best_score = score
            best_start = start
            best_terms = window_terms
    start = best_start
    end = min(len(text), start + window_chars)
    matched_terms = best_terms
    return matched_terms, _compact(text[start:end], max_chars=context_chars * 2)


def exact_evidence_preview(
    question: str,
    roots: Iterable[str],
    max_hits: int = 5,
    max_terms: int = 12,
    max_file_bytes: int = 5_000_000,
    context_chars: int = 500,
) -> dict[str, Any]:
    """Return grep-style evidence snippets for concrete question terms."""
    terms = extract_exact_terms(question, max_terms=max_terms)
    hits: list[ExactEvidenceHit] = []
    if not terms:
        return {"enabled": True, "terms": [], "hits": []}

    for path in _iter_candidate_files(roots, max_file_bytes=max_file_bytes):
        try:
            text = _read_text(path)
        except Exception:
            continue
        matched_terms, snippet = _best_snippet(text, terms, context_chars=context_chars)
        if not matched_terms:
            continue
        score = len(set(term.lower() for term in matched_terms))
        hits.append(
            ExactEvidenceHit(
                path=str(path),
                matched_terms=matched_terms,
                score=float(score),
                snippet=snippet,
            )
        )

    hits.sort(key=lambda hit: (hit.score, len(hit.matched_terms)), reverse=True)
    return {
        "enabled": True,
        "terms": terms,
        "hits": [hit.to_dict() for hit in hits[:max_hits]],
    }
