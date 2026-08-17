---
name: financial-formula-verifier
description: Deterministically verify and repair FCF, trailing PE, PB, and market-cap calculations from scoped same-period financial evidence. Use for derived-value questions where arithmetic, sign conventions, period alignment, or CNYm-to-亿元 conversion must be exact.
version: 0.1.0
category: finance
---

# Financial Formula Verifier

Use only evidence admitted by the active dataset and document scope.

Apply a repair only when every operand is present for the requested period. Preserve the source references and show the formula and operands. Treat CAPEX as an absolute cash outflow for the formal FCF metric. Convert CNYm to 亿元 by dividing by 100.

If a required operand is missing or ambiguous, leave the answer unchanged and emit a no-action trace.
