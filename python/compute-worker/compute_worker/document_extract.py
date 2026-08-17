"""Deterministic, dependency-free extraction for common document formats.

The extractors intentionally emit structure-preserving records rather than one
large text blob. Every text record carries a source locator suitable for
evidence citations and later human audit.
"""

import csv
import io
import json
import math
import posixpath
import re
import stat
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Iterable, Iterator, List, Mapping, Optional, Tuple
from xml.etree import ElementTree

from .artifacts import artifact_descriptor, sha256_file, write_ndjson_atomic
from .errors import ComputeOperationError
from .paths import generated_output_path


SUPPORTED_SUFFIXES = frozenset(
    (".docx", ".pptx", ".csv", ".md", ".markdown", ".txt")
)
ALLOWED_ZIP_COMPRESSION = frozenset((zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED))

DEFAULT_MAX_INPUT_BYTES = 64 * 1024 * 1024
HARD_MAX_INPUT_BYTES = 256 * 1024 * 1024
DEFAULT_MAX_RECORDS = 500_000
HARD_MAX_RECORDS = 2_000_000
DEFAULT_MAX_RECORD_BYTES = 2 * 1024 * 1024
HARD_MAX_RECORD_BYTES = 8 * 1024 * 1024
DEFAULT_MAX_RECORDS_BYTES = 256 * 1024 * 1024
HARD_MAX_RECORDS_BYTES = 1024 * 1024 * 1024
DEFAULT_MAX_TEXT_CHARS = 20_000_000
HARD_MAX_TEXT_CHARS = 100_000_000
DEFAULT_MAX_TEXT_CHARS_PER_RECORD = 1_000_000
HARD_MAX_TEXT_CHARS_PER_RECORD = 5_000_000
DEFAULT_MAX_ZIP_ENTRIES = 10_000
HARD_MAX_ZIP_ENTRIES = 50_000
DEFAULT_MAX_ZIP_ENTRY_BYTES = 32 * 1024 * 1024
HARD_MAX_ZIP_ENTRY_BYTES = 256 * 1024 * 1024
DEFAULT_MAX_ZIP_UNCOMPRESSED_BYTES = 256 * 1024 * 1024
HARD_MAX_ZIP_UNCOMPRESSED_BYTES = 1024 * 1024 * 1024
DEFAULT_MAX_COMPRESSION_RATIO = 200.0
HARD_MAX_COMPRESSION_RATIO = 1000.0
DEFAULT_MAX_XML_BYTES = 64 * 1024 * 1024
HARD_MAX_XML_BYTES = 256 * 1024 * 1024
DEFAULT_MAX_XML_ELEMENTS = 2_000_000
HARD_MAX_XML_ELEMENTS = 10_000_000
DEFAULT_MAX_CSV_ROWS = 1_000_000
HARD_MAX_CSV_ROWS = 2_000_000
DEFAULT_MAX_CSV_COLUMNS = 100_000
HARD_MAX_CSV_COLUMNS = 250_000
DEFAULT_MAX_CSV_CELLS = 5_000_000
HARD_MAX_CSV_CELLS = 20_000_000
DEFAULT_MAX_CSV_CELL_CHARS = 1_000_000
HARD_MAX_CSV_CELL_CHARS = 5_000_000

ATX_HEADING = re.compile(r"^[ \t]{0,3}(#{1,6})(?:[ \t]+|$)(.*)$")
SETEXT_HEADING = re.compile(r"^[ \t]{0,3}(=+|-+)[ \t]*$")
FENCE_START = re.compile(r"^[ \t]{0,3}(`{3,}|~{3,})")


def _positive_int_option(
    options: Mapping[str, Any],
    name: str,
    default: int,
    maximum: int,
) -> int:
    value = options.get(name, default)
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise ComputeOperationError(
            "options.{} must be a positive integer".format(name),
            "invalid_options",
        )
    if value > maximum:
        raise ComputeOperationError(
            "options.{} may not exceed {}".format(name, maximum),
            "invalid_options",
        )
    return value


def _positive_float_option(
    options: Mapping[str, Any],
    name: str,
    default: float,
    maximum: float,
) -> float:
    value = options.get(name, default)
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ComputeOperationError(
            "options.{} must be a positive number".format(name),
            "invalid_options",
        )
    converted = float(value)
    if not math.isfinite(converted) or converted <= 0 or converted > maximum:
        raise ComputeOperationError(
            "options.{} must be greater than zero and no more than {}".format(
                name, maximum
            ),
            "invalid_options",
        )
    return converted


def _single_character_option(
    options: Mapping[str, Any], name: str, default: str
) -> str:
    value = options.get(name, default)
    if not isinstance(value, str) or len(value) != 1 or value in ("\r", "\n", "\x00"):
        raise ComputeOperationError(
            "options.{} must be one non-newline character".format(name),
            "invalid_options",
        )
    return value


