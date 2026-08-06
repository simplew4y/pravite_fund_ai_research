from retrieval_control.evidence_fusion import fuse_evidence
from retrieval_control.models import RetrievalPolicy


def _chunk(text: str, *, doc_id: str, content_type: str = "text", **metadata):
    return {
        "page_content": text,
        "metadata": {
            "source_doc_id": doc_id,
            "content_type": content_type,
            **metadata,
        },
    }


def _policy(*, run_rag: bool = True, rag_required: bool = False) -> RetrievalPolicy:
    return RetrievalPolicy(
        mode="evidence_fusion",
        query_type="research_report" if rag_required else "single_fact",
        run_rag=run_rag,
        rag_required=rag_required,
        reason_codes=("TEST",),
    )


def test_low_confidence_dci_and_rag_are_both_injected() -> None:
    metric = {
        "high_confidence": False,
        "chunks": [_chunk(
            "FY2025E net profit: 5.2 EUR billion",
            doc_id="porsche",
            content_type="metric_fact",
            metric_name="net profit",
            value="5.2",
            period="FY2025E",
            actual_or_estimate="estimate",
        )],
    }
    rag = {
        "final_chunks": [_chunk(
            "FY2024 actual net profit was 3.6 EUR billion",
            doc_id="porsche",
            content_type="table",
        )],
        "pre_rerank_chunks": [],
        "time_info": [],
    }

    fused = fuse_evidence(
        query="Porsche FY2024 net profit",
        policy=_policy(),
        metric_result=metric,
        keyword_result=None,
        rag_result=rag,
        rag_executed=True,
        rag_succeeded=True,
    )

    assert len(fused.final_chunks) == 2
    assert [c["metadata"]["source_kind"] for c in fused.final_chunks] == ["dci_metric", "rag"]
    assert "STRUCTURED DCI FACTS" in fused.context
    assert "RAG EVIDENCE" in fused.context
    assert fused.final_chunks[0]["metadata"]["confidence_tier"] == "candidate"


def test_rag_failure_does_not_erase_dci() -> None:
    metric = {
        "high_confidence": False,
        "chunks": [_chunk("candidate fact", doc_id="porsche", content_type="metric_fact")],
    }

    fused = fuse_evidence(
        query="Porsche fact",
        policy=_policy(),
        metric_result=metric,
        keyword_result=None,
        rag_result=None,
        rag_executed=True,
        rag_succeeded=False,
    )

    assert len(fused.final_chunks) == 1
    assert fused.final_chunks[0]["metadata"]["source_kind"] == "dci_metric"
    assert fused.rag_executed is True
    assert fused.rag_succeeded is False


def test_conflicts_are_exposed_in_context() -> None:
    metric = {
        "high_confidence": False,
        "chunks": [
            _chunk(
                "actual 3.6",
                doc_id="porsche",
                content_type="metric_fact",
                metric_name="net profit",
                period="FY2024",
                value="3.6",
                actual_or_estimate="actual",
            ),
            _chunk(
                "estimate 5.2",
                doc_id="porsche",
                content_type="metric_fact",
                metric_name="net profit",
                period="FY2024",
                value="5.2",
                actual_or_estimate="estimate",
            ),
        ],
    }

    fused = fuse_evidence(
        query="Porsche FY2024 net profit",
        policy=_policy(),
        metric_result=metric,
        keyword_result=None,
        rag_result=None,
        rag_executed=True,
        rag_succeeded=False,
    )

    assert {conflict.conflict_type for conflict in fused.conflicts} == {
        "actual_estimate_conflict",
        "value_conflict",
    }
    assert "EVIDENCE CONFLICTS" in fused.context


def test_report_context_keeps_rag_before_keyword_evidence() -> None:
    keyword = {"chunks": [_chunk("keyword", doc_id="porsche")]}
    rag = {"final_chunks": [_chunk("narrative", doc_id="porsche")], "pre_rerank_chunks": []}

    fused = fuse_evidence(
        query="Porsche report",
        policy=_policy(rag_required=True),
        metric_result=None,
        keyword_result=keyword,
        rag_result=rag,
        rag_executed=True,
        rag_succeeded=True,
    )

    assert fused.context.index("RAG EVIDENCE") < fused.context.index("KEYWORD EVIDENCE")


def test_source_channels_have_reserved_limits() -> None:
    metric = {
        "high_confidence": False,
        "chunks": [
            _chunk(f"metric {index}", doc_id="porsche", content_type="metric_fact")
            for index in range(4)
        ],
    }
    rag = {
        "final_chunks": [_chunk(f"rag {index}", doc_id="porsche") for index in range(4)],
        "pre_rerank_chunks": [],
    }

    fused = fuse_evidence(
        query="Porsche",
        policy=_policy(),
        metric_result=metric,
        keyword_result=None,
        rag_result=rag,
        rag_executed=True,
        rag_succeeded=True,
        config={
            "evidence_fusion": {
                "max_metric_facts": 2,
                "max_text_chunks": 1,
                "max_table_chunks": 1,
            }
        },
    )

    assert len([c for c in fused.final_chunks if c["metadata"]["source_kind"] == "dci_metric"]) == 2
    assert len([c for c in fused.final_chunks if c["metadata"]["source_kind"] == "rag"]) == 1
