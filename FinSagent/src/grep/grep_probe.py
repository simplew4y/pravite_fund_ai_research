"""Structured grep evidence probe for SEC QA.

The probe is a cheap audit side-channel. It does not replace retrieval and it
does not answer questions. It finds lexical evidence anchors that downstream
preview, diagnosis, and SkillOps reports can inspect.
"""

from __future__ import annotations

import argparse
import json
import re
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Iterable


_TOKEN_RE = re.compile(r"[A-Za-z][A-Za-z0-9&./-]{2,}|\d[\d,.$%/-]*")
_NUMBER_RE = re.compile(
    r"(?<![A-Za-z])(?:[$RMBUS€£¥]{0,4}\s*)?-?\d[\d,]*(?:\.\d+)?\s*(?:%|percent|percentage points?|million|billion|thousand|mn|bn)?",
    re.IGNORECASE,
)
_YEAR_RE = re.compile(r"\b(?:20\d{2}|19\d{2})\b")
_QUARTER_RE = re.compile(r"\b(?:Q[1-4]|first quarter|second quarter|third quarter|fourth quarter)\b", re.IGNORECASE)
_PERIOD_PHRASE_RE = re.compile(
    r"\b(?:fiscal year|FY|year ended|nine months ended|three months ended|six months ended|quarter ended)\s+[^,.;:]{0,80}",
    re.IGNORECASE,
)
_STOPWORDS = {
    "about",
    "after",
    "also",
    "and",
    "are",
    "between",
    "business",
    "company",
    "compare",
    "compared",
    "did",
    "does",
    "ended",
    "for",
    "from",
    "had",
    "has",
    "how",
    "its",
    "mean",
    "period",
    "report",
    "reported",
    "same",
    "say",
    "technology",
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
_METRIC_ALIASES = {
    "revenue": ["revenue", "revenues", "total revenue", "net revenue", "sales"],
    "gross_profit": ["gross profit", "gross profits"],
    "gross_margin": ["gross margin", "gross profit margin"],
    "net_loss": ["net loss", "loss for the year", "net loss attributable"],
    "cash": ["cash", "cash and cash equivalents", "cash equivalents"],
    "delivery": ["delivery", "deliveries", "delivered vehicles", "vehicle deliveries"],
    "operating_expense": ["operating expense", "operating expenses", "total operating expenses"],
}


@dataclass(frozen=True)
class EvidenceAnchor:
    anchor_type: str
    text: str
    source_path: str
    start: int
    end: int
    snippet: str
    confidence_hint: float
    metadata: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class EvidenceProbeResult:
    question: str
    query_terms: list[str]
    metric_aliases: dict[str, list[str]]
    period_terms: list[str]
    anchors: list[EvidenceAnchor]
    files_scanned: int
    metadata: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        payload = asdict(self)
        payload["anchors"] = [anchor.to_dict() for anchor in self.anchors]
        return payload


def grep_probe(
    question: str,
    roots: Iterable[str],
    metadata: dict[str, Any] | None = None,
    *,
    regex_patterns: Iterable[str] | None = None,
    max_terms: int = 12,
    max_files: int = 200,
    max_file_bytes: int = 5_000_000,
    max_anchors: int = 30,
    context_chars: int = 260,
) -> EvidenceProbeResult:
    """Return structured lexical anchors for a SEC QA question."""
    query_terms = extract_query_terms(question, max_terms=max_terms)
    metric_aliases = select_metric_aliases(question)
    period_terms = extract_period_terms(question)
    patterns = [re.compile(pattern, re.IGNORECASE) for pattern in (regex_patterns or [])]
    anchors: list[EvidenceAnchor] = []
    files_scanned = 0

    for path in _iter_candidate_files(roots, max_file_bytes=max_file_bytes):
        if files_scanned >= max_files:
            break
        try:
            text = _read_text(path)
        except Exception:
            continue
        files_scanned += 1
        anchors.extend(_find_exact_anchors(text, path, query_terms, context_chars))
        anchors.extend(_find_metric_alias_anchors(text, path, metric_aliases, context_chars))
        anchors.extend(_find_period_anchors(text, path, period_terms, context_chars))
        anchors.extend(_find_regex_anchors(text, path, patterns, context_chars))
        anchors.extend(_find_nearby_number_anchors(text, path, query_terms, metric_aliases, period_terms, context_chars))

    anchors = _select_balanced_anchors(_dedupe_and_rank_anchors(anchors), max_anchors)
    return EvidenceProbeResult(
        question=question,
        query_terms=query_terms,
        metric_aliases=metric_aliases,
        period_terms=period_terms,
        anchors=anchors,
        files_scanned=files_scanned,
        metadata=metadata or {},
    )


def extract_query_terms(question: str, max_terms: int = 12) -> list[str]:
    terms: list[str] = []
    seen: set[str] = set()
    for expanded in _expand_multilingual_terms(question):
        key = expanded.lower()
        if key not in seen:
            seen.add(key)
            terms.append(expanded)
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


def _expand_multilingual_terms(question: str) -> list[str]:
    text = question or ""
    expansions: list[str] = []
    if "出口管制" in text:
        expansions.extend(["export controls", "export control", "license"])
    if "中国" in text:
        expansions.extend(["China", "Chinese"])
    if "数据中心" in text or "Data Center" in text:
        expansions.extend(["Data Center", "data center"])
    if "收入" in text:
        expansions.extend(["revenue", "revenues"])
    if "毛利率" in text:
        expansions.extend(["gross margin"])
    return expansions


def select_metric_aliases(question: str) -> dict[str, list[str]]:
    text = (question or "").lower()
    selected: dict[str, list[str]] = {}
    for metric, aliases in _METRIC_ALIASES.items():
        if any(alias.lower() in text for alias in aliases):
            selected[metric] = aliases
    return selected


def extract_period_terms(question: str) -> list[str]:
    terms: list[str] = []
    seen: set[str] = set()
    for pattern in (_PERIOD_PHRASE_RE, _QUARTER_RE, _YEAR_RE):
        for match in pattern.finditer(question or ""):
            term = match.group(0).strip(" ,.;:")
            key = term.lower()
            if term and key not in seen:
                seen.add(key)
                terms.append(term)
    if "财年" in (question or ""):
        for year in _YEAR_RE.findall(question or ""):
            for term in (f"fiscal year {year}", f"fiscal {year}"):
                key = term.lower()
                if key not in seen:
                    seen.add(key)
                    terms.append(term)
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
            return _json_payload_to_text(json.loads(raw))
        except Exception:
            return raw
    return raw


def _json_payload_to_text(payload: Any) -> str:
    text_fields = {
        "content",
        "text",
        "page_content",
        "title",
        "title_summary",
        "summary",
        "table",
        "html",
    }
    parts: list[str] = []

    def visit(value: Any, key: str = "") -> None:
        if isinstance(value, dict):
            for child_key, child in value.items():
                visit(child, str(child_key))
        elif isinstance(value, list):
            for child in value:
                visit(child, key)
        elif isinstance(value, str) and (key in text_fields or len(value) > 120):
            parts.append(value)

    visit(payload)
    return "\n".join(parts) if parts else json.dumps(payload, ensure_ascii=False)


def _find_exact_anchors(text: str, path: Path, terms: list[str], context_chars: int) -> list[EvidenceAnchor]:
    anchors: list[EvidenceAnchor] = []
    lowered = text.lower()
    for term in terms:
        term_lower = term.lower()
        start = 0
        while True:
            pos = lowered.find(term_lower, start)
            if pos < 0:
                break
            anchors.append(_make_anchor("exact_phrase", term, text, path, pos, pos + len(term), context_chars, 0.65))
            start = pos + max(1, len(term_lower))
            if len(anchors) >= 60:
                return anchors
    return anchors


def _find_metric_alias_anchors(
    text: str,
    path: Path,
    metric_aliases: dict[str, list[str]],
    context_chars: int,
) -> list[EvidenceAnchor]:
    anchors: list[EvidenceAnchor] = []
    lowered = text.lower()
    for metric, aliases in metric_aliases.items():
        for alias in aliases:
            pos = lowered.find(alias.lower())
            if pos < 0:
                continue
            anchors.append(
                _make_anchor(
                    "metric_alias",
                    alias,
                    text,
                    path,
                    pos,
                    pos + len(alias),
                    context_chars,
                    0.75,
                    {"metric": metric},
                )
            )
    return anchors


def _find_period_anchors(text: str, path: Path, period_terms: list[str], context_chars: int) -> list[EvidenceAnchor]:
    anchors: list[EvidenceAnchor] = []
    lowered = text.lower()
    for term in period_terms:
        pos = lowered.find(term.lower())
        if pos >= 0:
            anchors.append(_make_anchor("period_phrase", term, text, path, pos, pos + len(term), context_chars, 0.8))
    return anchors


def _find_regex_anchors(text: str, path: Path, patterns: list[re.Pattern], context_chars: int) -> list[EvidenceAnchor]:
    anchors: list[EvidenceAnchor] = []
    for pattern in patterns:
        for match in pattern.finditer(text):
            anchors.append(
                _make_anchor(
                    "regex",
                    match.group(0),
                    text,
                    path,
                    match.start(),
                    match.end(),
                    context_chars,
                    0.7,
                    {"pattern": pattern.pattern},
                )
            )
            if len(anchors) >= 20:
                return anchors
    return anchors


def _find_nearby_number_anchors(
    text: str,
    path: Path,
    terms: list[str],
    metric_aliases: dict[str, list[str]],
    period_terms: list[str],
    context_chars: int,
) -> list[EvidenceAnchor]:
    anchors: list[EvidenceAnchor] = []
    search_terms = [*terms, *period_terms]
    for aliases in metric_aliases.values():
        search_terms.extend(aliases)
    lowered = text.lower()
    candidate_windows: list[tuple[int, int, str]] = []
    for term in search_terms:
        pos = lowered.find(term.lower())
        if pos >= 0:
            candidate_windows.append((max(0, pos - 220), min(len(text), pos + 420), term))
    for start, end, term in candidate_windows[:40]:
        window = text[start:end]
        window_lower = window.lower()
        has_metric = any(alias.lower() in window_lower for aliases in metric_aliases.values() for alias in aliases)
        has_period = any(period.lower() in window_lower for period in period_terms)
        for match in _NUMBER_RE.finditer(window):
            number_text = match.group(0).strip()
            if not _is_meaningful_number_anchor(number_text):
                continue
            confidence = 0.78 + (0.08 if has_metric else 0.0) + (0.08 if has_period else 0.0)
            abs_start = start + match.start()
            abs_end = start + match.end()
            anchors.append(
                _make_anchor(
                    "nearby_number",
                    number_text,
                    text,
                    path,
                    abs_start,
                    abs_end,
                    context_chars,
                    min(confidence, 0.94),
                    {"near_term": term, "has_metric_context": has_metric, "has_period_context": has_period},
                )
            )
            if len(anchors) >= 40:
                return anchors
    return anchors


def _is_meaningful_number_anchor(value: str) -> bool:
    text = (value or "").strip().strip(",.;:")
    if not text:
        return False
    if re.search(r"[A-Za-z]\d|\d[A-Za-z]", text):
        lowered = text.lower()
        if not any(unit in lowered for unit in ("million", "billion", "thousand", "mn", "bn")):
            return False
    if text.startswith("-") and len(re.sub(r"\D", "", text)) > 4:
        return False
    if re.fullmatch(r"(?:19|20)\d{2}", text):
        return False
    if re.fullmatch(r"(?:19|20)\d{6}", text):
        return False
    lowered = text.lower()
    if any(unit in lowered for unit in ("%", "percent", "million", "billion", "thousand", "mn", "bn", "$", "rmb")):
        return True
    digits = re.sub(r"\D", "", text)
    if len(digits) >= 3:
        return True
    if re.search(r"\d+\.\d+", text):
        return True
    return False


def _make_anchor(
    anchor_type: str,
    value: str,
    text: str,
    path: Path,
    start: int,
    end: int,
    context_chars: int,
    confidence_hint: float,
    metadata: dict[str, Any] | None = None,
) -> EvidenceAnchor:
    snippet_start = max(0, start - context_chars)
    snippet_end = min(len(text), end + context_chars)
    return EvidenceAnchor(
        anchor_type=anchor_type,
        text=_compact(value, 160),
        source_path=str(path),
        start=start,
        end=end,
        snippet=_compact(text[snippet_start:snippet_end], context_chars * 2),
        confidence_hint=confidence_hint,
        metadata=metadata or {},
    )


def _dedupe_and_rank_anchors(anchors: list[EvidenceAnchor]) -> list[EvidenceAnchor]:
    seen: set[tuple[str, str, str, int]] = set()
    deduped: list[EvidenceAnchor] = []
    for anchor in anchors:
        key = (anchor.anchor_type, anchor.source_path, anchor.text.lower(), anchor.start // 20)
        if key in seen:
            continue
        seen.add(key)
        deduped.append(anchor)
    type_bonus = {
        "nearby_number": 0.12,
        "period_phrase": 0.22,
        "metric_alias": 0.2,
        "regex": 0.1,
        "exact_phrase": 0.05,
    }
    deduped.sort(
        key=lambda item: (
            item.confidence_hint + type_bonus.get(item.anchor_type, 0.0),
            -len(item.snippet),
        ),
        reverse=True,
    )
    return deduped


def _select_balanced_anchors(anchors: list[EvidenceAnchor], max_anchors: int) -> list[EvidenceAnchor]:
    if len(anchors) <= max_anchors:
        return anchors
    minimum_by_type = {
        "period_phrase": 4,
        "metric_alias": 4,
        "nearby_number": 8,
        "regex": 3,
        "exact_phrase": 6,
    }
    selected: list[EvidenceAnchor] = []
    selected_keys: set[tuple[str, str, str, int]] = set()

    def add(anchor: EvidenceAnchor) -> bool:
        key = (anchor.anchor_type, anchor.source_path, anchor.text.lower(), anchor.start // 20)
        if key in selected_keys or len(selected) >= max_anchors:
            return False
        selected.append(anchor)
        selected_keys.add(key)
        return True

    for anchor_type, quota in minimum_by_type.items():
        count = 0
        for anchor in anchors:
            if anchor.anchor_type != anchor_type:
                continue
            if add(anchor):
                count += 1
            if count >= quota:
                break

    for anchor in anchors:
        add(anchor)
        if len(selected) >= max_anchors:
            break
    return selected


def _compact(value: str, max_chars: int) -> str:
    text = re.sub(r"\s+", " ", value or "").strip()
    if len(text) <= max_chars:
        return text
    return text[: max_chars - 3].rstrip() + "..."


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--question", required=True)
    parser.add_argument("--root", action="append", required=True)
    parser.add_argument("--metadata_json", default=None)
    parser.add_argument("--regex", action="append", default=[])
    parser.add_argument("--out", default=None)
    parser.add_argument("--max_files", type=int, default=200)
    parser.add_argument("--max_anchors", type=int, default=30)
    args = parser.parse_args()

    metadata = json.loads(args.metadata_json) if args.metadata_json else {}
    result = grep_probe(
        args.question,
        args.root,
        metadata,
        regex_patterns=args.regex,
        max_files=args.max_files,
        max_anchors=args.max_anchors,
    )
    payload = json.dumps(result.to_dict(), ensure_ascii=False, indent=2)
    if args.out:
        output = Path(args.out)
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(payload + "\n", encoding="utf-8")
        print(output)
    else:
        print(payload)


if __name__ == "__main__":
    main()
