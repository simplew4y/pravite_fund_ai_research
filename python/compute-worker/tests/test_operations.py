import hashlib
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


PACKAGE_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PACKAGE_ROOT))

from compute_worker.operations import (  # noqa: E402
    DependencyUnavailableError,
    execute_request,
)


def request_for(
    operation: str, input_path: Path, output_directory: Path, **options: object
) -> dict:
    return {
        "protocolVersion": 1,
        "requestId": "request-1",
        "jobId": "job-1",
        "operation": operation,
        "inputPath": str(input_path),
        "outputDirectory": str(output_directory),
        "options": options,
    }


class FakeRect:
    width = 612.0
    height = 792.0


class FakePage:
    rect = FakeRect()
    rotation = 0

    def __init__(self, number: int) -> None:
        self.number = number

    def get_text(self, mode: str, sort: bool = False):
        self.assert_sort(sort)
        if mode == "text":
            return "Page {} text\n".format(self.number + 1)
        if mode == "blocks":
            return [
                (
                    10.0,
                    20.0,
                    200.0,
                    40.0,
                    "Page {} text".format(self.number + 1),
                    0,
                    0,
                )
            ]
        raise AssertionError("unexpected text mode")

    @staticmethod
    def assert_sort(sort: bool) -> None:
        if not sort:
            raise AssertionError("reading-order extraction must request sort=True")


class FakePdfDocument:
    page_count = 2
    needs_pass = False

    def __init__(self) -> None:
        self.closed = False

    def load_page(self, index: int) -> FakePage:
        return FakePage(index)

    def close(self) -> None:
        self.closed = True


class FakeFitz:
    def __init__(self) -> None:
        self.document = FakePdfDocument()

    def open(self, _path: str) -> FakePdfDocument:
        return self.document


class FakeCell:
    def __init__(
        self,
        coordinate: str,
        row: int,
        column: int,
        value: object,
        data_type: str,
        number_format: str = "General",
    ) -> None:
        self.coordinate = coordinate
        self.row = row
        self.column = column
        self.value = value
        self.data_type = data_type
        self.number_format = number_format


class FakeSheet:
    max_row = 1
    max_column = 2

    def __init__(self, cells: list) -> None:
        self.cells = cells
        self.by_coordinate = {cell.coordinate: cell for cell in cells}

    def iter_rows(self):
        return [tuple(self.cells)]

    def __getitem__(self, coordinate: str) -> FakeCell:
        return self.by_coordinate[coordinate]


class FakeWorkbook:
    sheetnames = ["Model"]

    def __init__(self, data_only: bool) -> None:
        formula_value = 42 if data_only else "=SUM(A1)"
        formula_type = "n" if data_only else "f"
        self.sheet = FakeSheet(
            [
                FakeCell("A1", 1, 1, 21, "n", "0"),
                FakeCell("B1", 1, 2, formula_value, formula_type, "0.00"),
            ]
        )
        self.closed = False

    def __getitem__(self, name: str) -> FakeSheet:
        if name != "Model":
            raise KeyError(name)
        return self.sheet

    def close(self) -> None:
        self.closed = True


class FakeOpenpyxl:
    def __init__(self) -> None:
        self.workbooks = []

    def load_workbook(self, *, filename: str, data_only: bool, **_options):
        workbook = FakeWorkbook(data_only)
        self.workbooks.append(workbook)
        return workbook


class OperationTests(unittest.TestCase):
    def test_pdf_extraction_writes_atomic_records_and_checksum(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "source.pdf"
            source.write_bytes(b"%PDF-fake")
            output = root / "output"
            fake_fitz = FakeFitz()

            with patch(
                "compute_worker.operations._load_fitz", return_value=fake_fitz
            ):
                response = execute_request(
                    request_for("extract_pdf", source, output)
                )

            self.assertEqual(response["status"], "completed", response)
            self.assertTrue(fake_fitz.document.closed)
            self.assertEqual(response["recordsFile"], "pdf-records.ndjson")
            self.assertEqual(response["metrics"]["pageCount"], 2)
            self.assertEqual(response["metrics"]["recordCount"], 2)
            artifact = response["artifacts"][0]
            records_path = output / artifact["path"]
            records = [
                json.loads(line)
                for line in records_path.read_text(encoding="utf-8").splitlines()
            ]
            self.assertEqual(records[0]["recordType"], "pdf_page")
            self.assertEqual(records[0]["pageNumber"], 1)
            self.assertEqual(records[0]["blocks"][0]["bbox"], [10.0, 20.0, 200.0, 40.0])
            expected_hash = hashlib.sha256(records_path.read_bytes()).hexdigest()
            self.assertEqual(artifact["checksum"], "sha256:" + expected_hash)
            self.assertEqual(artifact["size"], records_path.stat().st_size)
            self.assertEqual(list(output.glob(".compute-*")), [])

    def test_workbook_extraction_preserves_formula_and_cached_value(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "model.xlsx"
            source.write_bytes(b"fake-xlsx")
            output = root / "output"
            fake_openpyxl = FakeOpenpyxl()

            with patch(
                "compute_worker.operations._load_openpyxl",
                return_value=fake_openpyxl,
            ):
                response = execute_request(
                    request_for("extract_workbook", source, output)
                )

            self.assertEqual(response["status"], "completed", response)
            self.assertEqual(response["metrics"]["sheetCount"], 1)
            self.assertEqual(response["metrics"]["cellCount"], 2)
            self.assertTrue(all(workbook.closed for workbook in fake_openpyxl.workbooks))
            records = [
                json.loads(line)
                for line in (output / "workbook-records.ndjson")
                .read_text(encoding="utf-8")
                .splitlines()
            ]
            formula = next(
                record
                for record in records
                if record.get("recordType") == "cell"
                and record.get("coordinate") == "B1"
            )
            self.assertEqual(formula["formula"], "=SUM(A1)")
            self.assertEqual(formula["cachedValue"], 42)
            self.assertEqual(formula["numberFormat"], "0.00")

    def test_relative_paths_are_rejected_without_creating_artifacts(self) -> None:
        response = execute_request(
            {
                "protocolVersion": 1,
                "requestId": "request-relative",
                "jobId": "job-relative",
                "operation": "extract_pdf",
                "inputPath": "relative.pdf",
                "outputDirectory": "output",
                "options": {},
            }
        )
        self.assertEqual(response["status"], "failed")
        self.assertEqual(response["metrics"]["errorCode"], "invalid_path")
        self.assertIn("absolute", response["error"])

    def test_missing_dependency_is_explicit(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "source.pdf"
            source.write_bytes(b"%PDF-fake")
            with patch(
                "compute_worker.operations._load_fitz",
                side_effect=DependencyUnavailableError(
                    "extract_pdf requires PyMuPDF"
                ),
            ):
                response = execute_request(
                    request_for("extract_pdf", source, root / "out")
                )
        self.assertEqual(response["status"], "failed")
        self.assertEqual(
            response["metrics"]["errorCode"], "dependency_unavailable"
        )
        self.assertIn("PyMuPDF", response["error"])


if __name__ == "__main__":
    unittest.main()
