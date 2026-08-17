from __future__ import annotations

import json
from pathlib import Path

import pytest

from omnigent.server import private_fund_tracking
from omnigent.tools.base import ToolContext
from omnigent.tools.builtins.private_fund_dataset import (
    PrivateFundDatasetMemoTool,
    _DatasetStore,
    _memo_claims_to_markdown,
    _strip_memo_generation_directives,
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
                        f"[经营数据.xlsx Sheet1!B2](#source?evidence_id={evidence_id})"
                    ),
                }
            ],
        }
    ]


def _tool_context() -> ToolContext:
    return ToolContext(task_id="task-test", agent_id="agent-test")


def test_memo_schema_requires_explicit_semantic_operation() -> None:
    schema = PrivateFundDatasetMemoTool(None).get_schema()["function"]["parameters"]

    assert schema["required"] == ["operation"]
    assert schema["properties"]["operation"]["enum"] == ["create", "revise"]
    assert "[memo:<memo_version_id>]" in schema["properties"]["revision_of"]["description"]


def test_equity_report_payload_hides_internal_artifact_paths(tmp_path: Path) -> None:
    reports = (
        tmp_path
        / "output"
        / "users"
        / "alice"
        / "private_fund_datasets"
        / "demo"
        / "reports"
    )
    manifest = {
        "markdown_path": str(reports / "report.md"),
        "html_path": str(reports / "report.html"),
        "pdf_path": str(reports / "report.pdf"),
        "package_path": str(reports / "report.json"),
        "chart_paths": [str(reports / "charts" / "revenue.png")],
    }

    payload = _DatasetStore._equity_report_run_payload(
        {"run_id": "run-demo", "artifact_manifest_json": json.dumps(manifest)}
    )

    public_root = "private_fund_datasets/demo/reports"
    assert payload["artifact_manifest"] == {
        "markdown_path": f"{public_root}/report.md",
        "html_path": f"{public_root}/report.html",
        "pdf_path": f"{public_root}/report.pdf",
        "package_path": f"{public_root}/report.json",
        "chart_paths": [f"{public_root}/charts/revenue.png"],
    }
    assert "dataset_id=demo" in payload["pdf_url"]
    assert str(tmp_path) not in json.dumps(payload)


@pytest.mark.parametrize(
    ("payload", "expected_error"),
    [
        ({"topic": "Demo"}, "operation must be either"),
        (
            {"operation": "revise", "topic": "Demo"},
            "revision_of is required when operation='revise'",
        ),
        (
            {"operation": "create", "topic": "Demo", "revision_of": "mv_parent"},
            "revision_of must be omitted when operation='create'",
        ),
    ],
)
def test_memo_tool_rejects_inconsistent_version_intent(
    payload: dict[str, str], expected_error: str
) -> None:
    raw = PrivateFundDatasetMemoTool(None).invoke(json.dumps(payload), _tool_context())

    assert expected_error in json.loads(raw)["error"]


def test_memo_create_reuses_existing_topic_without_rendering(
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
    monkeypatch.setattr(store, "dataset_info", lambda _dataset_id=None: info)
    monkeypatch.setattr(
        store,
        "search",
        lambda **_kwargs: pytest.fail("duplicate create must not search or render"),
    )
    monkeypatch.setattr(
        private_fund_tracking,
        "current_memo_version_for_topic",
        lambda *_args, **_kwargs: {
            "topic": "收入增长",
            "markdown_path": str(dataset_root / "memos" / "memo.md"),
            "html_path": None,
            "pdf_path": None,
            "series_id": "ms_demo",
            "memo_version_id": "mv_demo",
            "version_no": 1,
            "revision_of_version_id": None,
            "inputs": {},
            "sections": [],
        },
    )

    result = store.memo(operation="create", topic="收入增长", dataset_id="demo")

    assert result["memo_version_id"] == "mv_demo"
    assert result["idempotent_replay"] is True
    assert not (dataset_root / "memos").exists()


def test_memo_revision_is_validated_before_artifacts_are_written(
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
    monkeypatch.setattr(store, "dataset_info", lambda _dataset_id=None: info)
    monkeypatch.setattr(
        private_fund_tracking,
        "resolve_memo_revision_target",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            ValueError("Unknown memo revision target: mv_missing")
        ),
    )

    with pytest.raises(ValueError, match="Unknown memo revision target"):
        store.memo(
            operation="revise",
            topic="收入增长",
            dataset_id="demo",
            revision_of="mv_missing",
        )

    assert not (dataset_root / "memos").exists()


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


def test_memo_artifacts_exclude_generation_directives(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = _store(monkeypatch)
    info = {
        **_info(),
        "name": "Demo dataset",
        "company_ticker": "000001",
        "collection_db_path": "/tmp/demo/collection.sqlite3",
    }
    body = (
        "## 用户要求\n\n加入氢能业务。\n\n"
        "## 对话上下文摘要\n\n用户要求全面分析业务范围。\n\n"
        "## 核心观点\n\n- 氢能业务仍需验证。"
    )

    assert _strip_memo_generation_directives(body) == "## 核心观点\n\n- 氢能业务仍需验证。"

    markdown = store._render_supplied_memo_markdown(
        info,
        "业务分析",
        body,
        instructions="加入氢能业务。",
        conversation_context="用户要求全面分析业务范围。",
        revision_of="mv_parent",
        key_questions=["新业务是否形成收入？"],
    )
    html = store._render_supplied_memo_html(
        info,
        "业务分析",
        body,
        instructions="加入氢能业务。",
        conversation_context="用户要求全面分析业务范围。",
        revision_of="mv_parent",
        key_questions=["新业务是否形成收入？"],
    )
    draft_markdown = store._render_memo_markdown(
        info,
        "业务分析",
        _sections(),
        instructions="加入氢能业务。",
        conversation_context="用户要求全面分析业务范围。",
        revision_of="mv_parent",
        key_questions=["新业务是否形成收入？"],
    )
    draft_html = store._render_memo_html(
        info,
        "业务分析",
        _sections(),
        instructions="加入氢能业务。",
        conversation_context="用户要求全面分析业务范围。",
        revision_of="mv_parent",
        key_questions=["新业务是否形成收入？"],
    )

    for artifact in (markdown, html, draft_markdown, draft_html):
        assert "用户要求" not in artifact
        assert "加入氢能业务。" not in artifact
        assert "对话上下文摘要" not in artifact
        assert "用户要求全面分析业务范围。" not in artifact
        assert "关键问题" not in artifact
        assert "新业务是否形成收入？" not in artifact
        assert "修订来源" not in artifact
        assert "mv_parent" not in artifact
        assert "证据库" not in artifact
        assert "/tmp/demo/collection.sqlite3" not in artifact
        assert "Memo 正文" not in artifact
    assert "核心观点" in markdown
    assert "核心观点" in html
    assert html.count("氢能业务仍需验证。") == 1


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
    monkeypatch.setattr(
        private_fund_tracking,
        "current_memo_version_for_topic",
        lambda *_args, **_kwargs: None,
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

    public_prefix = Path("private_fund_datasets") / "demo"
    audit_path = dataset_root / Path(str(result["citation_gate_audit_path"])).relative_to(
        public_prefix
    )
    markdown_path = dataset_root / Path(str(result["memo_markdown_path"])).relative_to(
        public_prefix
    )
    assert result["render_mode"] == "assistant_supplied_structured_claims"
    assert result["citation_gate"]["status"] == "passed"
    assert audit_path.is_file()
    assert markdown_path.is_file()
    assert "经营数据.xlsx Sheet1!B2" in markdown_path.read_text(encoding="utf-8")
