#!/usr/bin/env python3
"""Build a 90-case formal suite from auditable FinSagent database truth."""

from __future__ import annotations

import argparse
import json
import sqlite3
from pathlib import Path
from typing import Any


DOC_ID = "7c512f613540ee7590f9d63d2648344633f07e12"
CORE = {
    "IS1": ("营业收入", "SALES_IND"), "IS2": ("营业成本", "COGS_IND"),
    "IS3": ("毛利润", "GP_IND"), "IS4": ("毛利率", "GROSS_MARGIN_IND"),
    "IS5": ("营业利润（EBIT）", "EBIT_IND"), "IS6": ("归母净利润", "NP_XORD_IND"),
    "IS7": ("基本每股收益", "EPS_RP_IND"), "BS1": ("总资产", "TOT_ASSETS_IND"),
    "BS2": ("总负债", "TOT_LIABS_IND"), "BS3": ("股东权益", "SHR_EQTY"),
    "BS4": ("现金及等价物", "CASH_IND"), "BS5": ("应收账款", "ACCTS_REC_IND"),
    "BS6": ("存货", "INVENTORIES_IND"), "CF1": ("经营活动现金流", "CF_OP_IND"),
    "CF2": ("资本开支（绝对值）", "CAPEX_IND"),
}


def row(conn: sqlite3.Connection, metric: str, period: str) -> sqlite3.Row:
    result = conn.execute(
        "select * from metric_facts where metric_name=? and period=? and trim(sheet_name)='Upload Sheet' order by confidence desc limit 1",
        (metric, period),
    ).fetchone()
    if result is None:
        raise KeyError((metric, period))
    return result


def qrow(conn: sqlite3.Connection, metric: str, period: str) -> sqlite3.Row:
    result = conn.execute(
        "select * from metric_facts where metric_name=? and period=? and sheet_name='QoQ&Results' order by confidence desc limit 1",
        (metric, period),
    ).fetchone()
    if result is None:
        raise KeyError((metric, period))
    return result


def cell(conn: sqlite3.Connection, ref: str) -> sqlite3.Row:
    result = conn.execute(
        "select * from excel_cells where trim(sheet_name)='Control panel' and cell_ref=? limit 1", (ref,)
    ).fetchone()
    if result is None:
        raise KeyError(ref)
    return result


def atom(metric: str, value: float, unit: str, period: str, **extra: Any) -> dict[str, Any]:
    payload: dict[str, Any] = {"metric_id": metric, "value": round(float(value), 8), "unit": unit, "period": period}
    payload.update(extra)
    return payload


def case(case_id: str, metric: str, question: str, answer_atoms: list[dict[str, Any]], *, family: str = "formal_metric", must_refuse: bool = False) -> dict[str, Any]:
    return {
        "case_id": case_id, "priority": "P0", "dataset_id": "ygdy_data", "task_family": family,
        "metric_ids": [metric], "question": question, "company": "阳光电源", "ticker": "300274.CH",
        "answer_atoms": answer_atoms, "tolerance_rule": "must_refuse" if must_refuse else "formal_metric",
        "allowed_doc_ids": [DOC_ID], "forbidden_doc_ids": [],
        "expected_skills": ["period_alignment", "finskillops_financial_numeric_synthesis", "table_evidence_verifier"],
        "must_refuse": must_refuse, "data_class": "real", "formal_metric_coverage": True,
    }