@dataclass(frozen=True)
class ExtractionLimits:
    max_input_bytes: int
    max_records: int
    max_record_bytes: int
    max_records_bytes: int
    max_text_chars: int
    max_text_chars_per_record: int
    max_zip_entries: int
    max_zip_entry_bytes: int
    max_zip_uncompressed_bytes: int
    max_compression_ratio: float
    max_xml_bytes: int
    max_xml_elements: int
    max_csv_rows: int
    max_csv_columns: int
    max_csv_cells: int
    max_csv_cell_chars: int
    delimiter: str
    quote_char: str

    @classmethod
    def from_options(cls, options: Mapping[str, Any]) -> "ExtractionLimits":
        delimiter = _single_character_option(options, "delimiter", ",")
        quote_char = _single_character_option(options, "quoteChar", '"')
        if delimiter == quote_char:
            raise ComputeOperationError(
                "options.delimiter and options.quoteChar must be different",
                "invalid_options",
            )
        return cls(
            max_input_bytes=_positive_int_option(
                options,
                "maxInputBytes",
                DEFAULT_MAX_INPUT_BYTES,
                HARD_MAX_INPUT_BYTES,
            ),
            max_records=_positive_int_option(
                options, "maxRecords", DEFAULT_MAX_RECORDS, HARD_MAX_RECORDS
            ),
            max_record_bytes=_positive_int_option(
                options,
                "maxRecordBytes",
                DEFAULT_MAX_RECORD_BYTES,
                HARD_MAX_RECORD_BYTES,
            ),
            max_records_bytes=_positive_int_option(
                options,
                "maxRecordsBytes",
                DEFAULT_MAX_RECORDS_BYTES,
                HARD_MAX_RECORDS_BYTES,
            ),
            max_text_chars=_positive_int_option(
                options,
                "maxTextChars",
                DEFAULT_MAX_TEXT_CHARS,
                HARD_MAX_TEXT_CHARS,
            ),
            max_text_chars_per_record=_positive_int_option(
                options,
                "maxTextCharsPerRecord",
                DEFAULT_MAX_TEXT_CHARS_PER_RECORD,
                HARD_MAX_TEXT_CHARS_PER_RECORD,
            ),
            max_zip_entries=_positive_int_option(
                options,
                "maxZipEntries",
                DEFAULT_MAX_ZIP_ENTRIES,
                HARD_MAX_ZIP_ENTRIES,
            ),
            max_zip_entry_bytes=_positive_int_option(
                options,
                "maxZipEntryBytes",
                DEFAULT_MAX_ZIP_ENTRY_BYTES,
                HARD_MAX_ZIP_ENTRY_BYTES,
            ),
            max_zip_uncompressed_bytes=_positive_int_option(
                options,
                "maxZipUncompressedBytes",
                DEFAULT_MAX_ZIP_UNCOMPRESSED_BYTES,
                HARD_MAX_ZIP_UNCOMPRESSED_BYTES,
            ),
            max_compression_ratio=_positive_float_option(
                options,
                "maxCompressionRatio",
                DEFAULT_MAX_COMPRESSION_RATIO,
                HARD_MAX_COMPRESSION_RATIO,
            ),
            max_xml_bytes=_positive_int_option(
                options,
                "maxXmlBytes",
                DEFAULT_MAX_XML_BYTES,
                HARD_MAX_XML_BYTES,
            ),
            max_xml_elements=_positive_int_option(
                options,
                "maxXmlElements",
                DEFAULT_MAX_XML_ELEMENTS,
                HARD_MAX_XML_ELEMENTS,
            ),
            max_csv_rows=_positive_int_option(
                options,
                "maxCsvRows",
                DEFAULT_MAX_CSV_ROWS,
                HARD_MAX_CSV_ROWS,
            ),
            max_csv_columns=_positive_int_option(
                options,
                "maxCsvColumns",
                DEFAULT_MAX_CSV_COLUMNS,
                HARD_MAX_CSV_COLUMNS,
            ),
            max_csv_cells=_positive_int_option(
                options,
                "maxCsvCells",
                DEFAULT_MAX_CSV_CELLS,
                HARD_MAX_CSV_CELLS,
            ),
            max_csv_cell_chars=_positive_int_option(
                options,
                "maxCsvCellChars",
                DEFAULT_MAX_CSV_CELL_CHARS,
                HARD_MAX_CSV_CELL_CHARS,
            ),
            delimiter=delimiter,
            quote_char=quote_char,
        )


