from core.RAG import RAG


def _chunk(row_label: str):
    return {"metadata": {"row_label": row_label}}


def test_requested_revenue_row_gets_exact_label_bonus():
    query = "列出2025E、2026E、2027E营业收入"
    assert RAG._financial_row_label_bonus(query, _chunk("营业收入")) == 1.25
    assert RAG._financial_row_label_bonus(query, _chunk("逆变器业务毛利率")) == 0.0


def test_requested_margin_does_not_promote_revenue_row():
    query = "2026E毛利率是多少"
    assert RAG._financial_row_label_bonus(query, _chunk("毛利率")) == 1.25
    assert RAG._financial_row_label_bonus(query, _chunk("营业收入")) == 0.0


def test_requested_cost_of_revenue_promotes_cogs_row():
    query = "阳光电源2024年营业成本是多少"
    assert RAG._financial_row_label_bonus(query, _chunk("Cost of Goods Sold (-)")) == 1.25
    assert RAG._financial_row_label_bonus(query, _chunk("Gross Profit")) == 0.0
