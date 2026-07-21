from __future__ import annotations

import sqlite3
from datetime import date
from pathlib import Path
from typing import Any

import httpx
import pytest

from omnigent.server import private_fund_valuation_metric_agent as metric_agent
from omnigent.server import private_fund_valuation_metrics as metrics
from omnigent.server import private_fund_valuation_tracking as tracking


class _FakeProvider:
    name = "verified-test-api"

    def __init__(self, values: dict[str, Any]) -> None:
        self.values = values

    def fetch_metrics(self, *, company_name: str, ticker: str) -> dict[str, Any]:
        assert company_name == "Demo Corp"
        assert ticker == "300274.SZ"
        return {
            "provider": self.name,
            "status": "completed",
            "as_of": "2026-07-20T05:30:00+00:00",
            "metrics": self.values,
        }


class _FakePriceProvider(_FakeProvider):
    def fetch_daily_prices(
        self, *, ticker: str, start_date: date, end_date: date
    ) -> dict[str, Any]:
        assert ticker == "300274.SZ"
        assert start_date <= date(2026, 7, 20) <= end_date
        return {
            "provider": self.name,
            "provider_symbol": "300274",
            "canonical_ticker": ticker,
            "exchange": "SZ",
            "currency": "CNY",
            "adjustment": "raw",
            "source": "Verified daily API",
            "bars": [
                {"trade_date": "2026-07-17", "close": 80.0, "amount": 10_000.0},
                {"trade_date": "2026-07-20", "close": 82.0, "amount": 12_000.0},
                {"trade_date": date.today().isoformat(), "close": 100.0, "amount": 15_000.0},
            ],
        }


class _FakeAkshare:
    def __init__(self) -> None:
        self.a_share_params: dict[str, Any] = {}
        self.hk_params: dict[str, Any] = {}

    def stock_zh_a_hist(self, **kwargs: Any) -> list[dict[str, Any]]:
        self.a_share_params = kwargs
        return [
            {
                "日期": "2026-07-20",
                "开盘": 10.0,
                "收盘": 10.5,
                "最高": 10.8,
                "最低": 9.9,
                "成交量": 1_000,
                "成交额": 20_000,
            }
        ]

    def stock_hk_hist(self, **kwargs: Any) -> list[dict[str, Any]]:
        self.hk_params = kwargs
        return [{"日期": "2026-07-20", "收盘": 7.38, "成交额": 3_000}]


class _FakeMetricAgent:
    def __init__(self) -> None:
        self.calls = 0

    def chat(
        self,
        messages: list[dict[str, str]],
        *,
        max_tokens: int | None = None,
        temperature: float | None = None,
    ) -> str:
        del messages, max_tokens, temperature
        self.calls += 1
        return """{
          "valuation_date": {
            "value": "2026-07-18",
            "status": "available",
            "confidence": 0.95,
            "source": "Demo_valuation_2026_Jul_20.xlsx",
            "evidence_ids": ["cell:date-cell"],
            "reason": "The workbook contains an explicit valuation date cell."
          },
          "target_period": "2025Q2",
          "metrics": [
            {
              "metric_key": "quarter_net_profit_yoy",
              "value_numeric": 0.5,
              "unit": "percent",
              "period": "2025Q2",
              "status": "available",
              "confidence": 0.98,
              "method": "same_quarter_yoy",
              "source": "QoQ&Results!B7, QoQ&Results!B8",
              "evidence_ids": ["fact:fact-6", "fact:fact-7"],
              "derivation": "150 / 100 - 1"
            },
            {
              "metric_key": "quarter_gross_margin_qoq_delta",
              "value_numeric": 0.05,
              "unit": "percentage_point",
              "period": "2025Q2",
              "status": "available",
              "confidence": 0.96,
              "method": "quarter_margin_delta",
              "source": "QoQ&Results!B3:B6",
              "evidence_ids": ["fact:fact-2", "fact:fact-3", "fact:fact-4", "fact:fact-5"],
              "derivation": "52 / 130 - 38.5 / 110"
            },
            {
              "metric_key": "forward_pe",
              "value_numeric": 25.0,
              "unit": "multiple",
              "period": "2026E",
              "status": "available",
              "confidence": 0.99,
              "method": "explicit_forward_pe",
              "source": "QoQ&Results!B9",
              "evidence_ids": ["fact:fact-8"],
              "derivation": "Explicit model output"
            },
            {
              "metric_key": "avg_turnover_amount_20d",
              "value_numeric": 800000000.0,
              "unit": "currency",
              "period": "20D",
              "status": "available",
              "confidence": 0.99,
              "method": "explicit_model_value",
              "source": "QoQ&Results!B10",
              "evidence_ids": ["fact:fact-9"],
              "derivation": "Explicit model input"
            },
            {
              "metric_key": "quarter_revenue_growth_qoq",
              "value_numeric": 0.02,
              "unit": "percentage_point",
              "period": "2025Q2",
              "status": "available",
              "confidence": 0.97,
              "method": "quarter_yoy_growth_acceleration",
              "source": "QoQ&Results!B1:B4",
              "evidence_ids": ["fact:fact-0", "fact:fact-1", "fact:fact-2", "fact:fact-3"],
              "derivation": "(130 / 100 - 1) - (110 / 100 - 1)"
            }
          ],
          "warnings": []
        }"""


