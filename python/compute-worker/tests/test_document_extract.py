import hashlib
import json
import stat
import sys
import tempfile
import unittest
import warnings
import zipfile
from pathlib import Path
from typing import Any, Dict, Iterable, Mapping


PACKAGE_ROOT = Path(__file__).resolve().parents[1]
FIXTURES = Path(__file__).resolve().parent / "fixtures"
sys.path.insert(0, str(PACKAGE_ROOT))

from compute_worker.operations import execute_request  # noqa: E402


def _request(
    input_path: Path,
    output_directory: Path,
    options: Mapping[str, Any] = {},
) -> Dict[str, Any]:
    return {
        "protocolVersion": 1,
        "requestId": "request-document",
        "jobId": "job-document",
        "operation": "extract_document",
        "inputPath": str(input_path),
        "outputDirectory": str(output_directory),
        "options": dict(options),
    }


def _records(output: Path) -> list:
    return [
        json.loads(line)
        for line in (output / "document-records.ndjson")
        .read_text(encoding="utf-8")
        .splitlines()
    ]


def _write_archive(
    destination: Path,
    members: Iterable[tuple],
    compression: int = zipfile.ZIP_DEFLATED,
) -> None:
    with zipfile.ZipFile(destination, "w", compression=compression) as archive:
        for name, value in members:
            archive.writestr(name, value)


def _docx_xml(text: str = "Alpha") -> str:
    return """<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>{}</w:t></w:r></w:p>
    <w:tbl><w:tr><w:tc><w:tcPr><w:gridSpan w:val="2"/></w:tcPr><w:p><w:r><w:t>Cell</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
  </w:body>
</w:document>""".format(text)


def _write_pptx(destination: Path) -> None:
    presentation = """<?xml version="1.0" encoding="UTF-8"?>
<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
 xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
 <p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst>
</p:presentation>"""
    relationships = """<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
 <Relationship Id="rId1"
  Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide"
  Target="slides/slide1.xml"/>
</Relationships>"""
    slide = """<?xml version="1.0" encoding="UTF-8"?>
<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
 xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
 <p:cSld><p:spTree><p:sp><p:txBody>
  <a:p><a:r><a:t>Market</a:t></a:r></a:p>
  <a:p><a:r><a:t>Growth</a:t></a:r></a:p>
 </p:txBody></p:sp></p:spTree></p:cSld>
</p:sld>"""
    _write_archive(
        destination,
        (
            ("ppt/presentation.xml", presentation),
            ("ppt/_rels/presentation.xml.rels", relationships),
            ("ppt/slides/slide1.xml", slide),
        ),
    )


