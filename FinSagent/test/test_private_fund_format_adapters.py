from __future__ import annotations

import sys
import tempfile
import unittest
import zipfile
from pathlib import Path


DATA_PIPELINE_DIR = Path(__file__).resolve().parents[1] / "data_pipeline"
sys.path.insert(0, str(DATA_PIPELINE_DIR))

import private_fund_format_adapters as adapters  # noqa: E402


def _write_zip(path: Path, members: dict[str, str]) -> None:
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as package:
        for member, content in members.items():
            package.writestr(member, content)


def _assert_write_chunks_compatible(test: unittest.TestCase, chunks: list[dict]) -> None:
    test.assertTrue(chunks)
    for chunk in chunks:
        test.assertIsInstance(chunk["content"], str)
        test.assertTrue(chunk["content"])
        test.assertIsInstance(chunk["content_type"], str)
        test.assertIsInstance(chunk["title_path"], list)
        test.assertIsInstance(chunk["summary"], str)
        test.assertIsInstance(chunk["source_ref"], str)
        test.assertIsInstance(chunk["metadata"], dict)
        test.assertIsInstance(chunk["locations"], list)
        test.assertTrue(chunk["locations"])
        for location in chunk["locations"]:
            test.assertIn("display_text", location)
            test.assertIsInstance(location.get("metadata", {}), dict)


