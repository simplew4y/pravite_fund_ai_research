from __future__ import annotations

import json
import sqlite3
from pathlib import Path

import pytest

from omnigent.server import private_fund_valuation_impact_agent as impact_agent


class _FakeImpactAgent:
    def __init__(self) -> None:
        self.calls = 0

    def chat_json(
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


class _RetryingImpactAgent(_FakeImpactAgent):
    def __init__(self) -> None:
        super().__init__()
        self.attempts = 0
        self.max_tokens_seen: list[int | None] = []

    def chat_json(
        self,
        messages: list[dict[str, str]],
        *,
        max_tokens: int | None = None,
        temperature: float | None = None,
    ) -> str:
        self.attempts += 1
        self.max_tokens_seen.append(max_tokens)
        if self.attempts < 3:
            raise RuntimeError("LLM response was empty.")
        return super().chat_json(
            messages,
            max_tokens=max_tokens,
            temperature=temperature,
        )


class _AuthenticationFailureAgent:
    def __init__(self) -> None:
        self.calls = 0

    def chat_json(
        self,
        messages: list[dict[str, str]],
        *,
        max_tokens: int | None = None,
        temperature: float | None = None,
    ) -> str:
        del messages, max_tokens, temperature
        self.calls += 1
        raise RuntimeError("LLM request failed with HTTP 401: invalid API key")


class _SentimentImpactAgent:
    def __init__(self, evidence_ids: list[str]) -> None:
        self.evidence_ids = evidence_ids
        self.calls = 0
        self.messages: list[list[dict[str, str]]] = []

    def chat_json(
        self,
        messages: list[dict[str, str]],
        *,
        max_tokens: int | None = None,
        temperature: float | None = None,
    ) -> str:
        del max_tokens, temperature
        self.calls += 1
        self.messages.append(messages)
        return json.dumps(
            {
                "analysis_summary": (
                    "Public sentiment evidence points to a valuation driver change."
                ),
                "impacts": [
                    {
                        "direction": "down",
                        "horizon": "2026H2",
                        "confidence": 0.78,
                        "title": "Public sentiment flags margin pressure",
                        "evidence_summary": (
                            "Two located public reports describe the same margin pressure "
                            "signal from separate sources."
                        ),
                        "valuation_impact": (
                            "The signal may increase WACC assumptions or reduce gross "
                            "margin confidence until verified."
                        ),
                        "affected_inputs": ["gross_margin", "wacc"],
                        "watch_items": [
                            "Track company clarification",
                            "Check next gross margin disclosure",
                        ],
                        "evidence_ids": self.evidence_ids,
                    }
                ],
                "warnings": [],
            },
            ensure_ascii=False,
        )


class _EmptyImpactAgent:
    def __init__(self) -> None:
        self.calls = 0

    def chat_json(
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
                "analysis_summary": "Sentiment is observable but the agent stayed conservative.",
                "impacts": [],
                "warnings": ["No formal impact returned."],
            },
            ensure_ascii=False,
        )


class _StaticSentimentAdapter:
    def __init__(self, rows: list[dict[str, object]]) -> None:
        self.rows = rows
        self.calls: list[dict[str, object]] = []

    def fetch_sentiment_evidence(
        self,
        *,
        dataset_id: str,
        series_id: str,
        model_version_id: str,
        as_of: str,
        lookback_days: int,
    ) -> list[dict[str, object]]:
        self.calls.append(
            {
                "dataset_id": dataset_id,
                "series_id": series_id,
                "model_version_id": model_version_id,
                "as_of": as_of,
                "lookback_days": lookback_days,
            }
        )
        return self.rows


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


def test_skill_run_persists_append_only_auditable_cards(tmp_path: Path) -> None:
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

    assert client.calls == 2
    assert first["status"] == "completed"
    assert first["card_count"] == 2
    assert [card["direction"] for card in first["cards"]] == ["up", "down"]
    assert first["cards"][0]["source_refs"] == ["Management meeting.pdf p.3"]
    assert first["cards"][0]["review_status"] in {"ready", "needs_review"}
    assert first["cards"][0]["evidence_locations"][0]["page"] == 3
    assert first["selection_scope"]["mode"] == "all_current_effective_documents"
    assert first["coverage_summary"]["usable_evidence_count"] == 2
    assert second["run_id"] != first["run_id"]
    assert conn.execute("SELECT COUNT(*) FROM valuation_impact_agent_runs").fetchone()[0] == 2
    assert conn.execute("SELECT COUNT(*) FROM valuation_impact_cards").fetchone()[0] == 4
    conn.close()


