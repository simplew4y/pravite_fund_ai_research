import json
import logging
import math
import re
from collections import Counter, defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional

logger = logging.getLogger(__name__)


_TOKEN_RE = re.compile(r"[A-Za-z0-9_]+|[\u4e00-\u9fff]")


def normalize_doc_key(value: Any) -> str:
    """Normalize PDF/JSON filenames so PageIndex docs can be matched to chunks."""
    if value is None:
        return ""
    name = re.split(r"[\\/]", str(value))[-1]
    stem = Path(name).stem
    if stem.endswith("_structure"):
        stem = stem[: -len("_structure")]
    return re.sub(r"[^a-z0-9]+", "", stem.lower())


def _tokenize(text: str) -> List[str]:
    return [match.group(0).lower() for match in _TOKEN_RE.finditer(text or "")]


def _coerce_int(value: Any) -> Optional[int]:
    if value is None:
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _extract_doc_date(value: Any) -> str:
    """Extract a YYYYMMDD or YYYY-MM-DD date from common SEC-style filenames."""
    if value is None:
        return ""
    text = str(value)
    match = re.search(r"(20\d{2})[-_]?([01]\d)[-_]?([0-3]\d)", text)
    if not match:
        return ""
    return f"{match.group(1)}-{match.group(2)}-{match.group(3)}"


def _date_to_ordinal(value: str) -> int:
    if not value:
        return 0
    try:
        year, month, day = (int(part) for part in value.split("-", 2))
        return year * 372 + month * 31 + day
    except Exception:
        return 0


@dataclass(frozen=True)
class PageIndexNode:
    doc_key: str
    doc_name: str
    doc_description: str
    doc_date: str
    node_id: str
    title: str
    summary: str
    start_page: int
    end_page: int
    depth: int
    text: str


@dataclass(frozen=True)
class PageIndexHit:
    node: PageIndexNode
    score: float


