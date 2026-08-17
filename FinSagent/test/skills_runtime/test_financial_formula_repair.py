from utils.financial_formula_repair import repair_financial_formula_answer


def fact(name, period, value, source="Sheet A1"):
    return {"metric_name": name, "period": period, "value": str(value), "source_ref": source}


def test_repairs_formal_fcf_without_model_adjustment():
    result = repair_financial_formula_answer(
        "按正式口径计算阳光电源2026E年自由现金流",
        "old",
        [fact("CF_OP_IND", "2026E", 16561.2432281153), fact("CAPEX_IND", "2026E", -2931.414090760001)],
    )
    assert result["repair_applied"]
    assert "13,629.83 CNYm" in result["answer"]


def test_normalizes_operating_cost_to_positive_metric_magnitude():
    result = repair_financial_formula_answer(
        "阳光电源2026E年营业成本是多少？",
        "营业成本为-67,704.36百万元人民币",
        [fact("COGS_IND", "2026E", -67704.35991, "Upload Sheet T43")],
    )
    assert result["repair_applied"]
    assert "67,704.36 CNYm" in result["answer"]
    assert "原始列示值为-67,704.36 CNYm" in result["answer"]
    assert result["formula"] == "abs(COGS_IND)"


def test_repairs_pe_and_market_cap_arithmetic():
    pe = repair_financial_formula_answer(
        "根据当前价110.94元计算2020的Trailing PE（当前价/2020 EPS）",
        "old",
        [fact("EPS_RP_IND", "2020", 0.9609008954577172)],
    )
    assert "115.45倍" in pe["answer"]

    cap = repair_financial_formula_answer(
        "按当前价110.94元和2024年总股本计算总市值",
        "old",
        [fact("NUM_SH1", "2024", 2073.211424)],
    )
    assert "230,002.08 CNYm" in cap["answer"]
    assert "2,300.02亿元" in cap["answer"]


def test_estimate_period_accepts_model_period_without_e_suffix():
    result = repair_financial_formula_answer(
        "根据当前价110.94元计算2021E的PB市净率（当前价/2021E BVPS）",
        "old",
        [fact("BPS", "2021", 7.550841658515167)],
    )
    assert "14.69倍" in result["answer"]


def test_cost_normalization_does_not_replace_a_gross_margin_answer():
    result = repair_financial_formula_answer(
        "用2024年营业收入和营业成本计算毛利率",
        "原答案应保留",
        [fact("COGS_IND", "2024", -60), fact("SALES_IND", "2024", 100)],
    )
    assert result["repair_applied"] is False
    assert result["answer"] == "原答案应保留"


def test_missing_question_period_fails_closed_when_facts_span_periods():
    result = repair_financial_formula_answer(
        "按当前价110.94元计算Trailing PE",
        "原答案应保留",
        [fact("EPS_RP_IND", "2023", 1.0), fact("EPS_RP_IND", "2024", 2.0)],
    )
    assert result["repair_applied"] is False
    assert result["answer"] == "原答案应保留"


def test_market_cap_rejects_monetary_share_capital_row():
    result = repair_financial_formula_answer(
        "按当前价110.94元和2024年总股本计算总市值",
        "原答案应保留",
        [fact("ORD_CAPITAL", "2024", 5000)],
    )
    assert result["repair_applied"] is False
