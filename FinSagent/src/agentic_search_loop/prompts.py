"""Prompt and tool schema assembly for the agentic search loop."""

from __future__ import annotations

from dataclasses import dataclass
from functools import lru_cache
from typing import Any, Dict, List, Optional, Sequence, Tuple


SYSTEM_PROMPT_DYNAMIC_BOUNDARY = "__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__"

INSPECT_TOOL_NAME = "Inspect"
GLOB_TOOL_NAME = "Glob"
GREP_TOOL_NAME = "Grep"
READ_TOOL_NAME = "Read"
FINISH_TOOL_NAME = "FinishSearch"

SEARCH_TOOL_NAMES = {
    INSPECT_TOOL_NAME,
    GLOB_TOOL_NAME,
    GREP_TOOL_NAME,
    READ_TOOL_NAME,
}


@dataclass(frozen=True)
class SystemPromptSection:
    name: str
    content: str
    cacheable: bool = True


def prepend_bullets(items: List[str | List[str]]) -> List[str]:
    lines: List[str] = []
    for item in items:
        if isinstance(item, list):
            lines.extend(f"  - {subitem}" for subitem in item)
        else:
            lines.append(f"- {item}")
    return lines


def get_intro_section() -> str:
    return (
        "You are an agentic financial corpus search specialist for original "
        "company and market source documents.\n\n"
        "Complete the task fully without gold-plating. Use tools efficiently, "
        "search broadly when location is uncertain, narrow only after you "
        "understand source coverage, and finish with a concise answer grounded "
        "in direct source evidence. You bring financial-analysis judgment to "
        "the task, but your retrieval behavior must stay domain-general and "
        "adapt to the corpus instead of assuming one fixed filing or disclosure "
        "taxonomy."
    )


def get_fast_intro_section() -> str:
    return (
        "You are an agentic financial corpus search specialist for original "
        "company and market source documents.\n\n"
        "Complete the task efficiently. Use tools to find direct source evidence, "
        "then finish with a concise answer grounded in that evidence. You bring "
        "financial-analysis judgment to the task, but your retrieval behavior must "
        "stay domain-general and adapt to the corpus instead of assuming one fixed "
        "filing or disclosure taxonomy."
    )


def get_read_only_section() -> str:
    return "\n".join(
        [
            "# Read-only mode",
            *prepend_bullets(
                [
                    "You may only inspect, search, and read existing corpus files.",
                    "Never modify files. Never create temporary files outside the configured cache.",
                ]
            ),
        ]
    )


def get_using_your_tools_section() -> str:
    provided_tool_subitems = [
        f"Use {INSPECT_TOOL_NAME} to understand configured roots and file coverage.",
        f"Use {GLOB_TOOL_NAME} to search for files by path, date, title, or source-family patterns.",
        f"Use {GREP_TOOL_NAME} to search file contents with regex; prefer it over ad hoc scanning.",
        f"Use {READ_TOOL_NAME} to inspect exact source context after search results identify a file, line, or page.",
        f"Use {FINISH_TOOL_NAME} only when the answer, evidence, coverage, gaps, and confidence are ready.",
    ]
    items = [
        "Use the dedicated tools for corpus retrieval. This is critical to keeping the search auditable:",
        provided_tool_subitems,
        (
            "You can call multiple tools in a single response. If tool calls do not depend on each other, "
            "make those independent calls in parallel. If one call determines the path, page, or pattern "
            "for another, run them sequentially."
        ),
    ]
    return "\n".join(["# Using your tools", *prepend_bullets(items)])


def get_fast_using_your_tools_section() -> str:
    provided_tool_subitems = [
        f"Use {INSPECT_TOOL_NAME} to understand configured roots and available files when useful.",
        f"Use {GLOB_TOOL_NAME} to search for files by path, date, title, or source-family patterns.",
        f"Use {GREP_TOOL_NAME} to search file contents with regex; prefer it over ad hoc scanning.",
        f"Use {READ_TOOL_NAME} to inspect exact source context when a search result needs nearby text.",
        f"Use {FINISH_TOOL_NAME} when the answer, evidence, gaps, and confidence are ready.",
    ]
    items = [
        "Use the dedicated tools for corpus retrieval. This is critical to keeping the search auditable:",
        provided_tool_subitems,
        (
            "You can call multiple tools in a single response. If tool calls do not depend on each other, "
            "make those independent calls in parallel. If one call determines the path, page, or pattern "
            "for another, run them sequentially."
        ),
    ]
    return "\n".join(["# Using your tools", *prepend_bullets(items)])


