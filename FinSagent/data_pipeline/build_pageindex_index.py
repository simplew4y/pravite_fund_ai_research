#!/usr/bin/env python3
"""
Build a PageIndex workspace for FinSagent retrieval experiments.

This is an offline/preprocessing step. Runtime retrieval only needs the JSON
files written to --output_dir.

Example:
python data_pipeline/build_pageindex_index.py \
  --input_dir /root/autodl-tmp/RAG_Agent_data/Zeekr/20250729/raw_pdf \
  --output_dir /root/autodl-tmp/RAG_Agent_data/Zeekr/20250729/database_zeekr/pageindex \
  --pageindex_repo_path /root/autodl-tmp/PageIndex \
  --config_path config/production.yaml \
  --model gpt-4o-2024-11-20
"""

import argparse
import json
import logging
import os
import re
import sys
from pathlib import Path
from typing import Any, Callable, Iterable, Set


logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger("build_pageindex_index")
_LOCAL_TOKEN_ENCODER: Any | bool | None = None


def _iter_files(input_dir: Path, recursive: bool, extensions: Set[str]) -> Iterable[Path]:
    pattern = "**/*" if recursive else "*"
    for path in sorted(input_dir.glob(pattern)):
        if path.is_file() and path.suffix.lower() in extensions:
            yield path


def _load_pageindex_backend(pageindex_repo_path: str | None) -> tuple[str, Any]:
    if pageindex_repo_path:
        repo = Path(pageindex_repo_path).expanduser().resolve()
        sys.path.insert(0, str(repo))
        logger.info("Added PageIndex repo to sys.path: %s", repo)
    try:
        from pageindex import PageIndexClient
        return "client", PageIndexClient
    except Exception as client_exc:
        logger.info("PageIndexClient is unavailable, trying legacy page_index(): %s", client_exc)
    try:
        from pageindex import page_index
        _patch_legacy_pageindex_toc_normalization()
        return "legacy", page_index
    except Exception as legacy_exc:
        raise ImportError(
            "Unable to import PageIndex. Install PageIndex or pass "
            "--pageindex_repo_path /path/to/PageIndex."
        ) from legacy_exc


def _normalize_legacy_toc_items(payload: Any) -> list[dict[str, Any]]:
    """Legacy PageIndex occasionally gets a single JSON object instead of a list."""
    if payload is None:
        return []
    if isinstance(payload, list):
        return [item for item in payload if isinstance(item, dict)]
    if not isinstance(payload, dict):
        return []

    for key in ("toc", "table_of_contents", "sections", "items", "nodes", "result"):
        value = payload.get(key)
        if isinstance(value, list):
            return _normalize_legacy_toc_items(value)
        if isinstance(value, dict):
            return _normalize_legacy_toc_items(value)

    if {"structure", "title", "physical_index"} & set(payload):
        return [payload]

    for value in payload.values():
        if isinstance(value, list):
            normalized = _normalize_legacy_toc_items(value)
            if normalized:
                return normalized

    return [payload]