class RecordEmitter:
    """Validate bounded canonical records while tracking extraction metrics."""

    def __init__(self, limits: ExtractionLimits) -> None:
        self._limits = limits
        self.record_count = 0
        self.text_record_count = 0
        self.text_chars = 0
        self.records_bytes = 0
        self.record_type_counts: Dict[str, int] = {}

    def accept(self, record: Dict[str, Any]) -> Dict[str, Any]:
        if self.record_count >= self._limits.max_records:
            raise ComputeOperationError(
                "Document exceeds options.maxRecords",
                "document_limit_exceeded",
            )

        text = record.get("text")
        if text is not None:
            if not isinstance(text, str):
                raise ComputeOperationError(
                    "Extractor produced non-string text",
                    "invalid_document",
                )
            if len(text) > self._limits.max_text_chars_per_record:
                raise ComputeOperationError(
                    "A document record exceeds options.maxTextCharsPerRecord",
                    "document_limit_exceeded",
                )
            if self.text_chars + len(text) > self._limits.max_text_chars:
                raise ComputeOperationError(
                    "Document exceeds options.maxTextChars",
                    "document_limit_exceeded",
                )

        encoded = json.dumps(
            record,
            ensure_ascii=False,
            separators=(",", ":"),
            allow_nan=False,
        ).encode("utf-8")
        if len(encoded) + 1 > self._limits.max_record_bytes:
            raise ComputeOperationError(
                "A document record exceeds options.maxRecordBytes",
                "document_limit_exceeded",
            )
        encoded_bytes = len(encoded) + 1
        if self.records_bytes + encoded_bytes > self._limits.max_records_bytes:
            raise ComputeOperationError(
                "Document records exceed options.maxRecordsBytes",
                "document_limit_exceeded",
            )

        self.record_count += 1
        self.records_bytes += encoded_bytes
        record_type = str(record.get("recordType", "unknown"))
        self.record_type_counts[record_type] = (
            self.record_type_counts.get(record_type, 0) + 1
        )
        if text is not None:
            self.text_record_count += 1
            self.text_chars += len(text)
        return record


def _local_name(tag: Any) -> str:
    value = str(tag)
    return value.rsplit("}", 1)[-1] if "}" in value else value


def _first_descendant(
    element: ElementTree.Element, name: str
) -> Optional[ElementTree.Element]:
    for candidate in element.iter():
        if _local_name(candidate.tag) == name:
            return candidate
    return None


def _attribute_by_local_name(
    element: ElementTree.Element, name: str
) -> Optional[str]:
    for key, value in element.attrib.items():
        if _local_name(key) == name:
            return value
    return None


def _relationship_identifier(element: ElementTree.Element) -> Optional[str]:
    for key, value in element.attrib.items():
        if (
            _local_name(key) == "id"
            and "relationships" in str(key).lower()
        ):
            return value
    return None


def _element_text(element: ElementTree.Element) -> str:
    pieces: List[str] = []
    for candidate in element.iter():
        name = _local_name(candidate.tag)
        if name in ("t", "instrText", "delText"):
            pieces.append(candidate.text or "")
        elif name == "tab":
            pieces.append("\t")
        elif name in ("br", "cr"):
            pieces.append("\n")
        elif name == "noBreakHyphen":
            pieces.append("\u2011")
        elif name == "softHyphen":
            pieces.append("\u00ad")
    return "".join(pieces)


def _iter_descendants_before_nested(
    element: ElementTree.Element,
    wanted_name: str,
    stop_names: Tuple[str, ...],
) -> Iterator[ElementTree.Element]:
    pending = list(reversed(list(element)))
    while pending:
        child = pending.pop()
        name = _local_name(child.tag)
        if name == wanted_name:
            yield child
            continue
        if name in stop_names:
            continue
        pending.extend(reversed(list(child)))


