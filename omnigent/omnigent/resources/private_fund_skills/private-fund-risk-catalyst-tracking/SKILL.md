---
name: private-fund-risk-catalyst-tracking
description: Extract, verify, normalize, and reconcile evidence-backed private-fund risks and catalysts. Use when project documents or Memo versions must update the durable risk/catalyst ledger, when classifying ambiguous investment events, or when deciding whether a change deserves an alert.
---

# Private Fund Risk And Catalyst Tracking

Build a high-precision event ledger from supplied evidence. Prefer `needs_review` or rejection over an unsupported classification.

## Workflow

1. Treat every evidence block independently before reconciling related blocks.
2. Apply the definitions and counterexamples in [references/taxonomy.md](references/taxonomy.md).
3. Normalize entities and event identity with [references/normalization.md](references/normalization.md).
4. Return only items supported by one or more supplied evidence IDs.
5. Apply [references/alert-policy.md](references/alert-policy.md) when assigning impact and quality.

## Output contract

Return one JSON array and no prose. Each item must contain:

- `item_type`: `risk`, `catalyst`, `assumption`, `metric`, `thesis`, or `question`.
- `canonical_key`: stable event identity, not a copied sentence.
- `title`, `content`, `evidence_ids`, `state`, `impact`, `confidence`.
- Risks and catalysts must include `evidence_quotes`: a list of `{evidence_id, quote}` objects.
  Every quote must be an exact 8-160 character passage copied from its cited evidence block.
- `entity`, `event_type`, `subject`, `direction`.
- `trigger`, `transmission_path`, `classification_reason` for risks and catalysts.
- `expected_start` and `expected_end` only when evidence supports them.
- `quality_status`: `verified` only when the required structure and evidence are present; otherwise `needs_review`.

Use `direction=negative` for risks. Catalysts may be `positive`, `negative`, or `neutral`. Never invent a date, probability, metric, company, or causal path.

## Guardrails

- Do not classify a realized operating metric as a risk merely because it declined.
- Do not classify a forecast, margin assumption, valuation input, or generic positive statement as a catalyst.
- Do not treat `risk-free rate` or `无风险利率` as business risk.
- Do not create multiple items for translations or paraphrases of the same company event.
- Never use moderator prompts, speaker hand-offs, timestamps, or an adjacent chunk as evidence.
- The cited chunk must contain the exact supporting quote. If support spans chunks, cite each exact
  chunk separately. Reject the item when no supplied chunk directly supports the judgement.
- Do not infer invalidation from omission in a later Memo.
- Keep source language in `content`; use concise Chinese for `title` when the project is Chinese.