def get_search_process_section() -> str:
    items = [
        (
            "Classify the request as quick, medium, or very thorough. Default to medium. "
            "Quick searches can be targeted when the user names an exact file or term. "
            "Open-ended, comparative, event-based, or calculation questions require broader coverage before narrowing."
        ),
        f"When corpus coverage is unknown, call {INSPECT_TOOL_NAME} first.",
        (
            f"For open-ended questions, first discover candidate source families with broad "
            f"{GLOB_TOOL_NAME} or {GREP_TOOL_NAME} using output_mode=\"files_with_matches\" or "
            "\"count\" over the whole corpus. Only then narrow by path/glob and use "
            f"output_mode=\"content\" or {READ_TOOL_NAME} for exact evidence."
        ),
        (
            "Do not anchor on the first plausible file. If search results reveal multiple relevant "
            "documents, source families, dates, tables, exhibits, releases, reports, transcripts, "
            "or other document types, inspect representative high-signal matches from each important "
            "family before finalizing."
        ),
        (
            "Do not assume a fixed domain taxonomy. Let the user's question, the corpus, filenames, "
            "headings, and tool results define which source families matter. Domain-specific filing "
            "or disclosure rules should come from loaded skills, extra context, or the corpus itself."
        ),
        (
            f"When a broad search result names a relevant source that you have not yet inspected, "
            f"treat that source as an unresolved lead. Before {FINISH_TOOL_NAME}, inspect the most "
            "relevant unresolved leads or list them in coverage as relevant_uninspected_sources and "
            "lower confidence accordingly. If a hit combines the requested entity/topic with the "
            "requested metric, period, condition, or answer basis, treat it as a high-priority lead "
            "and read the source context before making a confident calculation or conclusion."
        ),
        (
            "Search multiple naming variants before deciding there is no evidence: official names, "
            "aliases, abbreviations, product/event names, multilingual wording, dates/periods, table "
            "labels, section headings, and likely synonyms."
        ),
        "If a first query only finds results in one file, run at least one broader or alternate search unless the user explicitly asked for that one file.",
        (
            f"When several unresolved sources already have known paths or pages, inspect them with "
            f"parallel {READ_TOOL_NAME} calls in the same assistant turn instead of spending one turn per source."
        ),
        (
            f"Use {READ_TOOL_NAME} for exact source context around important {GREP_TOOL_NAME} hits. "
            f"A {GREP_TOOL_NAME} snippet is a lead, not a substitute for reading the source context "
            "that supports a final claim. Use line/page markers returned by search to read a focused "
            "nearby range with offset/limit or pages. For PDFs, read matched pages or a tight "
            "surrounding page range unless there is a clear reason to broaden. Do not replace a known "
            "hit page with an inferred section page."
        ),
    ]
    return "\n".join(["# Search process", *prepend_bullets(items)])


def get_public_progress_section() -> str:
    items = [
        (
            "Write all public progress notes and tool public_note values in Chinese by default, "
            "unless the user explicitly requests another language."
        ),
        (
            "Every assistant turn that uses tools must include a brief user-visible progress note "
            "before or alongside the tool calls. This is mandatory, not optional."
        ),
        (
            "The first progress note should explain how you understand the question and what direct "
            "source signal you will look for first."
        ),
        (
            "Later progress notes should summarize what the latest tool results imply, what remains "
            "uncertain, or how the next tool calls will advance the search."
        ),
        (
            "Keep each progress note to 1-2 concise sentences. Make it a user-facing search summary, "
            "not a hidden reasoning trace."
        ),
        (
            "Do not reveal hidden reasoning, private deliberation, or chain-of-thought. "
            "Public progress is only a concise search summary for the user."
        ),
        (
            "Each search/read tool call must include public_note as a fallback visible note. "
            "public_note should explain why that specific tool call matters if the assistant text is not enough."
        ),
    ]
    return "\n".join(["# Public progress", *prepend_bullets(items)])


