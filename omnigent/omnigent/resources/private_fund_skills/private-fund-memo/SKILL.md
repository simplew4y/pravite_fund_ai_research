---
name: private-fund-memo
description: Generate or revise an evidence-backed private-fund research memo as Markdown, HTML, and PDF. Invoke this skill for every Memo creation or revision request, even if it was loaded earlier in the conversation, so version-lineage rules are always current. Use for a focused memo about a company, topic, question, risk, catalyst, comparison, or selected research context rather than a comprehensive long-term report.
---

# 📝 Private Fund Memo

Create a focused research memo with verifiable citations and durable output files.

## Revision Intent And Target Resolution

You, the agent, decide semantically whether the user is asking to revise an existing Memo.
Do not rely on the UI to classify revision intent, and do not treat every selected Memo as a
revision target when the user is only using it as research context.

Selected Memo assets appear inside `用户选择的问题上下文` in this exact form:

```text
- [memo:<memo_version_id>] <canonical topic>（memo）
```

When the user's meaning is to revise, update, extend, correct, or create a new version of an
existing Memo:

1. Set `operation` to `revise`. This is your semantic decision; the UI does not decide it.
2. Scan the selected context for `memo:<memo_version_id>` markers before planning any tool call.
3. If exactly one selected Memo is the semantic target, copy its `mv_...` identifier verbatim
   into `private_fund_dataset_memo.revision_of`. The selected asset title is the canonical topic;
   keep it unchanged.
4. Never replace an available `mv_...` identifier with a Markdown/PDF/HTML path remembered from
   an earlier tool result. Version identity comes from the selected marker, not from filenames.
5. If several selected Memos could be the target and the user's wording does not identify one
   unambiguously, ask which Memo to revise before generating anything.
6. If no selected Memo identifies the target, use an explicit Memo version ID supplied by the
   user. Otherwise ask for the target instead of guessing or silently creating a new series.
7. Pass the canonical topic without suffixes such as "revised", "updated", a version number, or
   a date. Put requested changes in `instructions`, not in `topic`.
8. After generation, verify that `revision_of_version_id` equals the selected `mv_...` identifier
   and that `memo_version_no` advanced. If either check fails, report the versioning failure and
   do not claim that the revision succeeded.

When the user's meaning is to create a separate Memo, set `operation` to `create` and omit
`revision_of` even if an earlier Memo was selected merely as supporting context.

## Workflow

1. Identify the current `dataset_id` and clarify the memo topic from the request.
2. Call `mcp__omnigent__private_fund_dataset_status` when dataset readiness or coverage is unclear.
3. Search with `mcp__omnigent__private_fund_dataset_search` and inspect decisive results with `mcp__omnigent__private_fund_source_detail`.
4. If the user selected nodes, call `mcp__omnigent__private_fund_research_context` and use those nodes as prioritized context.
5. Separate evidence, interpretation, counterevidence, and open questions. Use exact dates, periods, and units.
6. 📝 Call `mcp__omnigent__private_fund_dataset_memo`. Always provide the semantically chosen `operation`. For a finished Memo, prefer `memo_claims` with one claim per item (`section`, `text`, `status`, `evidence_ids`); never put citation markup inside `text`. Supply `revision_of` when revising an earlier Memo.
7. When revising or comparing an earlier Memo, use `mcp__omnigent__private_fund_history_compare` after the new version is registered. Report added, changed, unchanged, and `not_mentioned` sections separately; never translate `not_mentioned` into removed or invalidated without explicit evidence.
8. Return the Memo version ID plus PDF, Markdown, and HTML paths, followed by a short summary of conclusions, changes, and evidence gaps.

Never fabricate citations or silently replace an earlier artifact.

Treat `instructions`, `conversation_context`, `key_questions`, and `revision_of` as internal
generation or provenance inputs. Use them to plan retrieval, analysis, and version lineage, but
never reproduce them as standalone artifact sections such as `用户要求`, `对话上下文摘要`,
`关键问题`, `修订来源`, or equivalent operational metadata. Integrate analytically relevant
content into the appropriate research sections. These inputs may be summarized in the chat
response, while the Markdown, HTML, and PDF artifacts contain only client-facing research,
evidence citations, and research limitations. Never expose an internal database or filesystem
path in a Memo artifact.

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
