from __future__ import annotations

import json
import sqlite3
from pathlib import Path

from omnigent.server import private_fund_valuation_impact_agent as impact_agent


class _FakeImpactAgent:
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
        return json.dumps(
            {
                "analysis_summary": "订单增长与成本压力共同影响当前估值。",
                "impacts": [
                    {
                        "direction": "up",
                        "horizon": "2027年以后",
                        "confidence": 0.72,
                        "title": "数据中心订单提高增长可见度",
                        "evidence_summary": "会议纪要披露公司正在接洽数据中心储能订单。",
                        "valuation_impact": "若订单交付，可上调收入增速和订单转化假设。",
                        "affected_inputs": ["revenue_growth", "order_conversion"],
                        "watch_items": ["订单签约", "客户验收"],
                        "evidence_ids": ["chunk:chunk-a"],
                    },
                    {
                        "direction": "down",
                        "horizon": "2026年",
                        "confidence": 0.81,
                        "title": "原材料价格压低储能毛利率",
                        "evidence_summary": "研究报告测算原材料涨价增加单位成本。",
                        "valuation_impact": "应下调毛利率和自由现金流，并保留价格传导风险。",
                        "affected_inputs": ["gross_margin", "free_cash_flow"],
                        "watch_items": ["原材料价格", "新订单定价"],
                        "evidence_ids": ["chunk:chunk-b"],
                    },
                ],
                "warnings": [],
            },
            ensure_ascii=False,
        )


def _database(path: Path, *, supporting_documents: bool = True) -> sqlite3.Connection:
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    conn.executescript(
        """
        CREATE TABLE documents (
            doc_id TEXT PRIMARY KEY,
            dataset_id TEXT NOT NULL,
            original_filename TEXT NOT NULL,
            doc_type TEXT,
            doc_subtype TEXT,
            document_date TEXT,
            checksum TEXT,
            status TEXT NOT NULL,
            is_current INTEGER NOT NULL,
            lifecycle_state TEXT NOT NULL,
            created_at TEXT NOT NULL
        );
        CREATE TABLE chunks (
            chunk_id TEXT PRIMARY KEY,
            doc_id TEXT NOT NULL,
            chunk_index INTEGER NOT NULL,
            summary TEXT,
            content TEXT NOT NULL,
            source_ref TEXT,
            title_path TEXT,
            content_hash TEXT
        );
        """
    )
    now = "2026-07-21T00:00:00+00:00"
    conn.execute(
        """
        INSERT INTO documents VALUES
            ('model', 'demo', 'Demo valuation.xlsx', 'financial_valuation_data',
             'dcf_model', '2026-07-20', 'model-checksum', 'indexed', 1, 'active', ?)
        """,
        (now,),
    )
    if supporting_documents:
        conn.executemany(
            "INSERT INTO documents VALUES (?, 'demo', ?, ?, ?, ?, ?, 'indexed', 1, 'active', ?)",
            [
                (
                    "meeting",
                    "Management meeting.pdf",
                    "meeting_third_party",
                    "research_meeting",
                    "2026-07-18",
                    "meeting-checksum",
                    now,
                ),
                (
                    "report",
                    "Industry report.pdf",
                    "meeting_third_party",
                    "internal_research_report",
                    "2026-07-17",
                    "report-checksum",
                    now,
                ),
            ],
        )
        conn.executemany(
            "INSERT INTO chunks VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            [
                (
                    "chunk-a",
                    "meeting",
                    1,
                    "数据中心订单",
                    "管理层表示正在接洽数据中心储能订单，交付和客户验收仍待确认。",
                    "Management meeting.pdf p.3",
                    "page 3",
                    "hash-a",
                ),
                (
                    "chunk-b",
                    "report",
                    1,
                    "成本与毛利率",
                    "研究报告测算原材料价格上涨会增加单位成本并压低储能毛利率。",
                    "Industry report.pdf p.2",
                    "page 2",
                    "hash-b",
                ),
            ],
        )
    conn.commit()
    return conn


def test_skill_run_persists_validated_cards_and_reuses_cache(tmp_path: Path) -> None:
    conn = _database(tmp_path / "collection.sqlite3")
    client = _FakeImpactAgent()

    first = impact_agent.extract_with_skill(
        conn,
        dataset_id="demo",
        series_id="series-1",
        model_version_id="version-1",
        llm_client=client,
    )
    second = impact_agent.extract_with_skill(
        conn,
        dataset_id="demo",
        series_id="series-1",
        model_version_id="version-1",
        llm_client=client,
    )

    assert client.calls == 1
    assert first["status"] == "completed"
    assert first["card_count"] == 2
    assert [card["direction"] for card in first["cards"]] == ["up", "down"]
    assert first["cards"][0]["source_refs"] == ["Management meeting.pdf p.3"]
    assert second["run_id"] == first["run_id"]
    assert conn.execute("SELECT COUNT(*) FROM valuation_impact_cards").fetchone()[0] == 2
    conn.close()


def test_skill_rejects_unknown_evidence_and_inputs() -> None:
    formatted = impact_agent.validate_output(
        {
            "analysis_summary": "test",
            "impacts": [
                {
                    "direction": "up",
                    "horizon": "长期",
                    "confidence": 0.9,
                    "title": "无法追溯的估值影响",
                    "evidence_summary": "这段摘要长度足够，但证据不存在。",
                    "valuation_impact": "这段估值影响长度足够，但不可入库。",
                    "affected_inputs": ["invented_metric"],
                    "watch_items": ["后续事项"],
                    "evidence_ids": ["chunk:unknown"],
                }
            ],
            "warnings": [],
        },
        evidence_sources={"chunk:allowed": "Allowed.pdf p.1"},
    )

    assert formatted["impacts"] == []
    assert "未通过结构或证据校验" in formatted["warnings"][0]


def test_no_supporting_evidence_does_not_call_agent(tmp_path: Path) -> None:
    conn = _database(tmp_path / "collection.sqlite3", supporting_documents=False)
    client = _FakeImpactAgent()

    result = impact_agent.extract_with_skill(
        conn,
        dataset_id="demo",
        series_id="series-1",
        model_version_id="version-1",
        llm_client=client,
    )

    assert client.calls == 0
    assert result["status"] == "no_evidence"
    assert result["cards"] == []
    conn.close()