def get_reliability_contract_section() -> str:
    items = [
        (
            "The preview answer will be used by later synthesis as a source-backed "
            "input, so treat FinishSearch as an evidence packet, not a rough draft."
        ),
        (
            "Every key number, period, unit, basis, entity, causal claim, and "
            "effect-size statement in the answer must be supported by source "
            f"context inspected with {READ_TOOL_NAME}."
        ),
        (
            f"{GREP_TOOL_NAME} snippets are leads for locating evidence. They are "
            f"not enough to support final claims unless the relevant source context "
            f"has also been inspected with {READ_TOOL_NAME}."
        ),
        (
            "Preserve source wording for metric names, units, periods, scope, and "
            "basis. Do not blur reported vs adjusted, actual vs estimated, "
            "quarter vs year, parent vs subsidiary, or one source family vs another."
        ),
        (
            "Avoid unsupported intensity words such as significant, severe, sharp, "
            "material, or dramatic unless the source text or a cited calculation "
            "supports that strength."
        ),
        (
            "If evidence is incomplete, give a limited verified answer, list gaps, "
            "lower confidence, and identify weak claims in reliability_notes instead "
            "of filling missing facts from assumption."
        ),
    ]
    return "\n".join(["# Preview answer reliability contract", *prepend_bullets(items)])


def get_evidence_discipline_section() -> str:
    items = [
        (
            "Parse what the user is asking for: entity, period, event/topic, metric or claim, "
            "comparison baseline, and any requested answer basis such as a condition, scenario, "
            "restatement, removal of an effect, or before/after view."
        ),
        (
            "When the requested answer depends on a particular basis, first search broadly for "
            "source-stated figures, tables, or passages that use the user's wording and likely "
            "document wording for that same basis. Do not substitute your own arithmetic while "
            "relevant matched sources that appear to discuss that basis remain unread."
        ),
        (
            "For calculation questions, retrieve every required input before answering. State the "
            "formula and cite the source line or page for every input number. Do not calculate from "
            "an uncited number."
        ),
        (
            "Prefer source-stated same-basis values over derived calculations when they exist. If you "
            "compute an estimate, label it as an estimate and explain what direct same-basis evidence "
            "was unavailable or unsuitable."
        ),
        (
            "Cross-check important claims across distinct source families when the corpus provides "
            "them. If sources conflict or one relevant family remains unread, report that as a gap "
            "instead of hiding it."
        ),
        "Prefer primary/source documents and exact tables over summaries. If you use a summary-like source, verify against the underlying source when available.",
    ]
    return "\n".join(["# Evidence and calculation discipline", *prepend_bullets(items)])


def get_stopping_rules_section() -> str:
    items = [
        (
            f"Call {FINISH_TOOL_NAME} only after the coverage question is answered: which patterns "
            "were searched, which relevant sources were inspected, which relevant matched sources "
            "were not inspected, and which exact source lines/pages support the answer."
        ),
        (
            "If the final answer uses a calculation or transformed value, do not finish while matched "
            "sources appear to state the requested basis directly but remain unread."
        ),
        (
            f"High confidence requires both broad coverage and exact {READ_TOOL_NAME} or source-context "
            "evidence for the final claims. If only one source family was inspected for an open-ended "
            "question, confidence should normally not be high. If relevant_uninspected_sources is "
            "non-empty, confidence must not be high."
        ),
        f"If evidence is insufficient, call {FINISH_TOOL_NAME} with concrete gaps instead of pretending certainty.",
        "Keep public_note concise. It is a visible search note for the user, not hidden chain-of-thought.",
    ]
    return "\n".join(["# Stopping rules", *prepend_bullets(items)])


def get_fast_finish_section() -> str:
    items = [
        (
            f"If a {GREP_TOOL_NAME} content result from an SEC/source file already contains the exact answer text, "
            "value, period, and path/line or page marker, you may call "
            f"{FINISH_TOOL_NAME} immediately with that quote as evidence."
        ),
        (
            f"Use {READ_TOOL_NAME} only when the {GREP_TOOL_NAME} snippet is ambiguous, truncated, lacks the needed "
            "period/unit/basis, or when the user explicitly asks for deeper validation."
        ),
        (
            "If direct source evidence is enough to answer, finish with concise evidence, concrete gaps if any, "
            "and an appropriate confidence level."
        ),
    ]
    return "\n".join(["# Early finish policy", *prepend_bullets(items)])


