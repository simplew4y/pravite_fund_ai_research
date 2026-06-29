#!/usr/bin/env python3
"""Step 1: parse Markdown into structured blocks."""

from __future__ import annotations

import argparse
from pathlib import Path
from typing import Any

from markdown_it import MarkdownIt

from common import dump_json, ensure_supported_file, normalize_text, read_text, sha256_file


def _line_span(token) -> tuple[int | None, int | None]:
    if getattr(token, "map", None):
        return int(token.map[0]) + 1, int(token.map[1])
    return None, None


def _heading_level(token) -> int:
    try:
        return int(str(token.tag).lstrip("h"))
    except ValueError:
        return 1


def _make_location(block: dict[str, Any]) -> dict[str, Any]:
    line_start = block.get("line_start")
    line_end = block.get("line_end")
    display = f"lines {line_start}-{line_end}" if line_start and line_end else f"block {block.get('block_index')}"
    return {
        "block_id": block.get("block_id"),
        "block_type": block.get("block_type"),
        "token_index": block.get("token_index"),
        "line_start": line_start,
        "line_end": line_end,
        "heading_path": block.get("heading_path") or [],
        "display_text": display,
    }


def _table_from_tokens(tokens: list[Any], start_idx: int) -> tuple[str, int]:
    rows: list[list[str]] = []
    current_row: list[str] | None = None
    current_cell: list[str] | None = None
    idx = start_idx
    while idx < len(tokens):
        token = tokens[idx]
        token_type = token.type
        if token_type == "tr_open":
            current_row = []
        elif token_type in {"th_open", "td_open"}:
            current_cell = []
        elif token_type == "inline" and current_cell is not None:
            current_cell.append(str(token.content or "").strip())
        elif token_type in {"th_close", "td_close"} and current_row is not None:
            current_row.append(" ".join(item for item in current_cell or [] if item))
            current_cell = None
        elif token_type == "tr_close" and current_row is not None:
            rows.append(current_row)
            current_row = None
        elif token_type == "table_close":
            break
        idx += 1
    if not rows:
        return "", idx
    width = max(len(row) for row in rows)
    normalized = [row + [""] * (width - len(row)) for row in rows]
    lines = ["| " + " | ".join(normalized[0]) + " |", "| " + " | ".join(["---"] * width) + " |"]
    lines.extend("| " + " | ".join(row) + " |" for row in normalized[1:])
    return "\n".join(lines), idx


def parse_markdown_to_blocks(file_path: str | Path) -> dict[str, Any]:
    md_path = ensure_supported_file(file_path)
    text = read_text(md_path)
    parser = MarkdownIt("commonmark", {"html": False}).enable("table")
    tokens = parser.parse(text)
    heading_stack: list[tuple[int, str]] = []
    blocks: list[dict[str, Any]] = []
    list_depth = 0
    quote_depth = 0
    idx = 0
    block_index = 0

    while idx < len(tokens):
        token = tokens[idx]
        token_type = token.type

        if token_type in {"bullet_list_open", "ordered_list_open"}:
            list_depth += 1
            idx += 1
            continue
        if token_type in {"bullet_list_close", "ordered_list_close"}:
            list_depth = max(0, list_depth - 1)
            idx += 1
            continue
        if token_type == "blockquote_open":
            quote_depth += 1
            idx += 1
            continue
        if token_type == "blockquote_close":
            quote_depth = max(0, quote_depth - 1)
            idx += 1
            continue

        if token_type == "heading_open" and idx + 1 < len(tokens):
            inline = tokens[idx + 1]
            title = normalize_text(str(inline.content or ""))
            if title:
                level = _heading_level(token)
                heading_stack = [(lv, txt) for lv, txt in heading_stack if lv < level]
                heading_stack.append((level, title))
            idx += 3
            continue

        heading_path = [txt for _, txt in heading_stack]

        if token_type == "paragraph_open" and idx + 1 < len(tokens):
            inline = tokens[idx + 1]
            content = normalize_text(str(inline.content or ""))
            if content:
                line_start, line_end = _line_span(token)
                block_index += 1
                block_type = "paragraph"
                if list_depth:
                    block_type = "list_item"
                    content = "- " + content
                if quote_depth:
                    block_type = "quote"
                    content = "> " + content
                block = {
                    "block_id": f"md-{block_index}",
                    "block_index": block_index,
                    "block_type": block_type,
                    "content": content,
                    "heading_path": heading_path,
                    "line_start": line_start,
                    "line_end": line_end,
                    "token_index": idx,
                }
                block["source_location"] = _make_location(block)
                blocks.append(block)
            idx += 3
            continue

        if token_type == "table_open":
            table_text, end_idx = _table_from_tokens(tokens, idx)
            if table_text:
                line_start, line_end = _line_span(token)
                block_index += 1
                block = {
                    "block_id": f"md-{block_index}",
                    "block_index": block_index,
                    "block_type": "table",
                    "content": table_text,
                    "heading_path": heading_path,
                    "line_start": line_start,
                    "line_end": line_end,
                    "token_index": idx,
                }
                block["source_location"] = _make_location(block)
                blocks.append(block)
            idx = end_idx + 1
            continue

        if token_type in {"fence", "code_block"}:
            content = str(token.content or "").rstrip()
            if content:
                line_start, line_end = _line_span(token)
                block_index += 1
                language = normalize_text(str(getattr(token, "info", "") or "").split()[0] if getattr(token, "info", "") else "")
                block = {
                    "block_id": f"md-{block_index}",
                    "block_index": block_index,
                    "block_type": "code",
                    "content": content,
                    "language": language,
                    "heading_path": heading_path,
                    "line_start": line_start,
                    "line_end": line_end,
                    "token_index": idx,
                }
                block["source_location"] = _make_location(block)
                blocks.append(block)
            idx += 1
            continue

        if token_type == "html_block":
            content = str(token.content or "").strip()
            if content:
                line_start, line_end = _line_span(token)
                block_index += 1
                block = {
                    "block_id": f"md-{block_index}",
                    "block_index": block_index,
                    "block_type": "html_block",
                    "content": content,
                    "heading_path": heading_path,
                    "line_start": line_start,
                    "line_end": line_end,
                    "token_index": idx,
                }
                block["source_location"] = _make_location(block)
                blocks.append(block)
        idx += 1

    return {
        "source_path": str(md_path),
        "source_filename": md_path.name,
        "checksum": sha256_file(md_path),
        "parser": "markdown_it",
        "block_count": len(blocks),
        "blocks": blocks,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Parse Markdown into structured blocks.")
    parser.add_argument("--file", required=True, help="Path to .md/.markdown file")
    parser.add_argument("--output", required=True, help="Path to blocks.json")
    args = parser.parse_args()
    dump_json(parse_markdown_to_blocks(args.file), args.output)


if __name__ == "__main__":
    main()
