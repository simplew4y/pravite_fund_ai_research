#!/usr/bin/env python3
"""Step 2: build RAG-ready semantic chunks from Word blocks."""

from __future__ import annotations

import argparse
from copy import deepcopy
from pathlib import Path
from typing import Any

from common import dump_json, load_json, normalize_text, safe_stem, sha256_text, title_path_text


SECTION_BLOCKS = {"paragraph", "list_item", "layout_table_text"}
STANDALONE_BLOCKS = {"table", "image_ocr"}


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
    paragraph_indexes = [loc.get("paragraph_index") for loc in locations if loc.get("paragraph_index")]
    table_indexes = [loc.get("table_index") for loc in locations if loc.get("table_index")]
    image_indexes = [loc.get("image_index") for loc in locations if loc.get("image_index")]
    refs: list[str] = []
    if paragraph_indexes:
        start, end = min(paragraph_indexes), max(paragraph_indexes)
        refs.append(f"paragraph {start}" if start == end else f"paragraphs {start}-{end}")
    if table_indexes:
        refs.extend(f"table {idx}" for idx in table_indexes)
    if image_indexes:
        refs.extend(f"image {idx}" for idx in image_indexes)
    return "; ".join(refs)


def _content_type(block_type: str) -> str:
    if block_type == "table":
        return "word_table"
    if block_type == "image_ocr":
        return "word_image_ocr"
    return "word_section"


def _chunk_title(stem: str, heading_path: list[str], block_type: str) -> str:
    if heading_path:
        return heading_path[-1]
    if block_type == "table":
        return "Word table"
    if block_type == "image_ocr":
        return "Word image OCR"
    return stem


def _markdown_table_rows(content: str) -> list[list[str]]:
    rows: list[list[str]] = []
    for line in content.splitlines():
        raw = line.strip()
        if not raw.startswith("|") or not raw.endswith("|"):
            continue
        cells = [normalize_text(cell) for cell in raw.strip("|").split("|")]
        if cells and all(cell == "---" for cell in cells):
            continue
        rows.append(cells)
    return rows


def _table_summary(stem: str, heading_path: list[str], block: dict[str, Any], content: str) -> str:
    analysis = dict(block.get("table_analysis") or block.get("source_location", {}).get("table_analysis") or {})
    rows = _markdown_table_rows(content)
    header = rows[0] if rows else []
    preview_values: list[str] = []
    for row in rows[1:4]:
        preview_values.extend(cell for cell in row if cell)
    heading = title_path_text(heading_path) or stem
    row_count = analysis.get("row_count") or max(0, len(rows) - 1)
    column_count = analysis.get("column_count") or (len(header) if header else None)
    header_text = ", ".join(cell for cell in header if cell)[:240]
    preview_text = "; ".join(preview_values[:8])[:280]
    parts = [
        f"{heading} table",
        f"from {stem}",
    ]
    if row_count or column_count:
        parts.append(f"contains {row_count or 'unknown'} rows and {column_count or 'unknown'} columns")
    if header_text:
        parts.append(f"with columns or headers including {header_text}")
    if preview_text:
        parts.append(f"and sample values including {preview_text}")
    return ". ".join(parts) + "."


def _block_content(block: dict[str, Any]) -> str:
    text = str(block.get("content") or "").strip()
    if block.get("block_type") == "table":
        return text
    return normalize_text(text)