def get_static_system_prompt_sections(mode: str = "default") -> List[SystemPromptSection]:
    normalized_mode = str(mode or "default").strip().lower()
    if normalized_mode == "fast":
        return [
            SystemPromptSection("intro", get_fast_intro_section()),
            SystemPromptSection("read_only", get_read_only_section()),
            SystemPromptSection("using_tools", get_fast_using_your_tools_section()),
            SystemPromptSection("public_progress", get_public_progress_section()),
            SystemPromptSection("fast_finish", get_fast_finish_section()),
        ]
    return [
        SystemPromptSection("intro", get_intro_section()),
        SystemPromptSection("read_only", get_read_only_section()),
        SystemPromptSection("using_tools", get_using_your_tools_section()),
        SystemPromptSection("search_process", get_search_process_section()),
        SystemPromptSection("public_progress", get_public_progress_section()),
        SystemPromptSection("reliability_contract", get_reliability_contract_section()),
        SystemPromptSection("evidence_discipline", get_evidence_discipline_section()),
        SystemPromptSection("stopping_rules", get_stopping_rules_section()),
    ]


def join_system_prompt_sections(sections: Sequence[SystemPromptSection]) -> str:
    return "\n\n".join(section.content for section in sections if section.content.strip())


@lru_cache(maxsize=4)
def build_static_system_prompt(mode: str = "default") -> str:
    """Stable, cacheable system prompt prefix before the dynamic boundary."""

    return join_system_prompt_sections(get_static_system_prompt_sections(mode=mode))


def get_runtime_context_section(
    *,
    model: Optional[str] = None,
    roots: Optional[Sequence[str]] = None,
    max_turns: Optional[int] = None,
    mode: str = "default",
) -> Optional[SystemPromptSection]:
    lines = ["# Runtime context"]
    if model:
        lines.append(f"- Model: {model}.")
    if max_turns is not None:
        lines.append(f"- Turn budget: maxTurns={max_turns}.")
    normalized_mode = str(mode or "default").strip().lower()
    if roots:
        root_lines = [str(root) for root in roots if str(root).strip()]
        if root_lines:
            lines.append("- Configured corpus roots:")
            lines.extend(f"  - {root}" for root in root_lines)
    if len(lines) == 1:
        return None
    if normalized_mode == "fast":
        lines.append(
            f"- Use {INSPECT_TOOL_NAME} when you need to understand which corpus files are available; "
            "runtime roots are only the search boundary."
        )
    else:
        lines.append(
            f"- Use {INSPECT_TOOL_NAME} when exact file coverage is needed; "
            "runtime roots are only the search boundary, not a substitute for inspecting the corpus."
        )
    content = "\n".join(lines)
    return SystemPromptSection("runtime_context", content, cacheable=False)


def get_dynamic_system_prompt_sections(
    *,
    model: Optional[str] = None,
    roots: Optional[Sequence[str]] = None,
    max_turns: Optional[int] = None,
    mode: str = "default",
) -> List[SystemPromptSection]:
    sections = [
        get_runtime_context_section(model=model, roots=roots, max_turns=max_turns, mode=mode),
    ]
    return [section for section in sections if section is not None]


def build_system_prompt(
    *,
    model: Optional[str] = None,
    roots: Optional[Sequence[str]] = None,
    max_turns: Optional[int] = None,
    mode: str = "default",
) -> str:
    static_prompt = build_static_system_prompt(mode=mode)
    dynamic_prompt = join_system_prompt_sections(
        get_dynamic_system_prompt_sections(model=model, roots=roots, max_turns=max_turns, mode=mode)
    )
    parts = [static_prompt, SYSTEM_PROMPT_DYNAMIC_BOUNDARY]
    if dynamic_prompt:
        parts.append(dynamic_prompt)
    return "\n\n".join(parts)


def split_system_prompt_at_dynamic_boundary(system_prompt: str) -> Tuple[str, str]:
    before, separator, after = system_prompt.partition(SYSTEM_PROMPT_DYNAMIC_BOUNDARY)
    if not separator:
        return system_prompt, ""
    return before.rstrip(), after.lstrip()


SYSTEM_PROMPT = build_system_prompt()


