---
name: private-fund-valuation-impacts
description: Extract evidence-backed valuation-impact paths from research reports, meeting minutes, financial reports, announcements, and other supporting documents, then return fixed-shape JSON for valuation tracking. Use when supporting materials must be translated into upside, downside, or mixed effects on a current valuation model without changing model values.
---

# 📝 Private Fund Valuation Impacts

Translate current supporting evidence into auditable valuation-impact cards. Do not rewrite the valuation model or fill the five model-versus-actual metrics.

## Workflow

1. Read [references/output-schema.json](references/output-schema.json).
2. Review the supplied model context only to understand which valuation inputs exist.
3. Review every supplied supporting-document excerpt and its `chunk:` evidence ID.
4. Select only distinct, decision-relevant impact paths. Prefer fewer supported cards over speculative coverage.
5. Separate the factual `evidence_summary` from the inferred `valuation_impact`.
6. Map each impact to one direction and one or more controlled `affected_inputs`.
7. Keep controlled keys, evidence IDs, and direct quotations unchanged.
8. Return one JSON object matching the schema. Return an empty `impacts` array when evidence is insufficient.

## Direction and Confidence

- Use `up` only when the evidence supports a plausible upward change to cash flow, growth, profitability, success probability, or valuation multiple.
- Use `down` only when the evidence supports a plausible downward change or a higher discount/risk assumption.
- Use `mixed` when timing, costs, probability, or policy can materially offset the positive case.
- Treat management plans, forecasts, orders, and product roadmaps as unverified until delivery, acceptance, revenue recognition, or independent confirmation.
- Lower confidence when evidence comes from one speaker, one document, an imprecise transcript, or a long-dated plan.

## Evidence Rules

- Cite only supplied `chunk:` IDs. Include at least one evidence ID per card.
- Never invent figures, dates, customers, orders, policies, source pages, or certainty.
- Do not present an estimate, guidance, or management assertion as an achieved result.
- Do not repeat the same evidence path under multiple titles.
- Keep titles short, evidence summaries factual, valuation impacts explicit, and watch items testable.
- The service derives source names and page references from cited evidence. Do not fabricate source labels.

## Valuation Rules

- Explain the transmission path to current valuation, such as revenue growth, margin, investment, working capital, free cash flow, WACC, terminal growth, valuation multiple, timing discount, or success probability.
- Use probability weighting and timing discounts for products or markets that are not yet commercialized.
- Reflect policy and execution uncertainty in risk premium or probability, not as certain revenue loss.
- Keep cards explanatory. They must not directly alter model values, actual values, or alerts.
