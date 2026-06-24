"""Command line entrypoint for the standalone agentic search loop."""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
import textwrap
from pathlib import Path
from typing import Any, Dict, List, Set

from .corpus import CorpusStore
from .loop import AgenticSearchConfig, AgenticSearchLoop
from .prompts import GLOB_TOOL_NAME, GREP_TOOL_NAME, INSPECT_TOOL_NAME, READ_TOOL_NAME
from .types import SearchEvent


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Run standalone agentic corpus search.")
    parser.add_argument("question", nargs="?", help="Question to answer from raw PDF/Markdown corpus.")
    parser.add_argument(
        "--question-file",
        default="",
        help="Read the UTF-8 question from a file. Use '-' to read from stdin.",
    )
    parser.add_argument(
        "--root",
        action="append",
        default=[],
        help="Corpus root. Can be provided multiple times. Use raw_pdf or processed md directories.",
    )
    parser.add_argument(
        "--fin-config",
        default="",
        help="Optional FinSagent YAML config. Adds dataset_root/0_raw_pdf, 1_processed_pdf, 3_base_final if present.",
    )
    parser.add_argument("--cache-dir", default="", help="PDF text cache directory.")
    parser.add_argument("--model", default="", help="OpenAI-compatible model name.")
    parser.add_argument("--base-url", default="", help="OpenAI-compatible base URL.")
    parser.add_argument("--api-key", default="EMPTY", help="API key.")
    parser.add_argument("--mode", choices=["default", "fast"], default="", help="Agentic search mode.")
    parser.add_argument("--max-turns", dest="max_turns", type=int, default=None, help="Maximum agent turns.")
    parser.add_argument(
        "--enforce-finish-coverage",
        action="store_true",
        default=None,
        help="Reject FinishSearch when coverage is incomplete. Disabled by default for faster runs.",
    )
    parser.add_argument(
        "--no-enforce-minimum-reliability",
        dest="enforce_minimum_reliability",
        action="store_false",
        default=None,
        help="Disable minimum FinishSearch reliability checks for evidence and inspected-source consistency.",
    )
    parser.add_argument("--json", action="store_true", help="Print full JSON result.")
    parser.add_argument("--jsonl", action="store_true", help="Print raw JSONL events.")
    parser.add_argument("--verbose-deltas", action="store_true", help="Show streamed tool argument deltas.")
    parser.add_argument("--no-color", action="store_true", help="Disable ANSI colors.")
    return parser