class SafeOfficeArchive:
    """Read selected OOXML parts after validating the whole ZIP inventory."""

    def __init__(self, path: Path, limits: ExtractionLimits) -> None:
        self._path = path
        self._limits = limits
        self._archive: Optional[zipfile.ZipFile] = None
        self.entries: Dict[str, zipfile.ZipInfo] = {}
        self.entry_count = 0
        self.uncompressed_bytes = 0
        self.xml_bytes_read = 0
        self.xml_element_count = 0

    def __enter__(self) -> "SafeOfficeArchive":
        try:
            self._archive = zipfile.ZipFile(str(self._path), mode="r")
            self._validate_inventory()
        except ComputeOperationError:
            self.close()
            raise
        except (OSError, RuntimeError, zipfile.BadZipFile) as exc:
            self.close()
            raise ComputeOperationError(
                "Office document is not a valid OOXML ZIP package: {}".format(
                    exc
                ),
                "invalid_office_package",
            ) from exc
        return self

    def __exit__(self, _exc_type: Any, _exc: Any, _traceback: Any) -> None:
        self.close()

    def close(self) -> None:
        if self._archive is not None:
            self._archive.close()
            self._archive = None

    def _validate_inventory(self) -> None:
        if self._archive is None:
            raise AssertionError("archive is not open")
        infos = self._archive.infolist()
        if len(infos) > self._limits.max_zip_entries:
            raise ComputeOperationError(
                "Office package exceeds options.maxZipEntries",
                "document_limit_exceeded",
            )

        total_uncompressed = 0
        entries: Dict[str, zipfile.ZipInfo] = {}
        for info in infos:
            name = info.filename
            path_parts = name.split("/")
            is_directory = info.is_dir()
            if (
                not name
                or name.startswith("/")
                or "\\" in name
                or "\x00" in name
                or any(part in ("", ".", "..") for part in path_parts[:-1])
                or path_parts[-1] in (".", "..")
                or (path_parts[-1] == "" and not is_directory)
                or (path_parts and path_parts[0].endswith(":"))
            ):
                raise ComputeOperationError(
                    "Office package contains an unsafe member path",
                    "invalid_office_package",
                )
            if name in entries:
                raise ComputeOperationError(
                    "Office package contains duplicate member names",
                    "invalid_office_package",
                )
            if info.flag_bits & 0x1:
                raise ComputeOperationError(
                    "Encrypted OOXML members are not supported",
                    "invalid_office_package",
                )
            unix_mode = (info.external_attr >> 16) & 0xFFFF
            if stat.S_IFMT(unix_mode) == stat.S_IFLNK:
                raise ComputeOperationError(
                    "Office package may not contain symbolic links",
                    "invalid_office_package",
                )
            if info.compress_type not in ALLOWED_ZIP_COMPRESSION:
                raise ComputeOperationError(
                    "Office package uses an unsupported compression method",
                    "invalid_office_package",
                )
            if info.file_size > self._limits.max_zip_entry_bytes:
                raise ComputeOperationError(
                    "Office package member exceeds options.maxZipEntryBytes",
                    "document_limit_exceeded",
                )
            total_uncompressed += info.file_size
            if total_uncompressed > self._limits.max_zip_uncompressed_bytes:
                raise ComputeOperationError(
                    "Office package exceeds options.maxZipUncompressedBytes",
                    "document_limit_exceeded",
                )
            if (
                info.file_size > 0
                and info.file_size / max(info.compress_size, 1)
                > self._limits.max_compression_ratio
            ):
                raise ComputeOperationError(
                    "Office package member exceeds options.maxCompressionRatio",
                    "document_limit_exceeded",
                )
            entries[name] = info

        self.entries = entries
        self.entry_count = len(entries)
        self.uncompressed_bytes = total_uncompressed

    def parse_xml(self, name: str) -> ElementTree.Element:
        info = self.entries.get(name)
        if info is None or info.is_dir():
            raise ComputeOperationError(
                "Office package is missing required part {}".format(name),
                "invalid_office_package",
            )
        if info.file_size > self._limits.max_xml_bytes - self.xml_bytes_read:
            raise ComputeOperationError(
                "Office package exceeds options.maxXmlBytes",
                "document_limit_exceeded",
            )
        if self._archive is None:
            raise AssertionError("archive is not open")

        chunks: List[bytes] = []
        byte_count = 0
        try:
            with self._archive.open(info, mode="r") as stream:
                while True:
                    chunk = stream.read(64 * 1024)
                    if not chunk:
                        break
                    byte_count += len(chunk)
                    if (
                        byte_count > info.file_size
                        or byte_count > self._limits.max_zip_entry_bytes
                        or self.xml_bytes_read + byte_count
                        > self._limits.max_xml_bytes
                    ):
                        raise ComputeOperationError(
                            "Office XML exceeds configured extraction limits",
                            "document_limit_exceeded",
                        )
                    chunks.append(chunk)
        except ComputeOperationError:
            raise
        except Exception as exc:
            raise ComputeOperationError(
                "Office XML part could not be read: {}".format(name),
                "invalid_office_package",
            ) from exc

        data = b"".join(chunks)
        if len(data) != info.file_size:
            raise ComputeOperationError(
                "Office XML member size does not match its ZIP metadata",
                "invalid_office_package",
            )
        lowered = data.lower()
        if b"\x00" in data or b"<!doctype" in lowered or b"<!entity" in lowered:
            raise ComputeOperationError(
                "Office XML declarations and entities are not allowed",
                "unsafe_xml",
            )
        try:
            root = ElementTree.fromstring(data)
        except ElementTree.ParseError as exc:
            raise ComputeOperationError(
                "Office XML part is malformed: {}".format(name),
                "invalid_office_package",
            ) from exc

        element_count = sum(1 for _element in root.iter())
        if (
            self.xml_element_count + element_count
            > self._limits.max_xml_elements
        ):
            raise ComputeOperationError(
                "Office XML exceeds options.maxXmlElements",
                "document_limit_exceeded",
            )
        self.xml_bytes_read += byte_count
        self.xml_element_count += element_count
        return root


