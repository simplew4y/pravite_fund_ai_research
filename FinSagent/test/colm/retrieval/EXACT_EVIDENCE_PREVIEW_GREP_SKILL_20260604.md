# Exact evidence preview / grep skill (2026-06-04)

## Positioning

The grep-style component is now present as an optional exact evidence preview skill. It is not the primary retriever and it does not decide final answers. Its role is to provide cheap, explainable, exact-match snippets around concrete terms in a question.

In the current system, the main retrieval path is still BM25 / vector / table / PageIndex hybrid retrieval. The grep skill sits beside it as a preview, rescue, and audit channel.

## Why it is useful

Semantic retrieval can find relevant passages even when the wording differs, but it may also retrieve temporally adjacent or semantically similar evidence with the wrong year, period, or metric. Grep has the opposite tradeoff: it is literal and shallow, but very good when the question contains exact entities, years, amounts, tickers, product names, filing terms, or metric labels.

The intended use is:

- Preview: show exact snippets before or beside generated answers.
- Rescue: provide candidate evidence when semantic retrieval misses an exact phrase.
- Audit: check whether key answer terms, numbers, years, or product names appear in source text.

## Implementation

Code:

`src/utils/exact_evidence_preview.py`

Runner integration:

`test/colm/retrieval/run_rescue_e2e_sample.py`

New optional flags:

- `--exact_evidence_preview_enabled`
- `--exact_evidence_preview_roots`
- `--exact_evidence_preview_max_hits`
- `--exact_evidence_preview_max_terms`
- `--exact_evidence_preview_max_file_bytes`
- `--exact_evidence_preview_context_chars`

Default behavior is off, so existing benchmark results are not changed.

## Smoke result

Smoke output:

`test/colm/retrieval/exact_evidence_preview_smoke_20260604/lotus_q1_preview.json`

Question:

What was Lotus Technology revenue for the nine months ended September 30, 2024, and how did it compare with the same period in 2023?

The output row includes `exact_evidence_preview`, with extracted terms such as Lotus, Technology, revenue, nine months, September 30, 2024, and 2023. The preview hits include Lotus source JSON files and snippets containing the relevant first-nine-months 2024 revenue evidence.

## Reporting wording

Grep has been added as an optional exact evidence preview skill. It is deliberately not used as the main answer path. It gives the system a low-cost, interpretable way to show and audit exact source matches for concrete terms such as years, amounts, tickers, product names, and filing concepts. This makes the system more industrial: semantic retrieval finds broad relevance, PageIndex uses document structure, and grep provides literal source confirmation.

## Boundary

Grep should not replace PageIndex Hybrid retrieval. It does not understand synonyms, table structure, cross-page context, or financial reasoning. It is best used as a support skill for evidence preview, rescue, and audit.
