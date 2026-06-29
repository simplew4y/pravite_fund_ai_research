#!/usr/bin/env python3
"""Step 1: parse a DOCX file into ordered semantic blocks.

This step deliberately stays parser-oriented: it extracts Word paragraphs,
tables, optional image OCR text, and a best-effort heading path. Chunk sizing is
handled by step2.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
from pathlib import Path
from typing import Any, Iterator

from docx import Document
from docx.document import Document as DocumentObject
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml.table import CT_Tbl
from docx.oxml.text.paragraph import CT_P
from docx.table import Table
from docx.text.paragraph import Paragraph

from common import dump_json, ensure_supported_file, normalize_text, sha256_file


DEFAULT_MINERU_BIN = "/root/autodl-tmp/cjj/code/file2chunk/.venv/bin/mineru"
R_EMBED = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}embed"
R_LINK = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}link"
R_ID = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id"
O_RELID = "{urn:schemas-microsoft-com:office:office}relid"


def _iter_block_items(document: DocumentObject) -> Iterator[tuple[str, Paragraph | Table]]:
    body = document.element.body
    for child in body.iterchildren():
        if isinstance(child, CT_P):
            yield "paragraph", Paragraph(child, document)
        elif isinstance(child, CT_Tbl):
            yield "table", Table(child, document)


def _style_name(paragraph: Paragraph) -> str:
    try:
        return paragraph.style.name if paragraph.style is not None else ""
    except Exception:
        return ""


def _heading_level(style_name: str) -> int | None:
    match = re.match(r"Heading\s+(\d+)$", style_name or "", flags=re.IGNORECASE)
    if not match:
        return None
    return max(1, min(int(match.group(1)), 9))


def _is_list_paragraph(paragraph: Paragraph, style_name: str) -> bool:
    if "list" in (style_name or "").lower():
        return True
    ppr = paragraph._p.pPr
    return bool(ppr is not None and ppr.numPr is not None)


def _update_heading_stack(stack: list[str], level: int, title: str) -> list[str]:
    if len(stack) < level:
        stack.extend([""] * (level - len(stack)))
    stack[level - 1] = title
    del stack[level:]
    return [item for item in stack if item]


def _word_count(text: str) -> int:
    return len(re.findall(r"[A-Za-z0-9\u4e00-\u9fff]+", text or ""))


def _is_date_like(text: str) -> bool:
    return bool(
        re.fullmatch(
            r"(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s+\d{4}",
            text,
            flags=re.IGNORECASE,
        )
        or re.fullmatch(r"\d{4}[-/]\d{1,2}[-/]\d{1,2}", text)
    )


def _paragraph_features(paragraph: Paragraph, paragraph_index: int) -> dict[str, Any]:
    text = normalize_text(paragraph.text)
    style_name = _style_name(paragraph)
    chars = max(1, len(text))
    bold_chars = 0
    run_chars = 0
    max_font_pt: float | None = None
    for run in paragraph.runs:
        run_text = run.text or ""
        if not run_text:
            continue
        run_chars += len(run_text)
        run_bold = bool(run.bold)
        if run.bold is None:
            try:
                run_bold = bool(paragraph.style and paragraph.style.font and paragraph.style.font.bold)
            except Exception:
                run_bold = False
        if run_bold:
            bold_chars += len(run_text)
        try:
            if run.font.size is not None:
                size_pt = float(run.font.size.pt)
                max_font_pt = size_pt if max_font_pt is None else max(max_font_pt, size_pt)
        except Exception:
            pass
    try:
        if max_font_pt is None and paragraph.style and paragraph.style.font and paragraph.style.font.size:
            max_font_pt = float(paragraph.style.font.size.pt)
    except Exception:
        pass
    try:
        centered = paragraph.alignment == WD_ALIGN_PARAGRAPH.CENTER
    except Exception:
        centered = False
    return {
        "paragraph_index": paragraph_index,
        "text": text,
        "style_name": style_name,
        "explicit_heading_level": _heading_level(style_name),
        "is_list": _is_list_paragraph(paragraph, style_name),
        "word_count": _word_count(text),
        "char_count": len(text),
        "bold_ratio": round(bold_chars / max(1, run_chars), 3),
        "any_bold": bold_chars > 0,
        "max_font_pt": max_font_pt,
        "centered": centered,
        "all_caps": bool(text and text.upper() == text and re.search(r"[A-Z]", text)),
    }


def _next_meaningful(items: list[dict[str, Any]], index: int) -> dict[str, Any] | None:
    for item in items[index + 1 :]:
        if item.get("kind") in {"paragraph", "table", "image"}:
            return item
    return None


def _prev_meaningful(items: list[dict[str, Any]], index: int) -> dict[str, Any] | None:
    for item in reversed(items[:index]):
        if item.get("kind") in {"paragraph", "table", "image"}:
            return item
    return None


def _terminal_punctuation(text: str) -> bool:
    return bool(text.endswith((".", ",", ";", "?", "!", "。", "，", "；", "？", "！")))


def _is_boilerplate_non_heading(text: str) -> bool:
    lower = text.strip().lower()
    if lower in {"sincerely", "dear shareholder", "to our shareholders", "by order of the board of directors"}:
        return True
    if _is_date_like(text):
        return True
    return False


def _looks_like_numbered_heading(text: str) -> bool:
    return bool(
        re.match(r"^(\d+(\.\d+)*|[IVXLC]+\.|[A-Z]\.)\s+[^.]{3,}$", text)
        or re.match(r"^(part|section|chapter|appendix|proposal|item)\s+[\w\d]+", text, flags=re.IGNORECASE)
    )


def _looks_like_visual_heading(items: list[dict[str, Any]], index: int) -> bool:
    item = items[index]
    features = item.get("features") or {}
    text = features.get("text") or ""
    if not text or features.get("explicit_heading_level") is not None:
        return False
    if features.get("is_list") or features.get("word_count", 0) > 16 or features.get("char_count", 0) > 120:
        return False
    if features.get("char_count", 0) < 3 or _terminal_punctuation(text) or _is_boilerplate_non_heading(text):
        return False

    if _looks_like_numbered_heading(text):
        return True

    next_item = _next_meaningful(items, index)
    score = 0
    if features.get("any_bold") or features.get("bold_ratio", 0) >= 0.55:
        score += 1
    if features.get("centered") or features.get("all_caps"):
        score += 1
    if features.get("max_font_pt") and features["max_font_pt"] >= 13:
        score += 1
    if features.get("word_count", 0) <= 8 and re.match(r"^[A-Z0-9][A-Za-z0-9&/()'\- ]+$", text):
        score += 1
    if next_item and next_item.get("kind") == "table":
        score += 1
    if next_item and next_item.get("kind") == "paragraph" and len(next_item.get("features", {}).get("text", "")) >= 160:
        score += 1
    return score >= 2


def _visual_heading_level(text: str) -> int:
    if re.match(r"^(section)\s+[\w\d]+", text, flags=re.IGNORECASE):
        return 2
    if re.match(r"^(proposal|part|chapter|appendix|item)\s+[\w\d]+", text, flags=re.IGNORECASE):
        return 1
    numbered = re.match(r"^(\d+(?:\.\d+)*)\s+", text)
    if numbered:
        return min(3, numbered.group(1).count(".") + 1)
    return 1


def _table_rows(table: Table) -> list[list[str]]:
    rows: list[list[str]] = []
    for row in table.rows:
        values = [normalize_text(cell.text) for cell in row.cells]
        if any(values):
            rows.append(values)
    return rows


def _table_to_markdown(rows: list[list[str]]) -> str:
    if not rows:
        return ""
    width = max(len(row) for row in rows)
    normalized = [row + [""] * (width - len(row)) for row in rows]
    header = normalized[0]
    separator = ["---"] * width
    body = normalized[1:] if len(normalized) > 1 else []

    def fmt(row: list[str]) -> str:
        return "| " + " | ".join(cell.replace("\n", " ") for cell in row) + " |"

    return "\n".join([fmt(header), fmt(separator), *(fmt(row) for row in body)])


def _linearize_table_text(rows: list[list[str]]) -> str:
    values: list[str] = []
    seen: set[str] = set()
    for row in rows:
        for cell in row:
            value = normalize_text(cell)
            if value and value not in seen:
                seen.add(value)
                values.append(value)
    return " ".join(values)


def _classify_table(rows: list[list[str]]) -> dict[str, Any]:
    if not rows:
        return {"classification": "empty"}
    width = max(len(row) for row in rows)
    cells = [cell for row in rows for cell in row if cell]
    text = " ".join(cells)
    numeric_cells = sum(1 for cell in cells if re.search(r"[$€£¥%]|\b\d{2,}\b|\d+\.\d+", cell))
    unique_ratio = len(set(cells)) / max(1, len(cells))
    if len(rows) <= 1:
        classification = "layout"
    elif len(cells) <= 4 and numeric_cells == 0:
        classification = "layout"
    elif len(rows) <= 2 and width <= 3 and (numeric_cells == 0 or unique_ratio < 0.7):
        classification = "layout"
    else:
        classification = "content"
    return {
        "classification": classification,
        "row_count": len(rows),
        "column_count": width,
        "nonempty_cell_count": len(cells),
        "numeric_cell_count": numeric_cells,
        "unique_cell_ratio": round(unique_ratio, 3),
        "char_count": len(text),
    }


def _image_extension(part: Any) -> str:
    suffix = Path(str(getattr(part, "partname", ""))).suffix.lower()
    if suffix in {".png", ".jpg", ".jpeg"}:
        return suffix
    content_type = getattr(part, "content_type", "")
    if "png" in content_type:
        return ".png"
    return ".jpeg"


def _extract_image_refs(element: Any) -> list[str]:
    refs: list[str] = []
    for blip in element.xpath('.//*[local-name()="blip"]'):
        rid = blip.get(R_EMBED) or blip.get(R_LINK) or blip.get(R_ID)
        if rid:
            refs.append(rid)
    for image_data in element.xpath('.//*[local-name()="imagedata"]'):
        rid = image_data.get(R_ID) or image_data.get(O_RELID) or image_data.get("id") or image_data.get("relid")
        if rid:
            refs.append(rid)
    return refs


def _save_image_occurrences(
    *,
    document: DocumentObject,
    refs: list[str],
    image_dir: Path,
    image_index_start: int,
    context: dict[str, Any],
    saved_images: dict[str, dict[str, Any]],
) -> tuple[list[dict[str, Any]], int]:
    out: list[dict[str, Any]] = []
    image_dir.mkdir(parents=True, exist_ok=True)
    image_index = image_index_start
    for rid in refs:
        part = document.part.related_parts.get(rid)
        if part is None or not hasattr(part, "blob"):
            continue
        media_name = str(getattr(part, "partname", "")).lstrip("/")
        media_key = media_name or rid
        if media_key in saved_images:
            saved = saved_images[media_key]
            saved["occurrence_count"] = int(saved.get("occurrence_count") or 1) + 1
            saved.setdefault("occurrences", []).append(dict(context))
            continue
        image_index += 1
        ext = _image_extension(part)
        name = f"image_{image_index:04d}{ext}"
        path = image_dir / name
        path.write_bytes(part.blob)
        item = {
            "kind": "image",
            "image_index": image_index,
            "relationship_id": rid,
            "media_name": media_name,
            "stored_image_path": str(path),
            "occurrence_count": 1,
            "occurrences": [dict(context)],
            **context,
        }
        saved_images[media_key] = item
        out.append(item)
    return out, image_index


def _run_mineru_image_ocr(images_dir: Path, ocr_dir: Path, mineru_bin: str, ocr_lang: str) -> None:
    if not images_dir.exists() or not any(images_dir.iterdir()):
        return
    if not Path(mineru_bin).is_file():
        raise FileNotFoundError(f"mineru executable not found: {mineru_bin}")
    if ocr_dir.exists():
        shutil.rmtree(ocr_dir)
    ocr_dir.mkdir(parents=True, exist_ok=True)
    env = os.environ.copy()
    env["MINERU_MODEL_SOURCE"] = env.get("MINERU_MODEL_SOURCE", "modelscope")
    env["MINERU_FORMULA_ENABLE"] = env.get("MINERU_FORMULA_ENABLE", "true")
    cmd = [mineru_bin, "-p", str(images_dir), "-o", str(ocr_dir), "-b", "hybrid-auto-engine", "-l", ocr_lang]
    subprocess.run(cmd, check=True, env=env)


def _collect_text_from_json(obj: Any, out: list[str]) -> None:
    if isinstance(obj, dict):
        for key in ("text", "table_body", "table_caption", "table_footnote"):
            value = obj.get(key)
            if isinstance(value, str) and value.strip():
                out.append(value)
        value = obj.get("content")
        if isinstance(value, str) and value.strip():
            out.append(value)
        elif isinstance(value, list):
            _collect_text_from_json(value, out)
        for key in ("title_content", "text_level", "children"):
            value = obj.get(key)
            if isinstance(value, list):
                _collect_text_from_json(value, out)
    elif isinstance(obj, list):
        for item in obj:
            _collect_text_from_json(item, out)
    elif isinstance(obj, str) and obj.strip():
        out.append(obj)


def _clean_ocr_text(text: str) -> str:
    text = re.sub(r"!\[[^\]]*\]\([^)]*\)", "", text or "")
    lines: list[str] = []
    seen: set[str] = set()
    for raw_line in text.splitlines():
        line = normalize_text(raw_line)
        if not line:
            continue
        key = line.casefold()
        if key in seen:
            continue
        seen.add(key)
        lines.append(line)
    return "\n".join(lines)


def _extract_mineru_text_for_image(image_path: Path, ocr_dir: Path) -> tuple[str, list[str]]:
    stem = image_path.stem
    candidates = sorted(p for p in ocr_dir.rglob("*") if p.is_file() and stem in p.name)
    text_parts: list[str] = []
    source_files: list[str] = []
    for path in candidates:
        if path.suffix.lower() == ".json" and ("content_list" in path.name or path.name.endswith("_middle.json")):
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
            except Exception:
                continue
            _collect_text_from_json(data, text_parts)
            source_files.append(str(path))
        elif path.suffix.lower() == ".md":
            text = path.read_text(encoding="utf-8", errors="ignore")
            if text.strip():
                text_parts.append(text)
                source_files.append(str(path))
    return _clean_ocr_text("\n".join(part.strip() for part in text_parts if part.strip())), source_files


def _useful_ocr_text(text: str, min_chars: int) -> bool:
    normalized = normalize_text(text)
    if len(normalized) < min_chars:
        return False
    tokens = re.findall(r"[A-Za-z0-9\u4e00-\u9fff]+", normalized)
    if len(tokens) < 5:
        return False
    alnum_chars = sum(1 for ch in normalized if ch.isalnum())
    if alnum_chars / max(1, len(normalized)) < 0.28:
        return False
    unique_tokens = {token.lower() for token in tokens if len(token) > 1}
    if len(unique_tokens) <= 2:
        return False
    return True


def _apply_image_ocr(raw_items: list[dict[str, Any]], image_dir: Path, ocr_dir: Path, mineru_bin: str, ocr_lang: str, min_chars: int) -> None:
    image_items = [item for item in raw_items if item.get("kind") == "image"]
    if not image_items:
        return
    _run_mineru_image_ocr(image_dir, ocr_dir, mineru_bin, ocr_lang)
    for item in image_items:
        image_path = Path(item["stored_image_path"])
        text, sources = _extract_mineru_text_for_image(image_path, ocr_dir)
        item["ocr_text"] = normalize_text(text)
        item["ocr_source_files"] = sources
        item["ocr_useful"] = _useful_ocr_text(text, min_chars)


def parse_word_to_blocks(
    file_path: str | Path,
    *,
    processed_dir: str | Path | None = None,
    enable_image_ocr: bool = False,
    mineru_bin: str = DEFAULT_MINERU_BIN,
    ocr_lang: str = "en",
    ocr_min_chars: int = 40,
) -> dict[str, Any]:
    path = ensure_supported_file(file_path)
    document = Document(str(path))
    proc_dir = Path(processed_dir).resolve() if processed_dir else path.parent / f"{path.stem}_word_processed"
    image_dir = proc_dir / "images"
    ocr_dir = proc_dir / "image_ocr"
    raw_items: list[dict[str, Any]] = []
    paragraph_index = 0
    table_index = 0
    image_index = 0
    saved_images: dict[str, dict[str, Any]] = {}

    if enable_image_ocr:
        image_dir.mkdir(parents=True, exist_ok=True)

    for item_type, item in _iter_block_items(document):
        if item_type == "paragraph":
            paragraph_index += 1
            paragraph = item
            features = _paragraph_features(paragraph, paragraph_index)
            if features["text"]:
                raw_items.append({"kind": "paragraph", "features": features})
            if enable_image_ocr:
                image_items, image_index = _save_image_occurrences(
                    document=document,
                    refs=_extract_image_refs(paragraph._p),
                    image_dir=image_dir,
                    image_index_start=image_index,
                    context={"paragraph_index": paragraph_index},
                    saved_images=saved_images,
                )
                raw_items.extend(image_items)
            continue

        table_index += 1
        table = item
        rows = _table_rows(table)
        analysis = _classify_table(rows)
        raw_items.append({"kind": "table", "table_index": table_index, "rows": rows, "analysis": analysis})
        if enable_image_ocr:
            image_items, image_index = _save_image_occurrences(
                document=document,
                refs=_extract_image_refs(table._tbl),
                image_dir=image_dir,
                image_index_start=image_index,
                context={"table_index": table_index},
                saved_images=saved_images,
            )
            raw_items.extend(image_items)

    if enable_image_ocr:
        _apply_image_ocr(raw_items, image_dir, ocr_dir, mineru_bin, ocr_lang, ocr_min_chars)

    blocks: list[dict[str, Any]] = []
    heading_stack: list[str] = []
    detected_headings: list[dict[str, Any]] = []

    for idx, item in enumerate(raw_items):
        kind = item.get("kind")
        if kind == "paragraph":
            features = item["features"]
            text = features["text"]
            explicit_level = features.get("explicit_heading_level")
            is_visual = _looks_like_visual_heading(raw_items, idx)
            if explicit_level is not None or is_visual:
                level = explicit_level or _visual_heading_level(text)
                heading_stack = _update_heading_stack(heading_stack, level, text)
                detected_headings.append(
                    {
                        "text": text,
                        "level": level,
                        "paragraph_index": features["paragraph_index"],
                        "source": "style" if explicit_level is not None else "visual",
                    }
                )
                continue

            block_type = "list_item" if features.get("is_list") else "paragraph"
            content = f"- {text}" if block_type == "list_item" else text
            display = f"paragraph {features['paragraph_index']}"
            blocks.append(
                {
                    "block_id": f"p{features['paragraph_index']}",
                    "block_index": len(blocks),
                    "block_type": block_type,
                    "content": content,
                    "heading_path": list(heading_stack),
                    "paragraph_index": features["paragraph_index"],
                    "style_name": features["style_name"],
                    "source_location": {
                        "paragraph_index": features["paragraph_index"],
                        "style_name": features["style_name"],
                        "block_type": block_type,
                        "heading_path": list(heading_stack),
                        "display_text": display,
                        "parser_features": features,
                    },
                }
            )
            continue

        if kind == "table":
            rows = item.get("rows") or []
            analysis = item.get("analysis") or {}
            if analysis.get("classification") == "empty":
                continue
            table_index_value = item["table_index"]
            display = f"table {table_index_value}"
            if analysis.get("classification") == "layout":
                content = _linearize_table_text(rows)
                if not content:
                    continue
                block_type = "layout_table_text"
                block_id = f"lt{table_index_value}"
            else:
                content = _table_to_markdown(rows)
                block_type = "table"
                block_id = f"t{table_index_value}"
            blocks.append(
                {
                    "block_id": block_id,
                    "block_index": len(blocks),
                    "block_type": block_type,
                    "content": content,
                    "heading_path": list(heading_stack),
                    "table_index": table_index_value,
                    "table_analysis": analysis,
                    "source_location": {
                        "table_index": table_index_value,
                        "block_type": block_type,
                        "heading_path": list(heading_stack),
                        "display_text": display,
                        "table_analysis": analysis,
                    },
                }
            )
            continue

        if kind == "image" and item.get("ocr_useful"):
            image_index_value = item["image_index"]
            display = f"image {image_index_value}"
            media_name = item.get("media_name") or Path(item.get("stored_image_path", "")).name
            blocks.append(
                {
                    "block_id": f"img{image_index_value}",
                    "block_index": len(blocks),
                    "block_type": "image_ocr",
                    "content": item.get("ocr_text") or "",
                    "heading_path": list(heading_stack),
                    "image_index": image_index_value,
                    "source_location": {
                        "image_index": image_index_value,
                        "paragraph_index": item.get("paragraph_index"),
                        "table_index": item.get("table_index"),
                        "relationship_id": item.get("relationship_id"),
                        "media_name": media_name,
                        "stored_image_path": item.get("stored_image_path"),
                        "occurrence_count": item.get("occurrence_count") or 1,
                        "occurrences": item.get("occurrences") or [],
                        "ocr_source_files": item.get("ocr_source_files") or [],
                        "block_type": "image_ocr",
                        "heading_path": list(heading_stack),
                        "display_text": display,
                    },
                }
            )

    return {
        "source_path": str(path),
        "source_filename": path.name,
        "checksum": sha256_file(path),
        "parser": "python-docx",
        "paragraph_count": paragraph_index,
        "table_count": table_index,
        "image_count": image_index,
        "image_ocr_enabled": bool(enable_image_ocr),
        "image_ocr_count": sum(1 for item in raw_items if item.get("kind") == "image" and item.get("ocr_useful")),
        "detected_heading_count": len(detected_headings),
        "detected_headings": detected_headings,
        "processed_dir": str(proc_dir),
        "image_dir": str(image_dir) if enable_image_ocr else "",
        "image_ocr_dir": str(ocr_dir) if enable_image_ocr else "",
        "block_count": len(blocks),
        "blocks": blocks,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Parse DOCX into ordered blocks.")
    parser.add_argument("--file", required=True, help="Path to .docx file")
    parser.add_argument("--output", required=True, help="Path to blocks.json")
    parser.add_argument("--processed-dir", default="")
    parser.add_argument("--enable-image-ocr", action="store_true")
    parser.add_argument("--mineru-bin", default=DEFAULT_MINERU_BIN)
    parser.add_argument("--ocr-lang", default="en")
    parser.add_argument("--ocr-min-chars", type=int, default=40)
    args = parser.parse_args()
    dump_json(
        parse_word_to_blocks(
            args.file,
            processed_dir=args.processed_dir or None,
            enable_image_ocr=bool(args.enable_image_ocr),
            mineru_bin=args.mineru_bin,
            ocr_lang=args.ocr_lang,
            ocr_min_chars=args.ocr_min_chars,
        ),
        args.output,
    )


if __name__ == "__main__":
    main()