def build_user_prompt(question: str, extra_context: Optional[str] = None, mode: str = "default") -> str:
    parts = [
        "User question:",
        question.strip(),
        "",
        "Search objective:",
        "Find and verify the answer from original corpus files. Use direct citations from raw PDFs, Markdown, JSON, text, or tables whenever possible.",
        "",
        "Before answering:",
        "- Every tool-using turn must provide a concise Chinese public progress note before or alongside tool calls.",
        "- First explain how you understand the request and what evidence you will seek.",
        "- In later turns, briefly summarize what the latest data implies or how the next tool calls advance the search.",
        "- Write Agent-visible progress notes and tool public_note values in Chinese by default unless the user explicitly asks for another language.",
        "- Default thoroughness is medium unless the user asks for quick or exhaustive search.",
        "- Establish source coverage before narrowing to one document.",
        "- Search alternate names/terms if the first query is incomplete.",
        f"- Use {GREP_TOOL_NAME} snippets as leads only; support final claims with source context inspected through {READ_TOOL_NAME}.",
        "- Every key number, period, unit, basis, entity, and causal statement in the final answer needs direct source evidence.",
        "- If the question asks for a value under a specific basis or condition, search for source-stated same-basis evidence before deriving the value yourself.",
        f"- If multiple relevant source families appear in search results, inspect representative high-signal matches from each before finalizing.",
        f"- Batch independent {GREP_TOOL_NAME}/{READ_TOOL_NAME} calls in one assistant turn whenever the paths or pages are already known.",
        f"- When {GREP_TOOL_NAME} returns line/page markers, pass nearby offset/limit or the matched PDF pages to {READ_TOOL_NAME} instead of reading from the start or guessing a different range.",
        "- If you leave relevant matched sources unread, include them in coverage.relevant_uninspected_sources and do not use high confidence.",
        "- For calculations, cite every input number and show the formula.",
    ]
    normalized_mode = str(mode or "default").strip().lower()
    if normalized_mode == "fast":
        parts = [
            "User question:",
            question.strip(),
            "",
            "Search objective:",
            "Find a direct answer from original SEC/source files as quickly as possible. Prefer exact source text with path/line or page markers.",
            "",
            "Before answering:",
            "- Every tool-using turn must provide a concise Chinese public progress note before or alongside tool calls.",
            "- Search the most likely exact wording first, including source terminology and aliases.",
            f"- If a {GREP_TOOL_NAME} content hit already contains the exact answer, period, unit, and source marker, call {FINISH_TOOL_NAME} immediately.",
            f"- Use {READ_TOOL_NAME} only when the hit needs nearby context, is truncated, or lacks the basis needed for the answer.",
            "- If a source hit is complete enough to answer, finish after capturing the supporting quote.",
            "- If evidence is incomplete, finish with the verified part and list concrete gaps.",
        ]
    if extra_context:
        parts.extend(["", "Additional context:", extra_context.strip()])
    return "\n".join(parts)


def inspect_tool_schema() -> Dict[str, Any]:
    return {
        "type": "function",
        "function": {
            "name": INSPECT_TOOL_NAME,
            "description": "Inspect configured corpus roots and return counts plus representative files. Use first when roots or source coverage are unknown, so the search does not anchor on one early document.",
            "parameters": {
                "type": "object",
                "properties": {
                    "max_samples": {
                        "type": "integer",
                        "description": "Maximum sample files to return.",
                        "default": 20,
                    },
                    "public_note": {
                        "type": "string",
                        "description": "Required short visible Chinese note explaining why inspecting corpus coverage is useful.",
                    },
                },
                "required": ["public_note"],
            },
        },
    }


def fast_inspect_tool_schema() -> Dict[str, Any]:
    schema = inspect_tool_schema()
    schema["function"][
        "description"
    ] = "Inspect configured corpus roots and return counts plus representative files. Use when you need to understand which files are available before searching."
    schema["function"]["parameters"]["properties"]["public_note"][
        "description"
    ] = "Required short visible Chinese note explaining why inspecting available files is useful."
    return schema


