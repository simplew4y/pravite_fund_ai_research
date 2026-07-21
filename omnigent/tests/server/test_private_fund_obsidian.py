from __future__ import annotations

import sqlite3
from pathlib import Path

import yaml

from omnigent.server import private_fund_obsidian as obsidian
from omnigent.server import private_fund_obsidian_worker as obsidian_worker
from omnigent.server import private_fund_tracking as tracking
from omnigent.server import private_fund_valuation_tracking as valuation


def _create_collection(path: Path) -> None:
    with sqlite3.connect(path) as conn:
        conn.executescript(
            """
            CREATE TABLE documents (
                doc_id TEXT PRIMARY KEY,
                dataset_id TEXT NOT NULL,
                logical_doc_id TEXT,
                version_no INTEGER NOT NULL,
                is_current INTEGER NOT NULL,
                lifecycle_state TEXT NOT NULL,
                original_filename TEXT NOT NULL,
                doc_type TEXT,
                doc_subtype TEXT,
                company_name TEXT,
                company_ticker TEXT,
                document_date TEXT,
                stored_path TEXT,
                file_type TEXT,
                checksum TEXT NOT NULL,
                status TEXT NOT NULL,
                created_at TEXT NOT NULL
            );
            CREATE TABLE excel_sheets (
                doc_id TEXT NOT NULL,
                sheet_name TEXT NOT NULL,
                sheet_role TEXT NOT NULL
            );
            CREATE TABLE metric_facts (
                fact_id TEXT PRIMARY KEY,
                dataset_id TEXT NOT NULL,
                doc_id TEXT NOT NULL,
                metric_name TEXT NOT NULL,
                period TEXT,
                value_text TEXT,
                value_numeric REAL,
                unit TEXT,
                sheet_name TEXT NOT NULL,
                cell_ref TEXT NOT NULL,
                source_range TEXT,
                formula TEXT,
                confidence REAL,
                fact_status TEXT,
                quality_status TEXT,
                quality_issues_json TEXT,
                metadata_json TEXT
            );
            """
        )


def _insert_model(
    path: Path,
    *,
    doc_id: str,
    version_no: int,
    current: bool,
    target_price: float,
    wacc: float,
) -> None:
    with sqlite3.connect(path) as conn:
        if current:
            conn.execute(
                """
                UPDATE documents SET is_current=0, lifecycle_state='superseded'
                WHERE logical_doc_id='logical-model'
                """
            )
        conn.execute(
            """
            INSERT INTO documents
                (doc_id, dataset_id, logical_doc_id, version_no, is_current,
                 lifecycle_state, original_filename, doc_type, doc_subtype,
                 company_name, company_ticker, document_date, stored_path,
                 file_type, checksum, status, created_at)
            VALUES (?, 'demo', 'logical-model', ?, ?, ?, ?, 'valuation_model',
                    'dcf_model', 'Demo Corp', 'DEMO', ?, '', 'xlsx', ?,
                    'indexed', ?)
            """,
            (
                doc_id,
                version_no,
                int(current),
                "active" if current else "superseded",
                f"Demo_DCF_v{version_no}.xlsx",
                f"2026-07-{10 + version_no:02d}",
                f"checksum-{doc_id}",
                f"2026-07-{10 + version_no:02d}T00:00:00+00:00",
            ),
        )
        conn.execute(
            "INSERT INTO excel_sheets VALUES (?, 'DCF', 'valuation_dcf')",
            (doc_id,),
        )
        for index, (metric, period, value, unit, cell, formula) in enumerate(
            (
                ("Target Price", "Current", target_price, "USD", "E10", "=E8/E9"),
                ("WACC", "Long term", wacc, "%", "E5", ""),
                ("Revenue", "2027E", 1000 + version_no * 100, "USDm", "E20", "=D20*(1+E19)"),
            )
        ):
            conn.execute(
                """
                INSERT INTO metric_facts
                    (fact_id, dataset_id, doc_id, metric_name, period, value_text,
                     value_numeric, unit, sheet_name, cell_ref, source_range,
                     formula, confidence, fact_status, quality_status,
                     quality_issues_json, metadata_json)
                VALUES (?, 'demo', ?, ?, ?, ?, ?, ?, 'DCF', ?, ?, ?, 0.9,
                        'candidate', 'candidate_complete', '[]', '{}')
                """,
                (
                    f"fact-{doc_id}-{index}",
                    doc_id,
                    metric,
                    period,
                    str(value),
                    value,
                    unit,
                    cell,
                    f"DCF!{cell}",
                    formula,
                ),
            )


