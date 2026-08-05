---
name: table-evidence-verifier
description: Verify and canonicalize numeric answers against retrieved financial tables.
version: 0.1.0
category: verification
---

# Deterministic Table Evidence Verifier

## When to Use

Use for answers containing financial values derived from tables.

## Procedure

Check metric label, period column, accounting sign, unit, currency, and source before accepting a value.

## Pitfalls

- Never repair from a table outside the active document scope.
- Do not mix actual and estimated periods.

## Verification

Every changed number must remain traceable to retrieved table evidence.