def test_chat_json_retries_empty_content_and_uses_json_mode() -> None:
    client = _RetryingImpactAgent()

    payload, raw = impact_agent._chat_json(
        client,
        [{"role": "user", "content": "Return JSON"}],
    )

    assert client.attempts == 3
    assert client.max_tokens_seen == [6_000, 6_000, 6_000]
    assert payload["impacts"]
    assert json.loads(raw)["analysis_summary"]


def test_chat_json_does_not_retry_authentication_failures() -> None:
    client = _AuthenticationFailureAgent()

    with pytest.raises(RuntimeError, match="HTTP 401"):
        impact_agent._chat_json(
            client,
            [{"role": "user", "content": "Return JSON"}],
        )

    assert client.calls == 1


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


def _sentiment_row(
    sentiment_id: str,
    *,
    source_url: str,
    source_name: str,
    canonical_story_id: str,
    published_at: str = "2026-07-25T00:00:00+00:00",
    excerpt: str = "A public report says procurement delays may pressure margins for the company.",
) -> dict[str, object]:
    return {
        "sentiment_id": sentiment_id,
        "provider": "generic-api",
        "source_type": "public_web",
        "source_name": source_name,
        "source_url": source_url,
        "canonical_story_id": canonical_story_id,
        "title": "Margin pressure report",
        "excerpt": excerpt,
        "locator": "body paragraph 4",
        "published_at": published_at,
        "captured_at": "2026-07-26T09:00:00+00:00",
    }


def test_sentiment_adapter_adds_two_independent_located_sources_to_cards(tmp_path: Path) -> None:
    conn = _database(tmp_path / "collection.sqlite3", supporting_documents=False)
    adapter = _StaticSentimentAdapter(
        [
            _sentiment_row(
                "sentiment:s1",
                source_url="https://source-a.com/news/margin-pressure",
                source_name="Source A",
                canonical_story_id="story-a",
            ),
            _sentiment_row(
                "sentiment:s2",
                source_url="https://source-b.com/research/margin-pressure",
                source_name="Source B",
                canonical_story_id="story-b",
            ),
            _sentiment_row(
                "sentiment:old",
                source_url="https://source-a.com/news/old",
                source_name="Source A",
                canonical_story_id="story-old",
                published_at="2026-03-01T00:00:00+00:00",
            ),
            _sentiment_row(
                "sentiment:future",
                source_url="https://source-a.com/news/future",
                source_name="Source A",
                canonical_story_id="story-future",
                published_at="2026-08-02T00:00:00+00:00",
            ),
            _sentiment_row(
                "sentiment:block",
                source_url="https://blocked.example/news/margin",
                source_name="Blocked",
                canonical_story_id="story-block",
            ),
        ]
    )
    client = _SentimentImpactAgent(["sentiment:s1", "sentiment:s2"])

    result = impact_agent.extract_with_skill(
        conn,
        dataset_id="demo",
        series_id="series-1",
        model_version_id="version-1",
        llm_client=client,
        sentiment_adapter=adapter,
        sentiment_as_of="2026-08-01T00:00:00+00:00",
        sentiment_whitelist_hosts=["source-a.com", "source-b.com"],
    )

    assert client.calls == 1
    assert adapter.calls[0]["lookback_days"] == impact_agent.DEFAULT_SENTIMENT_LOOKBACK_DAYS
    assert "sentiment:s1" in client.messages[0][1]["content"]
    assert result["status"] == "completed"
    assert result["card_count"] == 1
    card = result["cards"][0]
    assert card["evidence_ids"] == ["sentiment:s1", "sentiment:s2"]
    assert card["source_refs"][0].endswith("https://source-a.com/news/margin-pressure")
    assert card["evidence_locations"][0]["locator_type"] == "web_url_quote"
    assert card["evidence_locations"][0]["quote"].startswith("A public report")
    assert card["evidence_coverage"]["source_urls"] == [
        "https://source-a.com/news/margin-pressure",
        "https://source-b.com/research/margin-pressure",
    ]
    assert result["coverage_summary"]["sentiment_evidence_count"] == 2
    assert result["coverage_summary"]["sentiment_independent_source_count"] == 2
    assert result["coverage_summary"]["sentiment_skipped_count"] == 3
    assert [
        item["evidence_id"] for item in result["coverage_summary"]["sentiment_observations"]
    ] == [
        "sentiment:s1",
        "sentiment:s2",
    ]
    conn.close()


