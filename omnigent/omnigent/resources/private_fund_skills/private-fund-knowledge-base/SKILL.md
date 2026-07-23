---
name: private-fund-knowledge-base
description: Maintain a readable, evidence-linked private-fund knowledge trail for versioned Memos and valuation models, including lineage, adjacent-version differences, quality gates, evidence cards, review state, and Obsidian projection. Use when the user asks to create, revise, refresh, compare, trace, organize, or explain multiple Memo/report/model versions, mentions Obsidian knowledge maintenance or provenance, or wants to know what changed and why.
---

# 📝 Private Fund Knowledge Base

Maintain research objects in the authoritative project database so the background Obsidian worker can project them safely. Never treat a Vault note as the version source of truth.

## 📝 Choose the durable object

- For a focused research deliverable, use `mcp__omnigent__private_fund_dataset_memo` and keep the topic stable across revisions.
- For an existing Memo update, pass the prior `memo_version_id` or artifact path through `revision_of`. A revision is a new artifact, never an in-place overwrite.
- For model updates, preserve the original Excel file as evidence. A newly ingested workbook becomes a new model version; Agent recommendations and derived workbooks remain separate objects.
- For comparisons, use exact version IDs. Compare adjacent versions by default unless the user names another baseline.

## 📝 Version semantics

1. Report the series ID, new version ID, version number, predecessor, and artifact paths after creation.
2. Classify Memo sections as `added`, `changed`, `unchanged`, or `not_mentioned`.
3. Never translate `not_mentioned` into invalidated, withdrawn, or false. Use those labels only when explicit evidence supports them.
4. For valuation changes, state old value, new value, absolute/relative delta when available, materiality, period/scenario, cell location, and evidence IDs.
5. Separate deterministic model differences from Agent interpretation. Label assumptions, inference, review requirements, rollback, and derived-model status explicitly.
6. Keep old versions discoverable. Never delete or silently replace history to make the current view cleaner.

## 📝 Obsidian projection contract

- The background `private_fund_obsidian_worker` owns Vault paths, series home notes, immutable version notes, adjacent diff notes, and Bases.
- Do not write directly into managed `AUTO` regions or invent Vault paths. The worker preserves `USER` regions and writes conflicts instead of silently overwriting analyst edits.
- A series home note is the current pointer. Version and diff notes are immutable snapshots. Bases provide cross-series views but do not define version truth.
- Original PDF/Excel files stay outside the Vault. Link to them through evidence cards; keep stable IDs in Properties or collapsed audit sections.
- Write for an investment professional first. Lead with the current conclusion, material change, evidence coverage, decision status, risks, and open questions. Do not lead with database IDs, filenames, parser metadata, formula counts, or sync fields.
- Never expose a bare `fact:`, `chunk:`, `cell:`, model ID, or Memo ID as the visible source. Resolve it to a human-readable evidence card with document version, page/Sheet/cell, surrounding labels, original value, formula where relevant, quality status, and a controlled local-file link.
- Apply quality gates before projection. Quarantine suspected period headers, company mismatches, invalid units, unresolved evidence, and parser-only candidates. Do not make low-quality candidates look authoritative by formatting them as normal facts.
- If a Memo section contains only workbook/sheet/region index summaries, label it as technical groundwork and collapse it. Never present index metadata as investment logic, a catalyst, a risk, or a tracked question.
- Keep company boundaries explicit. If selected sources do not match the project company, stop the research claim and report the mismatch for review.
- A section without resolvable evidence must say that it is not suitable for investment judgment. `needs-review` is not a substitute for a visible explanation of what is missing.
- If a user asks whether Obsidian is current, distinguish queued, running, completed, failed, and conflict states. Do not claim completion merely because a Memo/model job was submitted.
- Call `mcp__omnigent__private_fund_knowledge_status` before reporting projection completion, worker health, Vault availability, or conflict state.

## 📝 Response shape

Return a compact handoff:

```text
当前版本：<series_id> / <version_id> / vNNN
相比上一版：<material changes>
证据与复核：<human-readable source locations, coverage, quarantined items, and review state>
Obsidian：由后台投影；<completed, queued, failed, conflict, or unknown>
```
