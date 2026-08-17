"""Protocol validation shared by the worker CLI and operation dispatcher."""

import importlib.util
import re
import sys
from typing import Any, Dict, Mapping


PROTOCOL_VERSION = 1
MAX_REQUEST_BYTES = 16 * 1024 * 1024
MAX_OPERATION_CHARS = 160
MAX_PATH_CHARS = 32 * 1024
IDENTIFIER_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$")

CONTRACT_OPERATIONS = (
    "extract_pdf",
    "extract_document",
    "render_pdf_page",
    "extract_workbook",
    "derive_workbook",
    "fetch_market_data",
    "render_report",
)
IMPLEMENTED_OPERATIONS = CONTRACT_OPERATIONS


class ProtocolValidationError(ValueError):
    """A request cannot be interpreted as a ComputeRequest."""


def _require_identifier(value: Any, field: str) -> str:
    if not isinstance(value, str) or IDENTIFIER_PATTERN.fullmatch(value) is None:
        raise ProtocolValidationError(
            "{} must be a 1-160 character protocol identifier".format(field)
        )
    return value


def _require_non_empty_string(value: Any, field: str) -> str:
    if not isinstance(value, str) or not value:
        raise ProtocolValidationError("{} must be a non-empty string".format(field))
    return value


def _require_bounded_string(
    value: Any, field: str, maximum: int
) -> str:
    resolved = _require_non_empty_string(value, field)
    if len(resolved) > maximum:
        raise ProtocolValidationError(
            "{} may not exceed {} characters".format(field, maximum)
        )
    return resolved


def validate_request(value: Any) -> Dict[str, Any]:
    """Validate the runtime shape shared with packages/contracts.

    Unknown operation strings are retained so the dispatcher can return a
    structured "unsupported_operation" ComputeResponse. Known callers should
    still validate with the TypeScript ComputeRequest schema first.
    """

    if not isinstance(value, Mapping):
        raise ProtocolValidationError("request must be a JSON object")

    protocol_version = value.get("protocolVersion")
    if (
        isinstance(protocol_version, bool)
        or not isinstance(protocol_version, int)
        or protocol_version != PROTOCOL_VERSION
    ):
        raise ProtocolValidationError("protocolVersion must be 1")

    options = value.get("options", {})
    if not isinstance(options, Mapping):
        raise ProtocolValidationError("options must be a JSON object")

    return {
        "protocolVersion": PROTOCOL_VERSION,
        "requestId": _require_identifier(value.get("requestId"), "requestId"),
        "jobId": _require_identifier(value.get("jobId"), "jobId"),
        "operation": _require_bounded_string(
            value.get("operation"), "operation", MAX_OPERATION_CHARS
        ),
        "inputPath": _require_bounded_string(
            value.get("inputPath"), "inputPath", MAX_PATH_CHARS
        ),
        "outputDirectory": _require_bounded_string(
            value.get("outputDirectory"), "outputDirectory", MAX_PATH_CHARS
        ),
        "options": dict(options),
    }


def request_id_for_error(value: Any) -> str:
    if isinstance(value, Mapping):
        request_id = value.get("requestId")
        if isinstance(request_id, str) and IDENTIFIER_PATTERN.fullmatch(request_id):
            return request_id
    return "invalid-request"


def failed_response(
    request_id: str, error: str, error_code: str = "compute_failed"
) -> Dict[str, Any]:
    return {
        "protocolVersion": PROTOCOL_VERSION,
        "requestId": request_id,
        "status": "failed",
        "recordsFile": None,
        "artifacts": [],
        "metrics": {"errorCode": error_code},
        "error": error,
    }


def make_health_response() -> Dict[str, Any]:
    return {
        "protocolVersion": PROTOCOL_VERSION,
        "status": "ok",
        "worker": "private-fund-compute-worker",
        "pythonVersion": "{}.{}.{}".format(
            sys.version_info.major, sys.version_info.minor, sys.version_info.micro
        ),
        "implementedOperations": list(IMPLEMENTED_OPERATIONS),
        "contractOperations": list(CONTRACT_OPERATIONS),
        "capabilities": {
            "extract_document": {
                "extensions": [
                    ".csv",
                    ".docx",
                    ".markdown",
                    ".md",
                    ".pptx",
                    ".txt",
                ],
                "recordsMediaType": "application/x-ndjson",
                "boundedExtraction": True,
            },
            "fetch_market_data": {
                "providers": ["fixture", "akshare"],
                "akshareOptional": True,
            },
        },
        "dependencies": {
            "pymupdf": importlib.util.find_spec("fitz") is not None,
            "openpyxl": importlib.util.find_spec("openpyxl") is not None,
            "akshare": importlib.util.find_spec("akshare") is not None,
            "reportlab": importlib.util.find_spec("reportlab") is not None,
        },
    }