def test_sentiment_selection_balances_google_and_ifind_by_relevance(tmp_path: Path) -> None:
    conn = _database(tmp_path / "collection.sqlite3", supporting_documents=False)
    rows: list[dict[str, object]] = []
    for index in range(12):
        row = _sentiment_row(
            f"sentiment:g{index}",
            source_url=f"https://news.google.com/rss/articles/g{index}",
            source_name="Google News",
            canonical_story_id=f"g-story-{index}",
            excerpt=(
                "Broker rating says revenue growth and target price may lift valuation "
                f"multiple for story {index}."
            ),
        )
        row["provider"] = "google_news_rss"
        row["title"] = f"Google revenue growth rating {index}"
        rows.append(row)
    for index in range(12):
        high_value = index < 6
        row = _sentiment_row(
            f"sentiment:ifind-{index}",
            source_url=f"https://ft.10jqka.com.cn/report-{index}.pdf",
            source_name="同花顺iFinD",
            canonical_story_id=f"ifind-story-{index}",
            excerpt=(
                "iFinD announcement: buy rating, target price and profit growth support valuation."
                if high_value
                else "Monthly Return of Equity Issuer on Movements in Securities."
            ),
        )
        row["provider"] = "ifind_report_query"
        row["title"] = (
            f"iFinD target price profit growth {index}"
            if high_value
            else f"Monthly Return {index}"
        )
        rows.append(row)

    excerpts, _, _, _, summary = impact_agent._sentiment_payloads(
        conn,
        dataset_id="demo",
        series_id="series-1",
        model_version_id="version-1",
        sentiment_adapter=_StaticSentimentAdapter(rows),
        sentiment_as_of="2026-08-01T00:00:00+00:00",
        sentiment_lookback_days=90,
        sentiment_whitelist_hosts=["news.google.com", "ft.10jqka.com.cn"],
    )

    providers = [item["provider"] for item in excerpts]
    selected_ids = {item["evidence_id"] for item in excerpts}
    assert len(excerpts) == impact_agent.MAX_SENTIMENT_EVIDENCE
    assert summary["sentiment_candidate_evidence_count"] == 24
    assert providers.count("google_news_rss") >= 4
    assert providers.count("ifind_report_query") >= 4
    assert "sentiment:ifind-0" in selected_ids
    assert "sentiment:ifind-5" in selected_ids
    assert "sentiment:ifind-11" not in selected_ids
    conn.close()


def test_single_sentiment_source_is_observation_not_impact_card(tmp_path: Path) -> None:
    conn = _database(tmp_path / "collection.sqlite3", supporting_documents=False)
    adapter = _StaticSentimentAdapter(
        [
            _sentiment_row(
                "sentiment:solo",
                source_url="https://source-a.com/news/solo",
                source_name="Source A",
                canonical_story_id="story-solo",
            )
        ]
    )
    client = _SentimentImpactAgent(["sentiment:solo"])

    result = impact_agent.extract_with_skill(
        conn,
        dataset_id="demo",
        series_id="series-1",
        model_version_id="version-1",
        llm_client=client,
        sentiment_adapter=adapter,
        sentiment_as_of="2026-08-01T00:00:00+00:00",
        sentiment_whitelist_hosts=["source-a.com"],
    )

    assert client.calls == 1
    assert result["cards"] == []
    assert result["coverage_summary"]["sentiment_evidence_count"] == 1
    assert result["coverage_summary"]["sentiment_independent_source_count"] == 1
    assert (
        result["coverage_summary"]["sentiment_observations"][0]["evidence_id"] == "sentiment:solo"
    )
    conn.close()