def _count_tokens_with_local_encoding(text: str | None, model: str | None = None) -> int:
    del model
    global _LOCAL_TOKEN_ENCODER

    if _LOCAL_TOKEN_ENCODER is None:
        try:
            import tiktoken

            encoding_name = os.getenv("PAGEINDEX_TIKTOKEN_ENCODING", "cl100k_base")
            _LOCAL_TOKEN_ENCODER = tiktoken.get_encoding(encoding_name)
            logger.info("Using local PageIndex token encoding: %s", encoding_name)
        except Exception as exc:
            _LOCAL_TOKEN_ENCODER = False
            logger.warning("Unable to load tiktoken encoding; using approximate token counts: %s", exc)

    value = text or ""
    if _LOCAL_TOKEN_ENCODER:
        return len(_LOCAL_TOKEN_ENCODER.encode(value, disallowed_special=()))
    return max(1, len(value.encode("utf-8")) // 4)


def _get_page_tokens_with_local_encoding(
    pdf_path: Any,
    model: str | None = None,
    pdf_parser: str = "PyPDF2",
) -> list[tuple[str, int]]:
    del model
    page_texts: list[str] = []

    if pdf_parser == "PyPDF2":
        try:
            import PyPDF2

            reader = PyPDF2.PdfReader(pdf_path)
            page_texts = [page.extract_text() or "" for page in reader.pages]
        except Exception as exc:
            logger.warning("Patched PageIndex PyPDF2 extraction failed; trying PyMuPDF: %s", exc)

    if not page_texts:
        import fitz

        if hasattr(pdf_path, "getvalue"):
            doc = fitz.open(stream=pdf_path.getvalue(), filetype="pdf")
        else:
            doc = fitz.open(str(pdf_path))
        try:
            page_texts = [page.get_text("text") or "" for page in doc]
        finally:
            doc.close()

    return [(text, _count_tokens_with_local_encoding(text)) for text in page_texts]


def _get_number_of_pages_with_local_parser(pdf_path: Any) -> int:
    return len(_get_page_tokens_with_local_encoding(pdf_path))


def _patch_legacy_pageindex_toc_normalization() -> None:
    try:
        import importlib

        legacy_module = importlib.import_module("pageindex.page_index")
        utils_module = importlib.import_module("pageindex.utils")
    except Exception as exc:
        logger.warning("Unable to patch legacy PageIndex TOC normalization: %s", exc)
        return

    if not getattr(legacy_module, "_finsagent_toc_normalized", False):
        original_init = legacy_module.generate_toc_init
        original_continue = legacy_module.generate_toc_continue

        def generate_toc_init_normalized(*args: Any, **kwargs: Any) -> list[dict[str, Any]]:
            return _normalize_legacy_toc_items(original_init(*args, **kwargs))

        def generate_toc_continue_normalized(*args: Any, **kwargs: Any) -> list[dict[str, Any]]:
            return _normalize_legacy_toc_items(original_continue(*args, **kwargs))

        legacy_module.generate_toc_init = generate_toc_init_normalized
        legacy_module.generate_toc_continue = generate_toc_continue_normalized
        legacy_module._finsagent_toc_normalized = True
        logger.info("Patched legacy PageIndex TOC normalization for dict/list LLM outputs")

    legacy_module.count_tokens = _count_tokens_with_local_encoding
    utils_module.count_tokens = _count_tokens_with_local_encoding
    legacy_module.get_page_tokens = _get_page_tokens_with_local_encoding
    utils_module.get_page_tokens = _get_page_tokens_with_local_encoding
    legacy_module.get_number_of_pages = _get_number_of_pages_with_local_parser
    utils_module.get_number_of_pages = _get_number_of_pages_with_local_parser
    logger.info("Patched legacy PageIndex token counting to avoid remote tokenizer downloads")

    # JsonLogger in pageindex/utils.py lacks a warning() method; patch it to
    # route through the existing log() so callers in page_index.py don't crash.
    if not hasattr(utils_module.JsonLogger, "warning"):
        utils_module.JsonLogger.warning = utils_module.JsonLogger.info
        logger.info("Patched legacy PageIndex JsonLogger.warning (missing method)")

def _load_yaml_config(config_path: str | None) -> dict:
    if not config_path:
        return {}
    path = Path(config_path).expanduser()
    if not path.exists():
        raise FileNotFoundError(f"config_path not found: {path}")
    import yaml

    with open(path, "r", encoding="utf-8") as f:
        payload = yaml.safe_load(f) or {}
    if not isinstance(payload, dict):
        raise ValueError(f"config_path must contain a YAML mapping: {path}")
    return payload


def _configure_openai_env(
    config: dict,
    api_key: str | None,
    base_url: str | None,
) -> None:
    resolved_api_key = api_key or config.get("llm_api_key") or os.getenv("OPENAI_API_KEY")
    resolved_base_url = base_url or config.get("llm_base_url") or os.getenv("OPENAI_BASE_URL")

    if resolved_api_key:
        os.environ["OPENAI_API_KEY"] = str(resolved_api_key)
        logger.info("Configured OPENAI_API_KEY from %s", "CLI/config/env")
    else:
        logger.warning("OPENAI_API_KEY is not configured; PageIndex LLM calls may fail.")

    if resolved_base_url:
        os.environ["OPENAI_BASE_URL"] = str(resolved_base_url)
        logger.info("Configured OPENAI_BASE_URL=%s", resolved_base_url)


def _configure_tiktoken_model(model: str | None) -> None:
    if not model:
        return
    try:
        import tiktoken

        try:
            tiktoken.encoding_for_model(model)
            return
        except KeyError:
            pass

        import tiktoken.model as tiktoken_model

        encoding_name = os.getenv("PAGEINDEX_TIKTOKEN_ENCODING", "cl100k_base")
        tiktoken.get_encoding(encoding_name)
        tiktoken_model.MODEL_TO_ENCODING[model] = encoding_name
        logger.info("Mapped tiktoken model %s to encoding %s", model, encoding_name)
    except Exception as exc:
        logger.warning("Unable to configure tiktoken mapping for %s: %s", model, exc)


def _structure_json_path(output_dir: Path, file_path: Path) -> Path:
    return output_dir / f"{file_path.stem}_structure.json"


def _assert_pypdf2_readable(file_path: Path) -> None:
    import PyPDF2

    with open(file_path, "rb") as f:
        reader = PyPDF2.PdfReader(f)
        # Touch pages so strict trailer/xref problems surface before PageIndex.
        _ = len(reader.pages)


def _repair_pdf_for_pypdf2(file_path: Path, repair_dir: Path) -> Path:
    if file_path.suffix.lower() != ".pdf":
        return file_path

    try:
        _assert_pypdf2_readable(file_path)
        return file_path
    except Exception as exc:
        logger.warning("PDF is not readable by PyPDF2, attempting repair with PyMuPDF: %s (%s)", file_path, exc)

    import fitz

    repair_dir.mkdir(parents=True, exist_ok=True)
    repaired_path = repair_dir / file_path.name
    doc = fitz.open(str(file_path))
    try:
        doc.save(str(repaired_path), garbage=4, deflate=True, clean=True)
    finally:
        doc.close()

    _assert_pypdf2_readable(repaired_path)
    logger.info("Repaired PDF for legacy PageIndex: %s -> %s", file_path, repaired_path)
    return repaired_path


_FALLBACK_HEADING_RE = re.compile(r"^[A-Z][A-Z0-9 ,&/().:'\"%-]{4,120}$")
_WHITESPACE_RE = re.compile(r"\s+")


def _clean_text(value: str, max_chars: int | None = None) -> str:
    text = _WHITESPACE_RE.sub(" ", value or "").strip()
    if max_chars is not None and len(text) > max_chars:
        text = text[:max_chars].rstrip() + "..."
    return text


def _extract_pdf_page_texts(file_path: Path) -> list[str]:
    try:
        import fitz

        doc = fitz.open(str(file_path))
        try:
            return [page.get_text("text") or "" for page in doc]
        finally:
            doc.close()
    except Exception as fitz_exc:
        logger.warning("PyMuPDF extraction failed for %s: %s; trying PyPDF2", file_path, fitz_exc)

    import PyPDF2

    with open(file_path, "rb") as f:
        reader = PyPDF2.PdfReader(f)
        return [page.extract_text() or "" for page in reader.pages]


def _heading_candidates(page_text: str) -> list[str]:
    headings: list[str] = []
    for raw_line in (page_text or "").splitlines():
        line = _clean_text(raw_line)
        if not line:
            continue
        if line.upper() in {"TABLE OF CONTENTS", "CONTENTS"}:
            continue
        if line.startswith("<physical_index_"):
            continue
        if len(line) < 5 or len(line) > 120:
            continue
        if _FALLBACK_HEADING_RE.match(line):
            headings.append(line)
            continue
        # SEC filings often use title-case section headings that are not all caps.
        words = [word for word in re.split(r"[^A-Za-z]+", line) if word]
        if 2 <= len(words) <= 12 and sum(word[:1].isupper() for word in words) >= max(2, len(words) - 1):
            headings.append(line)
    return headings[:6]


def _first_heading(page_text: str, fallback: str) -> str:
    headings = _heading_candidates(page_text)
    return headings[0] if headings else fallback


def _build_manual_pdf_structure(
    file_path: Path,
    pages_per_node: int,
    summary_chars: int,
) -> dict[str, Any]:
    page_texts = _extract_pdf_page_texts(file_path)
    if not page_texts:
        raise ValueError(f"No pages extracted from PDF: {file_path}")

    effective_pages_per_node = max(1, int(pages_per_node))
    effective_summary_chars = max(200, int(summary_chars))
    nodes: list[dict[str, Any]] = []

    for group_start in range(0, len(page_texts), effective_pages_per_node):
        group_end = min(group_start + effective_pages_per_node, len(page_texts))
        group_text = "\n".join(page_texts[group_start:group_end])
        group_headings: list[str] = []
        for page_text in page_texts[group_start:group_end]:
            group_headings.extend(_heading_candidates(page_text))
        unique_headings = list(dict.fromkeys(group_headings))
        start_page = group_start + 1
        end_page = group_end
        title = unique_headings[0] if unique_headings else f"Pages {start_page}-{end_page}"
        heading_summary = "; ".join(unique_headings[:8])
        body_summary = _clean_text(group_text, effective_summary_chars)
        summary = _clean_text(
            f"Detected headings: {heading_summary}. Page text: {body_summary}"
            if heading_summary
            else body_summary,
            effective_summary_chars + 300,
        )

        child_nodes: list[dict[str, Any]] = []
        for page_idx in range(group_start, group_end):
            page_num = page_idx + 1
            page_text = page_texts[page_idx]
            page_title = _first_heading(page_text, f"Page {page_num}")
            child_nodes.append(
                {
                    "node_id": f"{file_path.stem}:page:{page_num}",
                    "title": page_title,
                    "summary": _clean_text(page_text, min(900, effective_summary_chars)),
                    "start_index": page_num,
                    "end_index": page_num,
                    "nodes": [],
                }
            )

        nodes.append(
            {
                "node_id": f"{file_path.stem}:fallback:{start_page}-{end_page}",
                "title": title,
                "summary": summary,
                "start_index": start_page,
                "end_index": end_page,
                "nodes": child_nodes,
            }
        )

    return {
        "doc_name": file_path.name,
        "doc_description": (
            "Manual fallback PageIndex-compatible structure generated after legacy "
            "PageIndex failed. Nodes are built from PDF page text and detected headings."
        ),
        "structure": nodes,
        "metadata": {
            "builder": "manual_pdf_fallback",
            "pages": len(page_texts),
            "pages_per_node": effective_pages_per_node,
        },
    }


def _write_manual_pdf_fallback(
    file_path: Path,
    output_path: Path,
    pages_per_node: int,
    summary_chars: int,
) -> None:
    if file_path.suffix.lower() != ".pdf":
        raise ValueError(f"Manual fallback only supports PDF files: {file_path}")
    payload = _build_manual_pdf_structure(
        file_path=file_path,
        pages_per_node=pages_per_node,
        summary_chars=summary_chars,
    )
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
    logger.info("Wrote manual fallback PageIndex JSON: %s", output_path)


def _index_with_client(
    PageIndexClient: Any,
    files: Iterable[Path],
    output_dir: Path,
    model: str | None,
    retrieve_model: str | None,
    force: bool,
) -> tuple[int, int, int]:
    client = PageIndexClient(
        model=model,
        retrieve_model=retrieve_model,
        workspace=str(output_dir),
    )

    existing_names = {
        str(doc.get("doc_name") or Path(str(doc.get("path", ""))).name)
        for doc in client.documents.values()
    }
    logger.info("Loaded %d existing PageIndex document(s)", len(existing_names))

    indexed = 0
    skipped = 0
    failed = 0
    for file_path in files:
        if not force and file_path.name in existing_names:
            skipped += 1
            logger.info("Skip existing PageIndex doc: %s", file_path.name)
            continue
        try:
            logger.info("Indexing %s", file_path)
            client.index(str(file_path))
            indexed += 1
        except Exception as exc:
            failed += 1
            logger.exception("Failed to index %s: %s", file_path, exc)
    return indexed, skipped, failed


def _index_with_legacy_page_index(
    page_index: Callable[..., dict],
    files: Iterable[Path],
    output_dir: Path,
    model: str | None,
    force: bool,
    legacy_options: dict[str, Any] | None = None,
    manual_fallback_on_fail: bool = False,
    fallback_pages_per_node: int = 4,
    fallback_summary_chars: int = 1200,
    repair_pdf_for_legacy: bool = False,
    repaired_pdf_dir: Path | None = None,
) -> tuple[int, int, int]:
    indexed = 0
    skipped = 0
    failed = 0
    legacy_options = legacy_options or {}
    for file_path in files:
        output_path = _structure_json_path(output_dir, file_path)
        if output_path.exists() and not force:
            skipped += 1
            logger.info("Skip existing PageIndex JSON: %s", output_path)
            continue
        try:
            index_file_path = file_path
            if repair_pdf_for_legacy:
                repair_dir = repaired_pdf_dir or output_dir / "_repaired_pdf"
                index_file_path = _repair_pdf_for_pypdf2(file_path, repair_dir)
            logger.info("Indexing %s with legacy page_index()", file_path)
            result = page_index(
                doc=str(index_file_path),
                model=model,
                if_add_node_summary="yes",
                if_add_node_text="no",
                if_add_node_id="yes",
                if_add_doc_description="yes",
                **legacy_options,
            )
            if not isinstance(result, dict):
                raise ValueError(f"Unexpected PageIndex result type: {type(result).__name__}")
            result.setdefault("doc_name", file_path.name)
            output_dir.mkdir(parents=True, exist_ok=True)
            with open(output_path, "w", encoding="utf-8") as f:
                json.dump(result, f, ensure_ascii=False, indent=2)
            indexed += 1
            logger.info("Wrote %s", output_path)
        except Exception as exc:
            logger.exception("Failed to index %s: %s", file_path, exc)
            if manual_fallback_on_fail:
                try:
                    logger.info("Trying manual PDF fallback for %s", file_path)
                    _write_manual_pdf_fallback(
                        file_path=file_path,
                        output_path=output_path,
                        pages_per_node=fallback_pages_per_node,
                        summary_chars=fallback_summary_chars,
                    )
                    indexed += 1
                    continue
                except Exception as fallback_exc:
                    logger.exception("Manual PDF fallback failed for %s: %s", file_path, fallback_exc)
            failed += 1
    return indexed, skipped, failed


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Build PageIndex tree JSON workspace.")
    parser.add_argument("--input_dir", required=True, help="Directory containing source PDFs/Markdown files.")
    parser.add_argument("--output_dir", required=True, help="Directory where PageIndex workspace JSON files are stored.")
    parser.add_argument("--pageindex_repo_path", default=None, help="Optional local PageIndex repo path to import from.")
    parser.add_argument("--config_path", default=None, help="Optional FinSagent YAML config; reads llm_model_name, llm_api_key, llm_base_url.")
    parser.add_argument("--api_key", default=None, help="Optional OpenAI-compatible API key override.")
    parser.add_argument("--base_url", default=None, help="Optional OpenAI-compatible base URL override.")
    parser.add_argument("--model", default=None, help="Model used by PageIndex indexing.")
    parser.add_argument("--retrieve_model", default=None, help="Optional model stored for PageIndex retrieval metadata.")
    parser.add_argument(
        "--toc_check_page_num",
        type=int,
        default=None,
        help="Legacy PageIndex only: number of leading pages to scan for a table of contents.",
    )
    parser.add_argument(
        "--max_page_num_each_node",
        type=int,
        default=None,
        help="Legacy PageIndex only: cap pages per generated structure node/group.",
    )
    parser.add_argument(
        "--max_token_num_each_node",
        type=int,
        default=None,
        help="Legacy PageIndex only: cap tokens per generated structure node/group.",
    )
    parser.add_argument(
        "--manual_fallback_on_fail",
        action="store_true",
        help="If legacy PageIndex fails for a PDF, write a PageIndex-compatible structure from extracted page text.",
    )
    parser.add_argument(
        "--repair_pdf_for_legacy",
        action="store_true",
        help="Before legacy PageIndex indexing, repair PDFs that PyPDF2 cannot read by rewriting them with PyMuPDF.",
    )
    parser.add_argument(
        "--repaired_pdf_dir",
        default=None,
        help="Optional directory for repaired PDF copies used by --repair_pdf_for_legacy.",
    )
    parser.add_argument(
        "--fallback_pages_per_node",
        type=int,
        default=4,
        help="Manual fallback only: number of PDF pages per parent structure node.",
    )
    parser.add_argument(
        "--fallback_summary_chars",
        type=int,
        default=1200,
        help="Manual fallback only: max characters stored in each node summary.",
    )
    parser.add_argument("--recursive", action=argparse.BooleanOptionalAction, default=False)
    parser.add_argument(
        "--extensions",
        default=".pdf,.md,.markdown",
        help="Comma-separated file extensions to index.",
    )
    parser.add_argument("--force", action="store_true", help="Index even if a doc with the same name already exists.")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    input_dir = Path(args.input_dir).expanduser().resolve()
    output_dir = Path(args.output_dir).expanduser().resolve()
    if not input_dir.exists():
        raise FileNotFoundError(f"input_dir not found: {input_dir}")
    output_dir.mkdir(parents=True, exist_ok=True)

    config = _load_yaml_config(args.config_path)
    _configure_openai_env(config=config, api_key=args.api_key, base_url=args.base_url)
    model = args.model or config.get("llm_model_name")
    _configure_tiktoken_model(model)

    extensions = {
        ext.strip().lower() if ext.strip().startswith(".") else f".{ext.strip().lower()}"
        for ext in args.extensions.split(",")
        if ext.strip()
    }
    files = list(_iter_files(input_dir, recursive=args.recursive, extensions=extensions))
    backend_name, backend = _load_pageindex_backend(args.pageindex_repo_path)
    logger.info("Using PageIndex backend: %s", backend_name)
    if backend_name == "client":
        indexed, skipped, failed = _index_with_client(
            PageIndexClient=backend,
            files=files,
            output_dir=output_dir,
            model=model,
            retrieve_model=args.retrieve_model,
            force=args.force,
        )
    else:
        legacy_options = {
            name: getattr(args, name)
            for name in (
                "toc_check_page_num",
                "max_page_num_each_node",
                "max_token_num_each_node",
            )
            if getattr(args, name) is not None
        }
        if legacy_options:
            logger.info("Using legacy PageIndex options: %s", legacy_options)
        indexed, skipped, failed = _index_with_legacy_page_index(
            page_index=backend,
            files=files,
            output_dir=output_dir,
            model=model,
            force=args.force,
            legacy_options=legacy_options,
            manual_fallback_on_fail=args.manual_fallback_on_fail,
            fallback_pages_per_node=args.fallback_pages_per_node,
            fallback_summary_chars=args.fallback_summary_chars,
            repair_pdf_for_legacy=args.repair_pdf_for_legacy,
            repaired_pdf_dir=Path(args.repaired_pdf_dir).expanduser().resolve() if args.repaired_pdf_dir else None,
        )

    logger.info(
        "PageIndex build complete: indexed=%d skipped=%d failed=%d output_dir=%s",
        indexed,
        skipped,
        failed,
        output_dir,
    )
    if failed:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
