#!/usr/bin/env python3
"""Step 2: build RAG-ready semantic chunks from PPT blocks."""

from __future__ import annotations

import argparse
from copy import deepcopy
from pathlib import Path
from typing import Any

from common import dump_json, load_json, normalize_text, safe_stem, sha256_text, title_path_text


SLIDE_TEXT_BLOCKS = {"title", "text"}
STANDALONE_BLOCKS = {"table", "notes"}


def _source_locations(blocks: list[dict[str, Any]]) -> list[dict[str, Any]]:
    locations: list[dict[str, Any]] = []
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
    slide_numbers = [loc.get("slide_number") for loc in locations if loc.get("slide_number") is not None]
    shape_indexes = [loc.get("shape_index") for loc in locations if loc.get("shape_index") is not None]
    table_indexes = [loc.get("table_index") for loc in locations if loc.get("table_index") is not None]
    notes = [loc.get("notes_index") for loc in locations if loc.get("notes_index") is not None]
    refs: list[str] = []
    if slide_numbers:
        start, end = min(slide_numbers), max(slide_numbers)
        refs.append(f"slide {start}" if start == end else f"slides {start}-{end}")
    if shape_indexes:
        start, end = min(shape_indexes), max(shape_indexes)
        refs.append(f"shapes {start}-{end}" if start != end else f"shape {start}")
    if table_indexes:
        refs.extend(f"table {idx}" for idx in table_indexes)
    if notes:
        refs.append("speaker notes")
    return "; ".join(refs)


def _content_type(block_type: str) -> str:
    if block_type == "table":
        return "ppt_table"
    if block_type == "notes":
        return "ppt_notes"
    return "ppt_slide"


def _slide_title(stem: str, blocks: list[dict[str, Any]]) -> str:
    for block in blocks:
        title = normalize_text(str(block.get("slide_title") or ""))
        if title:
            return title
    return stem


def _title_path(stem: str, blocks: list[dict[str, Any]]) -> list[str]:
    title = _slide_title(stem, blocks)
    return [stem, title] if title and title != stem else [stem]


def _block_content(block: dict[str, Any]) -> str:
    text = str(block.get("content") or "").strip()
    if block.get("block_type") == "table":
        return text
    return text.strip()


def _slide_content(*, stem: str, doc_type: str, blocks: list[dict[str, Any]]) -> str:
    locations = _source_locations(blocks)
    title = _slide_title(stem, blocks)
    slide_number = next((loc.get("slide_number") for loc in locations if loc.get("slide_number") is not None), "")
    body_parts: list[str] = []
    for block in blocks:
        if block.get("block_type") == "title":
            continue
        content = _block_content(block)
        if content:
            body_parts.append(content)
    body = "\n\n".join(body_parts).strip()
    return (
        f"Document: {stem}\n"
        f"Document type: {doc_type}\n"
        f"Slide: {slide_number}\n"
        f"Title: {title}\n"
        f"Source: {_source_ref(locations)}\n\n"
        f"{body}"
    ).strip()


def _table_summary(stem: str, heading_path: list[str], block: dict[str, Any], content: str) -> str:
    analysis = dict(block.get("table_analysis") or block.get("source_location", {}).get("table_analysis") or {})
    header = analysis.get("header") or []
    heading = title_path_text(heading_path) or stem
    row_count = analysis.get("row_count")
    column_count = analysis.get("column_count")
    header_text = ", ".join(str(cell) for cell in header if str(cell).strip())[:240]
    preview = " ".join(line.strip(" |") for line in content.splitlines()[2:5] if line.strip())[:280]
    parts = [
        f"{heading} table",
        f"from {stem}",
    ]
    if row_count or column_count:
        parts.append(f"contains {row_count or 'unknown'} rows and {column_count or 'unknown'} columns")
    if header_text:
        parts.append(f"with headers including {header_text}")
    if preview:
        parts.append(f"and sample values including {preview}")
    return ". ".join(parts) + "."


