"""Deterministic PDF-page PNG rendering."""

from pathlib import Path
from typing import Any, Dict, List, Mapping, Tuple

from .artifacts import (
    artifact_descriptor,
    sha256_file,
    write_bytes_new_or_identical,
    write_json_new_or_identical,
)
from .errors import ComputeOperationError, DependencyUnavailableError
from .paths import generated_output_path


def _load_fitz() -> Any:
    try:
        import fitz  # type: ignore
    except ImportError as exc:
        raise DependencyUnavailableError(
            "render_pdf_page requires PyMuPDF; install the compute-worker dependencies"
        ) from exc
    return fitz


def _positive_integer(
    options: Mapping[str, Any],
    name: str,
    default: int,
    maximum: int,
) -> int:
    value = options.get(name, default)
    if (
        isinstance(value, bool)
        or not isinstance(value, int)
        or value <= 0
        or value > maximum
    ):
        raise ComputeOperationError(
            "options.{} must be an integer between 1 and {}".format(
                name, maximum
            ),
            "invalid_options",
        )
    return value


def _png_dimensions(data: bytes) -> Tuple[int, int]:
    if len(data) < 24 or data[:8] != b"\x89PNG\r\n\x1a\n":
        raise ComputeOperationError(
            "PyMuPDF did not return a valid PNG image", "render_failed"
        )
    width = int.from_bytes(data[16:20], "big")
    height = int.from_bytes(data[20:24], "big")
    if width <= 0 or height <= 0:
        raise ComputeOperationError(
            "Rendered PNG has invalid dimensions", "render_failed"
        )
    return width, height


def render_pdf_page(
    input_path: Path,
    output_directory: Path,
    options: Mapping[str, Any],
) -> Tuple[str, List[Dict[str, Any]], Dict[str, Any]]:
    fitz = _load_fitz()
    page_number = _positive_integer(options, "pageNumber", 1, 1_000_000)
    dpi = _positive_integer(options, "dpi", 144, 600)
    max_pixels = _positive_integer(
        options, "maxPixels", 100_000_000, 250_000_000
    )
    password = options.get("password")
    if password is not None and not isinstance(password, str):
        raise ComputeOperationError(
            "options.password must be a string", "invalid_options"
        )

    try:
        document = fitz.open(str(input_path))
    except Exception as exc:
        raise ComputeOperationError(
            "PDF could not be opened: {}".format(exc), "invalid_pdf"
        ) from exc

    try:
        if not bool(getattr(document, "is_pdf", True)):
            raise ComputeOperationError(
                "inputPath is not a PDF document", "invalid_pdf"
            )
        if bool(getattr(document, "needs_pass", False)):
            if not password:
                raise ComputeOperationError(
                    "PDF is encrypted and options.password was not supplied",
                    "encrypted_pdf",
                )
            if not bool(document.authenticate(password)):
                raise ComputeOperationError(
                    "PDF password authentication failed", "encrypted_pdf"
                )
        page_count = int(document.page_count)
        if page_number > page_count:
            raise ComputeOperationError(
                "PDF has {} pages; page {} is invalid".format(
                    page_count, page_number
                ),
                "invalid_options",
            )
        page = document.load_page(page_number - 1)
        scale = dpi / 72.0
        estimated_pixels = int(page.rect.width * scale) * int(
            page.rect.height * scale
        )
        if estimated_pixels > max_pixels:
            raise ComputeOperationError(
                "Rendered page would exceed options.maxPixels",
                "document_limit_exceeded",
            )
        try:
            pixmap = page.get_pixmap(
                matrix=fitz.Matrix(scale, scale), alpha=False
            )
            png = bytes(pixmap.tobytes("png"))
        except Exception as exc:
            raise ComputeOperationError(
                "PDF page rendering failed: {}".format(exc), "render_failed"
            ) from exc
        width, height = _png_dimensions(png)
        if width * height > max_pixels:
            raise ComputeOperationError(
                "Rendered page exceeds options.maxPixels",
                "document_limit_exceeded",
            )
        rotation = int(getattr(page, "rotation", 0))
    finally:
        close = getattr(document, "close", None)
        if callable(close):
            close()

    image_name = "page-{:04d}-{}dpi.png".format(page_number, dpi)
    image_path = generated_output_path(output_directory, image_name)
    write_bytes_new_or_identical(png, image_path)
    image_artifact = artifact_descriptor(
        image_path, output_directory, "image/png"
    )

    manifest = {
        "manifestVersion": 1,
        "operation": "render_pdf_page",
        "sourceName": input_path.name,
        "sourceChecksum": sha256_file(input_path),
        "pageNumber": page_number,
        "pageCount": page_count,
        "dpi": dpi,
        "rotation": rotation,
        "width": width,
        "height": height,
        "image": image_artifact,
    }
    manifest_path = generated_output_path(
        output_directory,
        "page-{:04d}-{}dpi.manifest.json".format(page_number, dpi),
    )
    write_json_new_or_identical(manifest, manifest_path)
    manifest_artifact = artifact_descriptor(
        manifest_path, output_directory, "application/json"
    )
    metrics = {
        "pageNumber": page_number,
        "pageCount": page_count,
        "dpi": dpi,
        "width": width,
        "height": height,
        "inputChecksum": manifest["sourceChecksum"],
    }
    return manifest_path.name, [image_artifact, manifest_artifact], metrics