def _document_header(source_name: str, document_format: str) -> Dict[str, Any]:
    return {
        "recordType": "document",
        "format": document_format,
        "sourceName": source_name,
    }


def _iter_body_blocks(
    element: ElementTree.Element,
) -> Iterator[ElementTree.Element]:
    pending = list(reversed(list(element)))
    while pending:
        child = pending.pop()
        name = _local_name(child.tag)
        if name in ("p", "tbl"):
            yield child
        else:
            pending.extend(reversed(list(child)))


def _paragraph_style(paragraph: ElementTree.Element) -> Optional[str]:
    for candidate in paragraph.iter():
        if _local_name(candidate.tag) == "pStyle":
            return _attribute_by_local_name(candidate, "val")
    return None


def _table_cell_text(cell: ElementTree.Element) -> str:
    paragraphs = list(
        _iter_descendants_before_nested(cell, "p", ("tbl", "tc"))
    )
    return "\n".join(_element_text(paragraph) for paragraph in paragraphs)


def _table_column_span(cell: ElementTree.Element) -> int:
    for candidate in cell.iter():
        if _local_name(candidate.tag) != "gridSpan":
            continue
        raw = _attribute_by_local_name(candidate, "val")
        try:
            value = int(raw or "1")
        except ValueError:
            return 1
        return max(1, value)
    return 1


def _docx_records(
    input_path: Path,
    limits: ExtractionLimits,
    format_metrics: Dict[str, Any],
) -> Iterable[Dict[str, Any]]:
    with SafeOfficeArchive(input_path, limits) as archive:
        document = archive.parse_xml("word/document.xml")
        body = _first_descendant(document, "body")
        if body is None:
            raise ComputeOperationError(
                "DOCX document.xml does not contain a body",
                "invalid_office_package",
            )

        paragraph_count = 0
        table_count = 0
        table_cell_count = 0
        yield _document_header(input_path.name, "docx")
        for block in _iter_body_blocks(body):
            block_name = _local_name(block.tag)
            if block_name == "p":
                paragraph_count += 1
                style_name = _paragraph_style(block)
                record: Dict[str, Any] = {
                    "recordType": "text",
                    "text": _element_text(block),
                    "locator": {
                        "kind": "docx_paragraph",
                        "paragraphNumber": paragraph_count,
                    },
                }
                if style_name:
                    record["paragraphStyle"] = style_name
                yield record
                continue

            table_count += 1
            rows = list(
                _iter_descendants_before_nested(block, "tr", ("tbl",))
            )
            yield {
                "recordType": "table",
                "rowCount": len(rows),
                "locator": {
                    "kind": "docx_table",
                    "tableNumber": table_count,
                },
            }
            for row_number, row in enumerate(rows, start=1):
                cells = list(
                    _iter_descendants_before_nested(
                        row, "tc", ("tr", "tbl")
                    )
                )
                for column_number, cell in enumerate(cells, start=1):
                    table_cell_count += 1
                    yield {
                        "recordType": "text",
                        "text": _table_cell_text(cell),
                        "locator": {
                            "kind": "docx_table_cell",
                            "tableNumber": table_count,
                            "rowNumber": row_number,
                            "columnNumber": column_number,
                            "columnSpan": _table_column_span(cell),
                        },
                    }

        format_metrics.update(
            {
                "paragraphCount": paragraph_count,
                "tableCount": table_count,
                "tableCellCount": table_cell_count,
                "archiveEntryCount": archive.entry_count,
                "archiveUncompressedBytes": archive.uncompressed_bytes,
                "xmlBytesRead": archive.xml_bytes_read,
                "xmlElementCount": archive.xml_element_count,
            }
        )


def _relationship_target(source_part: str, raw_target: str) -> str:
    if (
        not raw_target
        or "\\" in raw_target
        or "\x00" in raw_target
        or "?" in raw_target
        or "#" in raw_target
    ):
        raise ComputeOperationError(
            "Presentation relationship contains an unsafe target",
            "invalid_office_package",
        )
    if raw_target.startswith("/"):
        normalized = posixpath.normpath(raw_target.lstrip("/"))
    else:
        normalized = posixpath.normpath(
            posixpath.join(posixpath.dirname(source_part), raw_target)
        )
    if (
        normalized in ("", ".", "..")
        or normalized.startswith("../")
        or normalized.startswith("/")
        or ":" in normalized.split("/", 1)[0]
    ):
        raise ComputeOperationError(
            "Presentation relationship escapes the package",
            "invalid_office_package",
        )
    return normalized