def build(conn: sqlite3.Connection, smoke_path: Path) -> list[dict[str, Any]]:
    cases: list[dict[str, Any]] = []
    seq = 1
    for metric, (label, field) in CORE.items():
        for period in ("2024", "2026E"):
            source = row(conn, field, period)
            value = float(source["value_numeric"])
            if metric in {"IS2", "CF2"}:
                value = abs(value)
            if metric == "IS4":
                value *= 100
            unit = "CNY/share" if metric == "IS7" else ("%" if metric == "IS4" else "CNYm")
            actual = "实际" if period == "2024" else "预测"
            cases.append(case(f"FORMAL_{metric}_{seq:03d}", metric, f"阳光电源{period}年{label}是多少？请注明这是{actual}值、单位和模型单元格来源。", [atom(metric, value, unit, period, actual_or_estimate="actual" if period == "2024" else "estimate", source_ref=f"Upload Sheet!{source['cell_ref']}")]))
            seq += 1

    # BS7 interest-bearing debt, CF3 formal free cash flow.
    for metric, label in (("BS7", "有息负债"), ("CF3", "自由现金流")):
        for period in ("2024", "2026E"):
            if metric == "BS7":
                left, right = row(conn, "ST_DEBT_IND", period), row(conn, "LT_DEBT_IND", period)
                value = abs(float(left["value_numeric"])) + abs(float(right["value_numeric"]))
                formula = "abs(ST_DEBT_IND)+abs(LT_DEBT_IND)"
            else:
                left, right = row(conn, "CF_OP_IND", period), row(conn, "CAPEX_IND", period)
                value = float(left["value_numeric"]) - abs(float(right["value_numeric"]))
                formula = "CF_OP_IND-abs(CAPEX_IND)"
            cases.append(case(f"FORMAL_{metric}_{seq:03d}", metric, f"按正式口径计算阳光电源{period}年{label}，列出公式和两个操作数。", [atom(metric, value, "CNYm", period, formula=formula)], family="derived_metric"))
            seq += 1

    # D1-D5 quarterly calculations, two periods each.
    quarter_specs = {
        "D1": [("1Q24", "1Q23"), ("2Q24", "2Q23")],
        "D2": [("1Q24", "1Q23"), ("2Q24", "2Q23")],
        "D3": [("1Q24", "4Q23"), ("2Q24", "1Q24")],
        "D4": [("1Q24", ""), ("2Q24", "")],
        "D5": [("1Q24", "4Q23"), ("2Q24", "1Q24")],
    }
    for metric, pairs in quarter_specs.items():
        for current, base in pairs:
            if metric == "D1":
                a, b = qrow(conn, "Revenue", current), qrow(conn, "Revenue", base); value = (float(a["value_numeric"]) - float(b["value_numeric"])) / abs(float(b["value_numeric"])) * 100
                question = f"计算阳光电源{current}单季营收同比增速，列出当季和上年同期收入。"
            elif metric == "D2":
                a, b = qrow(conn, "Net profit attributable to shareholders", current), qrow(conn, "Net profit attributable to shareholders", base); value = (float(a["value_numeric"]) - float(b["value_numeric"])) / abs(float(b["value_numeric"])) * 100
                question = f"计算阳光电源{current}单季归母净利润同比增速，列出两个操作数。"
            elif metric == "D3":
                a, b = qrow(conn, "Revenue", current), qrow(conn, "Revenue", base); value = (float(a["value_numeric"]) - float(b["value_numeric"])) / float(b["value_numeric"]) * 100
                question = f"计算阳光电源{current}单季营收环比增速，基期为{base}。"
            elif metric == "D4":
                a = qrow(conn, "Gross margin", current); value = float(a["value_numeric"]) * 100
                question = f"阳光电源{current}单季毛利率是多少？请同时用毛利润/收入验算。"
            else:
                a, b = qrow(conn, "Gross margin", current), qrow(conn, "Gross margin", base); value = (float(a["value_numeric"]) - float(b["value_numeric"])) * 100
                question = f"阳光电源{current}单季毛利率较{base}环比变化多少个百分点？"
            cases.append(case(f"FORMAL_{metric}_{seq:03d}", metric, question, [atom(metric, value, "%" if metric != "D5" else "ppt", current, comparison_period=base)], family="quarterly_derived"))
            seq += 1

    for metric in ("D6", "D7"):
        for period, previous in (("2024", "2023"), ("2026E", "2025")):
            if metric == "D6":
                profit = float(row(conn, "NP_XORD_IND", period)["value_numeric"])
                equity_now = float(row(conn, "SHR_EQTY", period)["value_numeric"])
                equity_prev = float(row(conn, "SHR_EQTY", previous)["value_numeric"])
                value = profit / ((equity_now + equity_prev) / 2) * 100
                question = f"使用平均股东权益计算阳光电源{period}年ROE，并列出归母净利润及期初期末权益。"
            else:
                liabilities = float(row(conn, "TOT_LIABS_IND", period)["value_numeric"])
                assets = float(row(conn, "TOT_ASSETS_IND", period)["value_numeric"])
                value = liabilities / assets * 100
                question = f"计算阳光电源{period}年资产负债率，并列出总负债和总资产。"
            cases.append(case(f"FORMAL_{metric}_{seq:03d}", metric, question, [atom(metric, value, "%", period)], family="derived_metric")); seq += 1

    # R1-R5 annual calculations.
    ratio_labels = {
        "R1": "营收同比增速", "R2": "归母净利润同比增速", "R3": "EBIT利润率",
        "R4": "归母净利润率", "R5": "经营性现金流占营业收入比率",
    }
    for metric in ("R1", "R2", "R3", "R4", "R5"):
        for period, previous in (("2024", "2023"), ("2026E", "2025")):
            sales = float(row(conn, "SALES_IND", period)["value_numeric"])
            if metric == "R1": value = (sales - float(row(conn, "SALES_IND", previous)["value_numeric"])) / abs(float(row(conn, "SALES_IND", previous)["value_numeric"])) * 100
            elif metric == "R2":
                now, old = float(row(conn, "NP_XORD_IND", period)["value_numeric"]), float(row(conn, "NP_XORD_IND", previous)["value_numeric"]); value = (now-old)/abs(old)*100
            elif metric == "R3": value = float(row(conn, "EBIT_IND", period)["value_numeric"]) / sales * 100
            elif metric == "R4": value = float(row(conn, "NP_XORD_IND", period)["value_numeric"]) / sales * 100
            else: value = float(row(conn, "CF_OP_IND", period)["value_numeric"]) / sales * 100
            cases.append(case(f"FORMAL_{metric}_{seq:03d}", metric, f"计算阳光电源{period}年{ratio_labels[metric]}，列出公式和操作数。", [atom(metric, value, "%", period, comparison_period=previous)], family="annual_ratio")); seq += 1

    # V1/V2/V3/V6/V7 from audited Control panel and share cells.
    price = float(cell(conn, "B16")["numeric_value"])
    valuation_specs = [
        ("V1", "Forward PE", "2021E", price / float(cell(conn, "D11")["numeric_value"]), "x", "当前价/2021E EPS"),
        ("V1", "Forward PE", "2022E", price / float(cell(conn, "E11")["numeric_value"]), "x", "当前价/2022E EPS"),
        ("V2", "Trailing PE", "2020", price / float(cell(conn, "C11")["numeric_value"]), "x", "当前价/2020 EPS"),
        ("V2", "Trailing PE", "2020", price / float(cell(conn, "C11")["numeric_value"]), "x", "换算复核"),
        ("V3", "PB市净率", "2020", price / float(cell(conn, "C10")["numeric_value"]), "x", "当前价/2020 BVPS"),
        ("V3", "PB市净率", "2021E", price / float(cell(conn, "D10")["numeric_value"]), "x", "当前价/2021E BVPS"),
    ]
    for metric, label, period, value, unit, note in valuation_specs:
        cases.append(case(f"FORMAL_{metric}_{seq:03d}", metric, f"根据Control panel当前价110.94元，计算阳光电源{period}的{label}（{note}）。", [atom(metric, value, unit, period)], family="valuation")); seq += 1
    shares_2024 = float(conn.execute("select value_numeric from metric_facts where metric_name='Shares outstanding (m, period-end)' and period='2024' and sheet_name='PL_BS_CFS' limit 1").fetchone()[0])
    for metric in ("V6", "V7"):
        for variant in range(2):
            value, unit = (shares_2024, "million shares") if metric == "V6" else (price * shares_2024, "CNYm")
            question = f"阳光电源2024年总股本是多少百万股？" if metric == "V6" else f"按当前价110.94元和2024年总股本计算阳光电源总市值。"
            cases.append(case(f"FORMAL_{metric}_{seq:03d}", metric, question + (" 请同时换算单位。" if variant else ""), [atom(metric, value, unit, "2024")], family="valuation")); seq += 1

    # V4/V5 are deliberately unavailable without a market-data series.
    for metric, label in (("V4", "近20日日均成交额"), ("V5", "近20日日均成交量")):
        for suffix in ("截至模型估值日", "截至2024年6月30日"):
            cases.append(case(f"FORMAL_{metric}_{seq:03d}", metric, f"仅根据当前入库资料，计算阳光电源{suffix}的{label}；若缺少20个交易日明细必须明确拒答。", [], family="external_data_gap", must_refuse=True)); seq += 1

    if len(cases) != 72:
        raise AssertionError(f"formal metric cases: {len(cases)}")
    smoke = json.loads(smoke_path.read_text(encoding="utf-8"))["cases"]
    cases.extend(smoke)
    # Six user-experience composites complete the 90-case suite.
    composites = [
        ("UX_COMPOSITE_085", "ygdy_data", ["IS1", "IS6"], "同时列出阳光电源2024年实际和2026E预测的营业收入、归母净利润，并标明实际/预测。"),
        ("UX_COMPOSITE_086", "ygdy_data", ["D1", "D3", "D4", "D5"], "对阳光电源2024年一、二季度做单季收入同比/环比和毛利率变化的小结，列出计算过程。"),
        ("UX_COMPOSITE_087", "ygdy_data", ["R1", "R2", "R3", "R4", "R5"], "基于2024年数据生成收入增长、利润增长、EBIT率、净利率及经营现金流/收入的质量摘要。"),
        ("UX_COMPOSITE_088", "test_real_data", [], "仅使用保时捷文档回答其2024、2025E、2026E归母净利润；不得引用NVIDIA、Hermès、地平线或其他公司。"),
        ("UX_COMPOSITE_089", "test_real_data", [], "比较NVIDIA模型封面分析师事实与地平线DCF结果，分别注明公司和文档，不得混用证据。"),
        ("UX_COMPOSITE_090", "ygdy_report_skill_lab", ["IS1", "IS6", "D4"], "生成阳光电源盈利桥的一页式投资委员会摘要，必须列出Excel中的2025E-2027E收入和三种情景。"),
    ]
    for case_id, dataset, metrics, question in composites:
        cases.append({"case_id": case_id, "priority": "P0", "dataset_id": dataset, "task_family": "ux_composite", "metric_ids": metrics, "question": question, "company": "multi", "ticker": "", "answer_atoms": [], "tolerance_rule": "llm_judge_plus_evidence", "allowed_doc_ids": [], "forbidden_doc_ids": [], "expected_skills": [], "must_refuse": False, "data_class": "real_or_isolated", "formal_metric_coverage": False})
    if len(cases) != 90:
        raise AssertionError(len(cases))
    return cases


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", required=True)
    parser.add_argument("--smoke", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    conn = sqlite3.connect(args.db); conn.row_factory = sqlite3.Row
    cases = build(conn, Path(args.smoke)); conn.close()
    payload = {"suite_id": "finsagent_formal_90_v1", "formal_metric_system": "IS1-IS7, BS1-BS7, CF1-CF3, D1-D7, V1-V7, R1-R5", "cases": cases}
    target = Path(args.output); target.parent.mkdir(parents=True, exist_ok=True); target.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    counts: dict[str, int] = {}
    for item in cases:
        for metric in item.get("metric_ids") or []: counts[metric] = counts.get(metric, 0) + 1
    print(json.dumps({"cases": len(cases), "metric_counts": counts, "output": str(target)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
