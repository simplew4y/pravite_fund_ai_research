"""Filesystem guards for the pure compute process."""

import os
from pathlib import Path


class PathValidationError(ValueError):
    """A compute path violates the worker's filesystem contract."""


def require_input_file(raw_path: str) -> Path:
    path = Path(raw_path)
    if not path.is_absolute():
        raise PathValidationError("inputPath must be absolute")
    if path.is_symlink():
        raise PathValidationError("inputPath may not be a symbolic link")
    try:
        resolved = path.resolve(strict=True)
    except FileNotFoundError as exc:
        raise PathValidationError("inputPath does not exist") from exc
    if not resolved.is_file():
        raise PathValidationError("inputPath must identify a regular file")
    return resolved


def prepare_output_directory(raw_path: str) -> Path:
    path = Path(raw_path)
    if not path.is_absolute():
        raise PathValidationError("outputDirectory must be absolute")
    if path.exists() and path.is_symlink():
        raise PathValidationError("outputDirectory may not be a symbolic link")
    try:
        path.mkdir(parents=True, mode=0o700, exist_ok=True)
        resolved = path.resolve(strict=True)
    except OSError as exc:
        raise PathValidationError(
            "outputDirectory could not be created: {}".format(exc)
        ) from exc
    if not resolved.is_dir():
        raise PathValidationError("outputDirectory must identify a directory")
    if path.is_symlink():
        raise PathValidationError("outputDirectory may not be a symbolic link")
    return resolved


def generated_output_path(output_directory: Path, filename: str) -> Path:
    if (
        not filename
        or filename in (".", "..")
        or "/" in filename
        or "\\" in filename
        or "\x00" in filename
    ):
        raise PathValidationError("invalid generated artifact filename")
    candidate = output_directory / filename
    normalized = Path(os.path.abspath(str(candidate)))
    try:
        normalized.relative_to(output_directory)
    except ValueError as exc:
        raise PathValidationError(
            "generated artifact escapes outputDirectory"
        ) from exc
    return normalized