def _presentation_slide_parts(
    archive: SafeOfficeArchive,
) -> List[str]:
    presentation = archive.parse_xml("ppt/presentation.xml")
    relationships = archive.parse_xml(
        "ppt/_rels/presentation.xml.rels"
    )
    targets_by_id: Dict[str, str] = {}
    for relationship in relationships.iter():
        if _local_name(relationship.tag) != "Relationship":
            continue
        relationship_id = relationship.attrib.get("Id")
        target = relationship.attrib.get("Target")
        target_mode = relationship.attrib.get("TargetMode")
        relationship_type = relationship.attrib.get("Type", "")
        if not relationship_id or not target:
            continue
        if str(target_mode or "").lower() == "external":
            continue
        if not relationship_type.lower().endswith("/slide"):
            continue
        if relationship_id in targets_by_id:
            raise ComputeOperationError(
                "Presentation relationship identifiers must be unique",
                "invalid_office_package",
            )
        targets_by_id[relationship_id] = _relationship_target(
            "ppt/presentation.xml", target
        )

    slide_parts: List[str] = []
    seen_parts = set()
    for slide_identifier in presentation.iter():
        if _local_name(slide_identifier.tag) != "sldId":
            continue
        relationship_id = _relationship_identifier(slide_identifier)
        target = targets_by_id.get(relationship_id or "")
        if target is None or target not in archive.entries:
            raise ComputeOperationError(
                "Presentation slide relationship is missing or invalid",
                "invalid_office_package",
            )
        if target in seen_parts:
            raise ComputeOperationError(
                "Presentation references the same slide more than once",
                "invalid_office_package",
            )
        seen_parts.add(target)
        slide_parts.append(target)
    return slide_parts


def _pptx_records(
    input_path: Path,
    limits: ExtractionLimits,
    format_metrics: Dict[str, Any],
) -> Iterable[Dict[str, Any]]:
    with SafeOfficeArchive(input_path, limits) as archive:
        slide_parts = _presentation_slide_parts(archive)
        text_block_count = 0
        yield _document_header(input_path.name, "pptx")
        for slide_number, slide_part in enumerate(slide_parts, start=1):
            slide = archive.parse_xml(slide_part)
            paragraphs = [
                candidate
                for candidate in slide.iter()
                if _local_name(candidate.tag) == "p"
            ]
            nonempty_paragraphs = [
                (paragraph, _element_text(paragraph))
                for paragraph in paragraphs
            ]
            nonempty_paragraphs = [
                item for item in nonempty_paragraphs if item[1] != ""
            ]
            yield {
                "recordType": "slide",
                "textBlockCount": len(nonempty_paragraphs),
                "locator": {
                    "kind": "pptx_slide",
                    "slideNumber": slide_number,
                    "part": slide_part,
                },
            }
            for slide_text_number, (_paragraph, text) in enumerate(
                nonempty_paragraphs, start=1
            ):
                text_block_count += 1
                yield {
                    "recordType": "text",
                    "text": text,
                    "locator": {
                        "kind": "pptx_slide_text",
                        "slideNumber": slide_number,
                        "textNumber": slide_text_number,
                    },
                }

        format_metrics.update(
            {
                "slideCount": len(slide_parts),
                "slideTextCount": text_block_count,
                "archiveEntryCount": archive.entry_count,
                "archiveUncompressedBytes": archive.uncompressed_bytes,
                "xmlBytesRead": archive.xml_bytes_read,
                "xmlElementCount": archive.xml_element_count,
            }
        )


def _read_bounded_bytes(input_path: Path, maximum: int) -> bytes:
    chunks: List[bytes] = []
    byte_count = 0
    with input_path.open("rb") as stream:
        while True:
            chunk = stream.read(64 * 1024)
            if not chunk:
                break
            byte_count += len(chunk)
            if byte_count > maximum:
                raise ComputeOperationError(
                    "Document exceeds options.maxInputBytes",
                    "document_limit_exceeded",
                )
            chunks.append(chunk)
    return b"".join(chunks)


def _decode_utf8_document(data: bytes) -> str:
    try:
        text = data.decode("utf-8-sig", errors="strict")
    except UnicodeDecodeError as exc:
        raise ComputeOperationError(
            "Text document must be valid UTF-8",
            "invalid_text_encoding",
        ) from exc
    if "\x00" in text:
        raise ComputeOperationError(
            "Text document contains NUL characters",
            "invalid_text_document",
        )
    return text


