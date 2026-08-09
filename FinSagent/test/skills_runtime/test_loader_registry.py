from pathlib import Path

import pytest

from skills_runtime.loader import SkillLoader
from skills_runtime.models import SkillValidationError
from skills_runtime.registry import RuntimeSkillRegistry
from skills_runtime.models import SkillContext
from skills_runtime.router import SkillRouter
from skillops.registry import load_skill_registry


PROJECT_ROOT = Path(__file__).resolve().parents[2]


def test_builtin_skill_packages_are_discoverable() -> None:
    skills = SkillLoader([PROJECT_ROOT / "skills"]).discover()
    registry = RuntimeSkillRegistry(skills)
    builtin = [skill for skill in skills if skill.manifest.implementation.get("source") != "qwen-dianjin"]
    dianjin = [skill for skill in skills if skill.manifest.implementation.get("source") == "qwen-dianjin"]

    assert len(builtin) == 8
    assert len(dianjin) == 83
    assert registry.summary()["status_counts"] == {"promoted": 5, "experimental": 86}
    assert {skill.manifest.skill_id for skill in builtin} == {
        "answer_coverage",
        "company_profile_boundary",
        "evidence_rescue_scorer",
        "exact_evidence_probe",
        "period_alignment",
        "quant_skill_hints",
        "source_conflict",
        "table_evidence_verifier",
    }
    assert all(not registry.is_enabled(skill) for skill in dianjin)
    assert all(skill.manifest.public is False for skill in dianjin)
    assert all(skill.manifest.permissions.network is False for skill in dianjin)
    assert all(skill.manifest.routing.keywords for skill in dianjin)
    forbidden = ("gildata-aidata", "finx ", "web_search", "asset-service", "message_notify_user")
    assert all(
        not any(token in skill.instruction.lower() for token in forbidden)
        for skill in dianjin
    )
    assert all((skill.directory / "references" / "UPSTREAM_SKILL.md").is_file() for skill in dianjin)


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


def test_dianjin_candidates_route_common_research_requests_in_evaluation_mode() -> None:
    skills = SkillLoader([PROJECT_ROOT / "skills"]).discover()
    router = SkillRouter(RuntimeSkillRegistry(skills, promoted_only=False))
    cases = {
        "帮我做一份保时捷公司深度分析": "dianjin_investment_researcher_company_deep_analysis",
        "解读这份重大公告": "dianjin_investment_researcher_announcement_analysis",
        "基于年报写一份业绩点评": "dianjin_investment_researcher_earnings_commentary_generator",
        "生成公司一页纸": "dianjin_investment_researcher_company_one_page_analysis",
        "做一个同业可比公司分析": "dianjin_investment_advisor_comparable_company_analysis",
    }

    for question, expected in cases.items():
        selected = router.select(
            "pre_answer",
            SkillContext(question=question, agent="general"),
        )
        assert expected in {skill.manifest.skill_id for skill in selected}


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

    assert len(registry.all()) == 91
    assert registry.status_counts() == {"promoted": 5, "experimental": 86}
    assert registry.get("table_evidence_verifier").implementation_refs
    assert registry.get("dianjin_investment_researcher_company_deep_analysis").status == "experimental"


def test_package_and_legacy_governance_ids_stay_in_sync() -> None:
    packages = load_skill_registry(PROJECT_ROOT / "skills")
    legacy = load_skill_registry(PROJECT_ROOT / "configs" / "skill_cards")

    package_identity = {
        (card.skill_id, card.version, card.status)
        for card in packages.all()
        if not card.skill_id.startswith("dianjin_")
    }
    legacy_identity = {(card.skill_id, card.version, card.status) for card in legacy.all()}
    assert package_identity == legacy_identity
