from pathlib import Path

import pytest

from skills_runtime.loader import SkillLoader
from skills_runtime.models import SkillValidationError
from skills_runtime.registry import RuntimeSkillRegistry
from skillops.registry import load_skill_registry


PROJECT_ROOT = Path(__file__).resolve().parents[2]


def test_builtin_skill_packages_are_discoverable() -> None:
    skills = SkillLoader([PROJECT_ROOT / "skills"]).discover()
    registry = RuntimeSkillRegistry(skills)

    assert len(skills) == 8
    assert registry.summary()["status_counts"] == {"promoted": 5, "experimental": 3}
    assert {row["skill_id"] for row in registry.catalog()} == {
        "answer_coverage",
        "company_profile_boundary",
        "evidence_rescue_scorer",
        "exact_evidence_probe",
        "period_alignment",
        "quant_skill_hints",
        "source_conflict",
        "table_evidence_verifier",
    }


def test_promoted_allowlist_controls_activation() -> None:
    skills = SkillLoader([PROJECT_ROOT / "skills"]).discover()
    registry = RuntimeSkillRegistry(
        skills,
        promoted_only=True,
        allow=["period_alignment", "table_evidence_verifier"],
    )

    assert [row["skill_id"] for row in registry.catalog() if row["enabled"]] == [
        "period_alignment",
        "table_evidence_verifier",
    ]


def test_missing_allowlisted_skill_is_a_startup_error() -> None:
    with pytest.raises(SkillValidationError, match="missing skills"):
        RuntimeSkillRegistry([], allow=["not_installed"])


def test_duplicate_skill_ids_are_rejected() -> None:
    skill = SkillLoader([PROJECT_ROOT / "skills"]).discover()[0]
    with pytest.raises(SkillValidationError, match="duplicate skill_id"):
        RuntimeSkillRegistry([skill, skill])


def test_public_catalog_hides_internal_hash_and_owner() -> None:
    registry = RuntimeSkillRegistry(SkillLoader([PROJECT_ROOT / "skills"]).discover())

    rows = registry.catalog(public_only=True)

    assert rows
    assert all("package_hash" not in row and "owner" not in row for row in rows)
    assert all(row["skill_id"] not in {"answer_coverage", "quant_skill_hints"} for row in rows)


def test_governance_registry_loads_from_skill_packages() -> None:
    registry = load_skill_registry(PROJECT_ROOT / "skills")

    assert len(registry.all()) == 8
    assert registry.status_counts() == {"promoted": 5, "experimental": 3}
    assert registry.get("table_evidence_verifier").implementation_refs


def test_package_and_legacy_governance_ids_stay_in_sync() -> None:
    packages = load_skill_registry(PROJECT_ROOT / "skills")
    legacy = load_skill_registry(PROJECT_ROOT / "configs" / "skill_cards")

    package_identity = {(card.skill_id, card.version, card.status) for card in packages.all()}
    legacy_identity = {(card.skill_id, card.version, card.status) for card in legacy.all()}
    assert package_identity == legacy_identity