def _csv_records(
    input_path: Path,
    limits: ExtractionLimits,
    format_metrics: Dict[str, Any],
) -> Iterable[Dict[str, Any]]:
    text = _decode_utf8_document(
        _read_bounded_bytes(input_path, limits.max_input_bytes)
    )
    row_count = 0
    cell_count = 0
    yield _document_header(input_path.name, "csv")

    previous_field_limit = csv.field_size_limit()
    csv.field_size_limit(limits.max_csv_cell_chars)
    try:
        reader = csv.reader(
            io.StringIO(text, newline=""),
            delimiter=limits.delimiter,
            quotechar=limits.quote_char,
            strict=True,
        )
        prior_line_number = 0
        for row in reader:
            row_count += 1
            if row_count > limits.max_csv_rows:
                raise ComputeOperationError(
                    "CSV exceeds options.maxCsvRows",
                    "document_limit_exceeded",
                )
            if len(row) > limits.max_csv_columns:
                raise ComputeOperationError(
                    "CSV row exceeds options.maxCsvColumns",
                    "document_limit_exceeded",
                )
            if cell_count + len(row) > limits.max_csv_cells:
                raise ComputeOperationError(
                    "CSV exceeds options.maxCsvCells",
                    "document_limit_exceeded",
                )
            line_start = prior_line_number + 1
            line_end = max(line_start, reader.line_num)
            prior_line_number = reader.line_num
            yield {
                "recordType": "row",
                "cellCount": len(row),
                "locator": {
                    "kind": "csv_row",
                    "rowNumber": row_count,
                    "lineStart": line_start,
                    "lineEnd": line_end,
                },
            }
            for column_number, value in enumerate(row, start=1):
                if len(value) > limits.max_csv_cell_chars:
                    raise ComputeOperationError(
                        "CSV cell exceeds options.maxCsvCellChars",
                        "document_limit_exceeded",
                    )
                cell_count += 1
                yield {
                    "recordType": "text",
                    "text": value,
                    "locator": {
                        "kind": "csv_cell",
                        "rowNumber": row_count,
                        "columnNumber": column_number,
                        "lineStart": line_start,
                        "lineEnd": line_end,
                    },
                }
    except UnicodeError as exc:
        raise ComputeOperationError(
            "CSV contains invalid text",
            "invalid_text_encoding",
        ) from exc
    except csv.Error as exc:
        message = str(exc)
        if "field larger than field limit" in message.lower():
            raise ComputeOperationError(
                "CSV cell exceeds options.maxCsvCellChars",
                "document_limit_exceeded",
            ) from exc
        raise ComputeOperationError(
            "CSV could not be parsed: {}".format(message),
            "invalid_csv",
        ) from exc
    finally:
        csv.field_size_limit(previous_field_limit)

    format_metrics.update(
        {
            "rowCount": row_count,
            "cellCount": cell_count,
            "delimiter": limits.delimiter,
        }
    )


def _atx_heading(line: str) -> Optional[Tuple[int, str]]:
    match = ATX_HEADING.match(line)
    if match is None:
        return None
    text = re.sub(r"[ \t]+#+[ \t]*$", "", match.group(2)).strip()
    return len(match.group(1)), text


def _setext_heading(
    lines: List[str], index: int
) -> Optional[Tuple[int, str]]:
    if index + 1 >= len(lines) or not lines[index].strip():
        return None
    underline = SETEXT_HEADING.match(lines[index + 1])
    if underline is None:
        return None
    level = 1 if underline.group(1).startswith("=") else 2
    return level, lines[index].strip()


def _fence_marker(line: str) -> Optional[Tuple[str, int]]:
    match = FENCE_START.match(line)
    if match is None:
        return None
    token = match.group(1)
    return token[0], len(token)


def _is_fence_close(line: str, marker: Tuple[str, int]) -> bool:
    stripped = line.lstrip(" \t")
    if len(line) - len(stripped) > 3:
        return False
    character, minimum_length = marker
    count = 0
    for candidate in stripped:
        if candidate != character:
            break
        count += 1
    return count >= minimum_length and stripped[count:].strip() == ""


