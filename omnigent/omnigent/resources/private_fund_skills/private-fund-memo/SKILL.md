---
name: private-fund-memo
description: Generate or revise an evidence-backed private-fund research memo as Markdown, HTML, and PDF. Use when the user requests a focused memo about a company, topic, question, risk, catalyst, comparison, or selected research context rather than a comprehensive long-term report.
---

# 📝 Private Fund Memo

Create a focused research memo with verifiable citations and durable output files.

## Workflow

1. Identify the current `dataset_id` and clarify the memo topic from the request.
2. Call `mcp__omnigent__private_fund_dataset_status` when dataset readiness or coverage is unclear.
3. Search with `mcp__omnigent__private_fund_dataset_search` and inspect decisive results with `mcp__omnigent__private_fund_source_detail`.
4. If the user selected nodes, call `mcp__omnigent__private_fund_research_context` and use those nodes as prioritized context.
5. Separate evidence, interpretation, counterevidence, and open questions. Use exact dates, periods, and units.
6. 📝 Call `mcp__omnigent__private_fund_dataset_memo`. For a finished Memo, prefer `memo_claims` with one claim per item (`section`, `text`, `status`, `evidence_ids`); never put citation markup inside `text`. Supply `revision_of` when revising an earlier Memo.
7. When revising or comparing an earlier Memo, use `mcp__omnigent__private_fund_history_compare` after the new version is registered. Report added, changed, unchanged, and `not_mentioned` sections separately; never translate `not_mentioned` into removed or invalidated without explicit evidence.
8. Return the Memo version ID plus PDF, Markdown, and HTML paths, followed by a short summary of conclusions, changes, and evidence gaps.

Never fabricate citations or silently replace an earlier artifact.

## 📝 Tool Completion Contract

- 📝 Call `mcp__omnigent__private_fund_dataset_status` only for an explicit status/readiness request or when dataset readiness is genuinely unknown. Do not prepend it automatically to a search.
- 📝 For a search-results request, call `mcp__omnigent__private_fund_dataset_search` once and answer from the returned evidence. Open source detail only when the user requests verification/traceability or the evidence is too thin, numerical, conflicting, or source-sensitive.
- 📝 For verification, search first and inspect only the decisive evidence IDs. Do not repeat status or search without a concrete evidence gap.
- 📝 Once the necessary result is available, the next assistant action must be the final answer. Never consume the last available step with an optional read-only tool.
- 📝 Before every additional tool call, name the unresolved user requirement it will satisfy. If none remains, stop and answer.

## 📝 Version and Obsidian Contract

- Keep the logical topic stable when revising a Memo so all revisions remain in one series. Use `revision_of` for explicit lineage and never overwrite an older Markdown, HTML, or PDF artifact.
- Treat the returned `memo_series_id`, `memo_version_id`, `memo_version_no`, and `revision_of_version_id` as authoritative. Do not infer identity from filenames or Obsidian paths.
- The background Obsidian worker creates the mutable series home, immutable version snapshot, adjacent difference note, and Base rows. Do not edit managed Vault `AUTO` regions directly.
- Describe a missing section as `not_mentioned`, not invalidated or withdrawn, unless evidence explicitly establishes the stronger state.
- Report Obsidian projection as pending or unknown unless worker state confirms completion; creation of the Memo alone is not proof that the Vault was updated.
- When projection state matters, call `mcp__omnigent__private_fund_knowledge_status` before answering.

## Provenance Rules

- Every material factual claim, date, event, amount, ratio, valuation input, and management statement must have a citation immediately after the claim.
- Use citations returned by `private_fund_dataset_search` only after inspecting decisive evidence with `private_fund_source_detail`.
- If a claim cannot be tied to a real file and page, sheet/cell, slide, or heading, label it `资料未覆盖/待复核` and keep it out of verified conclusions and charts.
- Preserve the evidence index in Markdown and HTML so users can identify the real document location; PDF keeps the same location as a plain source label.

## 📝 Citation Gate Contract

- 📝 The model selects only exact `chunk:` / `fact:` / `cell:` / `page:` IDs. The service validates those IDs and owns the human-readable citation rendering.
- 📝 Read the returned `citation_gate`. `passed` means the first submission was valid; `repaired` means one targeted citation-only retry succeeded; `needs_review` means unresolved claims were persisted only with `待复核`.
- 📝 Never report a Memo as fully verified while `citation_gate.needs_review` is true. Surface the affected claim and evidence gap.
