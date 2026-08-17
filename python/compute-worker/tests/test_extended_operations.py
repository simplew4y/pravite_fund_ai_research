import hashlib
import json
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch


PACKAGE_ROOT = Path(__file__).resolve().parents[1]
FIXTURES = Path(__file__).resolve().parent / "fixtures"
sys.path.insert(0, str(PACKAGE_ROOT))

from compute_worker.errors import DependencyUnavailableError  # noqa: E402
from compute_worker.operations import execute_request  # noqa: E402


def request_for(
    operation: str, input_path: Path, output_directory: Path, **options: object
) -> dict:
    return {
        "protocolVersion": 1,
        "requestId": "request-extended",
        "jobId": "job-extended",
        "operation": operation,
        "inputPath": str(input_path),
        "outputDirectory": str(output_directory),
        "options": options,
    }


def minimal_png(width: int, height: int) -> bytes:
    return (
        b"\x89PNG\r\n\x1a\n"
        + (13).to_bytes(4, "big")
        + b"IHDR"
        + width.to_bytes(4, "big")
        + height.to_bytes(4, "big")
    )


class FakePixmap:
    def tobytes(self, output: str) -> bytes:
        if output != "png":
            raise AssertionError(output)
        return minimal_png(1224, 1584)


class FakeRenderPage:
    rotation = 0

    class Rect:
        width = 612
        height = 792

    rect = Rect()

    def get_pixmap(self, *, matrix, alpha: bool):
        if matrix != (2.0, 2.0) or alpha:
            raise AssertionError("unexpected render options")
        return FakePixmap()


class FakeRenderDocument:
    page_count = 2
    needs_pass = False
    is_pdf = True

    def __init__(self) -> None:
        self.closed = False

    def load_page(self, index: int) -> FakeRenderPage:
        if index != 0:
            raise AssertionError(index)
        return FakeRenderPage()

    def close(self) -> None:
        self.closed = True


class FakeRenderFitz:
    def __init__(self) -> None:
        self.document = FakeRenderDocument()

    def open(self, _path: str) -> FakeRenderDocument:
        return self.document

    @staticmethod
    def Matrix(x: float, y: float):
        return (x, y)


class FakeDeriveCell:
    def __init__(self, value=None) -> None:
        self.value = value
        self.number_format = "General"


class FakeDeriveSheet:
    def __init__(self) -> None:
        self.cells = {
            "A1": FakeDeriveCell(10),
            "B2": FakeDeriveCell(None),
        }

    def __getitem__(self, coordinate: str) -> FakeDeriveCell:
        return self.cells.setdefault(coordinate, FakeDeriveCell())


class FakeCalculation:
    fullCalcOnLoad = False
    forceFullCalc = False
    calcMode = "manual"


class FakeDeriveWorkbook:
    sheetnames = ["Model"]

    def __init__(self, source: str) -> None:
        self.source = Path(source)
        self.sheet = FakeDeriveSheet()
        self.calculation = FakeCalculation()
        self.closed = False

    def __getitem__(self, name: str) -> FakeDeriveSheet:
        if name != "Model":
            raise KeyError(name)
        return self.sheet

    def save(self, destination: str) -> None:
        with zipfile.ZipFile(self.source, "r") as incoming, zipfile.ZipFile(
            destination, "w"
        ) as outgoing:
            for name in incoming.namelist():
                outgoing.writestr(name, incoming.read(name))
            outgoing.writestr(
                "xl/derived-cells.json",
                json.dumps(
                    {
                        coordinate: cell.value
                        for coordinate, cell in sorted(self.sheet.cells.items())
                    },
                    sort_keys=True,
                ),
            )

    def close(self) -> None:
        self.closed = True


class FakeDeriveOpenpyxl:
    def __init__(self) -> None:
        self.workbooks = []

    def load_workbook(self, *, filename: str, **_options):
        workbook = FakeDeriveWorkbook(filename)
        self.workbooks.append(workbook)
        return workbook