def _markdown_records(
    input_path: Path,
    limits: ExtractionLimits,
    format_metrics: Dict[str, Any],
) -> Iterable[Dict[str, Any]]:
    text = _decode_utf8_document(
        _read_bounded_bytes(input_path, limits.max_input_bytes)
    )
    lines = text.splitlines()
    heading_count = 0
    block_count = 0
    heading_path: List[str] = []
    yield _document_header(input_path.name, "markdown")

    index = 0
    while index < len(lines):
        if not lines[index].strip():
            index += 1
            continue

        heading = _atx_heading(lines[index])
        consumed_lines = 1
        if heading is None:
            heading = _setext_heading(lines, index)
            if heading is not None:
                consumed_lines = 2
        if heading is not None:
            heading_count += 1
            level, heading_text = heading
            heading_path = heading_path[: level - 1]
            while len(heading_path) < level - 1:
                heading_path.append("")
            heading_path.append(heading_text)
            yield {
                "recordType": "text",
                "text": heading_text,
                "locator": {
                    "kind": "text_heading",
                    "headingNumber": heading_count,
                    "level": level,
                    "lineStart": index + 1,
                    "lineEnd": index + consumed_lines,
                },
                "headingPath": list(heading_path),
            }
            index += consumed_lines
            continue

        block_start = index
        block_lines: List[str] = []
        active_fence: Optional[Tuple[str, int]] = None
        while index < len(lines):
            line = lines[index]
            if active_fence is not None:
                block_lines.append(line)
                if _is_fence_close(line, active_fence):
                    active_fence = None
                index += 1
                continue
            if not line.strip():
                break
            if index > block_start and (
                _atx_heading(line) is not None
                or _setext_heading(lines, index) is not None
            ):
                break
            marker = _fence_marker(line)
            if marker is not None:
                active_fence = marker
            block_lines.append(line)
            index += 1

        block_count += 1
        yield {
            "recordType": "text",
            "text": "\n".join(block_lines),
            "locator": {
                "kind": "text_block",
                "blockNumber": block_count,
                "lineStart": block_start + 1,
                "lineEnd": block_start + len(block_lines),
            },
            "headingPath": [value for value in heading_path if value],
        }

    format_metrics.update(
        {
            "lineCount": len(lines),
            "headingCount": heading_count,
            "blockCount": block_count,
        }
    )


def _plain_text_records(
    input_path: Path,
    limits: ExtractionLimits,
    format_metrics: Dict[str, Any],
) -> Iterable[Dict[str, Any]]:
    text = _decode_utf8_document(
        _read_bounded_bytes(input_path, limits.max_input_bytes)
    )
    lines = text.splitlines()
    yield _document_header(input_path.name, "text")
    for line_number, line in enumerate(lines, start=1):
        yield {
            "recordType": "text",
            "text": line,
            "locator": {
                "kind": "text_line",
                "lineNumber": line_number,
                "lineStart": line_number,
                "lineEnd": line_number,
            },
        }
    format_metrics.update({"lineCount": len(lines)})


def extract_document(
    input_path: Path,
    output_directory: Path,
    options: Mapping[str, Any],
) -> Tuple[str, List[Dict[str, Any]], Dict[str, Any]]:
    """Extract a common document into bounded, deterministic NDJSON records."""

    suffix = input_path.suffix.lower()
    if suffix not in SUPPORTED_SUFFIXES:
        raise ComputeOperationError(
            "extract_document supports docx, pptx, csv, md, markdown, and txt files",
            "unsupported_document_format",
        )
    limits = ExtractionLimits.from_options(options)
    input_size = input_path.stat().st_size
    if input_size > limits.max_input_bytes:
        raise ComputeOperationError(
            "Document exceeds options.maxInputBytes",
            "document_limit_exceeded",
        )

    document_format = {
        ".docx": "docx",
        ".pptx": "pptx",
        ".csv": "csv",
        ".md": "markdown",
        ".markdown": "markdown",
        ".txt": "text",
    }[suffix]
    format_metrics: Dict[str, Any] = {}
    emitter = RecordEmitter(limits)

    if suffix == ".docx":
        raw_records = _docx_records(input_path, limits, format_metrics)
    elif suffix == ".pptx":
        raw_records = _pptx_records(input_path, limits, format_metrics)
    elif suffix == ".csv":
        raw_records = _csv_records(input_path, limits, format_metrics)
    elif suffix in (".md", ".markdown"):
        raw_records = _markdown_records(input_path, limits, format_metrics)
    else:
        raw_records = _plain_text_records(input_path, limits, format_metrics)

    records_path = generated_output_path(
        output_directory, "document-records.ndjson"
    )
    record_count, byte_size = write_ndjson_atomic(
        (emitter.accept(record) for record in raw_records),
        records_path,
    )
    if (
        record_count != emitter.record_count
        or byte_size != emitter.records_bytes
    ):
        raise ComputeOperationError(
            "Document record count validation failed",
            "compute_failed",
        )

    artifact = artifact_descriptor(
        records_path, output_directory, "application/x-ndjson"
    )
    metrics: Dict[str, Any] = {
        "inputChecksum": sha256_file(input_path),
        "inputBytes": input_size,
        "format": document_format,
        "recordCount": record_count,
        "textRecordCount": emitter.text_record_count,
        "textChars": emitter.text_chars,
        "recordsBytes": byte_size,
        "recordTypeCounts": dict(sorted(emitter.record_type_counts.items())),
    }
    metrics.update(format_metrics)
    return records_path.name, [artifact], metrics
