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


def test_table_caption_is_used_when_page_content_is_empty() -> None:
    rag = {
        "final_chunks": [{
            "retriever": "Table",
            "page_content": "",
            "metadata": {
                "content_type": "table",
                "source_doc_id": "doc-1",
                "source_ref": "model.xlsx QoQ&Results!row 2",
                "caption": "cell=AG2 | value=12613.586 | column=1Q24 | unit=CNYm",
            },
        }],
        "pre_rerank_chunks": [],
    }

    fused = fuse_evidence(
        query="1Q24营业收入是多少？",
        policy=RetrievalPolicy(
            mode="evidence_fusion",
            query_type="financial_calculation",
            run_rag=True,
            require_table_evidence=True,
        ),
        metric_result=None,
        keyword_result=None,
        rag_result=rag,
        rag_executed=True,
        rag_succeeded=True,
    )

    assert "cell=AG2" in fused.context
    assert "value=12613.586" in fused.context
    assert "column=1Q24" in fused.context
    assert fused.context.index("RAG EVIDENCE") < fused.context.find("STRUCTURED DCI FACTS") or "STRUCTURED DCI FACTS" not in fused.context
    assert "never infer a cell address" in fused.context


def test_required_table_row_is_rescued_from_pre_rerank_candidates() -> None:
    wrong = _chunk("cell=D6 | value=0.302", doc_id="doc-1", content_type="table", row_label="毛利率")
    correct = _chunk("cell=D5 | value=89000", doc_id="doc-1", content_type="table", row_label="营业收入")
    fused = fuse_evidence(
        query="2025E营业收入和单元格",
        policy=RetrievalPolicy(
            mode="evidence_fusion",
            query_type="financial_calculation",
            run_rag=True,
            require_table_evidence=True,
        ),
        metric_result=None,
        keyword_result=None,
        rag_result={"final_chunks": [wrong], "pre_rerank_chunks": [wrong, correct]},
        rag_executed=True,
        rag_succeeded=True,
    )
    assert "cell=D5 | value=89000" in fused.context
    assert fused.final_chunks[0]["metadata"]["required_table_row_rescue"] is True


def test_formula_row_is_rescued_for_explicit_formula_request() -> None:
    header = _chunk("cell=C4 | value=单位影响系数", doc_id="doc-1", content_type="table", row_label="表头")
    formula = _chunk(
        "cell=B5 | value=1\ncell=C5 | value=0.006\ncell=D5 | value=0.006 | formula==B5*C5",
        doc_id="doc-1",
        content_type="table",
        row_label="基准变化",
    )
    fused = fuse_evidence(
        query="每上涨1万元，给出单元格和公式关系",
        policy=RetrievalPolicy(mode="evidence_fusion", query_type="single_fact", run_rag=True, require_table_evidence=True),
        metric_result=None,
        keyword_result=None,
        rag_result={"final_chunks": [header], "pre_rerank_chunks": [header, formula]},
        rag_executed=True,
        rag_succeeded=True,
    )
    assert "cell=D5 | value=0.006 | formula==B5*C5" in fused.context


def test_cost_of_revenue_row_is_rescued_for_chinese_metric() -> None:
    summary = _chunk("income statement summary", doc_id="doc-1", content_type="text")
    cogs = _chunk(
        "cell=R43 | value=-54544.61 | column=2024 | formula==PL_BS_CFS!M4",
        doc_id="doc-1",
        content_type="table",
        row_label="Cost of Goods Sold (-)",
    )
    fused = fuse_evidence(
        query="2024年营业成本是多少？请给出模型单元格",
        policy=RetrievalPolicy(mode="evidence_fusion", query_type="single_fact", run_rag=True, require_table_evidence=True),
        metric_result=None,
        keyword_result=None,
        rag_result={"final_chunks": [summary], "pre_rerank_chunks": [summary, cogs]},
        rag_executed=True,
        rag_succeeded=True,
    )
    assert "cell=R43 | value=-54544.61" in fused.context


def test_explicit_control_panel_peer_rows_are_rescued_without_policy_flag() -> None:
    summary = _chunk(
        "Excel sheet: Control panel; Key labels: Valuation, ROE, PER",
        doc_id="doc-1",
        content_type="excel_sheet_summary",
    )
    peer_rows = [
        _chunk(
            "Excel table row: model.xlsx | Control panel | row 23\n"
            "cell=A23 | value=Sungrow 2020E\ncell=B23 | value=ROE\n"
            "cell=C23 | value=0.2051756116 | column=2020",
            doc_id="doc-1", content_type="table", row_label="Sungrow 2020E",
        ),
        _chunk(
            "Excel table row: model.xlsx | Control panel | row 24\n"
            "cell=A24 | value=Sungrow 2021E\ncell=B24 | value=PER\n"
            "cell=D24 | value=21.4 | column=2021",
            doc_id="doc-1", content_type="table", row_label="Sungrow 2021E",
        ),
        _chunk(
            "Excel table row: model.xlsx | Control panel | row 25\n"
            "cell=A25 | value=Ginlong 2020E\ncell=B25 | value=ROE\n"
            "cell=C25 | value=0.2567 | column=2020",
            doc_id="doc-1", content_type="table", row_label="Ginlong 2020E",
        ),
        _chunk(
            "Excel table row: model.xlsx | Control panel | row 26\n"
            "cell=A26 | value=Ginlong 2021E\ncell=B26 | value=PER\n"
            "cell=D26 | value=33.9 | column=2021",
            doc_id="doc-1", content_type="table", row_label="Ginlong 2021E",
        ),
    ]
    fused = fuse_evidence(
        query="根据Control panel表中的同业比较，阳光电源与锦浪科技的2020E ROE和2021E PER分别是多少？",
        policy=RetrievalPolicy(mode="evidence_fusion", query_type="single_fact", run_rag=True),
        metric_result=None,
        keyword_result=None,
        rag_result={"final_chunks": [summary], "pre_rerank_chunks": [summary, *peer_rows]},
        rag_executed=True,
        rag_succeeded=True,
        config={"evidence_fusion": {"max_table_chunks": 6}},
    )
    assert "value=0.2051756116" in fused.context
    assert "value=21.4" in fused.context
    assert "value=0.2567" in fused.context
    assert "value=33.9" in fused.context
    assert "Normalized peer fact: issuer=sungrow; metric=ROE; 2020=20.5176%" in fused.context
    assert "Normalized peer fact: issuer=sungrow; metric=PER; 2021=21.4x" in fused.context
    assert "Normalized peer fact: issuer=ginlong; metric=ROE; 2020=25.67%" in fused.context
    assert "Normalized peer fact: issuer=ginlong; metric=PER; 2021=33.9x" in fused.context
    assert sum(bool(c["metadata"].get("peer_comparison_row_rescue")) for c in fused.final_chunks) == 4
