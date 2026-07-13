---
name: private-fund-node
description: Create and save a structured, traceable private-fund research node from information selected by the user. Use when the user asks to turn checked answer fragments, evidence, a conclusion, hypothesis, risk, catalyst, comparison, question, or decision into a reusable node for later analysis.
---

# 📝 Private Fund Node

Save selected research as a compact unit that can be checked into later LLM context and traced back to evidence.

## Workflow

1. Identify the current `dataset_id`. Use the project bound to the session; do not silently switch projects.
2. Call `mcp__omnigent__private_fund_research_context` to inspect the checked nodes and current research lineage.
3. Treat the user's selected text as the primary scope. For every material factual claim, date, event, amount, ratio, valuation input, management statement, and chart/table/metric value, call `mcp__omnigent__private_fund_dataset_search`, then inspect the strongest hits with `mcp__omnigent__private_fund_source_detail`.
4. Write `content_markdown` with these headings as the durable text fallback:
   - `## 结论`
   - `## 支持信息与引用`
   - `## 不确定性或反证`
   - `## 下一步问题`
5. Decide whether the result benefits from richer presentation. When it does, include ordered `content_blocks`; when plain prose is clearest, omit them. Available blocks:
   - `markdown`: narrative, reasoning, citations, and lists.
   - `metrics`: two to eight comparable headline indicators.
   - `table`: exact cross-sectional or period comparisons.
   - `chart`: a legacy declarative line trend or bar comparison backed by verified numeric data.
   - `html`: a self-contained visual composition. For the unified Chart output, include inline CSS/JavaScript that renders verified data with native SVG or Canvas; never use external assets, network calls, forms, navigation, downloads, storage, or parent-page access.
6. Call `mcp__omnigent__private_fund_research_node_save` exactly once with a concise title and summary, the full Markdown fallback, ordered presentation blocks when useful, relevant `parent_node_ids`, all verified `evidence_ids`, tags, and a calibrated confidence value. Add `evidence_ids` to each rich block for the evidence that directly supports that block.
7. Return the saved node ID and title, plus any unresolved evidence gap. Do not present an unsaved draft as a completed node.

## 📝 Chart Contract（2026-07-14）

- When the user selects Chart output, use exactly one `html` block rather than drawing a chart in text or returning a legacy `chart` block.
- Infer the most appropriate visual from the evidence: line, bar, pie/donut, area, scatter, radar, waterfall, or heatmap. Do not ask the user to preselect a chart type when the data relationship is clear.
- The HTML must be self-contained and responsive. Put verified data in inline JavaScript, render with native SVG or Canvas, and include a title, concise interpretation, legend, units, methodology/source note, and readable text or table fallback.
- Inline JavaScript runs only in an opaque-origin iframe sandbox. Do not use libraries or CDNs, `fetch`, XHR, WebSocket, remote images, forms, navigation, downloads, storage, `parent`/`top`, polling timers, or unbounded loops.
- Never output ASCII art, text axes, a Markdown pseudo-chart, Mermaid xychart, or a fenced code block as the visual result.
- When the user explicitly requests a chart, place it in `content_blocks` in the `private_fund_research_node_save` call. After saving, report the node ID instead of repeating the chart in chat.

## Node Types

Use the narrowest type: `insight`, `hypothesis`, `question`, `risk`, `catalyst`, `comparison`, or `decision`. Prefer `hypothesis` when the causal claim is not yet verified and `question` when no defensible conclusion exists.

## Evidence Rules

- Keep facts, interpretation, and open questions visibly separate.
- Attach only evidence IDs actually inspected or returned by search.
- Put the clickable `markdown_citation` immediately after each supported material claim in `content_markdown`; a detached source list alone is not sufficient.
- Every numeric metric, table, chart, or visual HTML block must carry one or more directly supporting `evidence_ids`. If no resolvable evidence ID exists, do not present the value as verified and do not place it in a chart.
- A factual node with no verified evidence must be explicitly labeled `待复核/资料未覆盖`; use `question` or `hypothesis` instead of presenting it as a confirmed `insight`.
- Preserve contradictory evidence; never smooth it away to raise confidence.
- Use exact dates, periods, units, and entities when available.
- Never invent numbers to make a chart look complete. If a series has insufficient comparable observations, use Markdown or a table and state the gap.
- Keep block titles short and do not duplicate the same content in multiple visual formats.
