"""Corpus discovery, PDF extraction, and range reading for agentic search."""

from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Sequence, Tuple


TEXT_EXTENSIONS = {
    ".md",
    ".markdown",
    ".txt",
    ".json",
    ".jsonl",
    ".csv",
    ".tsv",
    ".html",
    ".htm",
    ".xml",
    ".yaml",
    ".yml",
}
PDF_EXTENSIONS = {".pdf"}
DEFAULT_EXTENSIONS = TEXT_EXTENSIONS | PDF_EXTENSIONS
DEFAULT_IGNORE_DIRS = {
    ".git",
    ".svn",
    ".hg",
    "__pycache__",
    ".pytest_cache",
    ".mypy_cache",
    ".ruff_cache",
    "node_modules",
    ".venv",
    "venv",
    "env",
    "chroma",
    "ts_chroma",
    "table_chroma",
    "bm25_index",
}


@dataclass(frozen=True)
class DocumentRecord:
    path: Path
    rel_path: str
    ext: str
    size: int
    mtime: float

    def to_dict(self) -> Dict[str, object]:
        return {
            "path": str(self.path),
            "rel_path": self.rel_path,
            "ext": self.ext.lstrip("."),
            "size": self.size,
            "mtime": self.mtime,
        }


@dataclass
class LineRecord:
    text: str
    line: int
    page: Optional[int] = None


@dataclass
class ReadResult:
    path: str
    content: str
    start_line: int
    num_lines: int
    total_lines: int
    pages: List[int] = field(default_factory=list)
    extraction_method: Optional[str] = None

    def to_dict(self) -> Dict[str, object]:
        return {
            "path": self.path,
            "content": self.content,
            "start_line": self.start_line,
            "num_lines": self.num_lines,
            "total_lines": self.total_lines,
            "pages": self.pages,
            "extraction_method": self.extraction_method,
        }


class PDFExtractionError(RuntimeError):
    pass


def _normalize_exts(extensions: Optional[Sequence[str]]) -> Optional[set[str]]:
    if not extensions:
        return None
    normalized = set()
    for ext in extensions:
        e = str(ext).strip().lower()
        if not e:
            continue
        if not e.startswith("."):
            e = "." + e
        normalized.add(e)
    return normalized