class PrivateFundFormatAdaptersTest(unittest.TestCase):
    def test_text_markdown_and_markdown_suffix_keep_line_and_heading_provenance(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            text_path = root / "notes.txt"
            text_path.write_text("first line\n\nsecond line\n", encoding="utf-8")
            text_chunks = adapters.adapt_document(text_path)
            _assert_write_chunks_compatible(self, text_chunks)
            text_content = [chunk for chunk in text_chunks if chunk["content_type"] == "text_lines"]
            self.assertEqual(len(text_content), 1)
            self.assertEqual(text_content[0]["metadata"]["line_start"], 1)
            self.assertEqual(text_content[0]["metadata"]["line_end"], 3)

            markdown_path = root / "research.markdown"
            markdown_path.write_text(
                "preamble\n# Thesis\nbody\n```text\n# not a heading\n```\n## Risk\ndownside\n",
                encoding="utf-8",
            )
            markdown_chunks = adapters.adapt_document(markdown_path)
            _assert_write_chunks_compatible(self, markdown_chunks)
            sections = [chunk for chunk in markdown_chunks if chunk["content_type"] == "markdown_section"]
            paths = [chunk["title_path"] for chunk in sections]
            self.assertIn(["research", "Thesis"], paths)
            self.assertIn(["research", "Thesis", "Risk"], paths)
            self.assertFalse(any(path[-1] == "not a heading" for path in paths))
            for section in sections:
                self.assertEqual(section["metadata"]["heading_path"], section["title_path"])

    def test_csv_emits_table_row_and_cell_ranges(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "metrics.csv"
            path.write_text("metric,2024,2025E\nRevenue,100,120\nMargin,20%,22%\n", encoding="utf-8")
            chunks = adapters.adapt_document(path, max_chars=128)
            _assert_write_chunks_compatible(self, chunks)
            rows = [chunk for chunk in chunks if chunk["content_type"] == "csv_rows"]
            self.assertTrue(rows)
            self.assertEqual(rows[0]["metadata"]["table_name"], "metrics")
            self.assertEqual(rows[0]["locations"][0]["sheet_name"], "metrics")
            self.assertRegex(rows[0]["locations"][0]["cell_range"], r"^A\d+:C\d+$")
            self.assertIn("row_start", rows[0]["locations"][0]["metadata"])

    def test_docx_stdlib_parser_extracts_headings_body_and_tables(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "memo.docx"
            _write_zip(
                path,
                {
                    "word/document.xml": """<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Investment Thesis</w:t></w:r></w:p>
    <w:p><w:r><w:t>Demand remains resilient.</w:t></w:r></w:p>
    <w:tbl>
      <w:tr><w:tc><w:p><w:r><w:t>Metric</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>2025E</w:t></w:r></w:p></w:tc></w:tr>
      <w:tr><w:tc><w:p><w:r><w:t>Revenue</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>120</w:t></w:r></w:p></w:tc></w:tr>
    </w:tbl>
  </w:body>
</w:document>""",
                    "word/styles.xml": """<?xml version="1.0" encoding="UTF-8"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style>
</w:styles>""",
                },
            )
            chunks = adapters.adapt_document(path)
            _assert_write_chunks_compatible(self, chunks)
            paragraphs = [chunk for chunk in chunks if chunk["content_type"] == "docx_paragraphs"]
            tables = [chunk for chunk in chunks if chunk["content_type"] == "docx_table"]
            self.assertEqual(len(paragraphs), 1)
            self.assertIn("Demand remains resilient", paragraphs[0]["content"])
            self.assertEqual(paragraphs[0]["title_path"], ["memo", "Investment Thesis"])
            self.assertEqual(tables[0]["metadata"]["heading_path"], ["memo", "Investment Thesis", "table 1"])
            self.assertIn("Revenue", tables[0]["content"])

    def test_pptx_stdlib_parser_uses_presentation_order_and_extracts_notes(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "deck.pptx"
            presentation = """<?xml version="1.0" encoding="UTF-8"?>
<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
 xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <p:sldIdLst><p:sldId id="256" r:id="rId2"/><p:sldId id="257" r:id="rId1"/></p:sldIdLst>
</p:presentation>"""
            presentation_rels = """<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide2.xml"/>
</Relationships>"""
            slide_template = """<?xml version="1.0" encoding="UTF-8"?>
<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
 xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
 <p:cSld><p:spTree>
  <p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>{title}</a:t></a:r></a:p></p:txBody></p:sp>
  <p:sp><p:nvSpPr><p:nvPr/></p:nvSpPr><p:txBody><a:p><a:r><a:t>{body}</a:t></a:r></a:p></p:txBody></p:sp>
 </p:spTree></p:cSld>
</p:sld>"""
            slide2_rels = """<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rIdNotes" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/notesSlide1.xml"/>
</Relationships>"""
            notes = """<?xml version="1.0" encoding="UTF-8"?>
<p:notes xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
 xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
 <p:cSld><p:spTree>
  <p:sp><p:nvSpPr><p:nvPr><p:ph type="body"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>Verify source before publication.</a:t></a:r></a:p></p:txBody></p:sp>
  <p:sp><p:nvSpPr><p:nvPr><p:ph type="sldNum"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>1</a:t></a:r></a:p></p:txBody></p:sp>
 </p:spTree></p:cSld>
</p:notes>"""
            _write_zip(
                path,
                {
                    "ppt/presentation.xml": presentation,
                    "ppt/_rels/presentation.xml.rels": presentation_rels,
                    "ppt/slides/slide1.xml": slide_template.format(title="Second", body="Second body"),
                    "ppt/slides/slide2.xml": slide_template.format(title="First", body="First body"),
                    "ppt/slides/_rels/slide2.xml.rels": slide2_rels,
                    "ppt/notesSlides/notesSlide1.xml": notes,
                },
            )
            chunks = adapters.adapt_document(path)
            _assert_write_chunks_compatible(self, chunks)
            slides = [chunk for chunk in chunks if chunk["content_type"] == "pptx_slide"]
            note_chunks = [chunk for chunk in chunks if chunk["content_type"] == "pptx_notes"]
            self.assertEqual(slides[0]["metadata"]["slide_part"], "ppt/slides/slide2.xml")
            self.assertEqual(slides[0]["locations"][0]["slide_start"], 1)
            self.assertEqual(slides[0]["locations"][0]["slide_end"], 1)
            self.assertIn("First body", slides[0]["content"])
            self.assertEqual(len(note_chunks), 1)
            self.assertIn("Verify source", note_chunks[0]["content"])
            self.assertNotEqual(note_chunks[0]["content"].strip(), "1")

    def test_corrupt_ooxml_and_unsupported_suffix_fail_explicitly(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            corrupt = root / "broken.docx"
            corrupt.write_bytes(b"not a zip package")
            with self.assertRaisesRegex(adapters.FormatAdapterError, "Invalid DOCX package"):
                adapters.adapt_document(corrupt)

            unsupported = root / "legacy.xls"
            unsupported.write_bytes(b"legacy")
            with self.assertRaises(adapters.UnsupportedFormatError):
                adapters.adapt_document(unsupported)


if __name__ == "__main__":
    unittest.main()
