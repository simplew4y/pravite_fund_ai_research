from __future__ import annotations

import json

from omnigent import product_release as release_module


def test_product_release_prefers_configured_project_root(tmp_path, monkeypatch) -> None:
    manifest = tmp_path / "product-release.json"
    manifest.write_text(
        json.dumps(
            {
                "productVersion": "0.2.2",
                "databaseChanged": False,
                "databaseTargetVersion": "0.2.1",
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv("PRIVATE_FUND_PROJECT_ROOT", str(tmp_path))
    release_module.product_release.cache_clear()

    try:
        release = release_module.product_release()
        assert release["productVersion"] == "0.2.2"
        assert release["databaseChanged"] is False
    finally:
        release_module.product_release.cache_clear()