def _make_chunk(stem: str, doc_type: str, blocks: list[dict[str, Any]]) -> dict[str, Any]:
    first = blocks[0]
    block_type = str(first.get("block_type") or "text")
    content_type = _content_type(block_type)
    title_path = _title_path(stem, blocks)
    locations = _source_locations(blocks)
    if content_type == "ppt_table":
        table_content = _block_content(first)
        content = (
            f"Document: {stem}\n"
            f"Document type: {doc_type}\n"
            f"Slide: {first.get('slide_number')}\n"
            f"Title: {_slide_title(stem, blocks)}\n"
            f"Source: {_source_ref(locations)}\n\n"
            f"{table_content}"
        ).strip()
        summary = _table_summary(stem, title_path, first, table_content)
    elif content_type == "ppt_notes":
        notes = _block_content(first)
        content = (
            f"Document: {stem}\n"
            f"Document type: {doc_type}\n"
            f"Slide: {first.get('slide_number')}\n"
            f"Title: {_slide_title(stem, blocks)}\n"
            f"Source: {_source_ref(locations)}\n\n"
            f"Speaker notes:\n{notes}"
        ).strip()
        summary = ""
    else:
        content = _slide_content(stem=stem, doc_type=doc_type, blocks=blocks)
        summary = ""

    metadata = {
        "source": "file2chunk_ppt",
        "doc_type": doc_type,
        "block_types": sorted({str(block.get("block_type") or "") for block in blocks}),
        "block_ids": [block.get("block_id") for block in blocks],
        "slide_numbers": sorted({loc.get("slide_number") for loc in locations if loc.get("slide_number") is not None}),
        "shape_indexes": [loc.get("shape_index") for loc in locations if loc.get("shape_index") is not None],
        "table_indexes": [loc.get("table_index") for loc in locations if loc.get("table_index") is not None],
        "notes_indexes": [loc.get("notes_index") for loc in locations if loc.get("notes_index") is not None],
    }
    if block_type == "table":
        metadata["table_analysis"] = first.get("table_analysis") or first.get("source_location", {}).get("table_analysis")
    return {
        "content": content,
        "content_type": content_type,
        "type": content_type,
        "title": title_path[-1] if title_path else stem,
        "title_path": title_path,
        "slide_number": first.get("slide_number"),
        "source_ref": _source_ref(locations),
        "source_locations": locations,
        "metadata": metadata,
        "summary": summary,
        "content_hash": sha256_text(content),
    }


def _split_text(text: str, max_body_chars: int) -> list[str]:
    lines = [line for line in text.splitlines() if line.strip()]
    if len(text) <= max_body_chars or len(lines) <= 1:
        return [text]
    parts: list[str] = []
    current: list[str] = []
    current_len = 0
    for line in lines:
        if current and current_len + len(line) > max_body_chars:
            parts.append("\n".join(current))
            current = [line]
            current_len = len(line)
        else:
            current.append(line)
            current_len += len(line)
    if current:
        parts.append("\n".join(current))
    return parts or [text]


def _split_slide_chunk(chunk: dict[str, Any], max_chunk_chars: int) -> list[dict[str, Any]]:
    content = str(chunk.get("content") or "")
    if len(content) <= max_chunk_chars:
        return [chunk]
    header, _, body = content.partition("\n\n")
    max_body_chars = max(1000, max_chunk_chars - len(header) - 32)
    parts = _split_text(body or content, max_body_chars)
    out: list[dict[str, Any]] = []
    for part_index, part in enumerate(parts, start=1):
        new_chunk = deepcopy(chunk)
        new_chunk["content"] = f"{header}\n\n{part}".strip() if body else part
        new_chunk["content_hash"] = sha256_text(new_chunk["content"])
        metadata = dict(new_chunk.get("metadata") or {})
        metadata["part_index"] = part_index
        metadata["part_count"] = len(parts)
        new_chunk["metadata"] = metadata
        if len(parts) > 1:
            new_chunk["title_path"] = [*list(chunk.get("title_path") or []), f"part {part_index}"]
            new_chunk["title"] = str(new_chunk["title_path"][-1])
        out.append(new_chunk)
    return out


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
    analysis = dict(new_block.get("table_analysis") or {})
    analysis.update({"table_part_index": part_index, "table_row_start": row_start, "table_row_end": row_end})
    new_block["table_analysis"] = analysis
    return new_block


