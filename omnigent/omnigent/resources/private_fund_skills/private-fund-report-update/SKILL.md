---
name: private-fund-report-update
description: Create a new traceable revision of an existing private-fund research report using newly checked nodes and evidence. Use when the user asks to update, revise, roll forward, refresh, or compare a prior report while preserving history instead of overwriting the old version.
---

# Private Fund Report Update

Produce an append-only report revision with explicit lineage and a concise change log.

## Workflow

1. Identify the current `dataset_id` and the prior report path or identifier.
2. Read the prior Markdown report with `mcp__omnigent__sys_os_read`. If only PDF or HTML exists, locate the corresponding Markdown output before revising when possible.
3. Call `mcp__omnigent__private_fund_research_context` to load the currently checked nodes.
4. Compare the new context with the prior baseline. Classify important claims as `新增`, `变化`, `失效`, or `未变化`.
5. Verify every changed or invalidated material claim with `mcp__omnigent__private_fund_dataset_search` and `mcp__omnigent__private_fund_source_detail`.
6. Build a full replacement `memo_markdown`, preserving stable section names and adding version lineage plus a dated change log.
7. Call `mcp__omnigent__private_fund_dataset_memo` with the prior report in `revision_of` and the complete new Markdown in `memo_markdown`.
8. Return the new PDF, Markdown, and HTML paths with a concise list of changed conclusions. Never overwrite or delete the earlier report.

## Revision Rules

- Retain an old claim only when it remains supported; otherwise mark it stale or invalidated.
- Explain why confidence changed and identify the node or evidence responsible.
- Preserve unresolved contradictions and previously documented limitations.
- Include prior version, current version, update date, newly included node IDs, and superseded claims.
- Every新增、变化或失效的重大事实和数值必须带相邻引用，并在证据索引中保留真实文件位置。
- A prior citation cannot be reused blindly: inspect the current evidence with `private_fund_source_detail`, especially after a document version changes.
- If updated evidence cannot be resolved to a file and page, sheet/cell, slide, or heading, mark the claim `待复核` instead of carrying it forward as verified.
- A revision is a new artifact, not an in-place edit.