def _register_memo(
    database: Path,
    directory: Path,
    *,
    index: int,
    markdown: str,
) -> dict[str, object]:
    path = directory / f"memo-v{index}.md"
    path.write_text(markdown, encoding="utf-8")
    return tracking.register_memo_version(
        database,
        "demo",
        topic="海外盈利能力",
        markdown_path=path,
        source_type="test",
        created_at=f"2026-07-{index + 10:02d}T00:00:00+00:00",
        enqueue=False,
    )


def _prepare_versions(tmp_path: Path) -> tuple[Path, Path]:
    database = tmp_path / "collection.sqlite3"
    vault = tmp_path / "vault"
    vault.mkdir()
    _create_collection(database)
    _insert_model(
        database,
        doc_id="model-v1",
        version_no=1,
        current=False,
        target_price=100,
        wacc=0.10,
    )
    _insert_model(
        database,
        doc_id="model-v2",
        version_no=2,
        current=True,
        target_price=120,
        wacc=0.11,
    )
    _register_memo(
        database,
        tmp_path,
        index=1,
        markdown="## 核心结论\n\n海外利润率改善。\n\n## 风险\n\n渠道库存上升。\n",
    )
    _register_memo(
        database,
        tmp_path,
        index=2,
        markdown="## 核心结论\n\n海外利润率显著改善。\n",
    )
    valuation.enqueue_model_documents(database, "demo", include_history=True)
    while valuation.process_next_job(database, "demo"):
        pass
    return database, vault


def test_projects_memo_and_valuation_series_with_diffs_and_bases(tmp_path: Path) -> None:
    database, vault = _prepare_versions(tmp_path)

    result = obsidian.sync_dataset(database, "demo", vault)

    assert result["events_processed"] == 2
    assert result["failed"] == 0
    knowledge_root = vault / obsidian.KNOWLEDGE_ROOT_NAME
    memo_home = next(knowledge_root.rglob("Memo首页.md"))
    memo_versions = sorted(memo_home.parent.glob("versions/*.md"))
    memo_change = next(memo_home.parent.glob("changes/*.md"))
    valuation_home = next(knowledge_root.rglob("估值模型首页.md"))
    valuation_versions = sorted(valuation_home.parent.glob("versions/*.md"))
    valuation_change = next(valuation_home.parent.glob("changes/*.md"))

    assert len(memo_versions) == 2
    assert "v002" in memo_home.read_text(encoding="utf-8")
    assert "本版未提及（not_mentioned）" in memo_change.read_text(encoding="utf-8")
    assert "风险" in memo_change.read_text(encoding="utf-8")
    assert len(valuation_versions) == 2
    assert "v002" in valuation_home.read_text(encoding="utf-8")
    valuation_diff = valuation_change.read_text(encoding="utf-8")
    assert "Target Price" in valuation_diff
    assert "WACC" in valuation_diff
    assert "（高）" in valuation_diff
    analysis_note = sorted(valuation_home.parent.glob("analyses/v*-确定性分析.md"))[-1]
    analysis_text = analysis_note.read_text(encoding="utf-8")
    assert "## 可读性审查" in analysis_text
    assert "查看上游原始机器摘要" in analysis_text
    assert "具体数值、重要性和来源以版本差异页为准" in analysis_text
    evidence_cards = sorted(valuation_home.parent.glob("evidence/*.md"))
    assert evidence_cards
    assert "## 来源定位" in evidence_cards[0].read_text(encoding="utf-8")
    assert "evidence/" in valuation_versions[-1].read_text(encoding="utf-8")

    for base_path in knowledge_root.rglob("*.base"):
        parsed = yaml.safe_load(base_path.read_text(encoding="utf-8"))
        assert parsed["views"]
        assert parsed["formulas"]["entry"] == "link(file.path, title)"

    second = obsidian.sync_dataset(database, "demo", vault)
    assert second["events_created"] == 0
    assert second["events_processed"] == 0
    assert len(list(memo_home.parent.glob("versions/*.md"))) == 2
    assert len(list(valuation_home.parent.glob("versions/*.md"))) == 2


