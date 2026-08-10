"""Product release metadata shared by server and desktop packaging."""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from typing import Any

_DEFAULT_RELEASE = {
    "productVersion": "0.2.1",
    "legacyDataBaseline": "0.1.1",
    "databaseChanged": True,
    "databaseTargetVersion": "0.2.1",
    "migrations": [],
}


def _release_manifest_candidates() -> list[Path]:
    module_path = Path(__file__).resolve()
    return [
        module_path.parents[2] / "product-release.json",
        module_path.parents[3] / "product-release.json",
    ]


@lru_cache(maxsize=1)
def product_release() -> dict[str, Any]:
    for candidate in _release_manifest_candidates():
        if candidate.is_file():
            payload = json.loads(candidate.read_text(encoding="utf-8"))
            return {**_DEFAULT_RELEASE, **payload}
    return dict(_DEFAULT_RELEASE)


def product_version() -> str:
    return str(product_release()["productVersion"])


def legacy_data_baseline() -> str:
    return str(product_release()["legacyDataBaseline"])


def database_target_version() -> str:
    return str(product_release()["databaseTargetVersion"])