def build_semantic_chunks(blocks_path: str | Path, *, doc_type: str, max_chunk_chars: int = 6000, min_notes_chars: int = 40) -> list[dict[str, Any]]:
    doc = load_json(blocks_path)
    stem = safe_stem(doc.get("source_filename") or "ppt")
    blocks = list(doc.get("blocks") or [])
    by_slide: dict[int, list[dict[str, Any]]] = {}
    for block in blocks:
        slide_number = int(block.get("slide_number") or 0)
        if slide_number <= 0:
            continue
        by_slide.setdefault(slide_number, []).append(block)

    chunks: list[dict[str, Any]] = []
    for slide_number in sorted(by_slide):
        slide_blocks = by_slide[slide_number]
        text_blocks = [block for block in slide_blocks if block.get("block_type") in SLIDE_TEXT_BLOCKS]
        has_non_title_text = any(
            block.get("block_type") != "title" and str(block.get("content") or "").strip()
            for block in text_blocks
        )
        has_standalone_content = any(block.get("block_type") in STANDALONE_BLOCKS for block in slide_blocks)
        if has_non_title_text or (text_blocks and not has_standalone_content):
            chunks.extend(_split_slide_chunk(_make_chunk(stem, doc_type, text_blocks), max_chunk_chars))

        for table_block in [block for block in slide_blocks if block.get("block_type") == "table"]:
            for part in _split_table_block(table_block, max_chunk_chars):
                chunks.append(_make_chunk(stem, doc_type, [part]))

        for notes_block in [block for block in slide_blocks if block.get("block_type") == "notes"]:
            if len(str(notes_block.get("content") or "").strip()) >= min_notes_chars:
                chunks.extend(_split_slide_chunk(_make_chunk(stem, doc_type, [notes_block]), max_chunk_chars))

    for idx, chunk in enumerate(chunks, start=1):
        chunk["id"] = idx
        chunk["chunk_index"] = idx
    return chunks


def build_ppt_table_items(chunks: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Export ppt_table chunks in the PDF table reconstruction JSON shape."""
    table_items: list[dict[str, Any]] = []
    for chunk in chunks:
        if chunk.get("content_type") != "ppt_table":
            continue
        locations = list(chunk.get("source_locations") or [])
        metadata = dict(chunk.get("metadata") or {})
        table_indexes = metadata.get("table_indexes") or [
            loc.get("table_index") for loc in locations if loc.get("table_index") is not None
        ]
        original_index = table_indexes[0] if table_indexes else chunk.get("chunk_index")
        caption = title_path_text(chunk.get("title_path"))
        content = str(chunk.get("content") or "")
        table_content = content.split("\n\n", 1)[1] if "\n\n" in content else content
        first_loc = locations[0] if locations else {}
        bbox = first_loc.get("bbox")
        table_items.append(
            {
                "type": "table",
                "source_type": "ppt_table",
                "summary": chunk.get("summary") or "",
                "content": table_content,
                "page_idx": None,
                "bbox": bbox,
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
    parser = argparse.ArgumentParser(description="Build semantic PPT chunks.")
    parser.add_argument("--blocks", required=True, help="Path to blocks.json")
    parser.add_argument("--output", required=True, help="Path to base_final.json")
    parser.add_argument("--doc-type", default="research_deck")
    parser.add_argument("--max-chunk-chars", type=int, default=6000)
    parser.add_argument("--min-notes-chars", type=int, default=40)
    args = parser.parse_args()
    dump_json(
        build_semantic_chunks(
            args.blocks,
            doc_type=args.doc_type,
            max_chunk_chars=args.max_chunk_chars,
            min_notes_chars=args.min_notes_chars,
        ),
        args.output,
    )


if __name__ == "__main__":
    main()