class PageIndexRetriever:
    """
    Lightweight runtime retriever over pre-built PageIndex tree JSON files.

    The heavy PageIndex step is indexing PDFs into tree structures. At query time
    this class searches node titles/summaries, then the EnsembleRetriever maps
    selected page ranges back to existing Chroma chunks.
    """

    def __init__(
        self,
        index_dir: str,
        node_top_k: int = 8,
        min_score: float = 0.0,
        recency_boost: float = 0.0,
    ):
        self.index_dir = Path(index_dir).expanduser()
        self.node_top_k = int(node_top_k)
        self.min_score = float(min_score)
        self.recency_boost = max(0.0, float(recency_boost or 0.0))
        self.nodes: List[PageIndexNode] = []
        self._doc_term_freqs: List[Counter] = []
        self._doc_lengths: List[int] = []
        self._idf: Dict[str, float] = {}
        self._avgdl = 0.0
        self._min_doc_ordinal = 0
        self._max_doc_ordinal = 0

        self._load_nodes()
        self._build_index()

    @property
    def available(self) -> bool:
        return bool(self.nodes)

    def _iter_json_paths(self) -> Iterable[Path]:
        if self.index_dir.is_file() and self.index_dir.suffix.lower() == ".json":
            yield self.index_dir
            return
        if not self.index_dir.exists():
            logger.warning("[PageIndex] index_dir does not exist: %s", self.index_dir)
            return
        for path in sorted(self.index_dir.rglob("*.json")):
            if path.name == "_meta.json":
                continue
            yield path

    def _load_json(self, path: Path) -> Optional[Dict[str, Any]]:
        try:
            with open(path, "r", encoding="utf-8") as f:
                payload = json.load(f)
        except Exception as exc:
            logger.warning("[PageIndex] failed to load %s: %s", path, exc)
            return None
        return payload if isinstance(payload, dict) else None

    def _load_nodes(self) -> None:
        seen = set()
        for path in self._iter_json_paths():
            payload = self._load_json(path)
            if not payload:
                continue

            structure = payload.get("structure")
            if not structure:
                continue

            doc_name = payload.get("doc_name") or payload.get("filename") or path.name
            doc_description = payload.get("doc_description", "")
            doc_date = _extract_doc_date(doc_name) or _extract_doc_date(path.name)
            doc_ordinal = _date_to_ordinal(doc_date)
            if doc_ordinal > 0:
                self._min_doc_ordinal = (
                    doc_ordinal
                    if self._min_doc_ordinal == 0
                    else min(self._min_doc_ordinal, doc_ordinal)
                )
                self._max_doc_ordinal = max(self._max_doc_ordinal, doc_ordinal)
            doc_key = normalize_doc_key(doc_name) or normalize_doc_key(path.name)
            if not doc_key:
                continue

            for node in self._flatten_nodes(
                structure=structure,
                doc_key=doc_key,
                doc_name=str(doc_name),
                doc_description=str(doc_description or ""),
                doc_date=doc_date,
                depth=0,
            ):
                key = (node.doc_key, node.node_id, node.start_page, node.end_page, node.title)
                if key in seen:
                    continue
                seen.add(key)
                self.nodes.append(node)

        logger.info("[PageIndex] loaded %d searchable nodes from %s", len(self.nodes), self.index_dir)

    def _flatten_nodes(
        self,
        structure: Any,
        doc_key: str,
        doc_name: str,
        doc_description: str,
        doc_date: str,
        depth: int,
    ) -> Iterable[PageIndexNode]:
        if isinstance(structure, dict):
            items = [structure]
        elif isinstance(structure, list):
            items = [item for item in structure if isinstance(item, dict)]
        else:
            return

        for item in items:
            start_page = _coerce_int(item.get("start_index") or item.get("start_page") or item.get("page"))
            end_page = _coerce_int(item.get("end_index") or item.get("end_page") or item.get("page"))
            title = str(item.get("title") or "")
            summary = str(item.get("summary") or "")
            node_id = str(item.get("node_id") or item.get("id") or f"{doc_key}:{depth}:{title[:40]}")

            if start_page is not None and end_page is not None:
                if end_page < start_page:
                    start_page, end_page = end_page, start_page
                text = "\n".join(
                    part
                    for part in (
                        f"document: {doc_name}",
                        f"description: {doc_description}",
                        f"title: {title}",
                        f"summary: {summary}",
                    )
                    if part.strip()
                )
                if text.strip():
                    yield PageIndexNode(
                        doc_key=doc_key,
                        doc_name=doc_name,
                        doc_description=doc_description,
                        doc_date=doc_date,
                        node_id=node_id,
                        title=title,
                        summary=summary,
                        start_page=start_page,
                        end_page=end_page,
                        depth=depth,
                        text=text,
                    )

            child_nodes = item.get("nodes") or []
            if child_nodes:
                yield from self._flatten_nodes(
                    structure=child_nodes,
                    doc_key=doc_key,
                    doc_name=doc_name,
                    doc_description=doc_description,
                    doc_date=doc_date,
                    depth=depth + 1,
                )

    def _build_index(self) -> None:
        if not self.nodes:
            return

        doc_freq: Dict[str, int] = defaultdict(int)
        for node in self.nodes:
            tokens = _tokenize(node.text)
            term_freq = Counter(tokens)
            self._doc_term_freqs.append(term_freq)
            self._doc_lengths.append(len(tokens))
            for term in term_freq:
                doc_freq[term] += 1

        num_docs = len(self.nodes)
        self._avgdl = sum(self._doc_lengths) / max(num_docs, 1)
        self._idf = {
            term: math.log(1 + (num_docs - freq + 0.5) / (freq + 0.5))
            for term, freq in doc_freq.items()
        }

    def retrieve_nodes(self, query: str, k: Optional[int] = None) -> List[PageIndexHit]:
        if not self.nodes:
            return []

        query_terms = _tokenize(query)
        if not query_terms:
            return []

        effective_k = self.node_top_k if k is None else int(k)
        if effective_k <= 0:
            return []

        query_counts = Counter(query_terms)
        scored: List[PageIndexHit] = []
        k1 = 1.5
        b = 0.75

        for idx, node in enumerate(self.nodes):
            term_freq = self._doc_term_freqs[idx]
            doc_len = self._doc_lengths[idx] or 1
            score = 0.0
            for term, qtf in query_counts.items():
                tf = term_freq.get(term, 0)
                if tf <= 0:
                    continue
                idf = self._idf.get(term, 0.0)
                denom = tf + k1 * (1 - b + b * doc_len / max(self._avgdl, 1e-9))
                score += idf * ((tf * (k1 + 1)) / denom) * qtf

            title_tokens = set(_tokenize(node.title))
            if title_tokens:
                score += 0.15 * len(title_tokens.intersection(query_counts))

            if self.recency_boost > 0 and self._max_doc_ordinal > self._min_doc_ordinal > 0:
                doc_ordinal = _date_to_ordinal(node.doc_date)
                if doc_ordinal > 0:
                    recency_score = (doc_ordinal - self._min_doc_ordinal) / (
                        self._max_doc_ordinal - self._min_doc_ordinal
                    )
                    score += self.recency_boost * recency_score

            if score > self.min_score:
                scored.append(PageIndexHit(node=node, score=float(score)))

        scored.sort(
            key=lambda hit: (
                hit.score,
                -(hit.node.end_page - hit.node.start_page),
                -hit.node.depth,
            ),
            reverse=True,
        )
        return scored[:effective_k]
