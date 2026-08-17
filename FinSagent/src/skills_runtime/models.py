"""Data contracts shared by skill discovery, routing, execution, and audit."""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Literal


SkillPhase = Literal[
    "query_parse",
    "pre_retrieval",
    "post_retrieval",
    "calculation",
    "pre_answer",
    "post_answer",
]
SkillKind = Literal["prompt", "formula", "python", "builtin"]

VALID_PHASES = {
    "query_parse",
    "pre_retrieval",
    "post_retrieval",
    "calculation",
    "pre_answer",
    "post_answer",
}
VALID_KINDS = {"prompt", "formula", "python", "builtin"}
VALID_STATUSES = {"experimental", "proposed", "approved", "promoted", "deprecated"}


class SkillValidationError(ValueError):
    """Raised when an installed skill package violates the runtime contract."""


@dataclass(frozen=True)
class RoutingRule:
    intents: tuple[str, ...] = ()
    keywords: tuple[str, ...] = ()
    negative_keywords: tuple[str, ...] = ()

    @classmethod
    def from_dict(cls, value: Any) -> "RoutingRule":
        data = value if isinstance(value, dict) else {}
        return cls(
            intents=_strings(data.get("intents")),
            keywords=_strings(data.get("keywords")),
            negative_keywords=_strings(data.get("negative_keywords")),
        )


@dataclass(frozen=True)
class EvidenceContract:
    company_scope_required: bool = True
    same_company_required: bool = True
    same_period_required: bool = False
    comparable_period_required: bool = False
    unit_required: bool = False
    currency_required: bool = False
    source_evidence_required: bool = True
    allow_cross_company: bool = False
    allow_actual_estimate_mix: bool = False

    @classmethod
    def from_dict(cls, value: Any) -> "EvidenceContract":
        data = value if isinstance(value, dict) else {}
        known = {field_name for field_name in cls.__dataclass_fields__}
        return cls(**{key: bool(val) for key, val in data.items() if key in known})


@dataclass(frozen=True)
class PermissionConfig:
    network: bool = False
    filesystem_read: bool = False
    filesystem_write: bool = False
    external_tools: tuple[str, ...] = ()

    @classmethod
    def from_dict(cls, value: Any) -> "PermissionConfig":
        data = value if isinstance(value, dict) else {}
        return cls(
            network=bool(data.get("network", False)),
            filesystem_read=bool(data.get("filesystem_read", False)),
            filesystem_write=bool(data.get("filesystem_write", False)),
            external_tools=_strings(data.get("external_tools")),
        )


@dataclass(frozen=True)
class SkillManifest:
    schema_version: int
    skill_id: str
    version: str
    name: str
    description: str
    category: str
    kind: SkillKind
    phase: SkillPhase
    priority: int
    status: str
    owner: str
    agents: tuple[str, ...]
    routing: RoutingRule
    evidence_contract: EvidenceContract
    implementation: dict[str, Any]
    permissions: PermissionConfig
    public: bool = True

    @classmethod
    def from_dict(cls, data: Any, *, source: str = "") -> "SkillManifest":
        if not isinstance(data, dict):
            raise SkillValidationError(f"{source}: manifest must be a mapping")
        required = {
            "schema_version", "skill_id", "version", "name", "description",
            "category", "type", "phase", "status", "owner", "implementation",
        }
        missing = sorted(required - set(data))
        if missing:
            raise SkillValidationError(f"{source}: missing fields: {', '.join(missing)}")
        skill_id = str(data["skill_id"]).strip()
        if not skill_id or not skill_id.replace("_", "-").replace("-", "").isalnum():
            raise SkillValidationError(f"{source}: invalid skill_id={skill_id!r}")
        phase = str(data["phase"]).strip()
        kind = str(data["type"]).strip()
        status = str(data["status"]).strip()
        if phase not in VALID_PHASES:
            raise SkillValidationError(f"{source}: invalid phase={phase!r}")
        if kind not in VALID_KINDS:
            raise SkillValidationError(f"{source}: invalid type={kind!r}")
        if status not in VALID_STATUSES:
            raise SkillValidationError(f"{source}: invalid status={status!r}")
        implementation = data.get("implementation")
        if not isinstance(implementation, dict):
            raise SkillValidationError(f"{source}: implementation must be a mapping")
        return cls(
            schema_version=int(data["schema_version"]),
            skill_id=skill_id,
            version=str(data["version"]).strip(),
            name=str(data["name"]).strip(),
            description=str(data["description"]).strip(),
            category=str(data["category"]).strip(),
            kind=kind,  # type: ignore[arg-type]
            phase=phase,  # type: ignore[arg-type]
            priority=int(data.get("priority", 100)),
            status=status,
            owner=str(data["owner"]).strip(),
            agents=_strings(data.get("agents")),
            routing=RoutingRule.from_dict(data.get("routing")),
            evidence_contract=EvidenceContract.from_dict(data.get("evidence_contract")),
            implementation=dict(implementation),
            permissions=PermissionConfig.from_dict(data.get("permissions")),
            public=bool(data.get("public", True)),
        )

    def catalog_dict(self, *, enabled: bool, package_hash: str = "") -> dict[str, Any]:
        row = {
            "skill_id": self.skill_id,
            "version": self.version,
            "name": self.name,
            "description": self.description,
            "category": self.category,
            "type": self.kind,
            "phase": self.phase,
            "status": self.status,
            "enabled": enabled,
            "owner": self.owner,
            "package_hash": package_hash,
        }
        source = str(self.implementation.get("source") or "").strip()
        if source:
            row["source"] = source
            row["upstream_ref"] = str(self.implementation.get("upstream_ref") or "")
            row["upstream_path"] = str(self.implementation.get("upstream_path") or "")
        return row


@dataclass(frozen=True)
class RegisteredSkill:
    manifest: SkillManifest
    directory: Path
    instruction: str
    package_hash: str


@dataclass
class SkillContext:
    request_id: str = ""
    session_id: str = ""
    question: str = ""
    original_question: str = ""
    agent: str = ""
    dataset_id: str = ""
    allowed_doc_ids: list[str] = field(default_factory=list)
    parsed_query: dict[str, Any] = field(default_factory=dict)
    retrieval_plan: dict[str, Any] = field(default_factory=dict)
    metric_facts: list[dict[str, Any]] = field(default_factory=list)
    retrieved_chunks: list[dict[str, Any]] = field(default_factory=list)
    pre_rerank_candidates: list[dict[str, Any]] = field(default_factory=list)
    draft_answer: str = ""
    final_answer: str = ""
    derived_facts: list[dict[str, Any]] = field(default_factory=list)
    variables: dict[str, Any] = field(default_factory=dict)
    prompt_instructions: list[dict[str, str]] = field(default_factory=list)
    prior_skill_results: list["SkillResult"] = field(default_factory=list)
    skill_combo: dict[str, Any] = field(default_factory=dict)


@dataclass
class SkillResult:
    skill_id: str
    version: str
    phase: str
    triggered: bool
    status: str
    answer: str | None = None
    derived_facts: list[dict[str, Any]] = field(default_factory=list)
    answer_fragments: list[str] = field(default_factory=list)
    evidence_ids: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    confidence: float | None = None
    duration_ms: float = 0.0
    trace: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class PhaseExecution:
    context: SkillContext
    results: list[SkillResult]
    selected_skill_ids: list[str]


def _strings(value: Any) -> tuple[str, ...]:
    if value is None:
        return ()
    if isinstance(value, (list, tuple, set)):
        return tuple(str(item).strip() for item in value if str(item).strip())
    text = str(value).strip()
    return (text,) if text else ()
