#!/usr/bin/env python3
"""Step 2: build RAG-ready semantic chunks from Markdown blocks."""

from __future__ import annotations

import argparse
from pathlib import Path
from typing import Any

from common import dump_json, load_json, normalize_text, safe_stem, sha256_text, title_path_text


SECTION_BLOCKS = {"paragraph", "list_item", "quote", "html_block"}


def _source_locations(blocks: list[dict[str, Any]]) -> list[dict[str, Any]]:
    locations = []
    for block in blocks:
        loc = dict(block.get("source_location") or {})
        loc.update(
            {
                "block_id": block.get("block_id"),
                "block_type": block.get("block_type"),
                "heading_path": block.get("heading_path") or [],
            }
        )
        locations.append(loc)
    return locations


def _source_ref(locations: list[dict[str, Any]]) -> str:
    spans = []
    for loc in locations:
        start, end = loc.get("line_start"), loc.get("line_end")
        if start and end:
            spans.append(f"lines {start}-{end}")
    if not spans:
        return ""
    if len(spans) == 1:
        return spans[0]
    return f"{spans[0]}; {spans[-1]}"


def _content_type(block_type: str) -> str:
    if block_type == "table":
        return "markdown_table"
    if block_type == "code":
        return "markdown_code"
    return "markdown_section"


def _chunk_title(stem: str, heading_path: list[str], block_type: str) -> str:
    if heading_path:
        return heading_path[-1]
    if block_type == "table":
        return "Markdown table"
    if block_type == "code":
        return "Markdown code block"
    return stem


def _section_content(
    *,
    stem: str,
    doc_type: str,
    heading_path: list[str],
    blocks: list[dict[str, Any]],
    content_type: str,
) -> str:
    locations = _source_locations(blocks)
    source_ref = _source_ref(locations)
    heading = title_path_text(heading_path) or "Untitled"
    body = "\n\n".join(str(block.get("content") or "").strip() for block in blocks if str(block.get("content") or "").strip())
    if content_type == "markdown_code":
        language = blocks[0].get("language") or ""
        body = f"```{language}\n{body}\n```"
    return (
        f"Document: {stem}\n"
        f"Document type: {doc_type}\n"
        f"Heading: {heading}\n"
        f"Source: {source_ref}\n\n"
        f"{body}"
    ).strip()


def _make_chunk(stem: str, doc_type: str, blocks: list[dict[str, Any]]) -> dict[str, Any]:
    first = blocks[0]
    heading_path = list(first.get("heading_path") or [])
    block_type = str(first.get("block_type") or "paragraph")
    content_type = _content_type(block_type)
    title = _chunk_title(stem, heading_path, block_type)
    locations = _source_locations(blocks)
    content = _section_content(
        stem=stem,
        doc_type=doc_type,
        heading_path=heading_path,
        blocks=blocks,
        content_type=content_type,
    )
    metadata = {
        "source": "file2chunk_md",
        "doc_type": doc_type,
        "block_types": sorted({str(block.get("block_type") or "") for block in blocks}),
        "block_ids": [block.get("block_id") for block in blocks],
        "line_start": min((loc.get("line_start") for loc in locations if loc.get("line_start")), default=None),
        "line_end": max((loc.get("line_end") for loc in locations if loc.get("line_end")), default=None),
    }
    return {
        "content": content,
        "content_type": content_type,
        "type": content_type,
        "title": title,
        "title_path": [stem, *heading_path] if heading_path else [stem, title],
        "summary": "",
        "source_ref": _source_ref(locations),
        "source_locations": locations,
        "metadata": metadata,
        "content_hash": sha256_text(content),
    }


def _split_blocks_by_size(blocks: list[dict[str, Any]], max_chunk_chars: int) -> list[list[dict[str, Any]]]:
    groups: list[list[dict[str, Any]]] = []
    current: list[dict[str, Any]] = []
    current_len = 0
    for block in blocks:
        block_len = len(str(block.get("content") or ""))
        if current and current_len + block_len > max_chunk_chars:
            groups.append(current)
            current = [block]
            current_len = block_len
        else:
            current.append(block)
            current_len += block_len
    if current:
        groups.append(current)
    return groups


def _merge_short_sections(chunks: list[dict[str, Any]], min_chars: int = 240) -> list[dict[str, Any]]:
    merged: list[dict[str, Any]] = []
    for chunk in chunks:
        if (
            merged
            and chunk.get("content_type") == "markdown_section"
            and merged[-1].get("content_type") == "markdown_section"
            and len(str(chunk.get("content") or "")) < min_chars
            and chunk.get("title_path")[:-1] == merged[-1].get("title_path")[:-1]
        ):
            prev = merged[-1]
            prev_blocks = prev.get("metadata", {}).get("block_ids", [])
            new_blocks = chunk.get("metadata", {}).get("block_ids", [])
            prev["content"] = str(prev.get("content") or "") + "\n\n" + str(chunk.get("content") or "")
            prev["source_locations"] = list(prev.get("source_locations") or []) + list(chunk.get("source_locations") or [])
            prev["source_ref"] = _source_ref(prev["source_locations"])
            prev["content_hash"] = sha256_text(prev["content"])
            metadata = dict(prev.get("metadata") or {})
            metadata["block_ids"] = [*prev_blocks, *new_blocks]
            prev["metadata"] = metadata
        else:
            merged.append(chunk)
    return merged


def build_semantic_chunks(blocks_path: str | Path, *, doc_type: str, max_chunk_chars: int = 6000) -> list[dict[str, Any]]:
    doc = load_json(blocks_path)
    stem = safe_stem(doc.get("source_filename") or "markdown")
    blocks = list(doc.get("blocks") or [])
    chunks: list[dict[str, Any]] = []
    current_section: list[dict[str, Any]] = []
    current_heading: list[str] | None = None

    def flush_section() -> None:
        nonlocal current_section, current_heading
        if not current_section:
            return
        for group in _split_blocks_by_size(current_section, max_chunk_chars):
            chunks.append(_make_chunk(stem, doc_type, group))
        current_section = []
        current_heading = None

    for block in blocks:
        block_type = str(block.get("block_type") or "paragraph")
        heading_path = list(block.get("heading_path") or [])
        if block_type in {"table", "code"}:
            flush_section()
            chunks.append(_make_chunk(stem, doc_type, [block]))
            continue
        if block_type in SECTION_BLOCKS:
            if current_section and heading_path != current_heading:
                flush_section()
            current_section.append(block)
            current_heading = heading_path
    flush_section()

    chunks = _merge_short_sections(chunks)
    for idx, chunk in enumerate(chunks, start=1):
        chunk["id"] = idx
        chunk["chunk_index"] = idx
    return chunks


def main() -> None:
    parser = argparse.ArgumentParser(description="Build semantic Markdown chunks.")
    parser.add_argument("--blocks", required=True, help="Path to blocks.json")
    parser.add_argument("--output", required=True, help="Path to base_final.json")
    parser.add_argument("--doc-type", default="research_note")
    parser.add_argument("--max-chunk-chars", type=int, default=6000)
    args = parser.parse_args()
    dump_json(build_semantic_chunks(args.blocks, doc_type=args.doc_type, max_chunk_chars=args.max_chunk_chars), args.output)


if __name__ == "__main__":
    main()