class ExtendedOperationTests(unittest.TestCase):
    def test_render_pdf_page_writes_png_and_manifest(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "source.pdf"
            source.write_bytes(b"%PDF-render-fixture")
            output = root / "output"
            fake_fitz = FakeRenderFitz()
            with patch(
                "compute_worker.pdf_render._load_fitz",
                return_value=fake_fitz,
            ):
                response = execute_request(
                    request_for(
                        "render_pdf_page",
                        source,
                        output,
                        pageNumber=1,
                        dpi=144,
                    )
                )

            self.assertEqual(response["status"], "completed", response)
            self.assertTrue(fake_fitz.document.closed)
            self.assertEqual(
                response["recordsFile"], "page-0001-144dpi.manifest.json"
            )
            media_types = {item["mediaType"] for item in response["artifacts"]}
            self.assertEqual(media_types, {"image/png", "application/json"})
            image = output / "page-0001-144dpi.png"
            self.assertEqual(image.read_bytes(), minimal_png(1224, 1584))
            manifest = json.loads(
                (output / "page-0001-144dpi.manifest.json").read_text(
                    encoding="utf-8"
                )
            )
            self.assertEqual(manifest["width"], 1224)
            self.assertEqual(manifest["height"], 1584)
            self.assertEqual(manifest["image"]["checksum"], response["artifacts"][0]["checksum"])

    def test_market_fixture_matches_golden_ndjson(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / "output"
            response = execute_request(
                request_for(
                    "fetch_market_data",
                    FIXTURES / "market_a_share.json",
                    output,
                )
            )
            self.assertEqual(response["status"], "completed", response)
            self.assertEqual(response["metrics"]["provider"], "fixture")
            self.assertEqual(response["metrics"]["canonicalTicker"], "600519.SH")
            actual = (output / "market-records.ndjson").read_text(
                encoding="utf-8"
            )
            expected = (
                FIXTURES / "market_a_share.expected.ndjson"
            ).read_text(encoding="utf-8")
            self.assertEqual(actual, expected)
            retry = execute_request(
                request_for(
                    "fetch_market_data",
                    FIXTURES / "market_a_share.json",
                    output,
                )
            )
            self.assertEqual(retry["status"], "completed", retry)
            self.assertEqual(
                retry["artifacts"][0]["checksum"],
                response["artifacts"][0]["checksum"],
            )

    def test_akshare_adapter_uses_unadjusted_fallback(self) -> None:
        class FakeAkshare:
            primary_params = None
            fallback_params = None

            @classmethod
            def stock_zh_a_hist(cls, **params):
                cls.primary_params = params
                raise TimeoutError("primary timeout")

            @classmethod
            def stock_zh_a_daily(cls, **params):
                cls.fallback_params = params
                return [
                    {
                        "date": "2026-07-28",
                        "open": 10,
                        "high": 12,
                        "low": 9,
                        "close": 11,
                        "volume": 100,
                        "amount": 1100,
                    }
                ]

        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / "output"
            with patch(
                "compute_worker.market_data.AkshareMarketDataProvider._module",
                return_value=FakeAkshare,
            ):
                response = execute_request(
                    request_for(
                        "fetch_market_data",
                        FIXTURES / "market_a_share.json",
                        output,
                        provider="akshare",
                    )
                )
        self.assertEqual(response["status"], "completed", response)
        self.assertEqual(response["metrics"]["provider"], "akshare")
        self.assertEqual(response["metrics"]["adjustment"], "raw")
        self.assertEqual(FakeAkshare.primary_params["adjust"], "")
        self.assertEqual(FakeAkshare.fallback_params["adjust"], "")

    def test_akshare_network_failure_has_stable_error_code(self) -> None:
        class OfflineAkshare:
            @staticmethod
            def stock_zh_a_hist(**_params):
                raise TimeoutError("primary timeout")

            @staticmethod
            def stock_zh_a_daily(**_params):
                raise ConnectionError("fallback offline")

        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / "output"
            with patch(
                "compute_worker.market_data.AkshareMarketDataProvider._module",
                return_value=OfflineAkshare,
            ):
                response = execute_request(
                    request_for(
                        "fetch_market_data",
                        FIXTURES / "market_a_share.json",
                        output,
                        provider="akshare",
                    )
                )
        self.assertEqual(response["status"], "failed")
        self.assertEqual(
            response["metrics"]["errorCode"], "provider_network_error"
        )

    def test_akshare_missing_dependency_has_stable_error_code(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / "output"
            with patch(
                "compute_worker.market_data.AkshareMarketDataProvider._module",
                side_effect=DependencyUnavailableError("akshare missing"),
            ):
                response = execute_request(
                    request_for(
                        "fetch_market_data",
                        FIXTURES / "market_a_share.json",
                        output,
                        provider="akshare",
                    )
                )
        self.assertEqual(response["status"], "failed")
        self.assertEqual(
            response["metrics"]["errorCode"], "dependency_unavailable"
        )

    def test_report_keeps_markdown_and_html_when_pdf_is_unavailable(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / "output"
            with patch(
                "compute_worker.report_render._render_pdf_with_reportlab",
                side_effect=DependencyUnavailableError(
                    "render_report PDF requires reportlab"
                ),
            ):
                response = execute_request(
                    request_for(
                        "render_report",
                        FIXTURES / "research_report.md",
                        output,
                        renderPdf=True,
                    )
                )
            self.assertEqual(response["status"], "completed", response)
            self.assertEqual(response["metrics"]["pdfStatus"], "unavailable")
            media_types = {item["mediaType"] for item in response["artifacts"]}
            self.assertIn("text/markdown; charset=utf-8", media_types)
            self.assertIn("text/html; charset=utf-8", media_types)
            self.assertNotIn("application/pdf", media_types)
            html_artifact = next(
                item
                for item in response["artifacts"]
                if item["mediaType"].startswith("text/html")
            )
            rendered = (output / html_artifact["path"]).read_text(
                encoding="utf-8"
            )
            self.assertIn("<h1>Golden Research Report</h1>", rendered)
            self.assertIn("<ul>", rendered)
            self.assertIn("<blockquote>", rendered)
            self.assertNotIn("<script", rendered)
            self.assertIn("&lt;script&gt;", rendered)
            with patch(
                "compute_worker.report_render._render_pdf_with_reportlab",
                side_effect=DependencyUnavailableError(
                    "render_report PDF requires reportlab"
                ),
            ):
                retry = execute_request(
                    request_for(
                        "render_report",
                        FIXTURES / "research_report.md",
                        output,
                        renderPdf=True,
                    )
                )
            self.assertEqual(retry["status"], "completed", retry)
            self.assertEqual(
                [item["checksum"] for item in retry["artifacts"]],
                [item["checksum"] for item in response["artifacts"]],
            )

    def test_required_pdf_fails_without_committing_report_outputs(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / "output"
            with patch(
                "compute_worker.report_render._render_pdf_with_reportlab",
                side_effect=DependencyUnavailableError("reportlab missing"),
            ):
                response = execute_request(
                    request_for(
                        "render_report",
                        FIXTURES / "research_report.md",
                        output,
                        renderPdf=True,
                        requirePdf=True,
                    )
                )
            self.assertEqual(response["status"], "failed")
            self.assertEqual(
                response["metrics"]["errorCode"], "dependency_unavailable"
            )
            self.assertEqual(list(output.iterdir()), [])

    def test_derive_xlsm_preserves_vba_and_never_changes_source(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "model.xlsm"
            with zipfile.ZipFile(source, "w") as archive:
                archive.writestr("[Content_Types].xml", "<Types/>")
                archive.writestr("xl/vbaProject.bin", b"golden-vba")
            source_before = source.read_bytes()
            source_checksum = hashlib.sha256(source_before).hexdigest()
            output = root / "derived"
            fake_openpyxl = FakeDeriveOpenpyxl()
            options = {
                "changes": [
                    {
                        "sheet": "Model",
                        "cell": "A1",
                        "value": 12,
                        "expectedCurrentValue": 10,
                        "rationale": "Updated assumption",
                        "evidenceIds": ["cell:model:A1"],
                    },
                    {
                        "sheet": "Model",
                        "cell": "B2",
                        "formula": "=A1*2",
                    },
                ]
            }
            with patch(
                "compute_worker.workbook_derive._load_openpyxl",
                return_value=fake_openpyxl,
            ):
                response = execute_request(
                    request_for("derive_workbook", source, output, **options)
                )

            self.assertEqual(response["status"], "completed", response)
            self.assertEqual(response["metrics"]["changeCount"], 2)
            self.assertTrue(response["metrics"]["sourceHadVbaProject"])
            self.assertTrue(response["metrics"]["vbaProjectPreserved"])
            self.assertFalse(response["metrics"]["sourceOverwritten"])
            self.assertEqual(source.read_bytes(), source_before)
            self.assertEqual(
                hashlib.sha256(source.read_bytes()).hexdigest(), source_checksum
            )
            workbook_artifact = next(
                item
                for item in response["artifacts"]
                if item["path"].endswith(".xlsm")
            )
            with zipfile.ZipFile(output / workbook_artifact["path"]) as archive:
                self.assertEqual(
                    archive.read("xl/vbaProject.bin"), b"golden-vba"
                )
                derived = json.loads(
                    archive.read("xl/derived-cells.json").decode("utf-8")
                )
            self.assertEqual(derived["A1"], 12)
            self.assertEqual(derived["B2"], "=A1*2")
            self.assertTrue(all(item.closed for item in fake_openpyxl.workbooks))
            with patch(
                "compute_worker.workbook_derive._load_openpyxl",
                return_value=fake_openpyxl,
            ):
                retry = execute_request(
                    request_for("derive_workbook", source, output, **options)
                )
            self.assertEqual(retry["status"], "completed", retry)
            self.assertEqual(
                retry["metrics"]["outputChecksum"],
                response["metrics"]["outputChecksum"],
            )

    def test_derive_rejects_external_formula_instructions(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "model.xlsm"
            with zipfile.ZipFile(source, "w") as archive:
                archive.writestr("[Content_Types].xml", "<Types/>")
                archive.writestr("xl/vbaProject.bin", b"golden-vba")
            output = root / "derived"
            fake_openpyxl = FakeDeriveOpenpyxl()
            with patch(
                "compute_worker.workbook_derive._load_openpyxl",
                return_value=fake_openpyxl,
            ):
                response = execute_request(
                    request_for(
                        "derive_workbook",
                        source,
                        output,
                        changes=[
                            {
                                "sheet": "Model",
                                "cell": "B2",
                                "formula": '=WEBSERVICE("https://example.test")',
                            }
                        ],
                    )
                )
            self.assertEqual(response["status"], "failed")
            self.assertEqual(response["metrics"]["errorCode"], "unsafe_formula")
            self.assertEqual(list(output.iterdir()), [])


if __name__ == "__main__":
    unittest.main()