class FriendlyRenderer:
    def __init__(self, question: str, model: str, verbose_deltas: bool = False, color: bool = True):
        self.question = question
        self.model = model
        self.verbose_deltas = verbose_deltas
        self.color = color
        self._assistant_open = False
        self._seen_assistant_delta = False
        self._seen_arg_streams: Set[str] = set()

    def render(self, event: SearchEvent) -> None:
        handler = getattr(self, f"_render_{event.event}", None)
        if handler:
            handler(event.data)

    def close(self) -> None:
        self._close_assistant()

    def _render_loop_start(self, data: Dict[str, Any]) -> None:
        self._line(self._style("Agentic Search", "bold"))
        self._line(f"Question: {self.question}")
        self._line(f"Model: {self.model}")
        roots = data.get("roots") or []
        if roots:
            self._line("Corpus roots:")
            for root in roots:
                self._line(f"  - {root}")
        tool_names = data.get("tool_names") or []
        if tool_names:
            self._line(f"Tools: {', '.join(tool_names)}")

    def _render_iteration_start(self, data: Dict[str, Any]) -> None:
        self._close_assistant()
        label = "Finalization" if data.get("finalization") else f"Turn {data.get('iteration')}"
        self._line("")
        self._line(self._style(f"[{label}]", "bold"))

    def _render_assistant_delta(self, data: Dict[str, Any]) -> None:
        if not self._assistant_open:
            self._line(self._style("Assistant:", "cyan"))
            self._assistant_open = True
        sys.stdout.write(str(data.get("content", "")))
        sys.stdout.flush()
        self._seen_assistant_delta = True

    def _render_assistant_message(self, data: Dict[str, Any]) -> None:
        if self._seen_assistant_delta:
            self._close_assistant()
            self._seen_assistant_delta = False
            return
        content = str(data.get("content", "") or "").strip()
        if content:
            self._line(self._style("Assistant:", "cyan"))
            self._line(self._indent(content))

    def _render_tool_call_delta(self, data: Dict[str, Any]) -> None:
        tool_call_id = str(data.get("tool_call_id") or f"index_{data.get('index', 0)}")
        name = str(data.get("name") or "tool")
        if tool_call_id not in self._seen_arg_streams:
            self._close_assistant()
            self._seen_arg_streams.add(tool_call_id)
            self._line(self._style(f"Streaming tool input: {name}", "dim"))
        if self.verbose_deltas and data.get("argument_delta"):
            self._line(self._indent(str(data["argument_delta"]), prefix="    + "))

    def _render_tool_call(self, data: Dict[str, Any]) -> None:
        self._close_assistant()
        name = str(data.get("name", "tool"))
        args = data.get("arguments") or {}
        note = str(data.get("note") or args.get("public_note") or "")
        suffix = " (streaming)" if data.get("streaming") else ""
        if data.get("finalization"):
            suffix += " (finalization)"
        self._line(self._style(f"Tool call: {name}{suffix}", "yellow"))
        if note:
            self._line(self._indent(f"note: {note}"))
        self._line(self._indent(self._format_args(args)))

    def _render_tool_result(self, data: Dict[str, Any]) -> None:
        self._close_assistant()
        name = str(data.get("name", "tool"))
        ok = bool(data.get("ok", False))
        status = "ok" if ok else "error"
        style = "green" if ok else "red"
        self._line(self._style(f"Tool result: {name} [{status}]", style))
        if data.get("error"):
            self._line(self._indent(str(data["error"])))
            return
        summary = self._tool_result_summary(data)
        if summary:
            self._line(self._indent(summary))

    def _render_iteration_end(self, data: Dict[str, Any]) -> None:
        self._close_assistant()
        self._line(self._style(f"Turn complete: {data.get('tool_calls', 0)} tool call(s)", "dim"))

    def _render_error(self, data: Dict[str, Any]) -> None:
        self._close_assistant()
        self._line(self._style(f"Error: {data.get('type', 'Error')}: {data.get('error', '')}", "red"))

    def _render_finish_rejected(self, data: Dict[str, Any]) -> None:
        self._close_assistant()
        self._line(self._style("Finish rejected by coverage gate", "yellow"))
        reason = str(data.get("reason", "") or "")
        if reason:
            self._line(self._indent(self._truncate(reason, 1200)))

    def _render_final(self, data: Dict[str, Any]) -> None:
        self._close_assistant()
        self._line("")
        self._line(self._style("Final Answer", "bold"))
        answer = str(data.get("answer", "") or "").strip()
        if answer:
            self._line(self._indent(answer))
        else:
            self._line(self._indent("(no answer returned)"))
        confidence = data.get("confidence")
        stopped_reason = data.get("stopped_reason")
        if confidence or stopped_reason:
            self._line(f"Confidence: {confidence or 'unknown'} | Stop: {stopped_reason or 'unknown'}")
        evidence = data.get("evidence") or []
        if evidence:
            self._line("Evidence:")
            for item in evidence:
                if not isinstance(item, dict):
                    continue
                loc = item.get("path", "")
                if item.get("page"):
                    loc += f":page {item['page']}"
                if item.get("line"):
                    loc += f":line {item['line']}"
                quote = str(item.get("quote", "") or "")
                why = str(item.get("why_relevant", "") or "")
                self._line(self._indent(loc, prefix="  - "))
                if quote:
                    self._line(self._indent(self._truncate(quote, 360), prefix="    quote: "))
                if why:
                    self._line(self._indent(why, prefix="    why: "))
        coverage = data.get("coverage") or {}
        if isinstance(coverage, dict) and coverage:
            self._line("Coverage:")
            for key in ("searched_patterns", "inspected_sources", "relevant_uninspected_sources"):
                values = coverage.get(key) or []
                if values:
                    self._line(self._indent(f"{key}:"))
                    for value in values[:20]:
                        self._line(self._indent(str(value), prefix="    - "))
                    if len(values) > 20:
                        self._line(self._indent(f"... {len(values) - 20} more", prefix="    - "))
            rationale = coverage.get("stopping_rationale")
            if rationale:
                self._line(self._indent(f"stopping_rationale: {rationale}"))
        gaps = data.get("gaps") or []
        if gaps:
            self._line("Gaps:")
            for gap in gaps:
                self._line(self._indent(str(gap), prefix="  - "))

    def _tool_result_summary(self, data: Dict[str, Any]) -> str:
        payload = data.get("data") or {}
        name = data.get("name")
        if name == INSPECT_TOOL_NAME:
            counts = payload.get("counts_by_extension", {})
            return f"files={payload.get('total_files', 0)}, extensions={json.dumps(counts, ensure_ascii=False)}"
        if name == GLOB_TOOL_NAME:
            files = payload.get("files") or []
            shown = ", ".join(str(item.get("rel_path", item.get("path", ""))) for item in files[:8])
            suffix = " ..." if len(files) > 8 else ""
            return f"matched_files={payload.get('num_files', len(files))}: {shown}{suffix}"
        if name == GREP_TOOL_NAME:
            parts = [
                f"matches={payload.get('total_matches', 0)}",
                f"files={payload.get('matched_files', 0)}",
                f"searched={payload.get('searched_files', 0)}",
            ]
            matches = payload.get("matches") or []
            snippets = []
            for match in matches[:3]:
                loc = f"{match.get('rel_path', match.get('path', ''))}:{match.get('line')}"
                if match.get("page"):
                    loc += f" p.{match['page']}"
                snippets.append(f"{loc}\n{self._truncate(str(match.get('text', '')), 500)}")
            if snippets:
                parts.append("snippets:\n" + "\n\n".join(snippets))
            return "\n".join(parts)
        if name == READ_TOOL_NAME:
            header = f"lines={payload.get('num_lines', 0)}/{payload.get('total_lines', 0)}"
            if payload.get("pages"):
                header += f", pages={payload.get('pages')}"
            content = str(payload.get("content", "") or "")
            if content:
                return header + "\n" + self._truncate(content, 900)
            return header
        return self._truncate(str(data.get("content", "") or ""), 900)

    def _format_args(self, args: Dict[str, Any]) -> str:
        if not args:
            return "{}"
        compact = json.dumps(args, ensure_ascii=False)
        return self._truncate(compact, 700)

    def _close_assistant(self) -> None:
        if self._assistant_open:
            sys.stdout.write("\n")
            sys.stdout.flush()
            self._assistant_open = False

    def _line(self, text: str) -> None:
        print(text, flush=True)

    def _indent(self, text: str, prefix: str = "  ") -> str:
        wrapped_lines = []
        for raw_line in str(text).splitlines() or [""]:
            if len(raw_line) <= 120:
                wrapped_lines.append(prefix + raw_line)
            else:
                wrapped_lines.extend(textwrap.wrap(raw_line, width=120, initial_indent=prefix, subsequent_indent=prefix))
        return "\n".join(wrapped_lines)

    @staticmethod
    def _truncate(text: str, limit: int) -> str:
        if len(text) <= limit:
            return text
        return text[: max(limit - 20, 1)].rstrip() + "\n... [truncated]"

    def _style(self, text: str, style: str) -> str:
        if not self.color:
            return text
        codes = {
            "bold": "1",
            "dim": "2",
            "cyan": "36",
            "yellow": "33",
            "green": "32",
            "red": "31",
        }
        code = codes.get(style)
        return f"\033[{code}m{text}\033[0m" if code else text