def _section_content(
    *,
    stem: str,
    doc_type: str,
    heading_path: list[str],
    blocks: list[dict[str, Any]],
) -> str:
    locations = _source_locations(blocks)
    source_ref = _source_ref(locations)
    heading = title_path_text(heading_path) or "Untitled"
    body = "\n\n".join(_block_content(block) for block in blocks if str(block.get("content") or "").strip())
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
    content = _section_content(stem=stem, doc_type=doc_type, heading_path=heading_path, blocks=blocks)
    summary = _table_summary(stem, heading_path, first, _block_content(first)) if block_type == "table" else ""
    metadata = {
        "source": "file2chunk_word",
        "doc_type": doc_type,
        "block_types": sorted({str(block.get("block_type") or "") for block in blocks}),
        "block_ids": [block.get("block_id") for block in blocks],
        "paragraph_start": min((loc.get("paragraph_index") for loc in locations if loc.get("paragraph_index")), default=None),
        "paragraph_end": max((loc.get("paragraph_index") for loc in locations if loc.get("paragraph_index")), default=None),
        "table_indexes": [loc.get("table_index") for loc in locations if loc.get("table_index")],
        "image_indexes": [loc.get("image_index") for loc in locations if loc.get("image_index")],
    }
    if block_type == "table":
        metadata["table_analysis"] = first.get("table_analysis") or first.get("source_location", {}).get("table_analysis")
    return {
        "content": content,
        "content_type": content_type,
        "type": content_type,
        "title": title,
        "title_path": [stem, *heading_path] if heading_path else [stem, title],
        "source_ref": _source_ref(locations),
        "source_locations": locations,
        "metadata": metadata,
        "summary": summary,
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


def _split_table_block(block: dict[str, Any], max_chunk_chars: int) -> list[dict[str, Any]]:
    content = str(block.get("content") or "")
    if len(content) <= max_chunk_chars:
        return [block]
    lines = [line for line in content.splitlines() if line.strip()]
    if len(lines) <= 4:
        return [block]
    header = lines[:2]
    rows = lines[2:]
    out: list[dict[str, Any]] = []
    current: list[str] = []
    current_len = sum(len(line) for line in header)
    part_index = 1
    row_start = 1
    for row_number, row in enumerate(rows, start=1):
        row_len = len(row)
        if current and current_len + row_len > max_chunk_chars:
            out.append(_table_part(block, header, current, part_index, row_start, row_number - 1))
            part_index += 1
            row_start = row_number
            current = [row]
            current_len = sum(len(line) for line in header) + row_len
        else:
            current.append(row)
            current_len += row_len
    if current:
        out.append(_table_part(block, header, current, part_index, row_start, row_start + len(current) - 1))
    return out or [block]


def _table_part(block: dict[str, Any], header: list[str], rows: list[str], part_index: int, row_start: int, row_end: int) -> dict[str, Any]:
    new_block = deepcopy(block)
    new_block["block_id"] = f"{block.get('block_id')}_part{part_index}"
    new_block["content"] = "\n".join([*header, *rows])
    loc = dict(new_block.get("source_location") or {})
    loc.update(
        {
            "table_part_index": part_index,
            "table_row_start": row_start,
            "table_row_end": row_end,
            "display_text": f"{loc.get('display_text') or 'table'} rows {row_start}-{row_end}",
        }
    )
    new_block["source_location"] = loc
    metadata = dict(new_block.get("table_analysis") or {})
    metadata.update({"table_part_index": part_index, "table_row_start": row_start, "table_row_end": row_end})
    new_block["table_analysis"] = metadata
    return new_block


def _merge_short_sections(chunks: list[dict[str, Any]], min_chars: int = 280) -> list[dict[str, Any]]:
    merged: list[dict[str, Any]] = []
    for chunk in chunks:
        if (
            merged
            and chunk.get("content_type") == "word_section"
            and merged[-1].get("content_type") == "word_section"
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
            metadata["paragraph_start"] = min((loc.get("paragraph_index") for loc in prev["source_locations"] if loc.get("paragraph_index")), default=None)
            metadata["paragraph_end"] = max((loc.get("paragraph_index") for loc in prev["source_locations"] if loc.get("paragraph_index")), default=None)
            metadata["table_indexes"] = [loc.get("table_index") for loc in prev["source_locations"] if loc.get("table_index")]
            metadata["image_indexes"] = [loc.get("image_index") for loc in prev["source_locations"] if loc.get("image_index")]
            prev["metadata"] = metadata
        else:
            merged.append(chunk)
    return merged


def build_semantic_chunks(blocks_path: str | Path, *, doc_type: str, max_chunk_chars: int = 6000) -> list[dict[str, Any]]:
    doc = load_json(blocks_path)
    stem = safe_stem(doc.get("source_filename") or "word")
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
        if block_type in STANDALONE_BLOCKS:
            flush_section()
            if block_type == "table":
                for table_block in _split_table_block(block, max_chunk_chars):
                    chunks.append(_make_chunk(stem, doc_type, [table_block]))
            else:
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


def build_word_table_items(chunks: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Export word_table chunks in the PDF table reconstruction JSON shape."""
    table_items: list[dict[str, Any]] = []
    for chunk in chunks:
        if chunk.get("content_type") != "word_table":
            continue
        locations = list(chunk.get("source_locations") or [])
        metadata = dict(chunk.get("metadata") or {})
        table_indexes = metadata.get("table_indexes") or [
            loc.get("table_index") for loc in locations if loc.get("table_index") is not None
        ]
        original_index = table_indexes[0] if table_indexes else chunk.get("chunk_index")
        heading_path = []
        for loc in locations:
            if loc.get("heading_path"):
                heading_path = list(loc.get("heading_path") or [])
                break
        caption = title_path_text(heading_path or chunk.get("title_path"))
        content = str(chunk.get("content") or "")
        table_content = content.split("\n\n", 1)[1] if "\n\n" in content else content
        table_items.append(
            {
                "type": "table",
                "source_type": "word_table",
                "summary": chunk.get("summary") or "",
                "content": table_content,
                "page_idx": None,
                "bbox": None,
                "original_img_path": None,
                "table_caption": [caption] if caption else [],
                "table_footnote": [],
                "original_index": original_index,
                "source_locations": locations,
                "metadata": metadata,
            }
        )
    return table_items


def main() -> None:
    parser = argparse.ArgumentParser(description="Build semantic Word chunks.")
    parser.add_argument("--blocks", required=True, help="Path to blocks.json")
    parser.add_argument("--output", required=True, help="Path to base_final.json")
    parser.add_argument("--doc-type", default="research_report")
    parser.add_argument("--max-chunk-chars", type=int, default=6000)
    args = parser.parse_args()
    dump_json(build_semantic_chunks(args.blocks, doc_type=args.doc_type, max_chunk_chars=args.max_chunk_chars), args.output)


if __name__ == "__main__":
    main()