def test_two_independent_sentiment_sources_fallback_to_mixed_card(tmp_path: Path) -> None:
    conn = _database(tmp_path / "collection.sqlite3", supporting_documents=False)
    adapter = _StaticSentimentAdapter(
        [
            _sentiment_row(
                "sentiment:r1",
                source_url="https://source-a.com/xiaomi-buy-rating",
                source_name="Source A",
                canonical_story_id="story-a",
                excerpt="Broker maintains Xiaomi buy rating and higher target price.",
            ),
            _sentiment_row(
                "sentiment:r2",
                source_url="https://source-b.com/xiaomi-southbound-inflow",
                source_name="Source B",
                canonical_story_id="story-b",
                excerpt="Southbound funds continue net buying Xiaomi shares.",
            ),
        ]
    )
    client = _EmptyImpactAgent()

    result = impact_agent.extract_with_skill(
        conn,
        dataset_id="demo",
        series_id="series-1",
        model_version_id="version-1",
        llm_client=client,
        sentiment_adapter=adapter,
        sentiment_as_of="2026-08-01T00:00:00+00:00",
        sentiment_whitelist_hosts=["source-a.com", "source-b.com"],
    )

    assert client.calls == 1
    assert result["status"] == "completed"
    assert len(result["cards"]) == 1
    assert result["cards"][0]["direction"] == "mixed"
    assert result["cards"][0]["evidence_ids"] == ["sentiment:r1", "sentiment:r2"]
    assert result["cards"][0]["evidence_locations"][0]["locator_type"] == "web_url_quote"
    assert result["coverage_summary"]["sentiment_independent_source_count"] == 2
    conn.close()


def test_syndicated_sentiment_duplicates_do_not_meet_independence_threshold(
    tmp_path: Path,
) -> None:
    conn = _database(tmp_path / "collection.sqlite3", supporting_documents=False)
    adapter = _StaticSentimentAdapter(
        [
            _sentiment_row(
                "sentiment:r1",
                source_url="https://source-a.com/news/repost",
                source_name="Source A",
                canonical_story_id="wire-1",
            ),
            _sentiment_row(
                "sentiment:r2",
                source_url="https://source-b.com/news/repost",
                source_name="Source B",
                canonical_story_id="wire-1",
            ),
        ]
    )
    client = _SentimentImpactAgent(["sentiment:r1", "sentiment:r2"])

    result = impact_agent.extract_with_skill(
        conn,
        dataset_id="demo",
        series_id="series-1",
        model_version_id="version-1",
        llm_client=client,
        sentiment_adapter=adapter,
        sentiment_as_of="2026-08-01T00:00:00+00:00",
        sentiment_whitelist_hosts=["source-a.com", "source-b.com"],
    )

    assert client.calls == 1
    assert result["cards"] == []
    assert result["coverage_summary"]["sentiment_evidence_count"] == 2
    assert result["coverage_summary"]["sentiment_independent_source_count"] == 1
    conn.close()