async def main_async() -> None:
    args = build_parser().parse_args()
    question = read_question(args)
    roots: List[str] = list(args.root or [])
    if args.fin_config:
        corpus = CorpusStore.from_fin_config(
            args.fin_config,
            extra_roots=roots,
            cache_dir=args.cache_dir or None,
        )
    else:
        if not roots:
            raise SystemExit("Provide at least one --root or --fin-config")
        corpus = CorpusStore(roots=roots, cache_dir=args.cache_dir or None)

    if not args.model:
        raise SystemExit("Provide --model for the OpenAI-compatible search LLM")

    config_overrides = {
        "mode": args.mode or None,
        "max_turns": args.max_turns,
        "enforce_finish_coverage": args.enforce_finish_coverage,
        "enforce_minimum_reliability": args.enforce_minimum_reliability,
    }
    config = AgenticSearchConfig.from_agentic_search_config(
        load_agentic_search_config(args.fin_config),
        model=args.model,
        base_url=args.base_url or None,
        api_key=args.api_key,
        overrides=config_overrides,
    )
    loop = AgenticSearchLoop(corpus, config)

    if args.json:
        result = await loop.arun_search(question)
        print(json.dumps(result.to_dict(), ensure_ascii=False, indent=2))
        return

    if args.jsonl:
        async for event in loop.astream_search(question):
            print(json.dumps(event.to_dict(), ensure_ascii=False))
        return

    color = not args.no_color and sys.stdout.isatty() and os.environ.get("NO_COLOR") is None
    renderer = FriendlyRenderer(
        question=question,
        model=args.model,
        verbose_deltas=args.verbose_deltas,
        color=color,
    )
    async for event in loop.astream_search(question):
        renderer.render(event)
    renderer.close()


def read_question(args: argparse.Namespace) -> str:
    if args.question_file:
        if args.question_file == "-":
            question = sys.stdin.read()
        else:
            with open(args.question_file, "r", encoding="utf-8") as f:
                question = f.read()
    else:
        question = args.question or ""
    question = question.strip()
    if not question:
        raise SystemExit("Provide a question argument or --question-file")
    if looks_like_mojibake(question):
        print(
            "Warning: question text looks mojibake/garbled. Prefer --question-file with UTF-8 input.",
            file=sys.stderr,
            flush=True,
        )
    return question


def load_agentic_search_config(config_path: str) -> Dict[str, Any]:
    if not config_path:
        return {}
    try:
        import yaml
    except ImportError as exc:
        raise SystemExit("PyYAML is required to load --fin-config") from exc

    path = Path(config_path).expanduser().resolve()
    payload = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    agentic_config = payload.get("agentic_search", {}) if isinstance(payload, dict) else {}
    return agentic_config if isinstance(agentic_config, dict) else {}


def looks_like_mojibake(text: str) -> bool:
    # Common characters seen when UTF-8 Chinese text is decoded with a legacy code page.
    markers = ("\u9470", "\u7c8d", "\u934f", "\u951b", "\u7ee0", "\u5b2a")
    return "\ufffd" in text or sum(1 for marker in markers if marker in text) >= 2


def main() -> None:
    asyncio.run(main_async())


if __name__ == "__main__":
    main()
