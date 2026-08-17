"""Controlled, non-destructive XLSX/XLSM derivation."""

import datetime as dt
import hashlib
import json
import math
import os
import re
import tempfile
import zipfile
from pathlib import Path
from typing import Any, Dict, List, Mapping, Optional, Tuple

from .artifacts import (
    artifact_descriptor,
    commit_temporary_new_or_identical,
    sha256_file,
    write_json_new_or_identical,
)
from .errors import ComputeOperationError, DependencyUnavailableError
from .paths import generated_output_path


MAX_CHANGES = 10_000
MAX_FORMULA_LENGTH = 8_192
CELL_REFERENCE = re.compile(r"^[A-Za-z]{1,3}[1-9][0-9]{0,6}$")
EXTERNAL_FORMULA = re.compile(
    r"^=\s*(?:WEBSERVICE|FILTERXML|HYPERLINK|RTD|CALL|EXEC|REGISTER\.ID)\s*\(",
    re.IGNORECASE,
)
EXTERNAL_WORKBOOK_REFERENCE = re.compile(r"\[[^\]]+\][^!]*!")


def _load_openpyxl() -> Any:
    try:
        import openpyxl  # type: ignore
    except ImportError as exc:
        raise DependencyUnavailableError(
            "derive_workbook requires openpyxl; install the compute-worker dependencies"
        ) from exc
    return openpyxl


def _bool_option(
    options: Mapping[str, Any], name: str, default: bool
) -> bool:
    value = options.get(name, default)
    if not isinstance(value, bool):
        raise ComputeOperationError(
            "options.{} must be boolean".format(name), "invalid_options"
        )
    return value


def _manifest_value(value: Any) -> Any:
    if value is None or isinstance(value, (str, bool, int)):
        return value
    if isinstance(value, float):
        return value if math.isfinite(value) else str(value)
    if isinstance(value, (dt.datetime, dt.date, dt.time)):
        return value.isoformat()
    if isinstance(value, dt.timedelta):
        return value.total_seconds()
    return str(value)


def _safe_stem(value: str) -> str:
    cleaned = re.sub(r"[^\w.-]+", "-", value, flags=re.UNICODE).strip(".-")
    return cleaned[:100] or "workbook"


