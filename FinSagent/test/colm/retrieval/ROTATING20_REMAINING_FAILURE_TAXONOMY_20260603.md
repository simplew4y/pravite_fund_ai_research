# Rotating20 Remaining Failure Taxonomy

Date: 2026-06-03

Baseline for this report:

- Run: `test/colm/retrieval/skill_evolution_rotating_run_20260603/capitalization_skill_v1`
- Judge: 12 CORRECT / 3 PARTIAL / 5 INCORRECT
- Gate: 20 ALLOW / 0 REVIEW / 0 BLOCK
- Meaning: deterministic table risk is mostly closed for this diagnostic set; remaining failures are mainly coverage, source freshness, company profile, or definition-boundary issues.

## Remaining Non-Correct Cases

| index | verdict | failure type | short diagnosis | recommended action |
| --- | --- | --- | --- | --- |
| q21 | INCORRECT | latest financial/profile snapshot | The answer used an acquisition/privatization framing and 2023 liquidity, while gold expects missing market price, IPO/share structure, June 2025 cash, parent financing support, and volatile operating cash flow. | Do not patch as a table rule. Treat as latest-snapshot/profile skill or manual fact-registry candidate. |
| q45 | PARTIAL | coverage omission | Answer covers production/supply/R&D/uncertainty but misses explicit sales and marketing activity delays. | Low priority. Only fix if sales/marketing-delay omissions recur across cases. |
| q59 | PARTIAL | descriptor coverage | Answer identifies SEA platform but omits “open-source” and “modularized.” | Low priority profile fact. Avoid making a broad platform factbook. |
| q63 | PARTIAL | risk-factor coverage | Answer covers most risk points but omits foreign-exchange risk from large foreign-currency assets. | Medium-low priority. Consider risk-factor checklist only if multiple risk questions miss named risk categories. |
| q65 | INCORRECT | latest product roadmap | Answer over-includes 2024/extra models, under-specifies 2025 three-model plan, and misses two hybrid SUVs plus 2.0T hybrid engine detail. | Do not hard-code yet. This is a dynamic product-roadmap/latest-info problem. |
| q72 | INCORRECT | latest balance-sheet snapshot | Answer used 2021-2023 historical liabilities instead of 2025 Q1 / 2024 year-end liability snapshot expected by gold. | Pair with q21 under latest financial snapshot if pursued. Needs source-freshness guard. |
| q85 | INCORRECT | metric-definition conflict | Table answer gives Q4 2023 revenue breakdown in RMB, but gold expects “other sales revenue” of US$0.79B / $7.9e8. The category definition may not match generated table labels. | Do not hard-fix. Mark for human adjudication or metric-definition investigation. |
| q122 | INCORRECT | corporate structure chain | Answer found the right entity chain but added harmful uncertainty, saying the 100% chain was not definitively evidenced while gold expects a clear “Yes” with the 100% chain. | Best next structural skill: corporate ownership chain extraction/rendering from SEC structure disclosures. |

## Buckets

### Closed Or Mostly Closed

- Deterministic table facts: cash/quarterly metrics/revenue mix/component mix/capitalization now have passing gates on this rotating20 set.
- Period answer coverage: q93, q94, q95, q98 were repaired from partial to correct.
- Capitalization line items: q129 was repaired from incorrect to correct.

### Still Open

- Latest snapshot / source freshness: q21, q65, q72.
- Company/profile coverage: q45, q59, q63.
- Corporate structure graph: q122.
- Metric-definition ambiguity: q85.

## Next Skill Priority

P0: Corporate ownership chain skill.

Why: q122 is structural, SEC-native, and not merely a Zeekr answer patch. Many SEC filings have corporate structure diagrams or entity chains with percentage ownership. A reusable skill can:

- detect questions asking for ultimate parent / main operating company / ownership chain;
- retrieve corporate structure or organization chart sections;
- extract entity edges and ownership percentages;
- render a direct answer without adding unsupported uncertainty when the chain explicitly says 100%.

P1: Latest financial snapshot guard.

Why: q21 and q72 both failed because the answer used stale/historical snapshots instead of the latest expected date. This could be useful, but it is riskier because “latest” questions depend on moving external data and benchmark cutoff. It needs strong cutoff/source-date policy before implementation.

P2: Risk/profile descriptor coverage.

Why: q45/q59/q63 are partial omissions. These are useful for polish, but each missing item is a small benchmark-specific descriptor. Do only if repeated across fresh diagnostics.

Do not pursue now: q85.

Why: q85 may be a metric-definition or gold-label ambiguity. Fixing it directly would look like answer-key patching and could damage generality.

## Stop Boundary

Stop table-verifier expansion for this diagnostic set. The gate is already 20/20 ALLOW. More table work now has low marginal return and a high chance of overfitting.

Proceed only with one structural non-table skill at a time. If a candidate cannot improve a targeted failure without changing unrelated answers or weakening protected/cross-company gates, leave it as a report item rather than forcing a repair.
