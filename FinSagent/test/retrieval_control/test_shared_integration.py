from __future__ import annotations

import asyncio
import sqlite3
from datetime import datetime
from pathlib import Path

from agents.shared import retrieve_evidence


def _build_db(path: Path) -> None:
    conn = sqlite3.connect(path)
    try:
        conn.executescript(
            """
            CREATE TABLE documents (
                doc_id TEXT PRIMARY KEY,
                company_name TEXT,
                company_ticker TEXT,
                original_filename TEXT
            );
            CREATE TABLE metric_facts (
                metric_name TEXT,
                value_numeric REAL,
                value_text TEXT,
                unit TEXT,
                currency TEXT,
                doc_id TEXT,
                period TEXT,
                actual_or_estimate TEXT,
                sheet_name TEXT,
                cell_ref TEXT,
                confidence REAL,
                quality_flag TEXT
            );
            CREATE TABLE chunks (
                chunk_id TEXT PRIMARY KEY,
                doc_id TEXT,
                content TEXT,
                content_type TEXT,
                source_ref TEXT,
                chunk_index INTEGER
            );
            """
        )
        conn.execute(
            "INSERT INTO documents VALUES (?, ?, ?, ?)",
            ("porsche-doc", "Porsche AG", "P911.DE", "porsche.xlsx"),
        )
        conn.execute(
            "INSERT INTO metric_facts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                "net profit", 3600.0, None, "million", "EUR", "porsche-doc",
                "2024", "actual", "Income", "B12", 1.0, "",
            ),
        )
        conn.execute(
            "INSERT INTO chunks VALUES (?, ?, ?, ?, ?, ?)",
            (
                "porsche-keyword", "porsche-doc", "Porsche 2024 net profit discussion",
                "text", "p.10", 1,
            ),
        )
        conn.commit()
    finally:
        conn.close()


class _Manager:
    def __init__(self, mode: str = "evidence_fusion") -> None:
        self._config = {
            "retrieval_mode": mode,
            "retrieval_scope_required": True,
            "retrieval_company_aliases": {"P911.DE": ["保时捷", "Porsche"]},
            "datasets": {"active_dataset": "test-real"},
            "retrieval_control": {"evidence_fusion": {}},
        }


class _RAG:
    def __init__(self, *, fail: bool = False, empty: bool = False) -> None:
        self.rag_manager = _Manager()
        self.calls: list[dict] = []
        self.fail = fail
        self.empty = empty

    def retrieve(self, query, query_time, *, agent, allowed_source_doc_ids, **kwargs):
        self.calls.append({
            "query": query,
            "agent": agent,
            "allowed_source_doc_ids": list(allowed_source_doc_ids or []),
        })
        if self.fail:
            raise RuntimeError("test RAG failure")
        if self.empty:
            return {
                "rag_context": "",
                "final_chunks": [],
                "pre_rerank_chunks": [],
                "time_info": [],
            }
        chunk = {
            "page_content": "Annual report narrative for Porsche FY2024.",
            "metadata": {
                "chunk_id": "rag-1",
                "source_doc_id": "porsche-doc",
                "content_type": "text",
                "source_ref": "annual report p.20",
            },
        }
        return {
            "rag_context": "legacy context",
            "final_chunks": [chunk],
            "pre_rerank_chunks": [chunk],
            "time_info": [],
        }


def _retrieve(
    db_path: Path,
    rag: _RAG,
    question: str,
    sub_query: str,
    *,
    dataset_id: str = "",
):
    return asyncio.run(
        retrieve_evidence(
            rag,
            [sub_query],
            datetime.now(),
            "quant",
            collection_db=str(db_path),
            dataset_id=dataset_id,
            scope_query=question,
            scope_history=[],
        )
    )


def test_lossy_low_confidence_dci_runs_rag_and_retains_all_channels(tmp_path: Path) -> None:
    db_path = tmp_path / "collection.sqlite3"
    _build_db(db_path)
    rag = _RAG()

    evidences = _retrieve(
        db_path,
        rag,
        "保时捷 2024 年归母净利润是多少？",
        "2024 net profit",
    )

    assert rag.calls[0]["allowed_source_doc_ids"] == ["porsche-doc"]
    evidence = evidences[0]
    assert evidence["rag_executed"] is True
    assert evidence["rag_succeeded"] is True
    assert {chunk["metadata"]["source_kind"] for chunk in evidence["chunks"]} == {
        "dci_metric", "dci_keyword", "rag",
    }
    assert "LOW_CONFIDENCE_DCI_RETAINED" in evidence["retrieval_policy"]["reason_codes"]


