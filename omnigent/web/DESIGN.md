# Private Fund Research UI

Build a calm, evidence-first research workspace. Use Airtable-like information architecture for structured ledgers and workflow states, while preserving this project's warm paper and forest-green identity.

## Tokens

- Canvas: `var(--pf-canvas)` (`#f7f6f0` light).
- Primary panels: `var(--pf-panel-raised)`; subtle groups: `var(--pf-panel-subtle)`.
- Primary ink: `var(--pf-ink)`; secondary copy: `var(--pf-ink-secondary)`.
- Brand action: `var(--pf-accent)` (`#2f7d4d` light). Reserve it for primary actions, focus, and selected navigation.
- Risk: `--pf-risk-*`; catalyst: `--pf-catalyst-*`; review: `--pf-review-*`.
- Use existing dark-mode tokens. Never hard-code a light-only surface.

## Information architecture

- Prefer tables for collections above 12 records; use cards for summaries and empty states.
- Put search, filters, result count, and sort controls immediately above the data they affect.
- Open record details in a side drawer so the ledger context remains visible.
- Separate the durable ledger, alert inbox, review queue, and rule configuration into explicit views.
- Show evidence and quality status beside every decision-relevant claim.

## Components

- Use 6–12 px radii, hairline borders, and surface contrast instead of large shadows.
- Keep controls 32–36 px high and body copy 12–14 px in dense workspace views.
- Use compact semantic pills for type, state, impact, and quality.
- Provide loading, success, error, disabled reason, empty, and retry states for every asynchronous action.
- Preserve keyboard focus and a minimum 36 px pointer target for high-frequency controls.

## Guardrails

- Do not copy another product's palette, logo, proprietary font, or marketing-page scale.
- Do not use gradients, glass effects, or saturated color as decoration inside research views.
- Do not encode risk severity by color alone; always include a text label.
- Do not hide evidence, confidence, or review status behind hover-only interactions.
- Do not render a large research ledger as a two-column card grid.
