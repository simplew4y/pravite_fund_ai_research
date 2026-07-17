from __future__ import annotations

import sqlite3
from pathlib import Path

from omnigent.server import private_fund_valuation_overview as overview
from omnigent.server import private_fund_valuation_tracking as valuation


def _database(path: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    valuation.ensure_valuation_schema(conn, "demo")
    conn.executescript(
        """
        CREATE TABLE excel_cells (
            doc_id TEXT NOT NULL,
            sheet_name TEXT NOT NULL,
            row_index INTEGER NOT NULL,
            col_index INTEGER NOT NULL,
            display_value TEXT,
            raw_value TEXT,
            is_formula INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE metric_facts (
            fact_id TEXT PRIMARY KEY,
            doc_id TEXT NOT NULL,
            metric_name TEXT NOT NULL,
            period TEXT,
            value_text TEXT,
            value_numeric REAL,
            unit TEXT,
            sheet_name TEXT NOT NULL,
            cell_ref TEXT NOT NULL,
            source_range TEXT,
            confidence REAL,
            quality_status TEXT
        );
        """
    )
    conn.execute(
        """
        INSERT INTO valuation_model_series
            (series_id, dataset_id, series_key, name, company_name, company_ticker,
             model_type, current_model_version_id, current_version_no, status,
             created_at, updated_at)
        VALUES ('series-1', 'demo', 'logical-1', '示例 DCF', '示例公司', '000001.SZ',
                'dcf_model', 'version-1', 1, 'active', '2026-07-17', '2026-07-17')
        """
    )
    conn.execute(
        """
        INSERT INTO valuation_model_versions
            (model_version_id, series_id, dataset_id, doc_id, document_version_no,
             checksum, snapshot_hash, original_filename, model_type, node_count,
             formula_node_count, review_required_count, analyzer_version, created_at)
        VALUES ('version-1', 'series-1', 'demo', 'doc-1', 1, 'checksum', 'snapshot',
                '示例<模型>.xlsx', 'dcf_model', 2, 0, 0, 'valuation-tracking-v1',
                '2026-07-17')
        """
    )
    anchors = (
        ("doc-1", "PL_BS_CFS", 2, 1, "Income statement", "Income statement", 0),
        ("doc-1", "PL_BS_CFS", 10, 1, "Balance sheet", "Balance sheet", 0),
        ("doc-1", "PL_BS_CFS", 20, 1, "Cash flow statement", "Cash flow statement", 0),
    )
    conn.executemany("INSERT INTO excel_cells VALUES (?,?,?,?,?,?,?)", anchors)
    rows = (
        ("Revenue", 3, "CNYm", (100.0, 120.0, 150.0)),
        ("Net Profit", 4, "CNYm", (10.0, 14.0, 19.0)),
        ("Total Assets", 11, "CNYm", (300.0, 350.0, 410.0)),
        ("Total Liabilities", 12, "CNYm", (180.0, 195.0, 215.0)),
        ("Operating Cash Flow", 21, "CNYm", (20.0, 26.0, 34.0)),
        ("Free Cash Flow", 22, "CNYm", (12.0, 18.0, 25.0)),
    )
    periods = ("2024A", "2025E", "2026E")
    for row_no, (metric, sheet_row, unit, values) in enumerate(rows):
        for col_no, (period, value) in enumerate(zip(periods, values, strict=True), start=2):
            cell_ref = f"{chr(64 + col_no)}{sheet_row}"
            conn.execute(
                """
                INSERT INTO metric_facts
                    (fact_id, doc_id, metric_name, period, value_text, value_numeric,
                     unit, sheet_name, cell_ref, source_range, confidence, quality_status)
                VALUES (?, 'doc-1', ?, ?, ?, ?, ?, 'PL_BS_CFS', ?, ?, 0.9,
                        'candidate_complete')
                """,
                (
                    f"fact-{row_no}-{col_no}",
                    metric,
                    period,
                    str(value),
                    value,
                    unit,
                    cell_ref,
                    f"PL_BS_CFS!{cell_ref}",
                ),
            )
    for metric_key, label, value, unit, cell_ref in (
        ("target_price", "目标价", 128.0, "CNY/share", "E30"),
        ("wacc", "WACC", 0.082, "%", "E14"),
    ):
        node_id = f"node-{metric_key}"
        conn.execute(
            """
            INSERT INTO valuation_model_nodes
                (node_id, series_id, canonical_key, node_kind, metric_key,
                 display_name, scope, period, scenario, first_seen_at, updated_at)
            VALUES (?, 'series-1', ?, 'output', ?, ?, 'DCF', '2026E', 'base',
                    '2026-07-17', '2026-07-17')
            """,
            (node_id, f"output/{metric_key}", metric_key, label),
        )
        conn.execute(
            """
            INSERT INTO valuation_model_node_values
                (node_value_id, model_version_id, node_id, value_numeric, value_text,
                 unit, formula, formula_fingerprint, sheet_name, cell_ref, evidence_id,
                 quality_status, confidence, metadata_json, created_at)
            VALUES (?, 'version-1', ?, ?, ?, ?, '', '', 'DCF', ?, ?,
                    'candidate_complete', 0.9, '{}', '2026-07-17')
            """,
            (
                f"value-{metric_key}",
                node_id,
                value,
                str(value),
                unit,
                cell_ref,
                f"fact:{metric_key}",
            ),
        )
    conn.commit()
    return conn


def test_extracts_three_statements_trends_and_script_free_html(tmp_path: Path) -> None:
    with _database(tmp_path / "overview.sqlite3") as conn:
        series = dict(conn.execute("SELECT * FROM valuation_model_series").fetchone())
        version = dict(conn.execute("SELECT * FROM valuation_model_versions").fetchone())

        result = overview.ensure_model_overview(
            conn, dataset_id="demo", series=series, version=version
        )
        repeated = overview.ensure_model_overview(
            conn, dataset_id="demo", series=series, version=version
        )

    data = result["overview"]
    assert data["summary"]["statement_count"] == 3
    assert data["summary"]["missing_statements"] == []
    assert {table["statement_type"] for table in data["statements"]} == {
        "income_statement",
        "balance_sheet",
        "cash_flow",
    }
    assert {trend["metric_key"] for trend in data["trends"]} >= {
        "revenue",
        "net_profit",
        "free_cash_flow",
    }
    assert {metric["metric_key"] for metric in data["key_metrics"]} == {
        "target_price",
        "wacc",
    }
    assert result["overview_id"] == repeated["overview_id"]
    assert "<!DOCTYPE html>" in result["html"]
    assert "<script" not in result["html"].lower()
    assert "http://" not in result["html"]
    assert "https://" not in result["html"]
    assert "示例&lt;模型&gt;.xlsx" in result["html"]
