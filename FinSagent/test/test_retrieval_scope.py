from __future__ import annotations

import sqlite3
import sys
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT / "src") not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT / "src"))

from utils.cascade_retriever import CascadeRetriever
from utils.retrieval_scope import filter_chunks_to_scope


def _build_collection_db(path: Path) -> None:
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
                doc_id TEXT,
                period TEXT,
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
        conn.executemany(
            "INSERT INTO documents VALUES (?, ?, ?, ?)",
            [
                ("porsche-2024", "Porsche AG", "P911.DE", "porsche-2024.pdf"),
                ("sungrow-v44", "Sungrow", "300274 CH", "300274-v44.xlsx"),
            ],
        )
        conn.executemany(
            "INSERT INTO metric_facts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            [
                ("net profit", 3600.0, None, "EUR million", "porsche-2024", "2024", "income", "B12", 1.0, ""),
                ("net profit", 11000.0, None, "CNY million", "sungrow-v44", "2024", "利润表", "F44", 1.0, ""),
            ],
        )
        conn.executemany(
            "INSERT INTO chunks VALUES (?, ?, ?, ?, ?, ?)",
            [
                ("p1", "porsche-2024", "2024 net profit was EUR 3.6 billion", "text", "porsche p.10", 1),
                ("s1", "sungrow-v44", "2024 net profit was CNY 11 billion", "text", "model F44", 1),
            ],
        )
        conn.commit()
    finally:
        conn.close()


def test_original_company_scope_is_inherited_by_lossy_metric_rewrite(tmp_path: Path) -> None:
    db_path = tmp_path / "collection.sqlite3"
    _build_collection_db(db_path)
    retriever = CascadeRetriever(
        str(db_path),
        company_aliases={
            "P911.DE": ["保时捷", "Porsche"],
            "300274 CH": ["阳光电源", "Sungrow"],
        },
    )

    scope = retriever.resolve_scope("保时捷 2024 年归母净利润", dataset_id="test-real")
    assert scope.explicit_company is True
    assert scope.source_doc_ids == ("porsche-2024",)

    result = retriever.search_metric(
        "2024 net profit",
        allowed_doc_ids=scope.source_doc_ids,
        scope_explicit=scope.explicit_company,
    )

    assert result is not None
    assert result["high_confidence"] is True
    assert result["source_doc_ids"] == ["porsche-2024"]
    assert result["chunks"][0]["metadata"]["unit"] == "EUR million"


def test_original_company_scope_is_inherited_by_lossy_keyword_rewrite(tmp_path: Path) -> None:
    db_path = tmp_path / "collection.sqlite3"
    _build_collection_db(db_path)
    retriever = CascadeRetriever(
        str(db_path),
        company_aliases={"P911.DE": ["保时捷", "Porsche"]},
    )
    scope = retriever.resolve_scope("保时捷 2024 年归母净利润")

    result = retriever.search_keyword(
        "2024 net profit",
        allowed_doc_ids=scope.source_doc_ids,
        scope_explicit=scope.explicit_company,
    )

    assert result is not None
    assert result["source_doc_ids"] == ["porsche-2024"]


def test_explicit_empty_scope_never_falls_back_to_all_documents(tmp_path: Path) -> None:
    db_path = tmp_path / "collection.sqlite3"
    _build_collection_db(db_path)
    retriever = CascadeRetriever(str(db_path))

    assert retriever.search_metric("2024 net profit", allowed_doc_ids=[]) is None
    assert retriever.search_keyword("2024 net profit", allowed_doc_ids=[]) is None


def test_chunk_scope_distinguishes_unscoped_from_deny_all() -> None:
    chunks = [
        {"page_content": "porsche", "metadata": {"source_doc_id": "porsche-2024"}},
        {"page_content": "sungrow", "metadata": {"source_doc_id": "sungrow-v44"}},
        {"page_content": "legacy", "metadata": {"doc_id": "legacy-chunk-id"}},
    ]

    assert len(filter_chunks_to_scope(chunks, None)) == 3
    assert filter_chunks_to_scope(chunks, set()) == []
    assert [
        chunk["page_content"]
        for chunk in filter_chunks_to_scope(chunks, {"porsche-2024"})
    ] == ["porsche"]
