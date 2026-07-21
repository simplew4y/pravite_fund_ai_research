---
name: private-fund-memo
description: Run evidence-backed private fund research, QA, source tracing, and memo drafting from the latest structured SQLite dataset pipeline.
allowed-tools: mcp__omnigent__private_fund_dataset_status, mcp__omnigent__private_fund_knowledge_status, mcp__omnigent__private_fund_dataset_search, mcp__omnigent__private_fund_source_detail, mcp__omnigent__private_fund_dataset_memo, mcp__omnigent__sys_os_shell
when_to_use: Use when the user asks for private fund research, local dataset QA, investment memo generation, source-backed answers, citations, traceability, due diligence, Excel model evidence, PDF page evidence, 阳光电源 research, or research questions against the active local dataset. Trigger phrases include "私募研究", "投研", "数据库", "pipeline", "生成memo", "投资memo", "可溯源", "证据", "Excel模型", "PDF材料", and "本地资料".
argument-hint: "[research-question-or-memo-request]"
arguments:
  - request
---

# Private Fund Memo

Use this workflow to answer questions and draft memos from the latest structured private-fund dataset database.

The old direct PDF QA / memo workflow is deprecated. Do not run `scripts/run_pdf_research_demo.py`, do not register a standalone PDF, and do not call the old private-fund PDF API. The source of truth is the dataset written by `FinSagent/data_pipeline/private_fund_directory_ingest.py`.

## Data Contract

The active dataset is stored under:

```text
/Users/Admin/project/private_fund_ai_research/output/private_fund_datasets
```

The dataset registry is:

```text
/Users/Admin/project/private_fund_ai_research/output/private_fund_datasets/datasets.sqlite3
```

Each dataset has a collection DB:

```text
<dataset_id>/meta/collection.sqlite3
```

Evidence is unified across PDFs and Excel:

- PDF evidence uses `documents`, `chunks`, `chunk_locations`, and `pdf_pages`.
- Excel evidence uses `excel_sheets`, `excel_regions`, `excel_cells`, `metric_facts`, and summary chunks.
- Returned evidence ids look like `chunk:<id>`, `fact:<id>`, or `cell:<id>`.
- User-facing citations must use the returned `markdown_citation` field when it is present; fall back to `citation` only if no markdown link is returned.

## Required Tools

Use the MCP tools first:

- `mcp__omnigent__private_fund_dataset_status`: check active dataset, documents, counts, and index readiness.
- `mcp__omnigent__private_fund_knowledge_status`: confirm Obsidian projection, worker, and conflict state.
- `mcp__omnigent__private_fund_dataset_search`: retrieve source-backed evidence for a question.
- `mcp__omnigent__private_fund_source_detail`: open a returned evidence id for page text, Excel cells, formulas, and local raw paths.
- `mcp__omnigent__private_fund_dataset_memo`: create a memo draft backed by retrieved evidence.

Only use `mcp__omnigent__sys_os_shell` for diagnostics, such as checking that SQLite files exist. Do not use it to run the deprecated direct PDF workflow.

## QA Steps

1. Call `mcp__omnigent__private_fund_dataset_search` with the user's question.
2. If the top evidence is too thin, numerical, or source-sensitive, call `mcp__omnigent__private_fund_source_detail` on the most relevant evidence ids.
3. Answer in Chinese by default.
4. Cite every material claim using the returned `markdown_citation` so the UI can open the exact evidence source; use plain `citation` only as a fallback.
5. In chat, citations must be clickable Markdown links. Do not output bare source text such as `[阳光电源-20260615.pdf p.1]` when `markdown_citation` is available.
6. If evidence is insufficient, state what is missing and mark the conclusion as `需复核`.

## 📝 Tool Completion Contract

- 📝 Use `mcp__omnigent__private_fund_dataset_status` only for an explicit status/readiness request or when the target dataset is genuinely unknown or not known to be ready. Do not call it automatically before each search.
- 📝 For a search-results request, call `mcp__omnigent__private_fund_dataset_search` once and answer immediately from the returned items. Do not add source-detail calls unless the request or evidence quality requires verification.
- 📝 For verification or traceability, call search first, then open only the decisive evidence IDs with `mcp__omnigent__private_fund_source_detail`.
- 📝 After the required tool results arrive, the next assistant action must be the final answer. An optional extra lookup is not a reason to delay or omit that answer.
- 📝 Before another tool call, identify the exact unresolved user requirement it satisfies. If none remains, stop calling tools.

## Memo Steps

1. Call `mcp__omnigent__private_fund_dataset_memo` with the topic or memo request.
2. When the user asks for revisions or refers to the current conversation, pass a concise `conversation_context`, concrete `instructions`, and `key_questions` into the tool. Use `revision_of` if the user points to a prior generated memo path.
3. 📝 For a polished or revised Memo, use the first tool result as evidence, draft one structured item per claim, then call `mcp__omnigent__private_fund_dataset_memo` again with `memo_claims` plus the same context/instructions. Each item must contain `section`, citation-free `text`, `status`, and exact `evidence_ids`. Use legacy `memo_markdown` only when structured claims cannot represent the requested layout.
4. Use the returned PDF link/path as the primary deliverable. The tool also returns HTML and Markdown paths for inspection or further editing.
5. The generated PDF/HTML memo uses plain source labels such as file name + page or workbook + sheet/range; do not expect PDF citations to be clickable. This exception applies only inside generated files; chat summaries still need clickable `markdown_citation` links.
6. Preserve source citations in the chat summary, and keep unsupported claims as assumptions or diligence questions.

## 📝 Citation Gate Output Contract

- 📝 The service—not the model—renders citations from exact evidence IDs and blocks unknown or missing IDs before Memo persistence.
- 📝 Inspect `citation_gate.status`, `citation_gate.needs_review`, and `citation_gate.violations` after the final Memo call. A single targeted citation-only retry may change the status to `repaired`.
- 📝 If the status remains `needs_review`, identify the affected claims for the user and do not describe the artifact as fully verified. `资料未覆盖` is a valid boundary, not a fact claim.

## Output Shape

For QA:

```text
结论：...

依据：
- ... [markdown_citation]
- ... [markdown_citation]

需复核：...
```

For memo:

```text
已基于结构化数据集生成 memo：
PDF：<memo_pdf_url>
本机路径：<memo_pdf_path>

核心摘要：
- ... [markdown_citation]
- ... [markdown_citation]
```

## 📝 Version and Obsidian Rules

- A revision must pass the prior Memo ID or artifact path through `revision_of`; never overwrite an older Markdown, HTML, or PDF file.
- Keep the logical topic stable across revisions and return the authoritative series ID, version ID, version number, and predecessor ID.
- Classify an omitted section as `not_mentioned`. Do not call it invalidated or withdrawn without explicit evidence.
- The background Obsidian worker owns series home notes, immutable version/diff notes, Bases, and managed-region conflict handling. Do not edit generated Vault `AUTO` regions directly.
- Memo completion does not prove that Obsidian projection completed. Report the projection as pending or unknown unless worker state confirms it.
