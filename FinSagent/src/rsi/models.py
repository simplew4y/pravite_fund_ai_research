"""Stable, JSON-serializable contracts shared by the RSI control plane."""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from enum import IntEnum
from typing import Any


SCHEMA_VERSION = "finsagent-rsi/v1"


class MutationLevel(IntEnum):
    PARAMETER = 0
    PROMPT = 1
    SKILL = 2
    MEMORY_POLICY = 3
    WORKFLOW = 4

    @classmethod
    def parse(cls, value: int | str | "MutationLevel") -> "MutationLevel":
        if isinstance(value, cls):
            return value
        if isinstance(value, str):
            normalized = value.strip().upper()
            if normalized.startswith("L") and normalized[1:].isdigit():
                return cls(int(normalized[1:]))
            if normalized in cls.__members__:
                return cls[normalized]
        return cls(int(value))


@dataclass(frozen=True)
class FailureRecord:
    case_id: str
    failure_type: str
    capability: str
    stage: str
    company: str = ""
    temporal_scope: str = ""
    evidence_type: str = ""
    scope: str = ""
    confirmed: bool = True
    critical_errors: tuple[str, ...] = ()
    source_run: str = ""
    metadata: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, value: dict[str, Any]) -> "FailureRecord":
        return cls(
            case_id=str(value.get("case_id") or value.get("qid") or ""),
            failure_type=str(value.get("failure_type") or value.get("error_primary_subtype") or "unknown"),
            capability=str(value.get("capability") or value.get("task_family") or "unknown"),
            stage=str(value.get("stage") or value.get("failure_stage") or "unknown"),
            company=str(value.get("company") or ""),
            temporal_scope=str(value.get("temporal_scope") or value.get("period") or ""),
            evidence_type=str(value.get("evidence_type") or ""),
            scope=str(value.get("scope") or ""),
            confirmed=bool(value.get("confirmed", True)),
            critical_errors=tuple(str(x) for x in value.get("critical_errors", [])),
            source_run=str(value.get("source_run") or ""),
            metadata=dict(value.get("metadata") or {}),
        )


@dataclass(frozen=True)
class FailureCluster:
    cluster_id: str
    signature: tuple[str, ...]
    failure_type: str
    capability: str
    stage: str
    count: int
    case_ids: tuple[str, ...]
    companies: tuple[str, ...] = ()
    temporal_scopes: tuple[str, ...] = ()
    evidence_types: tuple[str, ...] = ()

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class CandidatePatch:
    candidate_id: str
    cluster_id: str
    mutation_level: MutationLevel
    hypothesis: str
    expected_mechanism: str
    target_paths: tuple[str, ...]
    target_capabilities: tuple[str, ...]
    target_failure_types: tuple[str, ...]
    patch_payload: dict[str, Any] = field(default_factory=dict)
    parent_candidate_ids: tuple[str, ...] = ()
    status: str = "proposed"
    requires_human_approval: bool = False
    schema_version: str = SCHEMA_VERSION

    def __post_init__(self) -> None:
        object.__setattr__(self, "mutation_level", MutationLevel.parse(self.mutation_level))
        if not self.candidate_id or not self.cluster_id:
            raise ValueError("candidate_id and cluster_id are required")
        if not self.target_paths:
            raise ValueError("at least one target path is required")
        if self.mutation_level == MutationLevel.WORKFLOW and not self.requires_human_approval:
            raise ValueError("L4 workflow mutations require human approval")

    def to_dict(self) -> dict[str, Any]:
        value = asdict(self)
        value["mutation_level"] = f"L{int(self.mutation_level)}"
        return value


@dataclass(frozen=True)
class MetricVector:
    success: float
    atomic_correctness: float
    citation_support: float
    scope_control: float
    refusal_quality: float
    latency_ms: float
    cost_units: float
    critical_error_count: int = 0
    trigger_true_positive: int = 0
    trigger_false_positive: int = 0
    mechanism_attributed: bool = False

    def __post_init__(self) -> None:
        for name in ("success", "atomic_correctness", "citation_support", "scope_control", "refusal_quality"):
            value = float(getattr(self, name))
            if not 0.0 <= value <= 1.0:
                raise ValueError(f"{name} must be between 0 and 1")
        if self.latency_ms < 0 or self.cost_units < 0 or self.critical_error_count < 0:
            raise ValueError("latency, cost, and critical errors must be non-negative")

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class PairedObservation:
    case_id: str
    seed: int
    suite: str
    capability: str
    baseline: MetricVector
    candidate: MetricVector

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class PromotionDecision:
    candidate_id: str
    decision: str
    reasons: tuple[str, ...]
    metrics: dict[str, Any]
    policy_version: str
    requires_human_approval: bool = True

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)