class DocumentExtractionGoldenTests(unittest.TestCase):
    def test_markdown_matches_golden_records_and_integrity(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / "output"
            response = execute_request(
                _request(FIXTURES / "document_markdown.md", output)
            )

            self.assertEqual(response["status"], "completed")
            actual = (output / "document-records.ndjson").read_bytes()
            expected = (
                FIXTURES / "document_markdown.expected.ndjson"
            ).read_bytes()
            self.assertEqual(actual, expected)
            self.assertEqual(response["recordsFile"], "document-records.ndjson")
            self.assertEqual(response["metrics"]["format"], "markdown")
            self.assertEqual(response["metrics"]["recordCount"], 5)
            self.assertEqual(response["metrics"]["textRecordCount"], 4)
            artifact = response["artifacts"][0]
            self.assertEqual(artifact["mediaType"], "application/x-ndjson")
            self.assertEqual(artifact["size"], len(actual))
            self.assertEqual(
                artifact["checksum"],
                "sha256:{}".format(hashlib.sha256(actual).hexdigest()),
            )

    def test_docx_preserves_paragraph_and_table_locators(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "research.docx"
            _write_archive(source, (("word/document.xml", _docx_xml()),))
            output = root / "output"

            response = execute_request(_request(source, output))

            self.assertEqual(response["status"], "completed")
            self.assertEqual(response["metrics"]["format"], "docx")
            self.assertEqual(response["metrics"]["paragraphCount"], 1)
            self.assertEqual(response["metrics"]["tableCount"], 1)
            records = _records(output)
            self.assertEqual(records[1]["text"], "Alpha")
            self.assertEqual(
                records[1]["locator"],
                {"kind": "docx_paragraph", "paragraphNumber": 1},
            )
            self.assertEqual(records[1]["paragraphStyle"], "Heading1")
            self.assertEqual(records[2]["recordType"], "table")
            self.assertEqual(
                records[3]["locator"],
                {
                    "kind": "docx_table_cell",
                    "tableNumber": 1,
                    "rowNumber": 1,
                    "columnNumber": 1,
                    "columnSpan": 2,
                },
            )

    def test_pptx_preserves_slide_and_text_locators(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "deck.pptx"
            _write_pptx(source)
            output = root / "output"

            response = execute_request(_request(source, output))

            self.assertEqual(response["status"], "completed")
            self.assertEqual(response["metrics"]["slideCount"], 1)
            self.assertEqual(response["metrics"]["slideTextCount"], 2)
            records = _records(output)
            self.assertEqual(records[1]["recordType"], "slide")
            self.assertEqual(records[2]["text"], "Market")
            self.assertEqual(
                records[3]["locator"],
                {
                    "kind": "pptx_slide_text",
                    "slideNumber": 1,
                    "textNumber": 2,
                },
            )

    def test_csv_and_plain_text_emit_cell_and_line_locators(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            csv_source = root / "metrics.csv"
            csv_source.write_text('name,value\n"Revenue, net",42\n', encoding="utf-8")
            csv_output = root / "csv-output"
            csv_response = execute_request(_request(csv_source, csv_output))
            self.assertEqual(csv_response["status"], "completed")
            self.assertEqual(csv_response["metrics"]["rowCount"], 2)
            self.assertEqual(csv_response["metrics"]["cellCount"], 4)
            csv_records = _records(csv_output)
            self.assertEqual(csv_records[5]["text"], "Revenue, net")
            self.assertEqual(csv_records[5]["locator"]["rowNumber"], 2)

            text_source = root / "notes.txt"
            text_source.write_text("one\ntwo\n", encoding="utf-8")
            text_output = root / "text-output"
            text_response = execute_request(_request(text_source, text_output))
            self.assertEqual(text_response["status"], "completed")
            self.assertEqual(
                _records(text_output)[2]["locator"],
                {
                    "kind": "text_line",
                    "lineNumber": 2,
                    "lineStart": 2,
                    "lineEnd": 2,
                },
            )


class DocumentExtractionSecurityTests(unittest.TestCase):
    def _assert_failed_without_artifact(
        self,
        source: Path,
        output: Path,
        error_code: str,
        options: Mapping[str, Any] = {},
    ) -> Dict[str, Any]:
        response = execute_request(_request(source, output, options))
        self.assertEqual(response["status"], "failed", response)
        self.assertEqual(response["metrics"]["errorCode"], error_code)
        self.assertEqual(response["artifacts"], [])
        self.assertFalse((output / "document-records.ndjson").exists())
        return response

    def test_zip_slip_member_is_rejected_before_reading_required_part(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "unsafe.docx"
            _write_archive(
                source,
                (
                    ("word/document.xml", _docx_xml()),
                    ("word/../escape.xml", "<x/>"),
                ),
            )
            self._assert_failed_without_artifact(
                source, root / "output", "invalid_office_package"
            )

    def test_duplicate_zip_members_are_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "duplicate.docx"
            with warnings.catch_warnings():
                warnings.simplefilter("ignore", UserWarning)
                _write_archive(
                    source,
                    (
                        ("word/document.xml", _docx_xml("first")),
                        ("word/document.xml", _docx_xml("second")),
                    ),
                )
            self._assert_failed_without_artifact(
                source, root / "output", "invalid_office_package"
            )

    def test_symbolic_link_zip_member_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "symlink.docx"
            with zipfile.ZipFile(source, "w") as archive:
                archive.writestr("word/document.xml", _docx_xml())
                link = zipfile.ZipInfo("word/link.xml")
                link.create_system = 3
                link.external_attr = (stat.S_IFLNK | 0o777) << 16
                archive.writestr(link, "../outside")
            self._assert_failed_without_artifact(
                source, root / "output", "invalid_office_package"
            )

    def test_compression_ratio_limit_rejects_zip_bomb_shape(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "compressed.docx"
            _write_archive(
                source,
                (("word/document.xml", _docx_xml("A" * 100_000)),),
            )
            self._assert_failed_without_artifact(
                source,
                root / "output",
                "document_limit_exceeded",
                {"maxCompressionRatio": 2},
            )

    def test_zip_inventory_and_uncompressed_byte_limits_are_enforced(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "inventory.docx"
            _write_archive(
                source,
                (
                    ("word/document.xml", _docx_xml()),
                    ("extra.xml", "<x/>"),
                ),
            )
            self._assert_failed_without_artifact(
                source,
                root / "entry-output",
                "document_limit_exceeded",
                {"maxZipEntries": 1},
            )
            self._assert_failed_without_artifact(
                source,
                root / "bytes-output",
                "document_limit_exceeded",
                {"maxZipUncompressedBytes": 10},
            )

    def test_doctype_and_entity_declarations_are_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "entity.docx"
            xml = (
                '<!DOCTYPE x [<!ENTITY bomb "expanded">]>'
                '<w:document xmlns:w="urn:w"><w:body><w:p>'
                "<w:r><w:t>&bomb;</w:t></w:r>"
                "</w:p></w:body></w:document>"
            )
            _write_archive(source, (("word/document.xml", xml),))
            self._assert_failed_without_artifact(
                source, root / "output", "unsafe_xml"
            )

    def test_record_count_character_and_record_byte_limits_are_enforced(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "limits.txt"
            source.write_text("abcd\nefgh\n", encoding="utf-8")
            self._assert_failed_without_artifact(
                source,
                root / "records-output",
                "document_limit_exceeded",
                {"maxRecords": 1},
            )
            self._assert_failed_without_artifact(
                source,
                root / "characters-output",
                "document_limit_exceeded",
                {"maxTextChars": 3},
            )
            self._assert_failed_without_artifact(
                source,
                root / "record-characters-output",
                "document_limit_exceeded",
                {"maxTextCharsPerRecord": 3},
            )
            self._assert_failed_without_artifact(
                source,
                root / "record-bytes-output",
                "document_limit_exceeded",
                {"maxRecordBytes": 16},
            )
            self._assert_failed_without_artifact(
                source,
                root / "records-bytes-output",
                "document_limit_exceeded",
                {"maxRecordsBytes": 80},
            )

    def test_input_xml_entry_and_element_limits_are_enforced(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            text_source = root / "input.txt"
            text_source.write_text("too large", encoding="utf-8")
            self._assert_failed_without_artifact(
                text_source,
                root / "input-output",
                "document_limit_exceeded",
                {"maxInputBytes": 3},
            )

            office_source = root / "limits.docx"
            _write_archive(
                office_source,
                (("word/document.xml", _docx_xml()),),
                compression=zipfile.ZIP_STORED,
            )
            for name, options in (
                ("entry", {"maxZipEntryBytes": 10}),
                ("xml-bytes", {"maxXmlBytes": 10}),
                ("xml-elements", {"maxXmlElements": 2}),
            ):
                self._assert_failed_without_artifact(
                    office_source,
                    root / "{}-output".format(name),
                    "document_limit_exceeded",
                    options,
                )

    def test_csv_row_column_cell_and_field_limits_are_enforced(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "limits.csv"
            source.write_text("a,b\nc,toolong\n", encoding="utf-8")
            for name, options in (
                ("rows", {"maxCsvRows": 1}),
                ("columns", {"maxCsvColumns": 1}),
                ("cells", {"maxCsvCells": 3}),
                ("field", {"maxCsvCellChars": 3}),
            ):
                self._assert_failed_without_artifact(
                    source,
                    root / "{}-output".format(name),
                    "document_limit_exceeded",
                    options,
                )

    def test_non_finite_compression_limit_is_invalid(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "finite.docx"
            _write_archive(source, (("word/document.xml", _docx_xml()),))
            self._assert_failed_without_artifact(
                source,
                root / "output",
                "invalid_options",
                {"maxCompressionRatio": float("nan")},
            )

    def test_invalid_encoding_and_unsupported_format_are_structured(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            invalid_text = root / "invalid.txt"
            invalid_text.write_bytes(b"\xff\xfe")
            self._assert_failed_without_artifact(
                invalid_text, root / "text-output", "invalid_text_encoding"
            )

            unsupported = root / "legacy.doc"
            unsupported.write_bytes(b"not-a-doc")
            self._assert_failed_without_artifact(
                unsupported,
                root / "doc-output",
                "unsupported_document_format",
            )


if __name__ == "__main__":
    unittest.main()
