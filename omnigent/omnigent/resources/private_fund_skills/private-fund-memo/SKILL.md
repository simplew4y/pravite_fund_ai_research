---
name: private-fund-memo
description: Generate or revise an evidence-backed private-fund research memo as Markdown, HTML, and PDF. Use when the user requests a focused memo about a company, topic, question, risk, catalyst, comparison, or selected research context rather than a comprehensive long-term report.
---

# Private Fund Memo

Create a focused research memo with verifiable citations and durable output files.

## Workflow

1. Identify the current `dataset_id` and clarify the memo topic from the request.
2. Call `mcp__omnigent__private_fund_dataset_status` when dataset readiness or coverage is unclear.
3. Search with `mcp__omnigent__private_fund_dataset_search` and inspect decisive results with `mcp__omnigent__private_fund_source_detail`.
4. If the user selected nodes, call `mcp__omnigent__private_fund_research_context` and use those nodes as prioritized context.
5. Separate evidence, interpretation, counterevidence, and open questions. Use exact dates, periods, and units.
6. Call `mcp__omnigent__private_fund_dataset_memo`. Supply `revision_of` when revising an earlier memo.
7. Return PDF, Markdown, and HTML paths plus a short summary of conclusions and evidence gaps.

Never fabricate citations or silently replace an earlier artifact.

## Provenance Rules

- Every material factual claim, date, event, amount, ratio, valuation input, and management statement must have a citation immediately after the claim.
- Use citations returned by `private_fund_dataset_search` only after inspecting decisive evidence with `private_fund_source_detail`.
- If a claim cannot be tied to a real file and page, sheet/cell, slide, or heading, label it `资料未覆盖/待复核` and keep it out of verified conclusions and charts.
- Preserve the evidence index in Markdown and HTML so users can identify the real document location; PDF keeps the same location as a plain source label.