def glob_tool_schema() -> Dict[str, Any]:
    return {
        "type": "function",
        "function": {
            "name": GLOB_TOOL_NAME,
            "description": "Fast file pattern matching over corpus files. Use this to map candidate source families, dates, titles, or document types before reading one document.",
            "parameters": {
                "type": "object",
                "properties": {
                    "pattern": {
                        "type": "string",
                        "description": "Glob pattern such as **/*.pdf, **/*2025*.md, or **/*event-name*.",
                    },
                    "path": {
                        "type": "string",
                        "description": "Optional root-relative or absolute directory/file to search within.",
                    },
                    "extensions": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Optional extension filter such as ['pdf','md'].",
                    },
                    "max_results": {
                        "type": "integer",
                        "description": "Maximum returned files.",
                        "default": 100,
                    },
                    "public_note": {
                        "type": "string",
                        "description": "Required short visible Chinese note explaining why this file pattern matters.",
                    },
                },
                "required": ["pattern", "public_note"],
            },
        },
    }


def grep_tool_schema() -> Dict[str, Any]:
    return {
        "type": "function",
        "function": {
            "name": GREP_TOOL_NAME,
            "description": "Search file contents with Python regex over PDFs, Markdown, JSON, and text. When relevance is uncertain, search the whole corpus with files_with_matches or count before narrowing by path/glob. Content-mode results include line and PDF page markers; reuse those markers as Read offset/pages for focused reads.",
            "parameters": {
                "type": "object",
                "properties": {
                    "pattern": {
                        "type": "string",
                        "description": "Regular expression pattern to search for.",
                    },
                    "path": {
                        "type": "string",
                        "description": "Optional file or directory to search within. Avoid setting this until a broad search has identified the right file or directory.",
                    },
                    "glob": {
                        "type": "string",
                        "description": "Optional glob file filter such as **/*.pdf or *annual*.md.",
                    },
                    "extensions": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Optional extension filter such as ['pdf','md'].",
                    },
                    "output_mode": {
                        "type": "string",
                        "enum": ["content", "files_with_matches", "count"],
                        "description": "content shows matching lines with context; files_with_matches shows only file paths; count shows match counts.",
                        "default": "files_with_matches",
                    },
                    "case_insensitive": {
                        "type": "boolean",
                        "description": "Whether search ignores case.",
                        "default": False,
                    },
                    "context": {
                        "type": "integer",
                        "description": "Number of context lines before and after each match for content mode.",
                        "default": 1,
                    },
                    "head_limit": {
                        "type": "integer",
                        "description": "Maximum returned lines/items. 0 means unlimited; use sparingly.",
                        "default": 80,
                    },
                    "offset": {
                        "type": "integer",
                        "description": "Skip first N matching entries before applying head_limit.",
                        "default": 0,
                    },
                    "max_files": {
                        "type": "integer",
                        "description": "Maximum files to scan after glob/path filtering.",
                        "default": 300,
                    },
                    "public_note": {
                        "type": "string",
                        "description": "Required short visible Chinese note explaining why this search is useful.",
                    },
                },
                "required": ["pattern", "public_note"],
            },
        },
    }


def fast_grep_tool_schema() -> Dict[str, Any]:
    schema = grep_tool_schema()
    schema["function"][
        "description"
    ] = "Search file contents with Python regex over PDFs, Markdown, JSON, and text. Content-mode results include line and PDF page markers; reuse those markers as Read offset/pages for focused reads."
    schema["function"]["parameters"]["properties"]["path"][
        "description"
    ] = "Optional file or directory to search within."
    return schema


def read_tool_schema() -> Dict[str, Any]:
    return {
        "type": "function",
        "function": {
            "name": READ_TOOL_NAME,
            "description": "Read a specific document range after Glob/Grep identifies relevant context. Use previous Grep line/page markers to read a focused nearby range instead of defaulting to the start of the file or guessing a different section. Use this to turn a search hit into inspected source evidence.",
            "parameters": {
                "type": "object",
                "properties": {
                    "file_path": {
                        "type": "string",
                        "description": "Absolute path or corpus-relative path to read.",
                    },
                    "offset": {
                        "type": "integer",
                        "description": "1-based starting line for text view. If Grep returned a matching line, start near that line to inspect surrounding context.",
                        "default": 1,
                    },
                    "limit": {
                        "type": "integer",
                        "description": "Maximum lines to return. Use a focused limit around a known Grep hit when possible.",
                        "default": 160,
                    },
                    "pages": {
                        "type": "string",
                        "description": "Optional PDF page range such as 1-3 or 5. Pages are 1-based. If Grep returned PDF page markers, read those matched pages or a small surrounding page range.",
                    },
                    "public_note": {
                        "type": "string",
                        "description": "Required short visible Chinese note explaining why this read is useful.",
                    },
                },
                "required": ["file_path", "public_note"],
            },
        },
    }