def test_preserves_user_block_and_reports_managed_region_conflicts(tmp_path: Path) -> None:
    database, vault = _prepare_versions(tmp_path)
    obsidian.sync_dataset(database, "demo", vault)
    memo_home = next((vault / obsidian.KNOWLEDGE_ROOT_NAME).rglob("Memo首页.md"))
    original = memo_home.read_text(encoding="utf-8")
    memo_home.write_text(
        original.replace(
            "本区域由研究员维护，后台同步不得覆盖。",
            "本区域由研究员维护，后台同步不得覆盖。\n> 我的长期判断：海外业务仍需季度验证。",
        ),
        encoding="utf-8",
    )
    _register_memo(
        database,
        tmp_path,
        index=3,
        markdown="## 核心结论\n\n海外利润率继续改善。\n\n## 催化剂\n\n新渠道放量。\n",
    )

    updated = obsidian.sync_dataset(database, "demo", vault)

    assert updated["conflicts"] == 0
    refreshed = memo_home.read_text(encoding="utf-8")
    assert "我的长期判断：海外业务仍需季度验证。" in refreshed
    assert "v003" in refreshed

    memo_home.write_text(
        refreshed.replace("## 当前研究结论", "## 被人工修改的当前研究结论"),
        encoding="utf-8",
    )
    _register_memo(
        database,
        tmp_path,
        index=4,
        markdown="## 核心结论\n\n海外利润率进入稳定期。\n",
    )

    conflicted = obsidian.sync_dataset(database, "demo", vault)

    assert conflicted["conflicts"] >= 1
    assert "被人工修改的当前研究结论" in memo_home.read_text(encoding="utf-8")
    conflicts = list(
        (vault / obsidian.KNOWLEDGE_ROOT_NAME / "99-系统" / "冲突").glob("*.md")
    )
    assert conflicts
    assert "未自动覆盖" in conflicts[-1].read_text(encoding="utf-8")


def test_standalone_worker_discovers_and_projects_dataset(tmp_path: Path) -> None:
    database, _unused_vault = _prepare_versions(tmp_path)
    workspace = tmp_path / "datasets"
    target = workspace / "demo" / "meta" / "collection.sqlite3"
    target.parent.mkdir(parents=True)
    with sqlite3.connect(database) as source, sqlite3.connect(target) as destination:
        source.backup(destination)
    vault = tmp_path / "worker-vault"

    processed = obsidian_worker.run_cycle(workspace, vault)

    assert processed == 2
    assert (vault / obsidian.KNOWLEDGE_ROOT_NAME / "00-总览" / "投研首页.md").is_file()
    health = (workspace / ".obsidian-projection-worker.json").read_text(encoding="utf-8")
    assert '"status": "online"' in health
    assert '"dataset_count": 1' in health


def test_quality_gate_quarantines_year_headers() -> None:
    usable, reason = obsidian._valuation_quality_gate(
        {
            "value_numeric": 2027,
            "value_text": "2027",
            "formula": "",
            "unit": "",
            "quality_status": "review_required",
            "confidence": 0.65,
            "source_col_label": "2027",
            "metadata": {
                "quality_issues": [
                    "metric_name_inferred_from_nearest_left_label",
                    "unit_missing",
                ]
            },
        }
    )

    assert usable is False
    assert "期间表头" in reason
