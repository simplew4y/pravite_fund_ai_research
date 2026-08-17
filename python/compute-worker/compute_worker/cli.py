"""Strict stdin/stdout NDJSON transport."""

import argparse
import json
import os
import sys
import traceback
from typing import Any, BinaryIO, Dict, Optional

from .operations import execute_request
from .protocol import (
    MAX_REQUEST_BYTES,
    PROTOCOL_VERSION,
    ProtocolValidationError,
    failed_response,
    make_health_response,
    request_id_for_error,
    validate_request,
)


def _write_line(stream: BinaryIO, value: Dict[str, Any]) -> None:
    encoded = json.dumps(
        value,
        ensure_ascii=False,
        separators=(",", ":"),
        allow_nan=False,
    ).encode("utf-8")
    stream.write(encoded + b"\n")
    stream.flush()


def _read_bounded_line(stream: BinaryIO) -> Optional[bytes]:
    line = stream.readline(MAX_REQUEST_BYTES + 1)
    if line == b"":
        return None
    if len(line) > MAX_REQUEST_BYTES:
        while line and not line.endswith(b"\n"):
            line = stream.readline(MAX_REQUEST_BYTES + 1)
        raise ProtocolValidationError(
            "request line exceeds {} bytes".format(MAX_REQUEST_BYTES)
        )
    return line


def _reject_nonstandard_json_constant(value: str) -> None:
    raise ProtocolValidationError(
        "request must use strict JSON; {} is not allowed".format(value)
    )


def _process_line(line: bytes) -> Dict[str, Any]:
    raw: Any = None
    try:
        if line in (b"\n", b"\r\n") or not line:
            raise ProtocolValidationError("blank NDJSON lines are not allowed")
        try:
            decoded = line.decode("utf-8", errors="strict")
        except UnicodeDecodeError as exc:
            raise ProtocolValidationError("request must be valid UTF-8") from exc
        try:
            raw = json.loads(
                decoded,
                parse_constant=_reject_nonstandard_json_constant,
            )
        except json.JSONDecodeError as exc:
            raise ProtocolValidationError(
                "request must contain exactly one JSON object"
            ) from exc
        request = validate_request(raw)
        return execute_request(request)
    except ProtocolValidationError as exc:
        return failed_response(
            request_id_for_error(raw), str(exc), "invalid_request"
        )
    except Exception as exc:
        if os.environ.get("COMPUTE_WORKER_DEBUG") == "1":
            traceback.print_exc(file=sys.stderr)
        return failed_response(
            request_id_for_error(raw),
            "Worker failed to process request: {}: {}".format(
                type(exc).__name__, exc
            ),
            "worker_error",
        )


def _run_once(stdin: BinaryIO, stdout: BinaryIO) -> int:
    try:
        line = _read_bounded_line(stdin)
    except ProtocolValidationError as exc:
        _write_line(stdout, failed_response("invalid-request", str(exc), "invalid_request"))
        return 0
    if line is None:
        print("compute worker expected one NDJSON request on stdin", file=sys.stderr)
        return 2
    _write_line(stdout, _process_line(line))
    return 0


def _run_stream(stdin: BinaryIO, stdout: BinaryIO) -> int:
    while True:
        try:
            line = _read_bounded_line(stdin)
        except ProtocolValidationError as exc:
            _write_line(
                stdout,
                failed_response("invalid-request", str(exc), "invalid_request"),
            )
            continue
        if line is None:
            return 0
        _write_line(stdout, _process_line(line))


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Private fund compute worker")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument(
        "--once",
        action="store_true",
        help="process exactly one ComputeRequest and exit",
    )
    mode.add_argument(
        "--health",
        action="store_true",
        help="emit a process-level JSON health record and exit",
    )
    parser.add_argument(
        "--version",
        action="store_true",
        help="print the protocol version and exit",
    )
    return parser


def main(argv: Optional[list] = None) -> int:
    args = build_parser().parse_args(argv)
    if args.version:
        print(PROTOCOL_VERSION)
        return 0
    if args.health:
        _write_line(sys.stdout.buffer, make_health_response())
        return 0
    if args.once:
        return _run_once(sys.stdin.buffer, sys.stdout.buffer)
    return _run_stream(sys.stdin.buffer, sys.stdout.buffer)
