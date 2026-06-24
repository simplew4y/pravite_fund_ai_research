"""Read-only tools exposed to the agentic search loop."""

from __future__ import annotations

import json
import re
import traceback
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence

from .corpus import CorpusStore, LineRecord, highlight_regex
from .prompts import GLOB_TOOL_NAME, GREP_TOOL_NAME, INSPECT_TOOL_NAME, READ_TOOL_NAME
from .types import ToolResultRecord


DEFAULT_HEAD_LIMIT = 80


@dataclass
class MatchRecord:
    path: str
    rel_path: str
    line: int
    text: str
    page: Optional[int] = None

    def to_dict(self) -> Dict[str, Any]:
        return {
            "path": self.path,
            "rel_path": self.rel_path,
            "line": self.line,
            "page": self.page,
            "text": self.text,
        }


class AgenticSearchTools:
    """Read-only search tools over a CorpusStore."""

    def __init__(self, corpus: CorpusStore):
        self.corpus = corpus

    async def execute(self, tool_call_id: str, name: str, arguments: Dict[str, Any]) -> ToolResultRecord:
        try:
            if name == INSPECT_TOOL_NAME:
                data = self.inspect(**arguments)
            elif name == GLOB_TOOL_NAME:
                data = self.glob(**arguments)
            elif name == GREP_TOOL_NAME:
                data = self.grep(**arguments)
            elif name == READ_TOOL_NAME:
                data = self.read(**arguments)
            else:
                return ToolResultRecord(
                    tool_call_id=tool_call_id,
                    name=name,
                    ok=False,
                    content=f"Unknown tool: {name}",
                    error=f"Unknown tool: {name}",
                )
            return ToolResultRecord(
                tool_call_id=tool_call_id,
                name=name,
                ok=True,
                content=self._format_result(name, data),
                data=data,
            )
        except Exception as exc:
            return ToolResultRecord(
                tool_call_id=tool_call_id,
                name=name,
                ok=False,
                content=f"<tool_error>{type(exc).__name__}: {exc}</tool_error>",
                data={"traceback": traceback.format_exc(limit=5)},
                error=str(exc),
            )

    def inspect(self, max_samples: int = 20, public_note: str = "") -> Dict[str, Any]:
        data = self.corpus.inspect(max_samples=max_samples)
        data["public_note"] = public_note
        return data

    def glob(
        self,
        pattern: str,
        path: Optional[str] = None,
        extensions: Optional[Sequence[str]] = None,
        max_results: int = 100,
        public_note: str = "",
    ) -> Dict[str, Any]:
        records = self.corpus.list_files(
            pattern=pattern,
            path=path,
            extensions=extensions,
            max_results=max_results,
        )
        return {
            "pattern": pattern,
            "path": path,
            "num_files": len(records),
            "files": [r.to_dict() for r in records],
            "truncated": len(records) >= max_results,
            "public_note": public_note,
        }

    def grep(
        self,
        pattern: str,
        path: Optional[str] = None,
        glob: Optional[str] = None,
        extensions: Optional[Sequence[str]] = None,
        output_mode: str = "files_with_matches",
        case_insensitive: bool = False,
        context: int = 1,
        head_limit: int = DEFAULT_HEAD_LIMIT,
        offset: int = 0,
        max_files: int = 300,
        public_note: str = "",
    ) -> Dict[str, Any]:
        flags = re.IGNORECASE if case_insensitive else 0
        regex = re.compile(pattern, flags)
        file_pattern = glob or "**/*"
        records = self.corpus.list_files(
            pattern=file_pattern,
            path=path,
            extensions=extensions,
            max_results=max_files,
        )

        matches: List[MatchRecord] = []
        counts: Dict[str, Dict[str, Any]] = {}
        extraction_errors: List[Dict[str, str]] = []

        for record in records:
            try:
                lines, method = self.corpus.get_line_records(record.path)
            except Exception as exc:
                extraction_errors.append({"path": str(record.path), "error": str(exc)})
                continue
            local_count = 0
            for idx, line in enumerate(lines):
                if not regex.search(line.text):
                    continue
                local_count += 1
                if output_mode == "content":
                    start = max(0, idx - max(context, 0))
                    end = min(len(lines), idx + max(context, 0) + 1)
                    snippet_lines = []
                    for ctx_line in lines[start:end]:
                        marker = ">" if ctx_line.line == line.line else " "
                        page_part = f" p.{ctx_line.page}" if ctx_line.page else ""
                        text = highlight_regex(ctx_line.text, regex) if ctx_line.line == line.line else ctx_line.text
                        snippet_lines.append(f"{marker}{ctx_line.line}{page_part}: {text}")
                    text = "\n".join(snippet_lines)
                else:
                    text = line.text
                matches.append(
                    MatchRecord(
                        path=str(record.path),
                        rel_path=record.rel_path,
                        line=line.line,
                        page=line.page,
                        text=text,
                    )
                )
            if local_count:
                counts[str(record.path)] = {
                    "rel_path": record.rel_path,
                    "count": local_count,
                    "extraction_method": method,
                }

        total_matches = len(matches)
        total_files = len(counts)
        limited_matches = self._apply_window(matches, head_limit=head_limit, offset=offset)

        return {
            "pattern": pattern,
            "public_note": public_note,
            "mode": output_mode,
            "searched_files": len(records),
            "matched_files": total_files,
            "total_matches": total_matches,
            "matches": [m.to_dict() for m in limited_matches],
            "counts": counts,
            "errors": extraction_errors[:20],
            "applied_limit": head_limit if head_limit and total_matches > offset + head_limit else None,
            "applied_offset": offset if offset else None,
        }

    def read(
        self,
        file_path: str,
        offset: int = 1,
        limit: int = 160,
        pages: Optional[str] = None,
        public_note: str = "",
    ) -> Dict[str, Any]:
        result = self.corpus.read_lines(file_path, offset=offset, limit=limit, pages=pages)
        data = result.to_dict()
        data["public_note"] = public_note
        return data

    @staticmethod
    def _apply_window(items: List[MatchRecord], head_limit: int, offset: int) -> List[MatchRecord]:
        start = max(offset, 0)
        if head_limit == 0:
            return items[start:]
        return items[start : start + max(head_limit, 1)]

    def _format_result(self, name: str, data: Dict[str, Any]) -> str:
        if name == INSPECT_TOOL_NAME:
            header = f"Inspect note: {data['public_note']}\n" if data.get("public_note") else ""
            lines = [
                header + f"Roots: {', '.join(data.get('roots', []))}",
                f"Total files: {data.get('total_files', 0)}",
                f"Counts by extension: {json.dumps(data.get('counts_by_extension', {}), ensure_ascii=False)}",
                "Samples:",
            ]
            for item in data.get("samples", []):
                lines.append(f"- {item['rel_path']} ({item['ext']}, {item['size']} bytes)")
            return "\n".join(lines)

        if name == GLOB_TOOL_NAME:
            header = f"Glob note: {data['public_note']}\n" if data.get("public_note") else ""
            files = data.get("files", [])
            if not files:
                return header + "No files found"
            lines = [header + f"Found {data.get('num_files', 0)} files:"]
            lines.extend(f"- {item['rel_path']} [{item['path']}]" for item in files)
            if data.get("truncated"):
                lines.append("(Results truncated. Use a narrower pattern/path.)")
            return "\n".join(lines)

        if name == GREP_TOOL_NAME:
            mode = data.get("mode")
            if data.get("public_note"):
                header = f"Search note: {data['public_note']}\n"
            else:
                header = ""
            if data.get("total_matches", 0) == 0:
                err = data.get("errors") or []
                suffix = f"\nExtraction errors: {json.dumps(err[:5], ensure_ascii=False)}" if err else ""
                return header + "No matches found" + suffix
            if mode == "files_with_matches":
                lines = [
                    header
                    + f"Found {data.get('matched_files', 0)} files with {data.get('total_matches', 0)} matches:"
                ]
                for path, payload in data.get("counts", {}).items():
                    lines.append(f"- {payload['rel_path']} ({payload['count']} matches) [{path}]")
                return "\n".join(lines)
            if mode == "count":
                lines = [
                    header
                    + f"Found {data.get('total_matches', 0)} matches across {data.get('matched_files', 0)} files:"
                ]
                for path, payload in data.get("counts", {}).items():
                    lines.append(f"- {payload['rel_path']}: {payload['count']} [{path}]")
                return "\n".join(lines)
            lines = [
                header
                + f"Found {data.get('total_matches', 0)} matches across {data.get('matched_files', 0)} files. Showing snippets:"
            ]
            for match in data.get("matches", []):
                page = f" page {match['page']}" if match.get("page") else ""
                lines.append(f"\n[{match['rel_path']}:{match['line']}{page}]\n{match['text']}")
            if data.get("applied_limit"):
                lines.append(
                    f"\n[Showing paginated results: limit={data.get('applied_limit')} offset={data.get('applied_offset') or 0}]"
                )
            return "\n".join(lines)

        if name == READ_TOOL_NAME:
            note = f"Read note: {data['public_note']}\n" if data.get("public_note") else ""
            pages = f" pages={data.get('pages')}" if data.get("pages") else ""
            method = f" extraction={data.get('extraction_method')}" if data.get("extraction_method") else ""
            return (
                note
                + f"Read {data.get('num_lines', 0)} lines from {data.get('path')} "
                + f"(start={data.get('start_line')}, total={data.get('total_lines')}{pages}{method})\n"
                + str(data.get("content", ""))
            )

        return json.dumps(data, ensure_ascii=False, indent=2)
