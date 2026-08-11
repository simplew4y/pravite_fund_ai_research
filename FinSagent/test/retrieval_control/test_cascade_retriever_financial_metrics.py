import sqlite3

from utils.cascade_retriever import CascadeRetriever, _extract_periods, _metric_terms


def test_metric_expansions_cover_formal_financial_rows():
    assert "cash_ind" in _metric_terms("阳光电源2024年现金及等价物是多少")
    assert "inventories_ind" in _metric_terms("阳光电源2024年存货是多少")
    assert "cf_op_ind" in _metric_terms("阳光电源2024年经营活动现金流是多少")
    assert "purchase of ppe" in _metric_terms("阳光电源2024年资本开支是多少")
    assert "num_sh1" in _metric_terms("阳光电源2024年总股本是多少")
    assert "cf_op_ind" in _metric_terms("计算阳光电源2024年自由现金流，列出公式和两个操作数")
    assert "capex_ind" in _metric_terms("计算阳光电源2024年自由现金流，列出公式和两个操作数")
    assert "tot_assets_ind" in _metric_terms("计算阳光电源2024年资产负债率")
    assert "sales_ind" in _metric_terms("计算阳光电源2024年归母净利润率")
    assert "eps_rp_ind" in _metric_terms("根据当前价计算2020的Trailing PE")
    assert "bvps" in _metric_terms("根据当前价计算2020的PB市净率（当前价/BVPS）")


def test_period_extraction_infers_yoy_and_qoq_comparisons():
    assert _extract_periods("计算2024年归母净利润同比增速") == ["2024", "2023"]
    assert _extract_periods("计算2Q24单季归母净利润同比增速") == ["2q24", "2q23"]
    assert _extract_periods("计算1Q24单季营收环比增速") == ["1q24", "4q23"]
    assert _extract_periods("计算2026E年归母净利润同比增速") == ["2026e", "2026", "2025"]
    assert _extract_periods("使用平均股东权益计算2024年ROE") == ["2024", "2023"]


def test_search_metric_uses_alias_period_and_formula(tmp_path):
    db = tmp_path / "collection.sqlite3"
    con = sqlite3.connect(db)
    con.execute(
        """CREATE TABLE metric_facts (
        metric_name TEXT, metric_alias TEXT, value_numeric REAL, value_text TEXT,
        unit TEXT, doc_id TEXT, period TEXT, sheet_name TEXT, cell_ref TEXT,
        formula TEXT, confidence REAL)"""
    )
    con.execute(
        "INSERT INTO metric_facts VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        ("CASH_IND", "cash_ind", 19799.44556, None, "CNYm", "doc-1", "2024", "Upload Sheet", "R139", "=PL_BS_CFS!M60", 1.0),
    )
    con.commit()
    con.close()

    result = CascadeRetriever(str(db)).search_metric(
        "阳光电源2024年现金及等价物是多少",
        allowed_doc_ids=["doc-1"],
        scope_explicit=True,
    )
    assert result is not None
    assert result["chunks"][0]["metadata"]["source_ref"] == "Upload Sheet R139"
    assert "formula==PL_BS_CFS!M60" in result["chunks"][0]["page_content"]


def test_company_scope_ignores_issuers_in_forbidden_clause(tmp_path):
    db = tmp_path / "collection.sqlite3"
    con = sqlite3.connect(db)
    con.execute(
        "CREATE TABLE documents (doc_id TEXT, company_name TEXT, company_ticker TEXT, original_filename TEXT)"
    )
    con.executemany(
        "INSERT INTO documents VALUES (?,?,?,?)",
        [
            ("porsche-doc", "Porsche AG", "P911_p.DE", "Porsche.xlsx"),
            ("nvda-doc", "NVIDIA Corporation", "NVDA.OQ", "NVIDIA.xlsm"),
            ("hermes-doc", "HERMES INTERNATIONAL", "HRMS.PA", "Hermes.xlsm"),
            ("horizon-doc", "Horizon Robotics", "9660.HK", "Horizon.xlsx"),
        ],
    )
    con.commit()
    con.close()
    aliases = {
        "P911_p.DE": ["保时捷", "Porsche"],
        "NVDA.OQ": ["英伟达", "NVIDIA"],
        "HRMS.PA": ["爱马仕", "Hermès"],
        "9660.HK": ["地平线", "Horizon Robotics"],
    }
    retriever = CascadeRetriever(str(db), company_aliases=aliases)
    ids, explicit = retriever.resolve_query_doc_ids(
        "仅使用保时捷文档回答归母净利润；不得引用NVIDIA、Hermès、地平线或其他公司。"
    )
    assert explicit is True
    assert ids == ["porsche-doc"]


def test_company_scope_keeps_both_positive_comparison_issuers(tmp_path):
    db = tmp_path / "collection.sqlite3"
    con = sqlite3.connect(db)
    con.execute(
        "CREATE TABLE documents (doc_id TEXT, company_name TEXT, company_ticker TEXT, original_filename TEXT)"
    )
    con.executemany(
        "INSERT INTO documents VALUES (?,?,?,?)",
        [
            ("nvda-doc", "NVIDIA Corporation", "NVDA.OQ", "NVIDIA.xlsm"),
            ("horizon-doc", "Horizon Robotics", "9660.HK", "Horizon.xlsx"),
        ],
    )
    con.commit()
    con.close()
    retriever = CascadeRetriever(
        str(db),
        company_aliases={"NVDA.OQ": ["NVIDIA"], "9660.HK": ["地平线"]},
    )
    ids, explicit = retriever.resolve_query_doc_ids(
        "比较NVIDIA模型封面分析师事实与地平线DCF结果，分别注明公司和文档，不得混用证据。"
    )
    assert explicit is True
    assert set(ids) == {"nvda-doc", "horizon-doc"}


def test_search_metric_infers_missing_unit_from_nearest_sheet_heading(tmp_path):
    db = tmp_path / "collection.sqlite3"
    con = sqlite3.connect(db)
    con.execute(
        """CREATE TABLE metric_facts (
        metric_name TEXT, metric_alias TEXT, value_numeric REAL, value_text TEXT,
        unit TEXT, doc_id TEXT, period TEXT, sheet_name TEXT, cell_ref TEXT,
        formula TEXT, confidence REAL)"""
    )
    con.execute(
        """CREATE TABLE excel_cells (
        doc_id TEXT, sheet_name TEXT, cell_ref TEXT, row_index INTEGER,
        col_index INTEGER, display_value TEXT)"""
    )
    con.execute(
        "INSERT INTO metric_facts VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        ("NP_XORD_IND", "net profit attributable", 1627.06, None, "", "porsche-doc", "2025E", "Financials", "AY209", "", 1.0),
    )
    con.execute(
        "INSERT INTO excel_cells VALUES (?,?,?,?,?,?)",
        ("porsche-doc", "Financials", "C163", 163, 3, "P&L in EURm"),
    )
    con.executemany(
        "INSERT INTO excel_cells VALUES (?,?,?,?,?,?)",
        [
            ("porsche-doc", "Financials", f"N{200 + index // 40}", 200 + index // 40, index % 40, f"noise-{index}")
            for index in range(300)
        ],
    )
    con.commit()
    con.close()

    result = CascadeRetriever(str(db)).search_metric(
        "保时捷2025E归母净利润",
        allowed_doc_ids=["porsche-doc"],
        scope_explicit=True,
    )
    assert result is not None
    assert result["chunks"][0]["metadata"]["unit"] == "EURm"
    assert "EURm" in result["chunks"][0]["page_content"]
