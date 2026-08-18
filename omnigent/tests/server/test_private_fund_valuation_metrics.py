from __future__ import annotations

import sqlite3
import time
from datetime import date, timedelta
from pathlib import Path
from typing import Any

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


class _FakeHttpResponse:
    def __init__(self, payload: dict[str, Any]) -> None:
        self.payload = payload

    def raise_for_status(self) -> None:
        return None

    def json(self) -> dict[str, Any]:
        return self.payload


class _FakeEastmoneyClient:
    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []

    def get(self, _url: str, **kwargs: Any) -> _FakeHttpResponse:
        self.calls.append(kwargs)
        return _FakeHttpResponse(
            {
                "result": {
                    "data": [
                        {
                            "REPORT_DATE": "2025-09-30",
                            "NOTICE_DATE": "2025-10-29",
                            "PARENT_NETPROFIT_YOY": 25.0,
                            "XSMLL": 32.0,
                            "TOTAL_OPERATE_INCOME_YOY": 18.0,
                        },
                        {
                            "REPORT_DATE": "2025-06-30",
                            "NOTICE_DATE": "2025-08-30",
                            "PARENT_NETPROFIT_YOY": 20.0,
                            "XSMLL": 30.0,
                            "TOTAL_OPERATE_INCOME_YOY": 12.0,
                        },
                    ]
                }
            }
        )


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



def test_standard_five_metric_template_adapts_excel_cells(tmp_path: Path) -> None:
    database = tmp_path / "collection.sqlite3"
    _create_database(database)
    headers = [
        "\u6307\u6807\u540d\u79f0",
        "\u6307\u6807\u4ee3\u7801",
        "\u5355\u4f4d",
        "\u8ba1\u7b97\u516c\u5f0f",
        "2024Q4",
    ]
    metric_rows = [
        ("Net profit YoY", "quarter_net_profit_yoy", "%", "formula", -0.2),
        ("Gross margin QoQ", "quarter_gross_margin_qoq_delta", "percentage_point", "formula", 0.01),
        ("Forward PE", "forward_pe", "x", "formula", 18.5),
        ("20D turnover", "avg_turnover_amount_20d", "\u767e\u4e07\u5143", "formula", 3200.0),
        ("Revenue growth QoQ", "quarter_revenue_growth_qoq", "percentage_point", "formula", 0.03),
    ]
    with sqlite3.connect(database) as conn:
        conn.row_factory = sqlite3.Row
        for column, value in enumerate(headers, start=1):
            conn.execute(
                """INSERT INTO excel_cells
                   (cell_id, doc_id, sheet_name, cell_ref, display_value, raw_value,
                    numeric_value, row_label, col_label, number_format)
                   VALUES (?, 'model-v1', 'Model', ?, ?, ?, NULL, '', '', 'General')""",
                (f"header-{column}", f"{chr(64 + column)}6", value, value),
            )
        for row_index, (name, code, unit, formula, value) in enumerate(metric_rows, start=7):
            for column, cell_value in enumerate((name, code, unit, formula, value), start=1):
                conn.execute(
                    """INSERT INTO excel_cells
                       (cell_id, doc_id, sheet_name, cell_ref, display_value, raw_value,
                        numeric_value, row_label, col_label, number_format)
                       VALUES (?, 'model-v1', 'Model', ?, ?, ?, ?, '', '', 'General')""",
                    (
                        f"metric-{row_index}-{column}",
                        f"{chr(64 + column)}{row_index}",
                        str(cell_value),
                        str(cell_value),
                        float(cell_value) if column == 5 else None,
                    ),
                )
        facts = metrics._facts_for_document(conn, "model-v1")
        explicit = metrics._explicit_five_metric_contract(facts)

    assert set(explicit) == set(metrics.METRIC_KEYS)
    assert explicit["forward_pe"]["period"] == "2024Q4"
    assert explicit["forward_pe"]["value_numeric"] == pytest.approx(18.5)
    assert explicit["avg_turnover_amount_20d"]["value_numeric"] == pytest.approx(
        3_200_000_000.0
    )
    assert explicit["quarter_net_profit_yoy"]["formula"] == "formula"



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
    assert by_key["avg_turnover_amount_20d"]["status"] == "period_mismatch"
    assert all(
        item["status"] == "compared"
        for item in comparisons
        if item["metric_key"] != "avg_turnover_amount_20d"
    )
    assert all(
        item["severity"] in {"warning", "critical"}
        for item in comparisons
        if item["metric_key"] != "avg_turnover_amount_20d"
    )
    timeline = payload["metric_timeline"]
    assert timeline["default_period"] == "2025Q2"
    selected_period = next(
        item for item in timeline["periods"] if item["period"] == "2025Q2"
    )
    assert selected_period["compared_count"] == 3
    assert {
        item["metric_key"] for item in selected_period["comparisons"]
    } == metrics.QUARTERLY_COMPARISON_KEYS

    alerts = tracking.list_metric_alerts(database, "demo")
    assert {alert["title"] for alert in alerts} == {
        "单季净利润增速",
        "单季毛利率环比变化",
        "单季营收增速环比",
    }
    assert all(alert["alert_type"] == "model_actual_gap" for alert in alerts)



