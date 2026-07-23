---
name: private-fund-valuation-metrics
description: Identify a valuation model's valuation date and the five standard model metrics from Excel facts or source-backed evidence, then return validated, fixed-shape JSON. Use when extracting or reviewing single-quarter net-profit growth, gross-margin sequential change, Forward PE, 20-day average turnover amount, single-quarter revenue-growth acceleration, valuation dates, or when model templates and labels vary across companies.
---

# 📝 Private Fund Valuation Metrics

Identify semantics across heterogeneous valuation workbooks while preserving exact evidence. Never fill a missing value by assumption.

## Workflow

1. Read [references/output-schema.json](references/output-schema.json) before extracting.
2. Establish the target company, model document, model version, and optional target-period hint.
3. In an interactive research session, retrieve candidate facts with `mcp__omnigent__private_fund_dataset_search` and inspect every selected fact or cell with `mcp__omnigent__private_fund_source_detail`. In an automated worker run, use only the supplied evidence packet.
4. Identify the valuation date from an explicit “valuation date”, “as of”, “基准日”, or equivalent workbook cell. Use the document date or filename only when it clearly denotes the model valuation date; cite `document:<doc_id>` and explain that inference.
5. Map evidence to exactly these metric keys:
   - `quarter_net_profit_yoy`: current standalone-quarter attributable net profit divided by the same quarter one year earlier, minus one.
   - `quarter_gross_margin_qoq_delta`: current standalone-quarter gross margin minus the immediately preceding quarter's gross margin.
   - `forward_pe`: explicit Forward/FWD/NTM/FY1 P/E only. Never substitute TTM, Current, trailing, or historical P/E.
   - `avg_turnover_amount_20d`: explicit model assumption for the arithmetic mean of the latest 20 complete trading days' traded amount. Do not convert trading volume into amount without price evidence.
   - `quarter_revenue_growth_qoq`: current quarter revenue YoY growth minus the immediately preceding quarter's revenue YoY growth.
6. Prefer standalone-quarter facts. If the workbook contains cumulative YTD figures, derive a standalone quarter only when both cumulative inputs have matching scope, unit, currency, and fiscal basis.
7. Preserve the source unit. Normalize percentage outputs to decimals: `12.5%` becomes `0.125`; a 2.1 percentage-point change becomes `0.021`.
8. Return one JSON object only, matching the reference schema. Include all five metrics in schema order even when unavailable.

## Evidence and Validation Rules

- Cite only supplied or tool-resolved `fact:`, `cell:`, or `document:` IDs.
- Cite at least two inputs for a derived growth or margin change. Cite all four quarter inputs for revenue-growth acceleration when it is calculated from revenues.
- Keep `value_numeric` null and `status` equal to `unavailable` when period, scope, unit, or evidence is insufficient.
- Put the human-readable `Sheet!Cell` locations in `source`; put the calculation in `derivation`.
- Use ISO `YYYY-MM-DD` for `valuation_date.value` and `YYYYQn` for quarterly `period`.
- Report conflicting candidates in `warnings`; do not average them or silently choose a low-confidence value.
- Do not invent values, dates, units, periods, evidence IDs, or certainty.
