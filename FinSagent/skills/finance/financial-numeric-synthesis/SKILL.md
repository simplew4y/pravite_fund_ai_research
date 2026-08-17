---
name: finskillops-financial-numeric-synthesis
description: Verify and synthesize financial values from scoped DCI and RAG evidence.
version: 0.1.0-pf1
category: finance
---

# Financial Numeric Synthesis

Use this workflow when the user requests a financial value, ratio, comparison,
or a concise explanation containing financial numbers.

## Evidence Fusion workflow

1. Preserve the issuer, exact metric wording and all qualifiers from the user request.
2. Resolve the requested fiscal period, comparison basis, actual/estimate status,
   currency and unit before choosing a value.
3. Inspect all admitted DCI metric facts and RAG chunks. DCI is structured
   evidence, not an answer shortcut; low-confidence DCI must be checked against
   document evidence instead of discarded.
4. Accept a number only when its metric label, period, unit and source span are
   compatible with the request. Keep signs and scale exactly as disclosed.
5. If compatible sources conflict, show the conflict and prefer the more direct,
   authoritative and period-specific source. Never silently average values.
6. Return the value together with period, unit/currency, actual-or-estimate label
   and a traceable source reference. Explain calculations and operands when a
   derived value is requested.

## Private-fund boundary

- Use only evidence admitted by `active_dataset` and `allowed_doc_ids`.
- Never import a same-named metric from another issuer or workbook.
- Do not fill a missing number from model memory, semantic similarity or an
  unscoped external source.
- If the evidence is insufficient, state which slot is missing instead of
  fabricating a complete answer.