def test_market_refresh_preserves_model_values_when_actual_period_is_newer(
    tmp_path: Path,
) -> None:
    database = tmp_path / "collection.sqlite3"
    _create_database(database)
    with sqlite3.connect(database) as conn:
        conn.row_factory = sqlite3.Row
        series = dict(conn.execute("SELECT * FROM valuation_model_series").fetchone())
        version = dict(conn.execute("SELECT * FROM valuation_model_versions").fetchone())
        model_result = metrics.refresh_model_metric_values(
            conn,
            dataset_id="demo",
            series=series,
            version=version,
        )
        assert model_result["model_metric_count"] == 5

        newer_actuals = {key: dict(value) for key, value in _actual_values().items()}
        for key in metrics.QUARTERLY_COMPARISON_KEYS:
            newer_actuals[key]["period"] = "2026Q1"
        metrics.refresh_metric_comparison(
            conn,
            dataset_id="demo",
            series=series,
            version=version,
            provider=_FakeProvider(newer_actuals),
        )
        conn.commit()
        stored = {
            str(row["metric_key"]): row["value_numeric"]
            for row in conn.execute(
                "SELECT metric_key, value_numeric FROM valuation_metric_model_values"
            )
        }
        payload = metrics.latest_metric_payload(
            conn,
            dataset_id="demo",
            series_id="series-1",
            model_version_id="version-1",
        )

    comparisons = {item["metric_key"]: item for item in payload["metric_comparisons"]}
    assert all(stored[key] is not None for key in metrics.METRIC_KEYS)
    assert all(
        comparisons[key]["model_value"] is not None
        and comparisons[key]["status"] == "period_mismatch"
        and comparisons[key]["severity"] == "unavailable"
        for key in metrics.QUARTERLY_COMPARISON_KEYS
    )


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


def test_hk_ticker_accepts_short_code_and_pads_provider_symbol() -> None:
    identity = metrics._security_identity("700.HK")

    assert identity.canonical_ticker == "700.HK"
    assert identity.provider_symbol == "00700"
    assert identity.market == "hk"


def test_free_combo_is_the_free_default_provider(monkeypatch: pytest.MonkeyPatch) -> None:
    for name in (
        "PRIVATE_FUND_MARKET_DATA_PROVIDER",
        "PRIVATE_FUND_MARKET_DATA_API_URL",
        "PRIVATE_FUND_CONSENSUS_API_URL",
        "PRIVATE_FUND_IFIND_BASE_URL",
        "PRIVATE_FUND_IFIND_ACCESS_TOKEN",
    ):
        monkeypatch.delenv(name, raising=False)

    provider = metrics.default_market_data_provider()

    assert isinstance(provider, metrics.FreeComboMarketDataProvider)
    assert [item.name for item in provider._providers_for_metrics("300274.SZ")] == [
        "akshare",
        "eastmoney_financial",
    ]
    assert [item.name for item in provider._providers_for_metrics("700.HK")] == [
        "tencent_hk",
        "yahoo",
    ]