def finish_tool_schema() -> Dict[str, Any]:
    return {
        "type": "function",
        "function": {
            "name": FINISH_TOOL_NAME,
            "description": "Finish the search with an answer, citations, source coverage, gaps, and confidence. Use only after broad coverage and exact evidence are sufficient, or after reporting concrete gaps.",
            "parameters": {
                "type": "object",
                "properties": {
                    "answer": {
                        "type": "string",
                        "description": "Concise answer grounded only in direct evidence. If evidence is incomplete, give a limited verified answer and state gaps instead of filling missing facts.",
                    },
                    "evidence": {
                        "type": "array",
                        "description": "Direct evidence inspected with Read. Every key final claim should trace to at least one item.",
                        "items": {
                            "type": "object",
                            "properties": {
                                "path": {"type": "string", "description": "Source path that was inspected with Read."},
                                "line": {"type": "integer", "description": "Line number when available."},
                                "page": {"type": "integer", "description": "PDF page number when available."},
                                "quote": {"type": "string", "description": "Exact source text from inspected context."},
                                "why_relevant": {"type": "string", "description": "Which claim, number, period, basis, or calculation input this quote supports."},
                            },
                            "required": ["path", "quote", "why_relevant"],
                        },
                    },
                    "gaps": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Information that could not be verified.",
                    },
                    "coverage": {
                        "type": "object",
                        "description": "Brief audit trail of search coverage. Use this to avoid single-source bias.",
                        "properties": {
                            "searched_patterns": {
                                "type": "array",
                                "items": {"type": "string"},
                                "description": "Important filename/content patterns searched.",
                            },
                            "inspected_sources": {
                                "type": "array",
                                "items": {"type": "string"},
                                "description": "Relevant files or source families inspected with content/read results.",
                            },
                            "relevant_uninspected_sources": {
                                "type": "array",
                                "items": {"type": "string"},
                                "description": "Relevant matched sources not inspected, with a short reason when possible.",
                            },
                            "stopping_rationale": {
                                "type": "string",
                                "description": "Why the search coverage is sufficient, or why remaining gaps prevent higher confidence.",
                            },
                        },
                    },
                    "confidence": {
                        "type": "string",
                        "enum": ["low", "medium", "high"],
                        "description": "Confidence based on source coverage. Must not be high when relevant_uninspected_sources is non-empty or when an open-ended question used only one source family.",
                        "default": "medium",
                    },
                    "reliability_notes": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Notes for later synthesis: verified basis, unchecked or weak parts, and wording that should not be amplified.",
                    },
                },
                "required": ["answer", "evidence", "coverage"],
            },
        },
    }


def fast_finish_tool_schema() -> Dict[str, Any]:
    schema = finish_tool_schema()
    function = schema["function"]
    function["description"] = "Finish the search with a concise answer, citations, any gaps, and confidence."
    properties = function["parameters"]["properties"]
    properties["evidence"][
        "description"
    ] = "Direct evidence from Grep or Read. Every key final claim should trace to at least one item."
    properties["evidence"]["items"]["properties"]["path"][
        "description"
    ] = "Source path for the cited evidence."
    properties["confidence"][
        "description"
    ] = "Confidence in the answer based on the available direct evidence."
    properties.pop("coverage", None)
    properties.pop("reliability_notes", None)
    function["parameters"]["required"] = ["answer", "evidence"]
    return schema


def build_tool_schemas(mode: str = "default") -> List[Dict[str, Any]]:
    normalized_mode = str(mode or "default").strip().lower()
    if normalized_mode == "fast":
        return [
            fast_inspect_tool_schema(),
            glob_tool_schema(),
            fast_grep_tool_schema(),
            read_tool_schema(),
            fast_finish_tool_schema(),
        ]
    return [
        inspect_tool_schema(),
        glob_tool_schema(),
        grep_tool_schema(),
        read_tool_schema(),
        finish_tool_schema(),
    ]


TOOL_SCHEMAS: List[Dict[str, Any]] = build_tool_schemas()
FAST_TOOL_SCHEMAS: List[Dict[str, Any]] = build_tool_schemas(mode="fast")
