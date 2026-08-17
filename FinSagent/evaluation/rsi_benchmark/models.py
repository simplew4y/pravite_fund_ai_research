from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any


SCHEMA_VERSION = "rsi-benchmark-item/v1"
ALLOWED_SPLITS = {"public", "internal"}
ALLOWED_DIFFICULTIES = {"easy", "medium", "hard", "adversarial"}


@dataclass(frozen=True)
class EvidenceRef:
    source_id: str
    uri: str = ""
    locator: str = ""
    content_sha256: str = ""

    @classmethod
    def from_dict(cls, value: dict[str, Any]) -> "EvidenceRef":
        return cls(**{key: str(value.get(key, "")) for key in cls.__annotations__})


@dataclass(frozen=True)
class Provenance:
    origin: str
    generation_round: int = 0
    generator: str = "imported"
    parent_ids: tuple[str, ...] = ()
    source_record: str = ""

    @classmethod
    def from_dict(cls, value: dict[str, Any]) -> "Provenance":
        return cls(
            origin=str(value.get("origin", "unknown")),
            generation_round=int(value.get("generation_round", 0)),
            generator=str(value.get("generator", "unknown")),
            parent_ids=tuple(str(x) for x in value.get("parent_ids", [])),
            source_record=str(value.get("source_record", "")),
        )


@dataclass(frozen=True)
class BenchmarkItem:
    item_id: str
    company: str
    question: str
    answer_key: str
    key_points: tuple[str, ...]
    capabilities: tuple[str, ...]
    split: str = "internal"
    difficulty: str = "medium"
    language: str = "zh"
    temporal_scope: str = ""
    expected_tools: tuple[str, ...] = ()
    evidence: tuple[EvidenceRef, ...] = ()
    provenance: Provenance = field(default_factory=lambda: Provenance(origin="unknown"))
    schema_version: str = SCHEMA_VERSION

    def to_dict(self, public: bool = False) -> dict[str, Any]:
        value = asdict(self)
        value["key_points"] = list(self.key_points)
        value["capabilities"] = list(self.capabilities)
        value["expected_tools"] = list(self.expected_tools)
        value["provenance"]["parent_ids"] = list(self.provenance.parent_ids)
        if public:
            value.pop("answer_key", None)
            value.pop("key_points", None)
            value.pop("evidence", None)
            value["provenance"].pop("source_record", None)
        return value

    @classmethod
    def from_dict(cls, value: dict[str, Any]) -> "BenchmarkItem":
        return cls(
            item_id=str(value["item_id"]),
            company=str(value["company"]),
            question=str(value["question"]),
            answer_key=str(value.get("answer_key", "")),
            key_points=tuple(str(x) for x in value.get("key_points", [])),
            capabilities=tuple(str(x) for x in value.get("capabilities", [])),
            split=str(value.get("split", "internal")),
            difficulty=str(value.get("difficulty", "medium")),
            language=str(value.get("language", "zh")),
            temporal_scope=str(value.get("temporal_scope", "")),
            expected_tools=tuple(str(x) for x in value.get("expected_tools", [])),
            evidence=tuple(EvidenceRef.from_dict(x) for x in value.get("evidence", [])),
            provenance=Provenance.from_dict(value.get("provenance", {})),
            schema_version=str(value.get("schema_version", SCHEMA_VERSION)),
        )

    def validation_errors(self, require_grounding: bool = True) -> list[str]:
        errors: list[str] = []
        if not self.item_id.strip():
            errors.append("item_id is required")
        if not self.company.strip():
            errors.append("company is required")
        if len(self.question.strip()) < 8:
            errors.append("question is too short")
        if not self.answer_key.strip():
            errors.append("answer_key is required in the canonical/internal dataset")
        if not self.key_points:
            errors.append("at least one key point is required")
        if not self.capabilities:
            errors.append("at least one capability is required")
        if self.split not in ALLOWED_SPLITS:
            errors.append(f"invalid split: {self.split}")
        if self.difficulty not in ALLOWED_DIFFICULTIES:
            errors.append(f"invalid difficulty: {self.difficulty}")
        if require_grounding and not self.evidence:
            errors.append("at least one evidence reference is required")
        return errors
