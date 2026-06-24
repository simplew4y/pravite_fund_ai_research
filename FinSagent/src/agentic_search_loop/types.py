"""Typed records for the standalone agentic search loop."""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any, Callable, Dict, List, Literal, Optional


EventType = Literal[
    "loop_start",
    "iteration_start",
    "assistant_delta",
    "assistant_message",
    "tool_call_delta",
    "tool_call",
    "tool_result",
    "finish_rejected",
    "iteration_end",
    "final",
    "error",
]


@dataclass
class SearchEvent:
    """A streamable event for upper layers to render/debug the search loop."""

    event: EventType
    data: Dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> Dict[str, Any]:
        return {"event": self.event, "data": self.data}


EventCallback = Callable[[SearchEvent], None]


@dataclass
class ToolCallRecord:
    tool_call_id: str
    name: str
    arguments: Dict[str, Any]
    note: str = ""

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


@dataclass
class ToolResultRecord:
    tool_call_id: str
    name: str
    ok: bool
    content: str
    data: Dict[str, Any] = field(default_factory=dict)
    error: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


@dataclass
class EvidenceItem:
    path: str
    quote: str
    line: Optional[int] = None
    page: Optional[int] = None
    why_relevant: str = ""

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


@dataclass
class AgenticSearchResult:
    answer: str
    evidence: List[EvidenceItem] = field(default_factory=list)
    gaps: List[str] = field(default_factory=list)
    coverage: Dict[str, Any] = field(default_factory=dict)
    confidence: str = "medium"
    reliability_notes: List[str] = field(default_factory=list)
    tool_calls: List[ToolCallRecord] = field(default_factory=list)
    tool_results: List[ToolResultRecord] = field(default_factory=list)
    events: List[SearchEvent] = field(default_factory=list)
    iterations: int = 0
    stopped_reason: str = "completed"

    def to_dict(self) -> Dict[str, Any]:
        payload = asdict(self)
        payload["evidence"] = [item.to_dict() for item in self.evidence]
        payload["tool_calls"] = [item.to_dict() for item in self.tool_calls]
        payload["tool_results"] = [item.to_dict() for item in self.tool_results]
        payload["events"] = [item.to_dict() for item in self.events]
        return payload