def _is_relative_to(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False


def _safe_read_text(path: Path, max_bytes: Optional[int] = None) -> str:
    if max_bytes is not None:
        with path.open("rb") as f:
            return f.read(max_bytes).decode("utf-8", errors="replace")
    return path.read_text(encoding="utf-8", errors="replace")


def parse_page_range(pages: Optional[str], total_pages: int) -> Optional[set[int]]:
    if not pages:
        return None
    selected: set[int] = set()
    for part in pages.split(","):
        p = part.strip()
        if not p:
            continue
        if "-" in p:
            left, right = p.split("-", 1)
            start = int(left.strip())
            end = int(right.strip())
            if start <= 0 or end <= 0 or end < start:
                raise ValueError(f"Invalid page range: {pages}")
            selected.update(range(start, min(end, total_pages) + 1))
        else:
            page = int(p)
            if page <= 0:
                raise ValueError(f"Invalid page range: {pages}")
            if page <= total_pages:
                selected.add(page)
    return selected


class PDFTextExtractor:
    """Lazy PDF text extraction with on-disk cache.

    The extractor tries PyMuPDF, pypdf/PyPDF2, pdfplumber, then pdftotext.
    Cache entries are invalidated by path, mtime, and size.
    """

    def __init__(self, cache_dir: Path):
        self.cache_dir = cache_dir

    def extract(self, path: Path) -> Tuple[List[str], str]:
        path = path.resolve()
        stat = path.stat()
        key = hashlib.sha1(
            f"{path}|{stat.st_mtime_ns}|{stat.st_size}".encode("utf-8", errors="replace")
        ).hexdigest()
        cache_file = self.cache_dir / f"{key}.json"
        if cache_file.is_file():
            payload = json.loads(cache_file.read_text(encoding="utf-8"))
            return list(payload.get("pages", [])), str(payload.get("method", "cache"))

        pages, method = self._extract_uncached(path)
        cache_file.parent.mkdir(parents=True, exist_ok=True)
        cache_file.write_text(
            json.dumps(
                {
                    "source": str(path),
                    "mtime_ns": stat.st_mtime_ns,
                    "size": stat.st_size,
                    "method": method,
                    "pages": pages,
                },
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )
        return pages, method

    def _extract_uncached(self, path: Path) -> Tuple[List[str], str]:
        errors: List[str] = []
        for method in (
            self._extract_with_pymupdf,
            self._extract_with_pypdf,
            self._extract_with_pdfplumber,
            self._extract_with_pdftotext,
        ):
            try:
                pages = method(path)
                if pages and any(p.strip() for p in pages):
                    return pages, method.__name__.replace("_extract_with_", "")
            except Exception as exc:  # optional dependency failures are expected
                errors.append(f"{method.__name__}: {exc}")
        raise PDFExtractionError(
            f"Unable to extract text from PDF: {path}. Tried PyMuPDF, pypdf/PyPDF2, pdfplumber, pdftotext. "
            + " | ".join(errors[-3:])
        )

    @staticmethod
    def _extract_with_pymupdf(path: Path) -> List[str]:
        import fitz  # type: ignore

        doc = fitz.open(str(path))
        try:
            return [page.get_text("text") or "" for page in doc]
        finally:
            doc.close()

    @staticmethod
    def _extract_with_pypdf(path: Path) -> List[str]:
        try:
            from pypdf import PdfReader  # type: ignore
        except Exception:
            from PyPDF2 import PdfReader  # type: ignore

        reader = PdfReader(str(path))
        return [(page.extract_text() or "") for page in reader.pages]

    @staticmethod
    def _extract_with_pdfplumber(path: Path) -> List[str]:
        import pdfplumber  # type: ignore

        with pdfplumber.open(str(path)) as pdf:
            return [(page.extract_text() or "") for page in pdf.pages]

    @staticmethod
    def _extract_with_pdftotext(path: Path) -> List[str]:
        proc = subprocess.run(
            ["pdftotext", "-layout", str(path), "-"],
            text=True,
            encoding="utf-8",
            errors="replace",
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=60,
            check=False,
        )
        if proc.returncode != 0:
            raise PDFExtractionError(proc.stderr.strip() or "pdftotext failed")
        text = proc.stdout
        # pdftotext separates pages with form feed.
        return text.split("\f")


class CorpusStore:
    """Read-only view over raw corpus roots."""

    def __init__(
        self,
        roots: Sequence[str | Path],
        cache_dir: str | Path | None = None,
        extensions: Optional[Sequence[str]] = None,
        ignore_dirs: Optional[Iterable[str]] = None,
        allow_outside_roots: bool = False,
        max_text_file_bytes: int = 20_000_000,
    ):
        if not roots:
            raise ValueError("At least one corpus root is required")
        self.roots = [Path(root).expanduser().resolve() for root in roots]
        missing_roots = [root for root in self.roots if not root.exists()]
        if missing_roots:
            raise ValueError(f"Corpus root does not exist: {missing_roots[0]}")
        self.extensions = _normalize_exts(extensions) or set(DEFAULT_EXTENSIONS)
        self.ignore_dirs = set(DEFAULT_IGNORE_DIRS)
        if ignore_dirs:
            self.ignore_dirs.update(ignore_dirs)
        self.allow_outside_roots = allow_outside_roots
        self.max_text_file_bytes = max_text_file_bytes
        if cache_dir is None:
            cache_dir = Path.cwd() / ".agentic_search_cache" / "pdf_text"
        self.pdf_extractor = PDFTextExtractor(Path(cache_dir).expanduser().resolve())

    @classmethod
    def from_fin_config(
        cls,
        config_path: str | Path,
        extra_roots: Optional[Sequence[str | Path]] = None,
        cache_dir: str | Path | None = None,
    ) -> "CorpusStore":
        import yaml

        cfg_path = Path(config_path).expanduser().resolve()
        config = yaml.safe_load(cfg_path.read_text(encoding="utf-8")) or {}
        roots: List[Path] = []
        persist = config.get("persist_directory")
        if persist:
            dataset_root = Path(persist).expanduser().resolve().parent
            for name in ("0_raw_pdf", "1_processed_pdf", "3_base_final"):
                candidate = dataset_root / name
                if candidate.exists():
                    roots.append(candidate)
        if extra_roots:
            roots.extend(Path(p).expanduser().resolve() for p in extra_roots)
        if not roots:
            raise ValueError(f"No corpus roots found from config: {cfg_path}")
        return cls(roots=roots, cache_dir=cache_dir)

    def inspect(self, max_samples: int = 20) -> Dict[str, object]:
        records = self.list_files(max_results=max(max_samples, 1), include_counts=True)
        counts: Dict[str, int] = {}
        total = 0
        for root in self.roots:
            for path in self._iter_files(root):
                ext = path.suffix.lower()
                if ext not in self.extensions:
                    continue
                counts[ext.lstrip(".") or "<none>"] = counts.get(ext.lstrip(".") or "<none>", 0) + 1
                total += 1
        return {
            "roots": [str(r) for r in self.roots],
            "total_files": total,
            "counts_by_extension": counts,
            "samples": [r.to_dict() for r in records],
        }

    def list_files(
        self,
        pattern: str = "**/*",
        path: Optional[str] = None,
        extensions: Optional[Sequence[str]] = None,
        max_results: int = 100,
        include_counts: bool = False,
    ) -> List[DocumentRecord]:
        selected_exts = _normalize_exts(extensions) or self.extensions
        bases = [self.resolve_path(path)] if path else self.roots
        records: List[DocumentRecord] = []
        seen: set[Path] = set()
        for base in bases:
            candidates: Iterable[Path]
            if base.is_file():
                candidates = [base]
            else:
                candidates = base.glob(pattern)
            for candidate in candidates:
                if len(records) >= max_results and not include_counts:
                    break
                if not candidate.is_file():
                    continue
                resolved = candidate.resolve()
                if resolved in seen:
                    continue
                seen.add(resolved)
                if resolved.suffix.lower() not in selected_exts:
                    continue
                if self._is_ignored(resolved):
                    continue
                records.append(self._record_for(resolved))
        records.sort(key=lambda r: (r.mtime, r.rel_path), reverse=True)
        return records[:max_results]

    def resolve_path(self, value: Optional[str | Path]) -> Path:
        if value is None or str(value).strip() == "":
            return self.roots[0]
        raw = Path(str(value)).expanduser()
        candidates = [raw.resolve()] if raw.is_absolute() else [
            (root / raw).resolve() for root in self.roots
        ]
        for candidate in candidates:
            if candidate.exists():
                if self.allow_outside_roots or any(_is_relative_to(candidate, root) for root in self.roots):
                    return candidate
        # Return first candidate for downstream friendly errors.
        candidate = candidates[0]
        if not self.allow_outside_roots and not any(_is_relative_to(candidate, root) for root in self.roots):
            raise ValueError(f"Path is outside configured corpus roots: {value}")
        return candidate

    def read_lines(
        self,
        path: str | Path,
        offset: int = 1,
        limit: int = 160,
        pages: Optional[str] = None,
    ) -> ReadResult:
        resolved = self.resolve_path(path)
        if not resolved.is_file():
            raise FileNotFoundError(f"Document not found: {path}")
        lines, method = self.get_line_records(resolved, pages=pages)
        start = max(offset, 1)
        selected = [item for item in lines if item.line >= start][: max(limit, 1)]
        total = max((item.line for item in lines), default=0)
        rendered = []
        selected_pages = []
        for item in selected:
            page_prefix = f" p.{item.page}" if item.page else ""
            rendered.append(f"{item.line:>6}{page_prefix} | {item.text}")
            if item.page and item.page not in selected_pages:
                selected_pages.append(item.page)
        return ReadResult(
            path=str(resolved),
            content="\n".join(rendered),
            start_line=start,
            num_lines=len(selected),
            total_lines=total,
            pages=selected_pages,
            extraction_method=method,
        )

    def get_line_records(self, path: Path, pages: Optional[str] = None) -> Tuple[List[LineRecord], Optional[str]]:
        path = path.resolve()
        ext = path.suffix.lower()
        if ext == ".pdf":
            page_texts, method = self.pdf_extractor.extract(path)
            selected_pages = parse_page_range(pages, len(page_texts))
            records: List[LineRecord] = []
            line_no = 1
            for page_idx, page_text in enumerate(page_texts, start=1):
                include_page = selected_pages is None or page_idx in selected_pages
                if include_page:
                    records.append(LineRecord(text=f"--- page {page_idx} ---", line=line_no, page=page_idx))
                line_no += 1
                for raw_line in page_text.splitlines():
                    if include_page:
                        records.append(LineRecord(text=raw_line.rstrip(), line=line_no, page=page_idx))
                    line_no += 1
            return records, method

        if ext not in TEXT_EXTENSIONS:
            raise ValueError(f"Unsupported file type for text search: {path.suffix}")
        size = path.stat().st_size
        if size > self.max_text_file_bytes:
            text = _safe_read_text(path, self.max_text_file_bytes)
        else:
            text = _safe_read_text(path)
        return [
            LineRecord(text=line.rstrip(), line=i)
            for i, line in enumerate(text.splitlines(), start=1)
        ], None

    def _iter_files(self, root: Path) -> Iterable[Path]:
        if root.is_file():
            yield root
            return
        for dirpath, dirnames, filenames in os.walk(root):
            dirnames[:] = [d for d in dirnames if d not in self.ignore_dirs]
            for filename in filenames:
                yield Path(dirpath) / filename

    def _is_ignored(self, path: Path) -> bool:
        return any(part in self.ignore_dirs for part in path.parts)

    def _record_for(self, path: Path) -> DocumentRecord:
        stat = path.stat()
        rel = self.relative_path(path)
        return DocumentRecord(path=path, rel_path=rel, ext=path.suffix.lower(), size=stat.st_size, mtime=stat.st_mtime)

    def relative_path(self, path: Path) -> str:
        resolved = path.resolve()
        for root in self.roots:
            if _is_relative_to(resolved, root):
                try:
                    return str(resolved.relative_to(root)).replace("\\", "/")
                except ValueError:
                    pass
        return str(resolved)


def highlight_regex(text: str, pattern: re.Pattern[str]) -> str:
    return pattern.sub(lambda m: f"<<{m.group(0)}>>", text)
