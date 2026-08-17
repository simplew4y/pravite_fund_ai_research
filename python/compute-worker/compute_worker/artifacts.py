"""Atomic NDJSON artifact creation and integrity metadata."""

import hashlib
import json
import os
import tempfile
from pathlib import Path
from typing import Any, Dict, Iterable, Tuple

from .errors import ArtifactConflictError


def sha256_file(path: Path, chunk_size: int = 1024 * 1024) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while True:
            chunk = stream.read(chunk_size)
            if not chunk:
                break
            digest.update(chunk)
    return "sha256:{}".format(digest.hexdigest())


def write_ndjson_atomic(
    records: Iterable[Dict[str, Any]], destination: Path
) -> Tuple[int, int]:
    """Write records atomically and return (record_count, byte_size)."""

    temp_name = None
    record_count = 0
    try:
        with tempfile.NamedTemporaryFile(
            mode="wb",
            prefix=".compute-",
            suffix=".ndjson.tmp",
            dir=str(destination.parent),
            delete=False,
        ) as stream:
            temp_name = stream.name
            for record in records:
                encoded = json.dumps(
                    record,
                    ensure_ascii=False,
                    separators=(",", ":"),
                    allow_nan=False,
                ).encode("utf-8")
                stream.write(encoded)
                stream.write(b"\n")
                record_count += 1
            stream.flush()
            os.fsync(stream.fileno())
        temporary = Path(temp_name)
        temp_name = None
        commit_temporary_new_or_identical(temporary, destination)
        return record_count, destination.stat().st_size
    finally:
        if temp_name is not None:
            try:
                os.unlink(temp_name)
            except FileNotFoundError:
                pass


def commit_temporary_new_or_identical(
    temporary: Path, destination: Path
) -> bool:
    """Atomically publish a new artifact without overwriting existing data.

    Returns True when this call created the destination. An existing byte-for-
    byte identical artifact is accepted for idempotent job retries. An existing
    artifact with different content is never replaced.
    """

    try:
        os.link(str(temporary), str(destination))
        created = True
    except FileExistsError:
        if (
            temporary.stat().st_size != destination.stat().st_size
            or sha256_file(temporary) != sha256_file(destination)
        ):
            raise ArtifactConflictError(destination.name)
        created = False
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass
    return created


def write_bytes_new_or_identical(data: bytes, destination: Path) -> bool:
    temporary_name = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="wb",
            prefix=".compute-",
            suffix=".artifact.tmp",
            dir=str(destination.parent),
            delete=False,
        ) as stream:
            temporary_name = stream.name
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        temporary = Path(temporary_name)
        temporary_name = None
        return commit_temporary_new_or_identical(temporary, destination)
    finally:
        if temporary_name is not None:
            try:
                os.unlink(temporary_name)
            except FileNotFoundError:
                pass


def write_json_new_or_identical(
    value: Dict[str, Any], destination: Path
) -> bool:
    encoded = (
        json.dumps(
            value,
            ensure_ascii=False,
            sort_keys=True,
            indent=2,
            allow_nan=False,
        )
        + "\n"
    ).encode("utf-8")
    return write_bytes_new_or_identical(encoded, destination)


def artifact_descriptor(
    path: Path, output_directory: Path, media_type: str
) -> Dict[str, Any]:
    relative = path.relative_to(output_directory).as_posix()
    stat = path.stat()
    return {
        "path": relative,
        "mediaType": media_type,
        "checksum": sha256_file(path),
        "size": stat.st_size,
    }
