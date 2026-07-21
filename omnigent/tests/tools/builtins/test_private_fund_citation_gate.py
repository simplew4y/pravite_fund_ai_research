from __future__ import annotations

from pathlib import Path

import pytest

from omnigent.server import private_fund_tracking
from omnigent.tools.builtins.private_fund_dataset import (
    _DatasetStore,
    _memo_claims_to_markdown,
)


def _store(monkeypatch: pytest.MonkeyPatch) -> _DatasetStore:
    project_root = Path(__file__).resolve().parents[4]
    store = _DatasetStore(project_root)
    monkeypatch.setattr(store, "_citation_repair_client", lambda: None)
    return store


def _info() -> dict[str, str]:
    return {
        "dataset_id": "demo",
        "company_name": "星河公司",
    }


def _sections() -> list[dict[str, object]]:
    evidence_id = "fact:demo:revenue-2025"
    return [
        {
            "section": "财务",
            "evidence": [
                {
                    "evidence_id": evidence_id,
                    "excerpt": "2025 年收入同比增长 17.4%。",
                    "citation": "经营数据.xlsx Sheet1!B2",
                    "markdown_citation": (
                        "[经营数据.xlsx Sheet1!B2]"
                        f"(#source?evidence_id={evidence_id})"
                    ),
                }
            ],
        }
    ]


def test_dataset_memo_gate_renders_canonical_source_link(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = _store(monkeypatch)

    markdown, audit, full_audit = store._gate_memo_markdown(
        "## 财务\n\n- 2025 年收入同比增长 17.4%。[fact:demo:revenue-2025]",
        info=_info(),
        section_payloads=_sections(),
    )

    assert audit["status"] == "passed"
    assert audit["needs_review"] is False
    assert "[经营数据.xlsx Sheet1!B2](#source?evidence_id=fact:demo:revenue-2025)" in markdown
    assert full_audit["dataset_id"] == "demo"
    assert full_audit["repair_enabled"] is False


def test_dataset_memo_gate_marks_uncited_claim_for_review(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = _store(monkeypatch)

    markdown, audit, _ = store._gate_memo_markdown(
        "## 财务\n\n- 2025 年收入同比增长 17.4%。",
        info=_info(),
        section_payloads=_sections(),
    )

    assert audit["status"] == "needs_review"
    assert audit["needs_review"] is True
    assert "待复核" in markdown


def test_structured_memo_claims_preserve_explicit_review_status() -> None:
    markdown = _memo_claims_to_markdown(
        [
            {
                "section": "财务",
                "text": "收入增长口径仍需确认。",
                "status": "needs_review",
                "evidence_ids": [],
            }
        ]
    )

    assert markdown == "## 财务\n\n- 收入增长口径仍需确认。 **（待复核）**"


def test_structured_memo_is_gated_and_persists_audit_before_artifact_write(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = _store(monkeypatch)
    dataset_root = tmp_path / "demo"
    info: dict[str, object] = {
        **_info(),
        "name": "Demo dataset",
        "company_ticker": "000001",
        "dataset_root": str(dataset_root),
        "collection_db_path": str(dataset_root / "meta" / "collection.sqlite3"),
    }
    evidence = _sections()[0]["evidence"]
    monkeypatch.setattr(store, "dataset_info", lambda _dataset_id=None: info)
    monkeypatch.setattr(
        store,
        "search",
        lambda **_kwargs: {"evidence": evidence},
    )
    monkeypatch.setattr(
        store,
        "_render_memo_pdf_from_html",
        lambda _html, path: path.write_bytes(b"%PDF-test"),
    )
    monkeypatch.setattr(
        private_fund_tracking,
        "register_memo_version",
        lambda *_args, **_kwargs: {
            "series_id": "memo-series-demo",
            "memo_version_id": "memo-version-demo",
            "version_no": 1,
            "revision_of_version_id": None,
            "tracking_job": None,
        },
    )

    result = store.memo(
        topic="收入增长",
        dataset_id="demo",
        sections=["财务"],
        memo_claims=[
            {
                "section": "财务",
                "text": "2025 年收入同比增长 17.4%。",
                "status": "supported",
                "evidence_ids": ["fact:demo:revenue-2025"],
            }
        ],
    )

    audit_path = Path(str(result["citation_gate_audit_path"]))
    markdown_path = Path(str(result["memo_markdown_path"]))
    assert result["render_mode"] == "assistant_supplied_structured_claims"
    assert result["citation_gate"]["status"] == "passed"
    assert audit_path.is_file()
    assert markdown_path.is_file()
    assert "经营数据.xlsx Sheet1!B2" in markdown_path.read_text(encoding="utf-8")
