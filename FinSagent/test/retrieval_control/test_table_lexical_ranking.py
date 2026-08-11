from utils.EnsembleRetriever import EnsembleRetriever


def test_exact_sheet_metric_and_period_outweigh_semantic_neighbor() -> None:
    query = "只根据QoQ&Results表回答阳光电源1Q24和1Q23单季营业收入"
    target = (
        "Excel table row: 300274 v44.xlsx | QoQ&Results | row 2\n"
        "Row label: Revenue\nperiod=1Q23\nperiod=1Q24"
    )
    neighbor = (
        "Excel table row: 300274 v44.xlsx | Chart | row 92\n"
        "Row label: Revenue growth rate\nperiod=2022"
    )
    target_score = EnsembleRetriever._table_lexical_score(
        query, target, {"source_ref": "300274 v44.xlsx QoQ&Results!row 2", "row_label": "Revenue"}
    )
    neighbor_score = EnsembleRetriever._table_lexical_score(
        query, neighbor, {"source_ref": "300274 v44.xlsx Chart!row 92", "row_label": "Revenue growth rate"}
    )
    assert target_score > neighbor_score


def test_annual_revenue_alias_matches_english_financial_row() -> None:
    score = EnsembleRetriever._table_lexical_score(
        "阳光电源2024年营业收入",
        "Row label: Revenue\ncell=M3 | value=77856.96696 | period=2024 | unit=CNYm",
        {"source_ref": "300274 v44.xlsx PL_BS_CFS!row 3", "row_label": "Revenue"},
    )
    assert score >= 16.0


def test_standalone_generated_table_chunk_does_not_require_neighbors() -> None:
    retriever = object.__new__(EnsembleRetriever)
    retriever.enable_expand = True
    retriever.docid2idx = {"row-1": 0}
    retriever.chunk_metadata = [{"doc_id": "row-1", "content_type": "table"}]
    assert retriever._expand_ids([0], retriever.chunk_metadata[0], {0: 0.9}, set()) == [0]
