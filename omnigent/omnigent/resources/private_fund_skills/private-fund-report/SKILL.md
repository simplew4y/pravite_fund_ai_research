---
name: private-fund-report
description: Build a source-backed, long-form private-fund research report from user-checked research nodes. Use when the user asks to compile selected nodes into a durable investment report, due-diligence report, investment-committee report, research baseline, or other Markdown, HTML, and PDF deliverable.
---

# 📝 Private Fund Report

Turn checked nodes into a versioned research baseline. The report is a synthesis of selected nodes, not an automatic dump of the entire dataset.

## Workflow

1. Identify the current `dataset_id` and call `mcp__omnigent__private_fund_research_context`.
2. Use checked nodes as the default report scope. If no node is checked, ask the user to select nodes unless they explicitly requested a whole-dataset report.
3. Verify material claims with `mcp__omnigent__private_fund_dataset_search` and inspect decisive evidence with `mcp__omnigent__private_fund_source_detail`.
4. Synthesize the FinRobot section payload: `tagline`, `company_overview`, `investment_overview`, `valuation_overview`, `risks`, `competitor_analysis`, `major_takeaways`, and `news_summary`. Distinguish facts, inference, assumptions, and unresolved questions.
5. Build `financial_metrics` as period-keyed values and `market_snapshot` only from verified evidence. Attach every used `chunk:`, `fact:`, or `cell:` ID through `section_evidence`.
6. Call `mcp__omnigent__private_fund_equity_report_generate`. Use `mcp__omnigent__private_fund_equity_report_status` for durable run state and `mcp__omnigent__private_fund_equity_report_get` when the full provenance package is needed.
7. Return the generated PDF as the primary deliverable and Markdown/HTML/JSON as supporting files. Also summarize the report version and the largest evidence gaps.

## 📝 FinRobot Alignment Contract

- The professional HTML layout and financial charts are rendered by the repository's FinRobot modules.
- Omnigent remains authoritative for local dataset retrieval, evidence IDs, document versions, report versions, and asset paths.
- Do not call FinRobot's web-research subprocess orchestration; all factual inputs must come through the Omnigent evidence tools.
- An unavailable value must remain `N/A` or `资料未覆盖/待复核`; never fill a template slot by guessing.

## Required Report Structure

1. Metadata: subject, dataset, creation date, scope, version, and selected node IDs
2. Executive summary
3. Core thesis and current judgment
4. Node-by-node synthesis and relationships
5. Operating and financial evidence
6. Valuation or scenarios when supported
7. Catalysts, risks, and counterevidence
8. Unresolved questions and next research actions
9. Evidence index
10. Baseline for the next update

## Quality Rules

- Every material conclusion must be traceable to a node or evidence item.
- Every material factual claim and numeric value must carry an adjacent citation to a verified evidence item; a node ID without its underlying source is insufficient for decisive claims.
- Inspect decisive evidence with `private_fund_source_detail` and preserve real file locations (page, sheet/cell, slide, or heading) in the evidence index.
- Claims without a resolvable source must be marked `资料未覆盖/待复核` and excluded from verified charts, valuation inputs, and firm conclusions.
- Do not invent figures, citations, or certainty.
- Surface conflicts between nodes and explain whether they are unresolved or reconciled.
- Use exact periods and units. Mark stale data explicitly.
- Preserve a stable section structure so later revisions can be compared.