def test_ifind_report_query_adapter_builds_located_hk_evidence(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    requested_bodies: list[dict[str, object]] = []

    class _Response:
        def __enter__(self) -> _Response:
            return self

        def __exit__(self, *args: object) -> None:
            del args

        def read(self) -> bytes:
            return json.dumps(
                {
                    "data": [
                        {
                            "pdfURL": "https://ft.10jqka.com.cn/report.pdf",
                            "reportTitle": "Xiaomi announces buyback",
                            "ctime": "2026-08-13T10:00:00+08:00",
                            "secName": "Xiaomi",
                            "thscode": "0001.HK",
                            "reportDate": "2026-08-13",
                            "announcementLanguage": "zh",
                            "seq": "seq-1",
                        }
                    ]
                }
            ).encode("utf-8")

    def fake_urlopen(request: object, *, timeout: float) -> _Response:
        assert timeout == 8
        assert str(request.full_url) == "https://ifind.example/report_query"
        requested_bodies.append(json.loads(request.data.decode("utf-8")))
        return _Response()

    monkeypatch.setattr(impact_agent, "urlopen", fake_urlopen)
    adapter = impact_agent.IfindReportQuerySentimentAdapter(
        "Xiaomi",
        "1.HK",
        access_token="token",
        url="https://ifind.example/report_query",
    )

    rows = adapter.fetch_sentiment_evidence(
        dataset_id="demo",
        series_id="series-1",
        model_version_id="version-1",
        as_of="2026-08-16T00:00:00+00:00",
        lookback_days=90,
    )

    assert requested_bodies[0]["codes"] == "0001.HK"
    assert requested_bodies[0]["functionpara"] == {"reportType": "904"}
    assert requested_bodies[0]["beginrDate"] == "2026-05-18"
    assert requested_bodies[0]["endrDate"] == "2026-08-16"
    assert len(rows) == 1
    assert rows[0]["sentiment_id"].startswith("ifind:")
    assert rows[0]["provider"] == "ifind_report_query"
    assert rows[0]["source_type"] == "provider_api"
    assert rows[0]["source_url"] == "https://ft.10jqka.com.cn/report.pdf"
    assert rows[0]["locator"] == "同花顺iFinD公告查询：公告标题与链接"
    assert rows[0]["published_at"] == "2026-08-13T02:00:00+00:00"


def test_google_and_ifind_same_story_share_canonical_id(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    rss = b"""<?xml version="1.0" encoding="UTF-8"?>
    <rss><channel><item>
      <title>Xiaomi announces buyback - Example News</title>
      <link>https://news.google.com/rss/articles/example</link>
      <pubDate>Thu, 13 Aug 2026 02:00:00 GMT</pubDate>
      <description>Xiaomi announces buyback</description>
      <source url="https://example.com">Example News</source>
    </item></channel></rss>"""
    ifind = json.dumps(
        {
            "data": [
                {
                    "pdfURL": "https://ft.10jqka.com.cn/report.pdf",
                    "reportTitle": "Xiaomi announces buyback",
                    "ctime": "2026-08-13T02:00:00+00:00",
                    "secName": "Xiaomi",
                    "thscode": "1810.HK",
                    "reportDate": "2026-08-13",
                    "seq": "seq-1",
                }
            ]
        }
    ).encode("utf-8")

    class _Response:
        def __init__(self, body: bytes) -> None:
            self.body = body

        def __enter__(self) -> _Response:
            return self

        def __exit__(self, *args: object) -> None:
            del args

        def read(self) -> bytes:
            return self.body

    def fake_urlopen(request: object, *, timeout: float) -> _Response:
        del timeout
        if "report_query" in str(request.full_url):
            return _Response(ifind)
        return _Response(rss)

    monkeypatch.setattr(impact_agent, "urlopen", fake_urlopen)
    adapter = impact_agent.CompositeSentimentEvidenceAdapter(
        [
            impact_agent.GoogleNewsRssSentimentAdapter("Xiaomi", "1810.HK"),
            impact_agent.IfindReportQuerySentimentAdapter(
                "Xiaomi",
                "1810.HK",
                access_token="token",
                url="https://ifind.example/report_query",
            ),
        ]
    )

    rows = adapter.fetch_sentiment_evidence(
        dataset_id="demo",
        series_id="series-1",
        model_version_id="version-1",
        as_of="2026-08-16T00:00:00+00:00",
        lookback_days=90,
    )

    assert len(rows) == 2
    assert {row["provider"] for row in rows} == {"google_news_rss", "ifind_report_query"}
    assert impact_agent._sentiment_independence_key(
        rows[0]
    ) == impact_agent._sentiment_independence_key(rows[1])


def test_google_news_rss_adapter_builds_located_xiaomi_evidence(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    rss = b"""<?xml version="1.0" encoding="UTF-8"?>
    <rss><channel><item>
      <title>Xiaomi launches new product - Example News</title>
      <link>https://news.google.com/rss/articles/example</link>
      <pubDate>Thu, 13 Aug 2026 08:30:00 GMT</pubDate>
      <description><![CDATA[
        <a href="https://example.com/xiaomi">Xiaomi launches new product</a>
      ]]></description>
      <source url="https://example.com">Example News</source>
    </item></channel></rss>"""
    requested_urls: list[str] = []

    class _Response:
        def __enter__(self) -> _Response:
            return self

        def __exit__(self, *args: object) -> None:
            del args

        def read(self) -> bytes:
            return rss

    def fake_urlopen(request: object, *, timeout: float) -> _Response:
        assert timeout == 8
        requested_urls.append(str(request.full_url))
        return _Response()

    monkeypatch.setattr(impact_agent, "urlopen", fake_urlopen)
    adapter = impact_agent.GoogleNewsRssSentimentAdapter("小米集团-W", "1810.HK")

    rows = adapter.fetch_sentiment_evidence(
        dataset_id="xiaomi",
        series_id="series-xiaomi",
        model_version_id="version-xiaomi",
        as_of="2026-08-14T00:00:00+00:00",
        lookback_days=90,
    )

    assert len(rows) == 1
    assert rows[0]["provider"] == "google_news_rss"
    assert rows[0]["source_name"] == "Example News"
    assert rows[0]["source_url"] == "https://news.google.com/rss/articles/example"
    assert rows[0]["publisher_url"] == "https://example.com"
    assert rows[0]["locator"] == "Google News RSS 条目标题与摘要"
    assert rows[0]["published_at"] == "2026-08-13T08:30:00+00:00"
    assert "1810.HK" in requested_urls[0]
    assert "after%3A2026-05-16" in requested_urls[0]