def _create_database(path: Path) -> None:
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
                checksum TEXT NOT NULL,
                status TEXT NOT NULL,
                created_at TEXT NOT NULL
            );
            CREATE TABLE metric_facts (
                fact_id TEXT PRIMARY KEY,
                dataset_id TEXT NOT NULL,
                doc_id TEXT NOT NULL,
                metric_name TEXT NOT NULL,
                metric_alias TEXT,
                period TEXT,
                value_text TEXT,
                value_numeric REAL,
                unit TEXT,
                sheet_name TEXT NOT NULL,
                cell_ref TEXT NOT NULL,
                formula TEXT,
                confidence REAL,
                quality_status TEXT
            );
            CREATE TABLE excel_cells (
                cell_id TEXT PRIMARY KEY,
                doc_id TEXT NOT NULL,
                sheet_name TEXT NOT NULL,
                cell_ref TEXT NOT NULL,
                display_value TEXT,
                raw_value TEXT,
                numeric_value REAL,
                row_label TEXT,
                col_label TEXT,
                number_format TEXT
            );
            CREATE TABLE chunks (
                chunk_id TEXT PRIMARY KEY,
                doc_id TEXT NOT NULL,
                chunk_index INTEGER NOT NULL,
                summary TEXT,
                content TEXT NOT NULL
            );
            """
        )
        tracking.ensure_valuation_schema(conn, "demo")
        now = "2026-07-20T00:00:00+00:00"
        conn.execute(
            """
            INSERT INTO documents
                (doc_id, dataset_id, logical_doc_id, version_no, is_current,
                 lifecycle_state, original_filename, doc_type, doc_subtype,
                 company_name, company_ticker, document_date, checksum, status, created_at)
            VALUES ('model-v1', 'demo', 'logical-model', 1, 1, 'active',
                    'Demo valuation.xlsx', 'valuation_model', 'integrated_model',
                    'Demo Corp', '300274.SZ', '2026-07-20', 'checksum', 'indexed', ?)
            """,
            (now,),
        )
        conn.execute(
            """
            INSERT INTO excel_cells
                (cell_id, doc_id, sheet_name, cell_ref, display_value, raw_value,
                 numeric_value, row_label, col_label, number_format)
            VALUES ('date-cell', 'model-v1', 'Control', 'B2', '2026-07-18',
                    '2026-07-18', NULL, 'Valuation Date', '', 'yyyy-mm-dd')
            """
        )
        conn.execute(
            """
            INSERT INTO valuation_model_series
                (series_id, dataset_id, series_key, name, company_name, company_ticker,
                 model_type, current_model_version_id, current_version_no, status,
                 created_at, updated_at)
            VALUES ('series-1', 'demo', 'logical-model', 'Demo valuation', 'Demo Corp',
                    '300274.SZ', 'integrated_model', 'version-1', 1, 'active', ?, ?)
            """,
            (now, now),
        )
        conn.execute(
            """
            INSERT INTO valuation_model_versions
                (model_version_id, series_id, dataset_id, doc_id, logical_doc_id,
                 document_version_no, checksum, snapshot_hash, original_filename,
                 document_date, model_type, node_count, formula_node_count, review_required_count,
                 analyzer_version, created_at)
            VALUES ('version-1', 'series-1', 'demo', 'model-v1', 'logical-model', 1,
                    'checksum', 'snapshot', 'Demo_valuation_2026_Jul_20.xlsx', '2026-07-20',
                    'integrated_model', 1, 0, 0, 'valuation-tracking-v1', ?)
            """,
            (now,),
        )
        conn.execute(
            """
            INSERT INTO valuation_model_nodes
                (node_id, series_id, canonical_key, node_kind, metric_key, display_name,
                 scope, period, scenario, first_seen_at, updated_at)
            VALUES ('target-node', 'series-1', 'output|target-price|current|base', 'output',
                    'target_price', 'Target Price', 'company', 'Current', 'base', ?, ?)
            """,
            (now, now),
        )
        conn.execute(
            """
            INSERT INTO valuation_model_node_values
                (node_value_id, model_version_id, node_id, value_numeric, value_text,
                 unit, formula, formula_fingerprint, sheet_name, cell_ref, evidence_id,
                 quality_status, confidence, metadata_json, created_at)
            VALUES ('target-value', 'version-1', 'target-node', 120.0, '120.0',
                    'CNY/share', '', '', 'DCF', 'D20', 'fact:target-price',
                    'candidate_complete', 0.99, '{}', ?)
            """,
            (now,),
        )

        rows = [
            ("Revenue", "2024Q1", 100.0),
            ("Revenue", "2024Q2", 100.0),
            ("Revenue", "2025Q1", 110.0),
            ("Revenue", "2025Q2", 130.0),
            ("Gross profit", "2025Q1", 38.5),
            ("Gross profit", "2025Q2", 52.0),
            ("Net profit attributable to shareholders", "2024Q2", 100.0),
            ("Net profit attributable to shareholders", "2025Q2", 150.0),
            ("Forward PE", "2026E", 25.0),
            ("近20日日均成交额", "20D", 800_000_000.0),
        ]
        for index, (name, period, value) in enumerate(rows):
            conn.execute(
                """
                INSERT INTO metric_facts
                    (fact_id, dataset_id, doc_id, metric_name, metric_alias, period,
                     value_text, value_numeric, unit, sheet_name, cell_ref, formula,
                     confidence, quality_status)
                VALUES (?, 'demo', 'model-v1', ?, '', ?, ?, ?, '', 'QoQ&Results', ?, '',
                        0.95, 'candidate_complete')
                """,
                (f"fact-{index}", name, period, str(value), value, f"B{index + 1}"),
            )
        conn.commit()


def _actual_values() -> dict[str, Any]:
    return {
        "quarter_net_profit_yoy": {
            "value": 0.35,
            "period": "2025Q2",
            "source": "Verified financial API",
        },
        "quarter_gross_margin_qoq_delta": {
            "value": 0.02,
            "period": "2025Q2",
            "source": "Verified financial API",
        },
        "forward_pe": {
            "value": 18.0,
            "period": "NTM",
            "source": "Consensus API",
        },
        "avg_turnover_amount_20d": {
            "value": 1_200_000_000.0,
            "period": "20D@20260720",
            "source": "Trading API",
        },
        "quarter_revenue_growth_qoq": {
            "value": 0.05,
            "period": "2025Q2",
            "source": "Verified financial API",
        },
    }


def test_extracts_exactly_five_metrics_and_compares_to_api_values(tmp_path: Path) -> None:
    database = tmp_path / "collection.sqlite3"
    _create_database(database)
    with sqlite3.connect(database) as conn:
        conn.row_factory = sqlite3.Row
        series = dict(conn.execute("SELECT * FROM valuation_model_series").fetchone())
        version = dict(conn.execute("SELECT * FROM valuation_model_versions").fetchone())
        result = metrics.refresh_metric_comparison(
            conn,
            dataset_id="demo",
            series=series,
            version=version,
            provider=_FakeProvider(_actual_values()),
        )
        conn.commit()
        payload = metrics.latest_metric_payload(
            conn,
            dataset_id="demo",
            series_id="series-1",
            model_version_id="version-1",
        )

    assert result["provider"] == "verified-test-api"
    comparisons = payload["metric_comparisons"]
    assert [item["metric_key"] for item in comparisons] == list(metrics.METRIC_KEYS)
    by_key = {item["metric_key"]: item for item in comparisons}
    assert by_key["quarter_net_profit_yoy"]["model_value"] == pytest.approx(0.50)
    assert by_key["quarter_gross_margin_qoq_delta"]["model_value"] == pytest.approx(0.05)
    assert by_key["forward_pe"]["model_value"] == pytest.approx(25.0)
    assert by_key["avg_turnover_amount_20d"]["model_value"] == pytest.approx(800_000_000)
    assert by_key["quarter_revenue_growth_qoq"]["model_value"] == pytest.approx(0.20)
    assert all(item["status"] == "compared" for item in comparisons)
    assert all(item["severity"] in {"warning", "critical"} for item in comparisons)
    timeline = payload["metric_timeline"]
    assert timeline["default_period"] == "2025Q2"
    assert next(
        item for item in timeline["periods"] if item["period"] == "2025Q2"
    )["compared_count"] == 3

    alerts = tracking.list_metric_alerts(database, "demo")
    assert len(alerts) == 5
    assert all(alert["alert_type"] == "model_actual_gap" for alert in alerts)


def test_source_verified_manual_override_survives_refresh(tmp_path: Path) -> None:
    database = tmp_path / "collection.sqlite3"
    _create_database(database)
    with sqlite3.connect(database) as conn:
        conn.row_factory = sqlite3.Row
        metrics.upsert_manual_metric_override(
            conn,
            dataset_id="demo",
            series_id="series-1",
            model_version_id="version-1",
            metric_key="forward_pe",
            value_numeric=30.0,
            period="2026E",
            source="QoQ&Results!B9",
            evidence_ids=["fact:fact-8"],
            derivation="人工核验显式 FY1 P/E 单元格。",
            reviewer="Codex manual review",
        )
        series = dict(conn.execute("SELECT * FROM valuation_model_series").fetchone())
        version = dict(conn.execute("SELECT * FROM valuation_model_versions").fetchone())
        metrics.refresh_metric_comparison(
            conn,
            dataset_id="demo",
            series=series,
            version=version,
            provider=_FakeProvider(_actual_values()),
        )
        metrics.refresh_metric_comparison(
            conn,
            dataset_id="demo",
            series=series,
            version=version,
            provider=_FakeProvider(_actual_values()),
        )
        conn.commit()
        payload = metrics.latest_metric_payload(
            conn,
            dataset_id="demo",
            series_id="series-1",
            model_version_id="version-1",
        )

    forward = next(
        item for item in payload["metric_comparisons"] if item["metric_key"] == "forward_pe"
    )
    assert forward["model_value"] == pytest.approx(30.0)
    assert forward["model_quality_status"] == "manual_verified"
    assert forward["model_method"] == "manual_override:source_verified"
    assert payload["skill_extraction"]["manual_metric_keys"] == ["forward_pe"]
    assert payload["skill_extraction"]["manual_overrides"][0]["derivation"]


def test_manual_override_rejects_unresolved_evidence(tmp_path: Path) -> None:
    database = tmp_path / "collection.sqlite3"
    _create_database(database)
    with sqlite3.connect(database) as conn:
        conn.row_factory = sqlite3.Row
        with pytest.raises(ValueError, match="unresolved manual evidence"):
            metrics.upsert_manual_metric_override(
                conn,
                dataset_id="demo",
                series_id="series-1",
                model_version_id="version-1",
                metric_key="forward_pe",
                value_numeric=30.0,
                period="2026E",
                source="Unknown!A1",
                evidence_ids=["fact:missing"],
                derivation="人工填写。",
                reviewer="Codex manual review",
            )


def test_akshare_normalizes_a_and_h_share_daily_prices() -> None:
    fake = _FakeAkshare()
    provider = metrics.AkshareMarketDataProvider(fake)

    a_share = provider.fetch_daily_prices(
        ticker="300274.SZ", start_date=date(2026, 7, 1), end_date=date(2026, 7, 20)
    )
    hk_share = provider.fetch_daily_prices(
        ticker="9660.HK", start_date=date(2026, 7, 1), end_date=date(2026, 7, 20)
    )

    assert fake.a_share_params == {
        "symbol": "300274",
        "period": "daily",
        "start_date": "20260701",
        "end_date": "20260720",
        "adjust": "",
    }
    assert a_share["canonical_ticker"] == "300274.SZ"
    assert a_share["currency"] == "CNY"
    assert a_share["bars"][0]["close"] == pytest.approx(10.5)
    assert fake.hk_params["symbol"] == "09660"
    assert hk_share["canonical_ticker"] == "9660.HK"
    assert hk_share["currency"] == "HKD"


def test_akshare_is_the_free_default_provider(monkeypatch: pytest.MonkeyPatch) -> None:
    for name in (
        "PRIVATE_FUND_MARKET_DATA_PROVIDER",
        "PRIVATE_FUND_MARKET_DATA_API_URL",
        "TUSHARE_TOKEN",
        "TUSHARE_API_TOKEN",
    ):
        monkeypatch.delenv(name, raising=False)

    assert isinstance(metrics.default_market_data_provider(), metrics.AkshareMarketDataProvider)


def test_target_price_is_compared_with_valuation_and_latest_closes(tmp_path: Path) -> None:
    database = tmp_path / "collection.sqlite3"
    _create_database(database)
    with sqlite3.connect(database) as conn:
        conn.row_factory = sqlite3.Row
        result = metrics.refresh_metric_comparison(
            conn,
            dataset_id="demo",
            series=dict(conn.execute("SELECT * FROM valuation_model_series").fetchone()),
            version=dict(conn.execute("SELECT * FROM valuation_model_versions").fetchone()),
            provider=_FakePriceProvider(_actual_values()),
        )
        conn.commit()
        payload = metrics.latest_metric_payload(
            conn,
            dataset_id="demo",
            series_id="series-1",
            model_version_id="version-1",
        )
        cached_bars = conn.execute("SELECT COUNT(*) FROM valuation_market_price_bars").fetchone()[
            0
        ]

    price = payload["price_comparison"]
    assert result["price_comparison"]["status"] == "completed"
    assert price["target_price"] == pytest.approx(120.0)
    assert price["valuation_date"] == "2026-07-20"
    assert price["benchmark_trade_date"] == "2026-07-20"
    assert price["benchmark_close"] == pytest.approx(82.0)
    assert price["latest_close"] == pytest.approx(100.0)
    assert price["implied_upside"] == pytest.approx(120.0 / 82.0 - 1.0)
    assert price["latest_upside"] == pytest.approx(0.20)
    assert price["target_source"] == "DCF!D20"
    assert cached_bars == 3


def test_agent_skill_formats_metrics_and_overrides_valuation_date(tmp_path: Path) -> None:
    database = tmp_path / "collection.sqlite3"
    _create_database(database)
    agent = _FakeMetricAgent()
    with sqlite3.connect(database) as conn:
        conn.row_factory = sqlite3.Row
        result = metrics.refresh_metric_comparison(
            conn,
            dataset_id="demo",
            series=dict(conn.execute("SELECT * FROM valuation_model_series").fetchone()),
            version=dict(conn.execute("SELECT * FROM valuation_model_versions").fetchone()),
            provider=_FakePriceProvider(_actual_values()),
            llm_client=agent,
        )
        conn.commit()
        payload = metrics.latest_metric_payload(
            conn,
            dataset_id="demo",
            series_id="series-1",
            model_version_id="version-1",
        )

    assert agent.calls == 1
    assert result["skill_extraction"]["applied_metric_keys"] == list(metrics.METRIC_KEYS)
    assert result["skill_extraction"]["conflict_metric_keys"] == []
    assert payload["skill_extraction"]["status"] == "completed"
    assert payload["skill_extraction"]["applied_metric_keys"] == list(metrics.METRIC_KEYS)
    agent_metrics = {
        item["metric_key"]: item
        for item in payload["skill_extraction"]["formatted_output"]["metrics"]
    }
    assert agent_metrics["quarter_revenue_growth_qoq"]["value_numeric"] == pytest.approx(0.2)
    assert agent_metrics["quarter_revenue_growth_qoq"]["method"] == (
        "agent_identified_server_calculated"
    )
    assert payload["price_comparison"]["valuation_date"] == "2026-07-18"
    assert payload["price_comparison"]["benchmark_trade_date"] == "2026-07-17"
    assert payload["price_comparison"]["metadata"]["valuation_date_method"] == "agent_skill"

    with sqlite3.connect(database) as conn:
        conn.row_factory = sqlite3.Row
        metrics.refresh_metric_comparison(
            conn,
            dataset_id="demo",
            series=dict(conn.execute("SELECT * FROM valuation_model_series").fetchone()),
            version=dict(conn.execute("SELECT * FROM valuation_model_versions").fetchone()),
            provider=_FakePriceProvider(_actual_values()),
            llm_client=agent,
        )
    assert agent.calls == 1


def test_agent_skill_rejects_unresolved_evidence_and_non_forward_pe() -> None:
    payload = {
        "valuation_date": {
            "value": "2083-01-01",
            "status": "available",
            "confidence": 0.99,
            "source": "Unknown",
            "evidence_ids": ["cell:not-supplied"],
            "reason": "",
        },
        "target_period": "2025Q2",
        "metrics": [
            {
                "metric_key": "forward_pe",
                "value_numeric": 18.0,
                "status": "available",
                "confidence": 0.99,
                "source": "Current PE",
                "evidence_ids": ["fact:not-supplied"],
            }
        ],
        "warnings": [],
    }
    formatted = metric_agent.validate_output(
        payload,
        allowed_evidence_ids={"fact:supplied"},
        target_period_hint="2025Q2",
    )

    assert formatted["valuation_date"]["status"] == "unavailable"
    assert len(formatted["metrics"]) == 5
    assert all(item["status"] == "unavailable" for item in formatted["metrics"])
    assert any("forward_pe" in warning for warning in formatted["warnings"])


def test_agent_evidence_packet_prioritizes_two_digit_target_quarter() -> None:
    with sqlite3.connect(":memory:") as conn:
        conn.row_factory = sqlite3.Row
        conn.execute(
            """
            CREATE TABLE metric_facts (
                fact_id TEXT PRIMARY KEY,
                doc_id TEXT NOT NULL,
                metric_name TEXT NOT NULL,
                metric_alias TEXT,
                period TEXT,
                value_text TEXT,
                value_numeric REAL,
                unit TEXT,
                sheet_name TEXT,
                cell_ref TEXT,
                formula TEXT,
                confidence REAL,
                quality_status TEXT
            )
            """
        )
        periods = [f"{quarter}Q{year:02d}" for year in range(20, 25) for quarter in range(1, 5)]
        for index, period in enumerate(periods):
            conn.execute(
                """
                INSERT INTO metric_facts VALUES (?, 'model', 'Revenue', '', ?, ?, ?,
                    'CNYm', 'P&L', ?, '', 0.9, 'candidate_complete')
                """,
                (f"fact-{index}", period, str(index), float(index), f"B{index + 1}"),
            )
        candidates = metric_agent._fact_candidates(
            conn,
            "model",
            target_period="2024Q2",
        )

    assert any(
        item["metric_name"] == "Revenue"
        and metric_agent._canonical_quarter(item["period"]) == "2024Q2"
        for item in candidates
    )


def test_document_date_is_reconciled_with_full_filename_date() -> None:
    payload = {
        "valuation_date": {
            "value": "2025-01-01",
            "status": "available",
            "confidence": 0.99,
            "source": "document:model",
            "evidence_ids": ["document:model"],
            "reason": "Document metadata",
        },
        "warnings": [],
    }
    reconciled = metric_agent.reconcile_valuation_date(
        payload,
        evidence_packet={
            "document": {
                "evidence_id": "document:model",
                "original_filename": "Formula_One_FWONA.OQ_2025_Jun_11.xlsx",
            }
        },
    )

    assert reconciled["valuation_date"]["value"] == "2025-06-11"
    assert "Formula_One" in reconciled["valuation_date"]["source"]
    assert any("冲突" in warning for warning in reconciled["warnings"])


def test_missing_actual_value_is_explicit_and_never_alerts(tmp_path: Path) -> None:
    database = tmp_path / "collection.sqlite3"
    _create_database(database)
    actual = _actual_values()
    actual.pop("forward_pe")
    with sqlite3.connect(database) as conn:
        conn.row_factory = sqlite3.Row
        metrics.refresh_metric_comparison(
            conn,
            dataset_id="demo",
            series=dict(conn.execute("SELECT * FROM valuation_model_series").fetchone()),
            version=dict(conn.execute("SELECT * FROM valuation_model_versions").fetchone()),
            provider=_FakeProvider(actual),
        )
        conn.commit()
        payload = metrics.latest_metric_payload(
            conn,
            dataset_id="demo",
            series_id="series-1",
            model_version_id="version-1",
        )

    forward = next(
        item for item in payload["metric_comparisons"] if item["metric_key"] == "forward_pe"
    )
    assert forward["actual_value"] is None
    assert forward["severity"] == "unavailable"
    assert "未触发预警" in forward["explanation"]
    alerts = tracking.list_metric_alerts(database, "demo")
    assert all(alert["title"] != "Forward PE" for alert in alerts)


def test_tushare_quarter_conversion_uses_standalone_values() -> None:
    rows = [
        {"end_date": "20250331", "revenue": 100.0},
        {"end_date": "20250630", "revenue": 230.0},
        {"end_date": "20250930", "revenue": 390.0},
    ]
    standalone = metrics._standalone_quarters(rows, ("revenue",))
    assert standalone[(2025, 1)]["revenue"] == pytest.approx(100.0)
    assert standalone[(2025, 2)]["revenue"] == pytest.approx(130.0)
    assert standalone[(2025, 3)]["revenue"] == pytest.approx(160.0)


def test_tushare_proxy_transport_retries_without_leaking_credentials(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("TUSHARE_MIN_INTERVAL_SECONDS", "0")
    monkeypatch.setenv("TUSHARE_REQUEST_ATTEMPTS", "3")
    monkeypatch.setattr(metrics.time, "sleep", lambda _seconds: None)
    calls: list[dict[str, Any]] = []

    def fake_post(url: str, **kwargs: Any) -> httpx.Response:
        calls.append({"url": url, **kwargs})
        if len(calls) == 1:
            raise httpx.ConnectError("transient TLS failure")
        return httpx.Response(
            200,
            json={
                "code": 0,
                "msg": "",
                "data": {"fields": ["ts_code"], "items": [["300274.SZ"]]},
            },
            request=httpx.Request("POST", url),
        )

    monkeypatch.setattr(metrics.httpx, "post", fake_post)
    provider = metrics.TushareMarketDataProvider("test-token", "https://example.test/api")

    rows = provider._call("stock_basic", {"list_status": "L"}, ["ts_code"])

    assert rows == [{"ts_code": "300274.SZ"}]
    assert len(calls) == 2
    assert calls[-1]["headers"]["Accept-Encoding"] == "gzip"


def test_tushare_provider_reuses_short_lived_metric_cache(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("TUSHARE_MIN_INTERVAL_SECONDS", "0")
    monkeypatch.setenv("TUSHARE_CACHE_TTL_SECONDS", "300")
    provider = metrics.TushareMarketDataProvider("test-token", "https://example.test/api")
    api_calls: list[str] = []

    def fake_call(
        api_name: str, _params: dict[str, Any], _fields: list[str]
    ) -> list[dict[str, Any]]:
        api_calls.append(api_name)
        return []

    monkeypatch.setattr(provider, "_call", fake_call)

    first = provider.fetch_metrics(company_name="Demo", ticker="300274.SZ")
    second = provider.fetch_metrics(company_name="Demo", ticker="300274.SZ")

    assert first == second
    assert api_calls == ["income", "daily"]


def test_tushare_provider_builds_period_aligned_historical_metrics(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("TUSHARE_MIN_INTERVAL_SECONDS", "0")
    provider = metrics.TushareMarketDataProvider("test-token", "https://example.test/api")
    income = [
        {
            "end_date": "20240331",
            "ann_date": "20240425",
            "revenue": 100.0,
            "oper_cost": 60.0,
            "n_income_attr_p": 10.0,
        },
        {
            "end_date": "20240630",
            "ann_date": "20240824",
            "revenue": 220.0,
            "oper_cost": 130.0,
            "n_income_attr_p": 25.0,
        },
        {
            "end_date": "20250331",
            "ann_date": "20250425",
            "revenue": 130.0,
            "oper_cost": 70.0,
            "n_income_attr_p": 20.0,
        },
        {
            "end_date": "20250630",
            "ann_date": "20250824",
            "revenue": 290.0,
            "oper_cost": 150.0,
            "n_income_attr_p": 50.0,
        },
    ]
    daily = [
        {
            "trade_date": (date(2025, 6, 30) - metrics.timedelta(days=index)).strftime(
                "%Y%m%d"
            ),
            "close": 80.0,
            "amount": 100.0 + index,
        }
        for index in range(30)
    ]

    def fake_call(
        api_name: str, _params: dict[str, Any], _fields: list[str]
    ) -> list[dict[str, Any]]:
        return income if api_name == "income" else daily

    monkeypatch.setattr(provider, "_call", fake_call)

    payload = provider.fetch_metrics(company_name="Demo", ticker="300274.SZ")

    history = {item["period"]: item for item in payload["metric_history"]}
    q2 = history["2025Q2"]["metrics"]
    assert q2["quarter_net_profit_yoy"]["value"] == pytest.approx(1.0)
    assert q2["quarter_gross_margin_qoq_delta"]["value"] == pytest.approx(
        0.5 - 60.0 / 130.0
    )
    assert q2["quarter_revenue_growth_qoq"]["value"] == pytest.approx(
        (160.0 / 120.0 - 1.0) - (130.0 / 100.0 - 1.0)
    )
    assert q2["avg_turnover_amount_20d"]["period"].startswith("20D@202506")


def test_metric_timeline_defaults_to_latest_comparable_period(tmp_path: Path) -> None:
    database = tmp_path / "collection.sqlite3"
    _create_database(database)
    current = {
        key: {**value, "period": "2026Q1"}
        for key, value in _actual_values().items()
    }
    historical = _actual_values()

    class HistoricalProvider:
        name = "historical-test-api"

        def fetch_metrics(self, *, company_name: str, ticker: str) -> dict[str, Any]:
            assert company_name == "Demo Corp"
            assert ticker == "300274.SZ"
            return {
                "provider": self.name,
                "status": "completed",
                "as_of": "2026-07-21T00:00:00Z",
                "metrics": current,
                "metric_history": [
                    {"period": "2025Q2", "metrics": historical},
                    {"period": "2026Q1", "metrics": current},
                ],
            }

    with sqlite3.connect(database) as conn:
        conn.row_factory = sqlite3.Row
        metrics.refresh_metric_comparison(
            conn,
            dataset_id="demo",
            series=dict(conn.execute("SELECT * FROM valuation_model_series").fetchone()),
            version=dict(conn.execute("SELECT * FROM valuation_model_versions").fetchone()),
            provider=HistoricalProvider(),
        )
        conn.commit()
        payload = metrics.latest_metric_payload(
            conn,
            dataset_id="demo",
            series_id="series-1",
            model_version_id="version-1",
        )

    timeline = payload["metric_timeline"]
    assert timeline["default_period"] == "2025Q2"
    assert timeline["latest_period"] == "2026Q1"
    by_period = {item["period"]: item for item in timeline["periods"]}
    q2_net = next(
        item
        for item in by_period["2025Q2"]["comparisons"]
        if item["metric_key"] == "quarter_net_profit_yoy"
    )
    q1_net = next(
        item
        for item in by_period["2026Q1"]["comparisons"]
        if item["metric_key"] == "quarter_net_profit_yoy"
    )
    assert q2_net["model_value"] == pytest.approx(0.5)
    assert q2_net["actual_value"] == pytest.approx(0.35)
    assert q2_net["status"] == "compared"
    assert q1_net["model_value"] is None
    assert q1_net["actual_value"] == pytest.approx(0.35)


def test_configured_tushare_proxy_is_selected(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("PRIVATE_FUND_MARKET_DATA_PROVIDER", "tushare")
    monkeypatch.setenv("TUSHARE_TOKEN", "test-token")
    monkeypatch.setenv("TUSHARE_API_URL", "https://example.test/api")

    provider = metrics.default_market_data_provider()

    assert isinstance(provider, metrics.TushareMarketDataProvider)
    assert provider.base_url == "https://example.test/api"


def test_hybrid_provider_routes_a_shares_to_tushare_and_hk_to_fallback() -> None:
    class RecordingProvider:
        def __init__(self, name: str) -> None:
            self.name = name
            self.tickers: list[str] = []

        def fetch_metrics(self, *, company_name: str, ticker: str) -> dict[str, Any]:
            del company_name
            self.tickers.append(ticker)
            return {"provider": self.name, "status": "completed", "metrics": {}}

    a_share = RecordingProvider("a-share")
    hk = RecordingProvider("hk")
    provider = metrics.RoutedMarketDataProvider(
        a_share_provider=a_share,
        hk_provider=hk,
    )

    provider.fetch_metrics(company_name="Sungrow", ticker="300274.SZ")
    provider.fetch_metrics(company_name="Horizon", ticker="9660.HK")
    unsupported = provider.fetch_metrics(company_name="Porsche", ticker="P911.DE")

    assert a_share.tickers == ["300274.SZ"]
    assert hk.tickers == ["9660.HK"]
    assert unsupported["status"] == "unavailable"


def test_tushare_adapter_does_not_send_non_a_share_codes(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    provider = metrics.TushareMarketDataProvider("test-token", "https://example.test/api")
    monkeypatch.setattr(
        provider,
        "_call",
        lambda *_args, **_kwargs: pytest.fail("unsupported ticker reached Tushare API"),
    )

    result = provider.fetch_metrics(company_name="Horizon", ticker="9660.HK")

    assert result["status"] == "unavailable"


def test_quarterly_comparison_rejects_period_mismatch() -> None:
    result = metrics._comparison(
        metrics.METRIC_BY_KEY["quarter_net_profit_yoy"],
        {"value_numeric": 0.25, "period": "2024Q2"},
        {"value_numeric": 0.10, "period": "2026Q1"},
    )

    assert result["status"] == "period_mismatch"
    assert result["severity"] == "unavailable"
    assert result["absolute_gap"] is None
    assert "未触发预警" in result["explanation"]


def test_period_mismatch_dismisses_stale_quarterly_alerts(tmp_path: Path) -> None:
    database = tmp_path / "collection.sqlite3"
    _create_database(database)
    mismatched_actuals = _actual_values()
    for key in metrics.QUARTERLY_COMPARISON_KEYS:
        mismatched_actuals[key] = {**mismatched_actuals[key], "period": "2026Q1"}

    with sqlite3.connect(database) as conn:
        conn.row_factory = sqlite3.Row
        series = dict(conn.execute("SELECT * FROM valuation_model_series").fetchone())
        version = dict(conn.execute("SELECT * FROM valuation_model_versions").fetchone())
        metrics.refresh_metric_comparison(
            conn,
            dataset_id="demo",
            series=series,
            version=version,
            provider=_FakeProvider(_actual_values()),
        )
        metrics.refresh_metric_comparison(
            conn,
            dataset_id="demo",
            series=series,
            version=version,
            provider=_FakeProvider(mismatched_actuals),
        )
        conn.commit()

    active_alerts = tracking.list_metric_alerts(database, "demo", status="new")

    assert {alert["title"] for alert in active_alerts} == {
        "Forward PE",
        "近20日日均成交额",
    }


@pytest.mark.parametrize(
    ("label", "expected"),
    [
        ("Q1-23", (2023, 1)),
        ("4Q 23", (2023, 4)),
        ("4Q99", (1999, 4)),
        ("2025 Q2", (2025, 2)),
    ],
)
def test_quarter_parser_supports_real_model_header_variants(
    label: str, expected: tuple[int, int]
) -> None:
    assert metrics._parse_quarter(label) == expected


@pytest.mark.parametrize(
    ("label", "expected"),
    [
        ("Total revenue", "revenue"),
        ("Group Sales", "revenue"),
        ("Net profit / (loss) to shareholder", "net_profit"),
        ("Gross Margin %", "gross_margin"),
        ("Total COGS", "cost"),
        ("Sales expense / sales", ""),
    ],
)
def test_model_metric_aliases_cover_common_bank_model_labels(label: str, expected: str) -> None:
    assert metrics._base_metric_kind(label) == expected


def test_metric_units_separate_margin_rows_from_amount_rows() -> None:
    assert metrics._fact_metric_kind({"metric_name": "Total gross profit", "unit": "%"}) == (
        "gross_margin"
    )
    assert metrics._fact_metric_kind({"metric_name": "Revenue", "unit": "%"}) == ""


def test_structural_workbook_detection_routes_misclassified_model(tmp_path: Path) -> None:
    database = tmp_path / "collection.sqlite3"
    _create_database(database)
    with sqlite3.connect(database) as conn:
        conn.row_factory = sqlite3.Row
        conn.execute(
            "UPDATE documents SET doc_type='financial_valuation_data', "
            "doc_subtype='financial_statements' WHERE doc_id='model-v1'"
        )
        conn.execute(
            "CREATE TABLE excel_workbooks (doc_id TEXT PRIMARY KEY, workbook_type TEXT NOT NULL)"
        )
        conn.execute("INSERT INTO excel_workbooks VALUES ('model-v1', 'valuation_model')")
        documents = tracking._model_documents(conn, "demo", current_only=True)

    assert [document["doc_id"] for document in documents] == ["model-v1"]


def test_auxiliary_document_becomes_context_card_only(tmp_path: Path) -> None:
    database = tmp_path / "collection.sqlite3"
    _create_database(database)
    with sqlite3.connect(database) as conn:
        conn.row_factory = sqlite3.Row
        conn.execute(
            """
            INSERT INTO documents
                (doc_id, dataset_id, logical_doc_id, version_no, is_current,
                 lifecycle_state, original_filename, doc_type, doc_subtype,
                 company_name, company_ticker, document_date, checksum, status, created_at)
            VALUES ('meeting-1', 'demo', 'meeting-logical', 1, 1, 'active',
                    'Management meeting.pdf', 'meeting_minutes', 'meeting_minutes',
                    'Demo Corp', '300274.SZ', '2026-07-18', 'meeting-checksum',
                    'indexed', '2026-07-18T00:00:00+00:00')
            """
        )
        conn.execute(
            """
            INSERT INTO chunks (chunk_id, doc_id, chunk_index, summary, content)
            VALUES ('chunk-1', 'meeting-1', 0,
                    'Management expects gross margin to stabilize.', 'full text')
            """
        )
        cards = metrics.refresh_context_cards(
            conn,
            dataset_id="demo",
            model_version_id="version-1",
        )
        conn.commit()

    assert len(cards) == 1
    assert cards[0]["card_type"] == "管理层口径"
    assert cards[0]["title"] == "Management meeting"
    assert "gross margin" in cards[0]["summary"]
    assert cards[0]["evidence_ids"] == ["document:meeting-1"]
    with sqlite3.connect(database) as conn:
        assert conn.execute("SELECT COUNT(*) FROM valuation_metric_comparisons").fetchone()[0] == 0