def test_hybrid_alias_selects_the_free_combo_provider(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("PRIVATE_FUND_MARKET_DATA_PROVIDER", "hybrid")

    provider = metrics.default_market_data_provider()

    assert isinstance(provider, metrics.FreeComboMarketDataProvider)


def test_default_market_data_provider_rejects_unknown_selection(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("PRIVATE_FUND_MARKET_DATA_PROVIDER", "unexpected")

    with pytest.raises(ValueError, match="Unsupported PRIVATE_FUND_MARKET_DATA_PROVIDER"):
        metrics.default_market_data_provider()
def test_ifind_rows_parses_official_tables_and_datatype_shape() -> None:
    payload = {
        "errorcode": 0,
        "tables": [
            {
                "thscode": "9988.HK",
                "time": ["2025-12-31", "2026-03-31"],
                "table": {
                    "np_atsopc_yoy": [15.0, 20.0],
                    "gross_selling_rate": [56.0, 57.5],
                    "or_yoy": [8.0, 10.0],
                },
            }
        ],
        "datatype": [
            {"itemid": "np_atsopc_yoy", "type": "DT_DOUBLE"},
            {"itemid": "gross_selling_rate", "type": "DT_DOUBLE"},
            {"itemid": "or_yoy", "type": "DT_DOUBLE"},
        ],
    }

    rows = metrics._ifind_rows(payload)

    assert rows == [
        {
            "time": "2025-12-31",
            "np_atsopc_yoy": 15.0,
            "gross_selling_rate": 56.0,
            "or_yoy": 8.0,
        },
        {
            "time": "2026-03-31",
            "np_atsopc_yoy": 20.0,
            "gross_selling_rate": 57.5,
            "or_yoy": 10.0,
        },
    ]


@pytest.mark.parametrize(("ticker", "ifind_ticker"), [("300274.SZ", "300274.SZ"), ("700.HK", "0700.HK")])
def test_ifind_official_provider_fetches_and_normalizes_all_five_metrics(
    monkeypatch: pytest.MonkeyPatch,
    ticker: str,
    ifind_ticker: str,
) -> None:
    calls: list[dict[str, Any]] = []
    identity = metrics._security_identity(ticker)
    financial_mapping, market_mapping = metrics._ifind_indicators(identity)
    financial_indicators = list(financial_mapping.values())
    market_indicators = list(market_mapping.values())
    market_dates = [
        (date(2026, 7, 1) + timedelta(days=index)).isoformat() for index in range(25)
    ]

    def fake_post(url: str, **kwargs: Any) -> _FakeHttpResponse:
        calls.append({"url": url, **kwargs})
        interval = kwargs["json"]["functionpara"]["Interval"]
        if interval == "Q":
            return _FakeHttpResponse(
                {
                    "errorcode": 0,
                    "indicators": financial_indicators,
                    "time": ["2026-03-31", "2026-06-30", "2026-09-30"],
                    "data": {
                        financial_mapping["net_profit_yoy"]: [10.0, 20.0, None],
                        financial_mapping["gross_margin"]: [30.0, 33.0, None],
                        **(
                            {financial_mapping["gross_margin_fallback"]: [29.0, 32.0, None]}
                            if "gross_margin_fallback" in financial_mapping
                            else {}
                        ),
                        financial_mapping["revenue_yoy"]: [5.0, 8.0, None],
                    },
                }
            )
        return _FakeHttpResponse(
            {
                "errorcode": 0,
                "indicators": market_indicators,
                "time": market_dates,
                "data": {
                    market_indicators[0]: [15.0] * 24 + [17.5691],
                    market_indicators[1]: [
                        100_000_000.0 + index * 1_000_000.0 for index in range(25)
                    ],
                },
            }
        )

    monkeypatch.setattr(metrics.httpx, "post", fake_post)
    provider = metrics.IFindHttpMarketDataProvider(
        "https://ifind.example/api/v1", "secret"
    )

    payload = provider.fetch_metrics(company_name="Demo Corp", ticker=ticker)

    assert payload["status"] == "completed"
    assert set(payload["metrics"]) == set(metrics.METRIC_KEYS)
    assert payload["metrics"]["quarter_net_profit_yoy"]["value"] == pytest.approx(0.20)
    assert payload["metrics"]["quarter_gross_margin_qoq_delta"]["value"] == pytest.approx(
        0.03
    )
    assert payload["metrics"]["quarter_revenue_growth_qoq"]["value"] == pytest.approx(
        0.03
    )
    assert payload["metrics"]["quarter_net_profit_yoy"]["period"] == "2026Q2"
    assert [item["period"] for item in payload["metric_history"]] == [
        "2026Q1",
        "2026Q2",
    ]
    assert payload["metrics"]["forward_pe"]["value"] == pytest.approx(17.5691)
    turnover = payload["metrics"]["avg_turnover_amount_20d"]
    assert turnover["value"] == pytest.approx(114_500_000.0)
    assert turnover["metadata"]["raw_unit"] == identity.currency
    assert turnover["metadata"]["unit_assumption"] is True
    assert len(calls) == 2
    assert all(call["url"].endswith("/date_sequence") for call in calls)
    assert all(call["headers"]["access_token"] == "secret" for call in calls)
    assert all(call["json"]["codes"] == ifind_ticker for call in calls)
    assert all("Authorization" not in call["headers"] for call in calls)
    assert (
        date.fromisoformat(calls[0]["json"]["enddate"])
        - date.fromisoformat(calls[0]["json"]["startdate"])
    ).days == 5 * 366
    assert {
        item["indicator"] for item in calls[0]["json"]["indipara"]
    } == set(financial_indicators)
    assert {
        item["indicator"] for item in calls[1]["json"]["indipara"]
    } == set(market_indicators)
    if identity.market == "hk":
        by_indicator = {
            item["indicator"]: item["indiparams"]
            for item in calls[1]["json"]["indipara"]
        }
        assert by_indicator["fore_pe_in_12m"] == [""]
        assert by_indicator["amt"] == ["", "BB"]
        assert turnover["metadata"]["raw_unit"] == "HKD"




def test_ifind_hk_financials_fall_back_to_reported_gross_margin() -> None:
    indicators = metrics.IFIND_HK_FINANCIAL_INDICATORS
    rows = [
        {
            "time": "2025-12-31",
            indicators["net_profit_yoy"]: 15.0,
            indicators["gross_margin"]: None,
            indicators["gross_margin_fallback"]: 56.0,
            indicators["revenue_yoy"]: 8.0,
        },
        {
            "time": "2026-03-31",
            indicators["net_profit_yoy"]: 20.0,
            indicators["gross_margin"]: None,
            indicators["gross_margin_fallback"]: 57.5,
            indicators["revenue_yoy"]: 10.0,
        },
    ]

    latest, _history = metrics.IFindHttpMarketDataProvider._financial_metrics(
        rows, indicators
    )

    assert latest["quarter_gross_margin_qoq_delta"]["value"] == pytest.approx(0.015)
    assert (
        latest["quarter_gross_margin_qoq_delta"]["metadata"]["indicator"]
        == "gross_selling_rate"
    )


def test_ifind_period_market_query_uses_requested_as_of_date(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict[str, Any] = {}
    indicators = list(metrics.IFIND_MARKET_INDICATORS.values())
    dates = [(date(2024, 6, 3) + timedelta(days=index)).isoformat() for index in range(26)]

    def fake_post(_url: str, **kwargs: Any) -> _FakeHttpResponse:
        captured.update(kwargs["json"])
        return _FakeHttpResponse(
            {
                "errorcode": 0,
                "indicators": indicators,
                "time": dates,
                "data": {
                    indicators[0]: [18.0] * len(dates),
                    indicators[1]: [100_000_000.0] * len(dates),
                },
            }
        )

    monkeypatch.setattr(metrics.httpx, "post", fake_post)
    provider = metrics.IFindHttpMarketDataProvider(
        "https://ifind.example/api/v1", "secret"
    )

    payload = provider.fetch_market_metrics_as_of(
        ticker="300274.SZ", as_of=date(2024, 6, 30)
    )

    assert captured["enddate"] == "2024-06-30"
    assert captured["startdate"] == "2024-05-01"
    assert captured["functionpara"]["Interval"] == "D"
    assert set(payload["metrics"]) == {"forward_pe", "avg_turnover_amount_20d"}


def test_period_market_snapshot_compares_only_selected_quarter_model_values(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    conn.executescript(
        """
        CREATE TABLE valuation_model_series (
            dataset_id TEXT, series_id TEXT, company_name TEXT, company_ticker TEXT
        );
        CREATE TABLE valuation_model_versions (
            model_version_id TEXT, series_id TEXT, doc_id TEXT
        );
        INSERT INTO valuation_model_series
        VALUES ('demo', 'series-1', 'Demo Corp', '300274.SZ');
        INSERT INTO valuation_model_versions
        VALUES ('version-1', 'series-1', 'doc-1');
        """
    )
    monkeypatch.setattr(metrics, "ensure_metric_schema", lambda _conn: None)
    model_values = [
        {
            "metric_key": "forward_pe",
            "value_numeric": 20.0,
            "unit": "multiple",
            "period": "2024Q2",
            "status": "available",
            "method": "explicit_forward_pe",
            "source": "Model!B2",
            "evidence_ids": ["fact:pe"],
            "quality_status": "candidate_complete",
        },
        {
            "metric_key": "avg_turnover_amount_20d",
            "value_numeric": 90_000_000.0,
            "unit": "currency",
            "period": "2024Q2",
            "status": "available",
            "method": "explicit_model_value",
            "source": "Model!B3",
            "evidence_ids": ["fact:turnover"],
            "quality_status": "candidate_complete",
        },
    ]
    monkeypatch.setattr(metrics, "extract_model_metrics", lambda *_args, **_kwargs: model_values)
    monkeypatch.setattr(
        metrics,
        "_apply_manual_metric_overrides",
        lambda *_args, **_kwargs: (model_values, []),
    )

    class PeriodProvider:
        name = "ifind"

        def fetch_market_metrics_as_of(
            self, *, ticker: str, as_of: date
        ) -> dict[str, Any]:
            assert ticker == "300274.SZ"
            assert as_of == date(2024, 6, 30)
            return {
                "provider": self.name,
                "as_of": "2024-06-28",
                "metrics": {
                    "forward_pe": {
                        "value": 18.0,
                        "period": "2024-06-28",
                        "source": "iFinD official date_sequence",
                        "observed_at": "2024-06-28",
                    },
                    "avg_turnover_amount_20d": {
                        "value": 100_000_000.0,
                        "period": "20D@2024-06-28",
                        "source": "iFinD official date_sequence",
                        "observed_at": "2024-06-28",
                    },
                },
            }

    payload = metrics.period_market_snapshot(
        conn,
        dataset_id="demo",
        series_id="series-1",
        model_version_id="version-1",
        period="2024Q2",
        provider=metrics.FreeComboMarketDataProvider(ifind_provider=PeriodProvider()),
    )

    assert payload["period"] == "2024Q2"
    assert "provider" not in payload
    assert payload["as_of"] == "2024-06-30"
    assert payload["model_available_count"] == 2
    assert payload["actual_available_count"] == 2
    assert payload["compared_count"] == 2
    assert all(item["status"] == "compared" for item in payload["comparisons"])



def test_hk_period_market_fallback_marks_yahoo_api_date() -> None:
    class PeriodSource:
        def __init__(self, name: str, values: dict[str, dict[str, Any]]) -> None:
            self.name = name
            self.values = values

        def fetch_market_metrics_as_of(self, *, ticker: str, as_of: date) -> dict[str, Any]:
            assert ticker == "700.HK"
            assert as_of == date(2025, 12, 31)
            return {"provider": self.name, "metrics": self.values}

    ifind = PeriodSource("ifind", {})
    tencent = PeriodSource(
        "tencent_hk",
        {
            "avg_turnover_amount_20d": {
                "value": 85_340_000.0,
                "period": "20D@2025-12-31",
                "source": "Tencent Finance public HK daily K-line",
            }
        },
    )
    yahoo = PeriodSource(
        "yahoo",
        {
            "forward_pe": {
                "value": 18.2,
                "period": "API@2026-08-13",
                "source": "Yahoo Finance forwardPE (current fallback)",
                "status": "stale",
                "metadata": {"stale_fallback": True, "as_of_supported": False},
            }
        },
    )

    payload = metrics.FreeComboMarketDataProvider(
        ifind_provider=ifind,
        tencent_hk_provider=tencent,
        yahoo_provider=yahoo,
    ).fetch_market_metrics_as_of(ticker="700.HK", as_of=date(2025, 12, 31))

    assert payload["as_of"] == "2025-12-31"
    assert payload["metrics"]["avg_turnover_amount_20d"]["source"].startswith("Tencent")
    assert payload["metrics"]["forward_pe"]["period"] == "API@2026-08-13"
    assert payload["metrics"]["forward_pe"]["metadata"]["as_of_supported"] is False
def test_ifind_financial_failure_keeps_market_values_and_redacts_token(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    token = "top-secret"
    indicators = list(metrics.IFIND_MARKET_INDICATORS.values())
    dates = [(date(2026, 7, 1) + timedelta(days=index)).isoformat() for index in range(20)]

    def fake_post(_url: str, **kwargs: Any) -> _FakeHttpResponse:
        if kwargs["json"]["functionpara"]["Interval"] == "Q":
            return _FakeHttpResponse(
                {"errorcode": -1, "errmsg": f"expired credential {token}"}
            )
        return _FakeHttpResponse(
            {
                "errorcode": 0,
                "tables": [
                    {
                        "time": dates,
                        "table": {
                            indicators[0]: [18.0] * 20,
                            indicators[1]: [200_000_000.0] * 20,
                        },
                    }
                ],
            }
        )

    monkeypatch.setattr(metrics.httpx, "post", fake_post)
    provider = metrics.IFindHttpMarketDataProvider(
        "https://ifind.example/api/v1", token
    )

    payload = provider.fetch_metrics(company_name="Demo Corp", ticker="300274.SZ")

    assert payload["status"] == "partial"
    assert set(payload["metrics"]) == {"forward_pe", "avg_turnover_amount_20d"}
    assert token not in payload["error"]
    assert "[redacted]" in payload["error"]


def test_ifind_refresh_token_fetches_and_reuses_access_token() -> None:
    calls: list[dict[str, Any]] = []

    class Client:
        def post(self, url: str, **kwargs: Any) -> _FakeHttpResponse:
            calls.append({"url": url, **kwargs})
            if url.endswith("/get_access_token"):
                return _FakeHttpResponse({"data": {"access_token": "fresh-access"}})
            return _FakeHttpResponse({"errorcode": 0, "time": [], "data": {}})

    provider = metrics.IFindHttpMarketDataProvider(
        "https://ifind.example/api/v1",
        "",
        refresh_token="refresh-secret",
        http_client=Client(),
    )

    provider._date_sequence({"codes": "300274.SZ"})
    provider._date_sequence({"codes": "300274.SZ"})

    assert [call["url"] for call in calls].count(
        "https://ifind.example/api/v1/get_access_token"
    ) == 1
    assert calls[0]["headers"]["refresh_token"] == "refresh-secret"
    assert all(
        call["headers"]["access_token"] == "fresh-access"
        for call in calls
        if call["url"].endswith("/date_sequence")
    )


def test_ifind_refresh_token_alone_configures_priority_provider(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("PRIVATE_FUND_IFIND_ACCESS_TOKEN", raising=False)
    monkeypatch.setenv("PRIVATE_FUND_IFIND_REFRESH_TOKEN", "refresh-secret")

    provider = metrics.FreeComboMarketDataProvider()
    first = provider._providers_for_metrics("300274.SZ")[0]

    assert isinstance(first, metrics.IFindHttpMarketDataProvider)


def test_ifind_environment_configures_official_priority_provider(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("PRIVATE_FUND_IFIND_BASE_URL", "https://ifind.example/api/v1")
    monkeypatch.setenv("PRIVATE_FUND_IFIND_ACCESS_TOKEN", "secret")

    provider = metrics.FreeComboMarketDataProvider()
    first = provider._providers_for_metrics("300274.SZ")[0]

    assert isinstance(first, metrics.IFindHttpMarketDataProvider)
    assert provider._providers_for_metrics("700.HK")[0] is first
    assert first.name == "ifind"
    assert first.base_url == "https://ifind.example/api/v1"


def test_ifind_api_is_the_highest_priority_source() -> None:
    actual = _actual_values()
    provider = metrics.FreeComboMarketDataProvider(
        ifind_provider=_WaterfallSource("ifind", actual),
        akshare_provider=_WaterfallSource("akshare", {}),
        eastmoney_financial_provider=_WaterfallSource("eastmoney_financial", {}),
    )

    payload = provider.fetch_metrics(company_name="Demo Corp", ticker="300274.SZ")

    assert payload["status"] == "completed"
    assert set(payload["metrics"]) == set(metrics.METRIC_KEYS)
    assert payload["provider_attempts"][0]["provider"] == "ifind"
    assert all(
        attempt["status"] == "skipped"
        for attempt in payload["provider_attempts"][1:]
    )


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


class _WaterfallSource:
    def __init__(self, name: str, values: dict[str, Any], status: str = "completed") -> None:
        self.name = name
        self.values = values
        self.status = status

    def fetch_metrics(self, *, company_name: str, ticker: str) -> dict[str, Any]:
        assert company_name == "Demo Corp"
        assert ticker == "300274.SZ"
        return {
            "provider": self.name,
            "status": self.status,
            "as_of": "2026-07-20T05:30:00+00:00",
            "metrics": self.values,
            "error": "" if self.values else "no fields",
        }

    def fetch_daily_prices(
        self, *, ticker: str, start_date: date, end_date: date
    ) -> dict[str, Any]:
        del start_date, end_date
        return {
            "provider": self.name,
            "provider_symbol": ticker,
            "canonical_ticker": ticker,
            "currency": "CNY",
            "bars": [{"trade_date": "2026-07-20", "close": 10.0, "amount": 100.0}],
        }



class _FakeTencentClient:
    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []

    def get(self, _url: str, **kwargs: Any) -> _FakeHttpResponse:
        self.calls.append(kwargs)
        first_date = date(2026, 7, 19)
        rows = [
            [
                (first_date + timedelta(days=index)).isoformat(),
                "10.0",
                "11.0",
                "12.0",
                "9.0",
                "100.0",
            ]
            for index in range(20)
        ]
        quote = [""] * 38
        quote[30] = "2026/08/07 16:08:23"
        quote[37] = "2000.0"
        return _FakeHttpResponse(
            {
                "code": 0,
                "data": {
                    "hk00700": {
                        "day": rows,
                        "qt": {"hk00700": quote},
                    }
                },
            }
        )



def test_public_market_http_proxy_requires_explicit_opt_in(monkeypatch) -> None:
    monkeypatch.setenv("HTTPS_PROXY", "http://unreachable.invalid:7897")
    monkeypatch.delenv("PRIVATE_FUND_MARKET_TRUST_ENV_PROXY", raising=False)
    assert metrics._market_data_trust_env_proxy() is False

    monkeypatch.setenv("PRIVATE_FUND_MARKET_TRUST_ENV_PROXY", "1")
    assert metrics._market_data_trust_env_proxy() is True

def test_tencent_hk_provider_returns_turnover_when_akshare_upstream_is_unavailable() -> None:
    client = _FakeTencentClient()
    provider = metrics.TencentHkMarketDataProvider(http_client=client)

    payload = provider.fetch_metrics(company_name="腾讯控股", ticker="700.HK")

    assert payload["status"] == "completed"
    assert payload["ticker"] == "700.HK"
    turnover = payload["metrics"]["avg_turnover_amount_20d"]
    assert turnover["value"] == pytest.approx((19 * 1100.0 + 2000.0) / 20)
    assert turnover["metadata"]["estimated_days"] == 19
    assert client.calls[0]["params"]["param"] == "hk00700,day,,,140,"
    assert client.calls[0]["timeout"] == 10.0

def test_eastmoney_financial_provider_normalizes_quarterly_metrics() -> None:
    client = _FakeEastmoneyClient()
    provider = metrics.EastmoneyFinancialMarketDataProvider(http_client=client)

    payload = provider.fetch_metrics(company_name="Demo Corp", ticker="300274.SZ")

    assert payload["status"] == "completed"
    assert payload["metrics"]["quarter_net_profit_yoy"]["value"] == pytest.approx(0.25)
    assert payload["metrics"]["quarter_gross_margin_qoq_delta"]["value"] == pytest.approx(
        0.02
    )
    assert payload["metrics"]["quarter_revenue_growth_qoq"]["value"] == pytest.approx(
        0.06
    )
    assert client.calls[0]["params"]["filter"] == '(SECUCODE="300274.SZ")'


def test_hk_waterfall_uses_ifind_tencent_then_yahoo_by_field() -> None:
    class _HkSource:
        def __init__(self, name: str, values: dict[str, Any]) -> None:
            self.name = name
            self.values = values

        def fetch_metrics(self, *, company_name: str, ticker: str) -> dict[str, Any]:
            assert company_name == "Demo Corp"
            assert ticker == "700.HK"
            return {"provider": self.name, "status": "completed", "metrics": self.values}

    actual = _actual_values()
    provider = metrics.FreeComboMarketDataProvider(
        ifind_provider=_HkSource(
            "ifind",
            {
                "quarter_net_profit_yoy": actual["quarter_net_profit_yoy"],
                "quarter_gross_margin_qoq_delta": actual["quarter_gross_margin_qoq_delta"],
            },
        ),
        tencent_hk_provider=_HkSource(
            "tencent_hk", {"avg_turnover_amount_20d": actual["avg_turnover_amount_20d"]}
        ),
        yahoo_provider=_HkSource(
            "yahoo",
            {
                "avg_turnover_amount_20d": {"value": 0.0},
                "quarter_revenue_growth_qoq": actual["quarter_revenue_growth_qoq"],
                "forward_pe": actual["forward_pe"],
            },
        ),
    )

    payload = provider.fetch_metrics(company_name="Demo Corp", ticker="700.HK")

    assert set(payload["metrics"]) == set(metrics.METRIC_KEYS)
    assert payload["metrics"]["avg_turnover_amount_20d"] == actual["avg_turnover_amount_20d"]
    assert payload["metrics"]["forward_pe"] == actual["forward_pe"]
    assert [attempt["provider"] for attempt in payload["provider_attempts"]] == [
        "ifind",
        "tencent_hk",
        "yahoo",
    ]

def test_free_combo_waterfall_merges_by_priority_and_keeps_diagnostics(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("PRIVATE_FUND_IFIND_ACCESS_TOKEN", raising=False)
    actual = _actual_values()
    provider = metrics.FreeComboMarketDataProvider(
        akshare_provider=_WaterfallSource(
            "akshare",
            {
                "quarter_net_profit_yoy": actual["quarter_net_profit_yoy"],
                "quarter_gross_margin_qoq_delta": actual["quarter_gross_margin_qoq_delta"],
            },
        ),
        eastmoney_financial_provider=_WaterfallSource(
            "eastmoney_financial",
            {
                "quarter_revenue_growth_qoq": actual["quarter_revenue_growth_qoq"],
                "avg_turnover_amount_20d": actual["avg_turnover_amount_20d"],
            },
        ),
    )

    payload = provider.fetch_metrics(company_name="Demo Corp", ticker="300274.SZ")

    assert payload["provider"] == "free_combo"
    assert payload["status"] == "partial"
    assert set(payload["metrics"]) == {
        "quarter_net_profit_yoy",
        "quarter_gross_margin_qoq_delta",
        "avg_turnover_amount_20d",
        "quarter_revenue_growth_qoq",
    }
    assert payload["missing_metric_keys"] == ["forward_pe"]
    assert "TTM PE was not substituted" in payload["error"]
    assert [attempt["provider"] for attempt in payload["provider_attempts"]] == [
        "akshare",
        "eastmoney_financial",
    ]

def test_free_combo_times_out_one_source_and_continues_waterfall(monkeypatch) -> None:
    class _SlowSource(_WaterfallSource):
        def fetch_metrics(self, *, company_name: str, ticker: str) -> dict[str, Any]:
            time.sleep(0.05)
            return super().fetch_metrics(company_name=company_name, ticker=ticker)

    monkeypatch.setenv("PRIVATE_FUND_MARKET_SOURCE_TIMEOUT_SECONDS", "0.01")
    monkeypatch.delenv("PRIVATE_FUND_IFIND_ACCESS_TOKEN", raising=False)
    provider = metrics.FreeComboMarketDataProvider(
        akshare_provider=_SlowSource("akshare", _actual_values()),
        eastmoney_financial_provider=_WaterfallSource(
            "eastmoney_financial",
            {"avg_turnover_amount_20d": _actual_values()["avg_turnover_amount_20d"]},
        ),
    )

    payload = provider.fetch_metrics(company_name="Demo Corp", ticker="300274.SZ")

    assert payload["status"] == "partial"
    assert set(payload["metrics"]) == {"avg_turnover_amount_20d"}
    assert payload["provider_attempts"][0]["provider"] == "akshare"
    assert "did not respond within 0.01s" in payload["provider_attempts"][0]["error_message"]

def test_free_combo_missing_ticker_is_partial_ready_without_alerts(tmp_path: Path) -> None:
    database = tmp_path / "collection.sqlite3"
    _create_database(database)
    with sqlite3.connect(database) as conn:
        conn.row_factory = sqlite3.Row
        conn.execute("UPDATE valuation_model_series SET company_ticker='' WHERE series_id='series-1'")
        result = metrics.refresh_metric_comparison(
            conn,
            dataset_id="demo",
            series=dict(conn.execute("SELECT * FROM valuation_model_series").fetchone()),
            version=dict(conn.execute("SELECT * FROM valuation_model_versions").fetchone()),
            provider=metrics.FreeComboMarketDataProvider(
                akshare_provider=_WaterfallSource("akshare", {}),
                eastmoney_financial_provider=_WaterfallSource("eastmoney_financial", {}),
            ),
        )
        conn.commit()

    assert result["status"] == "missing_ticker"
    assert result["comparisons"]
    assert tracking.list_metric_alerts(database, "demo") == []


def test_free_combo_uses_independent_consensus_for_forward_pe(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("PRIVATE_FUND_IFIND_ACCESS_TOKEN", raising=False)
    actual = _actual_values()
    provider = metrics.FreeComboMarketDataProvider(
        akshare_provider=_WaterfallSource("akshare", {}),
        eastmoney_financial_provider=_WaterfallSource("eastmoney_financial", {}),
        consensus_provider=_WaterfallSource(
            "consensus_api",
            {"forward_pe": actual["forward_pe"]},
        ),
    )

    payload = provider.fetch_metrics(company_name="Demo Corp", ticker="300274.SZ")

    assert payload["metrics"]["forward_pe"] == actual["forward_pe"]
    assert payload["provider_attempts"][-1]["provider"] == "consensus_api"

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


def test_metric_timeline_defaults_to_latest_comparable_period(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
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
        quarterly_calls = 0
        original_quarterly_values = metrics._quarterly_values

        def counting_quarterly_values(
            facts: list[dict[str, Any]], kind: str
        ) -> dict[tuple[int, int], dict[str, Any]]:
            nonlocal quarterly_calls
            quarterly_calls += 1
            return original_quarterly_values(facts, kind)

        monkeypatch.setattr(metrics, "_quarterly_values", counting_quarterly_values)
        payload = metrics.latest_metric_payload(
            conn,
            dataset_id="demo",
            series_id="series-1",
            model_version_id="version-1",
        )

    assert quarterly_calls == 5
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

    assert active_alerts == []


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