def test_explicit_dataset_id_is_propagated_to_retrieval_scope(tmp_path: Path) -> None:
    db_path = tmp_path / "collection.sqlite3"
    _build_db(db_path)
    rag = _RAG()

    evidences = _retrieve(
        db_path,
        rag,
        "保时捷 2024 年归母净利润是多少？",
        "2024 net profit",
        dataset_id="omnigent-demo",
    )

    assert evidences[0]["retrieval_scope"]["dataset_id"] == "omnigent-demo"


def test_high_confidence_simple_fact_skips_rag_but_keeps_dci(tmp_path: Path) -> None:
    db_path = tmp_path / "collection.sqlite3"
    _build_db(db_path)
    rag = _RAG()

    evidences = _retrieve(
        db_path,
        rag,
        "保时捷 2024 年净利润是多少？",
        "2024 net profit",
    )

    assert rag.calls == []
    assert evidences[0]["rag_executed"] is False
    assert any(chunk["metadata"]["source_kind"] == "dci_metric" for chunk in evidences[0]["chunks"])


def test_report_forces_rag_even_when_dci_is_high_confidence(tmp_path: Path) -> None:
    db_path = tmp_path / "collection.sqlite3"
    _build_db(db_path)
    rag = _RAG()

    evidences = _retrieve(
        db_path,
        rag,
        "请生成一份保时捷 2024 年净利润研报",
        "2024 net profit",
    )

    assert len(rag.calls) == 1
    assert evidences[0]["retrieval_policy"]["rag_required"] is True
    assert "REPORT_REQUIRES_RAG" in evidences[0]["retrieval_policy"]["reason_codes"]


def test_rag_failure_keeps_dci_evidence(tmp_path: Path) -> None:
    db_path = tmp_path / "collection.sqlite3"
    _build_db(db_path)
    rag = _RAG(fail=True)

    evidences = _retrieve(
        db_path,
        rag,
        "保时捷 2024 年归母净利润是多少？",
        "2024 net profit",
    )

    assert evidences[0]["rag_executed"] is True
    assert evidences[0]["rag_succeeded"] is False
    assert any(chunk["metadata"]["source_kind"] == "dci_metric" for chunk in evidences[0]["chunks"])


def test_empty_rag_result_is_not_reported_as_success(tmp_path: Path) -> None:
    db_path = tmp_path / "collection.sqlite3"
    _build_db(db_path)
    rag = _RAG(empty=True)

    evidences = _retrieve(
        db_path,
        rag,
        "保时捷 2024 年归母净利润是多少？",
        "2024 net profit",
    )

    assert evidences[0]["rag_executed"] is True
    assert evidences[0]["rag_succeeded"] is False
    trace = evidences[0]["retrieval_trace"][0]
    assert trace["rag_chunks"] == 0
    assert trace["rag_succeeded"] is False


def test_rag_only_skips_dci_and_runs_scoped_rag(tmp_path: Path) -> None:
    db_path = tmp_path / "collection.sqlite3"
    _build_db(db_path)
    rag = _RAG()
    rag.rag_manager = _Manager(mode="rag_only")

    evidences = _retrieve(
        db_path,
        rag,
        "保时捷 2024 年净利润是多少？",
        "2024 net profit",
    )

    assert rag.calls[0]["allowed_source_doc_ids"] == ["porsche-doc"]
    evidence = evidences[0]
    assert len(evidence["chunks"]) == 1
    assert evidence["chunks"][0]["metadata"]["source_doc_id"] == "porsche-doc"
    assert evidence["retrieval_policy"]["mode"] == "rag_only"
    assert evidence["retrieval_policy"]["reason_codes"] == ["LEGACY_RAG_FALLBACK"]


def test_explicit_allowed_doc_ids_intersect_company_scope_fail_closed(tmp_path: Path) -> None:
    db_path = tmp_path / "collection.sqlite3"
    _build_db(db_path)
    rag = _RAG()
    rag.rag_manager._config["retrieval_scope_allowed_doc_ids"] = ["different-doc"]

    evidences = _retrieve(
        db_path,
        rag,
        "保时捷 2024 年归母净利润是多少？",
        "2024 net profit",
    )

    assert evidences == []
    assert rag.calls == []
