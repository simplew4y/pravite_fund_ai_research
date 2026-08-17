import json
import subprocess
import sys
import unittest
from pathlib import Path


PACKAGE_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PACKAGE_ROOT))

from compute_worker.protocol import (  # noqa: E402
    CONTRACT_OPERATIONS,
    IMPLEMENTED_OPERATIONS,
    ProtocolValidationError,
    make_health_response,
    validate_request,
)


WORKER = PACKAGE_ROOT / "worker.py"


class ProtocolTests(unittest.TestCase):
    def test_request_defaults_options(self) -> None:
        request = validate_request(
            {
                "protocolVersion": 1,
                "requestId": "request-1",
                "jobId": "job-1",
                "operation": "extract_pdf",
                "inputPath": "/tmp/input.pdf",
                "outputDirectory": "/tmp/output",
            }
        )
        self.assertEqual(request["options"], {})

    def test_request_rejects_boolean_protocol_version(self) -> None:
        with self.assertRaises(ProtocolValidationError):
            validate_request(
                {
                    "protocolVersion": True,
                    "requestId": "request-1",
                    "jobId": "job-1",
                    "operation": "extract_pdf",
                    "inputPath": "/tmp/input.pdf",
                    "outputDirectory": "/tmp/output",
                }
            )

    def test_health_reports_capabilities_and_dependency_state(self) -> None:
        health = make_health_response()
        self.assertEqual(health["status"], "ok")
        self.assertIn("extract_pdf", health["implementedOperations"])
        self.assertIn("extract_workbook", health["implementedOperations"])
        self.assertIn("extract_document", health["implementedOperations"])
        self.assertEqual(
            health["implementedOperations"],
            health["contractOperations"],
        )
        self.assertEqual(
            tuple(health["implementedOperations"]),
            CONTRACT_OPERATIONS,
        )
        self.assertEqual(CONTRACT_OPERATIONS, IMPLEMENTED_OPERATIONS)
        self.assertEqual(
            health["capabilities"]["extract_document"]["extensions"],
            [".csv", ".docx", ".markdown", ".md", ".pptx", ".txt"],
        )
        self.assertTrue(
            health["capabilities"]["extract_document"]["boundedExtraction"]
        )
        self.assertIsInstance(health["dependencies"]["pymupdf"], bool)

    def test_request_bounds_paths_and_unknown_operation_names(self) -> None:
        base = {
            "protocolVersion": 1,
            "requestId": "request-1",
            "jobId": "job-1",
            "operation": "extract_document",
            "inputPath": "/tmp/input.md",
            "outputDirectory": "/tmp/output",
        }
        with self.assertRaises(ProtocolValidationError):
            validate_request({**base, "operation": "x" * 161})
        with self.assertRaises(ProtocolValidationError):
            validate_request({**base, "inputPath": "/" + "x" * 32_768})


class CliTests(unittest.TestCase):
    def _run(self, *arguments: str, stdin: bytes = b"") -> subprocess.CompletedProcess:
        return subprocess.run(
            [sys.executable, str(WORKER), *arguments],
            input=stdin,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )

    def test_health_is_one_json_line(self) -> None:
        result = self._run("--health")
        self.assertEqual(result.returncode, 0, result.stderr.decode())
        self.assertTrue(result.stdout.endswith(b"\n"))
        lines = result.stdout.splitlines()
        self.assertEqual(len(lines), 1)
        self.assertEqual(json.loads(lines[0])["status"], "ok")

    def test_unknown_operation_is_structured_failure(self) -> None:
        request = {
            "protocolVersion": 1,
            "requestId": "request-unsupported",
            "jobId": "job-unsupported",
            "operation": "unknown_operation",
            "inputPath": "/does/not/need/to/exist.pdf",
            "outputDirectory": "/does/not/need/to/exist",
            "options": {},
        }
        result = self._run(
            "--once",
            stdin=(json.dumps(request) + "\n").encode("utf-8"),
        )
        self.assertEqual(result.returncode, 0, result.stderr.decode())
        response = json.loads(result.stdout)
        self.assertEqual(response["requestId"], request["requestId"])
        self.assertEqual(response["status"], "failed")
        self.assertEqual(response["metrics"]["errorCode"], "unsupported_operation")
        self.assertEqual(response["artifacts"], [])

    def test_invalid_json_still_returns_compute_response_shape(self) -> None:
        result = self._run("--once", stdin=b"{not-json}\n")
        self.assertEqual(result.returncode, 0)
        response = json.loads(result.stdout)
        self.assertEqual(response["requestId"], "invalid-request")
        self.assertEqual(response["status"], "failed")
        self.assertEqual(response["recordsFile"], None)
        self.assertEqual(response["metrics"]["errorCode"], "invalid_request")

    def test_nonstandard_nan_json_is_rejected(self) -> None:
        request = (
            '{"protocolVersion":1,"requestId":"request-nan","jobId":"job-nan",'
            '"operation":"extract_document","inputPath":"/tmp/input.md",'
            '"outputDirectory":"/tmp/output","options":{"limit":NaN}}\n'
        ).encode("utf-8")
        result = self._run("--once", stdin=request)
        self.assertEqual(result.returncode, 0, result.stderr.decode())
        response = json.loads(result.stdout)
        self.assertEqual(response["status"], "failed")
        self.assertEqual(response["metrics"]["errorCode"], "invalid_request")
        self.assertIn("strict JSON", response["error"])

    def test_once_without_input_fails_at_process_level(self) -> None:
        result = self._run("--once")
        self.assertEqual(result.returncode, 2)
        self.assertEqual(result.stdout, b"")
        self.assertIn(b"expected one NDJSON request", result.stderr)


if __name__ == "__main__":
    unittest.main()