def _change_digest(source_checksum: str, changes: List[Dict[str, Any]]) -> str:
    canonical = json.dumps(
        {"sourceChecksum": source_checksum, "changes": changes},
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _validated_changes(options: Mapping[str, Any]) -> List[Dict[str, Any]]:
    raw_changes = options.get("changes")
    if (
        not isinstance(raw_changes, list)
        or not raw_changes
        or len(raw_changes) > MAX_CHANGES
    ):
        raise ComputeOperationError(
            "options.changes must contain between 1 and {} cell instructions".format(
                MAX_CHANGES
            ),
            "invalid_options",
        )
    validated: List[Dict[str, Any]] = []
    targets = set()
    for index, raw in enumerate(raw_changes):
        if not isinstance(raw, Mapping):
            raise ComputeOperationError(
                "options.changes[{}] must be an object".format(index),
                "invalid_options",
            )
        sheet = raw.get("sheet")
        cell = raw.get("cell")
        if not isinstance(sheet, str) or not sheet:
            raise ComputeOperationError(
                "options.changes[{}].sheet must be non-empty".format(index),
                "invalid_options",
            )
        if (
            not isinstance(cell, str)
            or CELL_REFERENCE.fullmatch(cell) is None
        ):
            raise ComputeOperationError(
                "options.changes[{}].cell is not a single A1 cell".format(
                    index
                ),
                "invalid_options",
            )
        target = (sheet, cell.upper())
        if target in targets:
            raise ComputeOperationError(
                "options.changes contains duplicate target {}!{}".format(
                    sheet, cell.upper()
                ),
                "invalid_options",
            )
        targets.add(target)

        has_formula = "formula" in raw
        has_value = "value" in raw
        if has_formula == has_value:
            raise ComputeOperationError(
                "options.changes[{}] must contain exactly one of value or formula".format(
                    index
                ),
                "invalid_options",
            )
        instruction: Dict[str, Any] = {
            "sheet": sheet,
            "cell": cell.upper(),
        }
        if has_formula:
            formula = raw.get("formula")
            if (
                not isinstance(formula, str)
                or not formula.startswith("=")
                or len(formula) > MAX_FORMULA_LENGTH
            ):
                raise ComputeOperationError(
                    "options.changes[{}].formula must start with = and be at most {} characters".format(
                        index, MAX_FORMULA_LENGTH
                    ),
                    "invalid_options",
                )
            if (
                EXTERNAL_FORMULA.search(formula)
                or EXTERNAL_WORKBOOK_REFERENCE.search(formula)
                or ("|" in formula and "!" in formula)
            ):
                raise ComputeOperationError(
                    "options.changes[{}].formula may not introduce external execution or network access".format(
                        index
                    ),
                    "unsafe_formula",
                )
            instruction["formula"] = formula
        else:
            value = raw.get("value")
            if isinstance(value, (dict, list)):
                raise ComputeOperationError(
                    "options.changes[{}].value must be a JSON scalar".format(
                        index
                    ),
                    "invalid_options",
                )
            if isinstance(value, str) and value.startswith("="):
                raise ComputeOperationError(
                    "options.changes[{}].value may not start with =; use formula explicitly".format(
                        index
                    ),
                    "unsafe_formula",
                )
            if isinstance(value, float) and not math.isfinite(value):
                raise ComputeOperationError(
                    "options.changes[{}].value must be finite".format(index),
                    "invalid_options",
                )
            instruction["value"] = value
        if "expectedCurrentValue" in raw:
            instruction["expectedCurrentValue"] = raw.get(
                "expectedCurrentValue"
            )
        number_format = raw.get("numberFormat")
        if number_format is not None:
            if not isinstance(number_format, str) or len(number_format) > 255:
                raise ComputeOperationError(
                    "options.changes[{}].numberFormat is invalid".format(index),
                    "invalid_options",
                )
            instruction["numberFormat"] = number_format
        rationale = raw.get("rationale")
        if rationale is not None:
            if not isinstance(rationale, str) or len(rationale) > 10_000:
                raise ComputeOperationError(
                    "options.changes[{}].rationale is invalid".format(index),
                    "invalid_options",
                )
            instruction["rationale"] = rationale
        evidence_ids = raw.get("evidenceIds")
        if evidence_ids is not None:
            if (
                not isinstance(evidence_ids, list)
                or any(
                    not isinstance(item, str) or not item
                    for item in evidence_ids
                )
                or len(evidence_ids) > 100
            ):
                raise ComputeOperationError(
                    "options.changes[{}].evidenceIds is invalid".format(index),
                    "invalid_options",
                )
            instruction["evidenceIds"] = evidence_ids
        validated.append(instruction)
    return validated


def _has_vba_archive(path: Path) -> bool:
    try:
        with zipfile.ZipFile(str(path), "r") as archive:
            return any(
                name.lower().endswith("vbaproject.bin")
                for name in archive.namelist()
            )
    except (OSError, zipfile.BadZipFile) as exc:
        raise ComputeOperationError(
            "Workbook is not a valid Office archive: {}".format(exc),
            "invalid_workbook",
        ) from exc


def _normalize_office_archive(source: Path, destination: Path) -> None:
    """Normalize ZIP entry order/timestamps for retry-stable checksums."""

    try:
        with zipfile.ZipFile(str(source), "r") as incoming, zipfile.ZipFile(
            str(destination), "w"
        ) as outgoing:
            for name in sorted(incoming.namelist()):
                original = incoming.getinfo(name)
                normalized = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
                normalized.compress_type = original.compress_type
                normalized.comment = original.comment
                normalized.extra = original.extra
                normalized.internal_attr = original.internal_attr
                normalized.external_attr = original.external_attr
                normalized.create_system = original.create_system
                outgoing.writestr(normalized, incoming.read(name))
    except (OSError, zipfile.BadZipFile) as exc:
        raise ComputeOperationError(
            "Derived workbook could not be normalized: {}".format(exc),
            "workbook_save_failed",
        ) from exc


def _temporary_path(directory: Path, suffix: str) -> Path:
    handle, name = tempfile.mkstemp(
        prefix=".compute-workbook-", suffix=suffix, dir=str(directory)
    )
    os.close(handle)
    return Path(name)


def _output_name(
    input_path: Path,
    options: Mapping[str, Any],
    digest: str,
) -> str:
    suffix = input_path.suffix.lower()
    requested = options.get("outputFilename")
    if requested is None:
        return "{}-derived-{}{}".format(
            _safe_stem(input_path.stem), digest[:12], suffix
        )
    if (
        not isinstance(requested, str)
        or not requested
        or Path(requested).name != requested
        or "/" in requested
        or "\\" in requested
        or "\x00" in requested
    ):
        raise ComputeOperationError(
            "options.outputFilename must be a safe file name",
            "invalid_options",
        )
    if Path(requested).suffix.lower() != suffix:
        raise ComputeOperationError(
            "Derived workbook must keep the source workbook extension",
            "invalid_options",
        )
    return requested


def derive_workbook(
    input_path: Path,
    output_directory: Path,
    options: Mapping[str, Any],
) -> Tuple[str, List[Dict[str, Any]], Dict[str, Any]]:
    suffix = input_path.suffix.lower()
    if suffix not in (".xlsx", ".xlsm"):
        raise ComputeOperationError(
            "derive_workbook supports only XLSX and XLSM sources",
            "unsupported_workbook_format",
        )
    openpyxl = _load_openpyxl()
    changes = _validated_changes(options)
    allow_unchecked = _bool_option(
        options, "allowOverwriteWithoutExpected", False
    )
    source_checksum = sha256_file(input_path)
    source_has_vba = _has_vba_archive(input_path)
    digest = _change_digest(source_checksum, changes)
    output_name = _output_name(input_path, options, digest)
    output_path = generated_output_path(output_directory, output_name)
    if output_path.resolve() == input_path.resolve():
        raise ComputeOperationError(
            "Derived workbook may not overwrite the source workbook",
            "source_overwrite_forbidden",
        )

    try:
        workbook = openpyxl.load_workbook(
            filename=str(input_path),
            data_only=False,
            read_only=False,
            keep_vba=suffix == ".xlsm",
            keep_links=True,
        )
    except Exception as exc:
        raise ComputeOperationError(
            "Workbook could not be opened for derivation: {}".format(exc),
            "invalid_workbook",
        ) from exc

    applied: List[Dict[str, Any]] = []
    raw_temporary: Optional[Path] = None
    normalized_temporary: Optional[Path] = None
    try:
        for instruction in changes:
            sheet_name = str(instruction["sheet"])
            coordinate = str(instruction["cell"])
            if sheet_name not in workbook.sheetnames:
                raise ComputeOperationError(
                    "Workbook does not contain sheet: {}".format(sheet_name),
                    "invalid_options",
                )
            cell = workbook[sheet_name][coordinate]
            if cell.__class__.__name__ == "MergedCell":
                raise ComputeOperationError(
                    "Derived target {}!{} is a non-anchor merged cell".format(
                        sheet_name, coordinate
                    ),
                    "invalid_options",
                )
            old_value = _manifest_value(cell.value)
            if "expectedCurrentValue" in instruction:
                if old_value != instruction["expectedCurrentValue"]:
                    raise ComputeOperationError(
                        "Derived target {}!{} no longer matches expectedCurrentValue".format(
                            sheet_name, coordinate
                        ),
                        "workbook_precondition_failed",
                    )
            elif old_value is not None and not allow_unchecked:
                raise ComputeOperationError(
                    "Derived target {}!{} is populated; expectedCurrentValue is required".format(
                        sheet_name, coordinate
                    ),
                    "workbook_precondition_required",
                )
            new_value = (
                instruction["formula"]
                if "formula" in instruction
                else instruction.get("value")
            )
            cell.value = new_value
            if "numberFormat" in instruction:
                cell.number_format = instruction["numberFormat"]
            applied.append(
                {
                    "sheet": sheet_name,
                    "cell": coordinate,
                    "oldValue": old_value,
                    "newValue": _manifest_value(new_value),
                    "kind": (
                        "formula" if "formula" in instruction else "value"
                    ),
                    "numberFormat": instruction.get("numberFormat"),
                    "rationale": instruction.get("rationale"),
                    "evidenceIds": instruction.get("evidenceIds", []),
                }
            )

        calculation = getattr(workbook, "calculation", None)
        if calculation is not None:
            calculation.fullCalcOnLoad = True
            calculation.forceFullCalc = True
            calculation.calcMode = "auto"

        raw_temporary = _temporary_path(output_directory, suffix)
        try:
            workbook.save(str(raw_temporary))
        except Exception as exc:
            try:
                raw_temporary.unlink()
            except FileNotFoundError:
                pass
            raw_temporary = None
            raise ComputeOperationError(
                "Derived workbook could not be saved: {}".format(exc),
                "workbook_save_failed",
            ) from exc
    finally:
        close = getattr(workbook, "close", None)
        if callable(close):
            close()

    try:
        normalized_temporary = _temporary_path(output_directory, suffix)
        _normalize_office_archive(raw_temporary, normalized_temporary)
        raw_temporary.unlink()
        raw_temporary = None
        if source_has_vba and not _has_vba_archive(normalized_temporary):
            raise ComputeOperationError(
                "Derived XLSM lost its VBA project", "macro_preservation_failed"
            )
        if sha256_file(input_path) != source_checksum:
            raise ComputeOperationError(
                "Source workbook changed during derivation",
                "source_changed",
            )
        commit_temporary_new_or_identical(
            normalized_temporary, output_path
        )
        normalized_temporary = None
    finally:
        for temporary in (raw_temporary, normalized_temporary):
            if temporary is not None:
                try:
                    temporary.unlink()
                except FileNotFoundError:
                    pass

    output_artifact = artifact_descriptor(
        output_path,
        output_directory,
        (
            "application/vnd.ms-excel.sheet.macroEnabled.12"
            if suffix == ".xlsm"
            else "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        ),
    )
    manifest = {
        "manifestVersion": 1,
        "operation": "derive_workbook",
        "sourceName": input_path.name,
        "sourceChecksum": source_checksum,
        "output": output_artifact,
        "instructionDigest": digest,
        "changeCount": len(applied),
        "changes": applied,
        "sourceHadVbaProject": source_has_vba,
        "vbaProjectPreserved": (
            source_has_vba and _has_vba_archive(output_path)
        ),
        "sourceOverwritten": False,
    }
    manifest_path = generated_output_path(
        output_directory, "{}.manifest.json".format(Path(output_name).stem)
    )
    write_json_new_or_identical(manifest, manifest_path)
    manifest_artifact = artifact_descriptor(
        manifest_path, output_directory, "application/json"
    )
    metrics = {
        "inputChecksum": source_checksum,
        "outputChecksum": output_artifact["checksum"],
        "changeCount": len(applied),
        "sourceHadVbaProject": source_has_vba,
        "vbaProjectPreserved": manifest["vbaProjectPreserved"],
        "sourceOverwritten": False,
    }
    return manifest_path.name, [output_artifact, manifest_artifact], metrics
