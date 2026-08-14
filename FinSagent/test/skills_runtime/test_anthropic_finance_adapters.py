from pathlib import Path

import yaml

from skills_runtime.loader import SkillLoader
from skills_runtime.models import SkillContext
from skills_runtime.registry import RuntimeSkillRegistry
from skills_runtime.router import SkillRouter


PINNED_REF = "38652224c10610fa52eee2acee3ac712dcff01f2"
EXPECTED = {
    "anthropic_three_statement_model",
    "anthropic_dcf_model",
    "anthropic_comps_analysis",
    "anthropic_model_update",
    "anthropic_audit_xls",
    "anthropic_initiating_coverage",
    "anthropic_ic_memo",
}


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[2]


def test_anthropic_finance_adapters_are_discoverable_and_shadow_only():
    root = _repo_root()
    skills = SkillLoader([root / "skills"], strict=True).discover()
    selected = {skill.manifest.skill_id: skill for skill in skills if skill.manifest.skill_id in EXPECTED}

    assert set(selected) == EXPECTED
    for skill in selected.values():
        manifest = skill.manifest
        assert manifest.status == "experimental"
        assert manifest.public is False
        assert manifest.implementation["source"] == "anthropic-financial-services"
        assert manifest.implementation["upstream_ref"] == PINNED_REF
        assert manifest.implementation["external_tools_blocked"] is True
        assert manifest.permissions.network is False
        assert manifest.permissions.filesystem_write is False


def test_production_allowlist_does_not_activate_shadow_adapters():
    root = _repo_root()
    config = yaml.safe_load((root / "config" / "production.yaml").read_text(encoding="utf-8"))
    allowed = set(config.get("skills", {}).get("allow", []))
    assert EXPECTED.isdisjoint(allowed)


def test_shadow_router_selects_modeling_and_memo_capabilities():
    root = _repo_root()
    skills = SkillLoader([root / "skills"], strict=True).discover()
    router = SkillRouter(RuntimeSkillRegistry(skills, promoted_only=False))
    cases = [
        ("帮我搭一个三表模型", "quant", "anthropic_three_statement_model"),
        ("用DCF测算公司的内在价值", "quant", "anthropic_dcf_model"),
        ("做一个trading comps估值足球场", "market_researcher", "anthropic_comps_analysis"),
        ("财报出来后更新模型和目标价", "company_researcher", "anthropic_model_update"),
        ("审计模型的公式错误和三表勾稽", "quant", "anthropic_audit_xls"),
        ("为这家公司制作首次覆盖深度研报", "company_researcher", "anthropic_initiating_coverage"),
        ("为这个LBO收购项目写投委会memo", "legal_risk", "anthropic_ic_memo"),
    ]
    for question, agent, expected in cases:
        selected = router.select("post_answer" if expected == "anthropic_audit_xls" else "pre_answer", SkillContext(question=question, agent=agent))
        assert expected in {skill.manifest.skill_id for skill in selected}


def test_pe_ic_memo_does_not_route_secondary_market_request():
    root = _repo_root()
    skills = SkillLoader([root / "skills"], strict=True).discover()
    router = SkillRouter(RuntimeSkillRegistry(skills, promoted_only=False))
    selected = router.select(
        "pre_answer",
        SkillContext(question="写一份二级市场股票多头 IC Memo", agent="company_researcher"),
    )
    assert "anthropic_ic_memo" not in {skill.manifest.skill_id for skill in selected}


def test_source_registry_records_license_and_duplicate_policy():
    root = _repo_root()
    source = yaml.safe_load(
        (root / "skill_sources" / "anthropic-financial-services.yaml").read_text(encoding="utf-8")
    )
    assert source["license"] == "Apache-2.0"
    assert source["current_observation"]["ref"] == PINNED_REF
    assert source["adaptation_policy"]["status"] == "shadow_evaluation_only"
    assert source["adaptation_policy"]["production_allowlist"] is False
    duplicate_repositories = {row["repository"] for row in source["excluded_duplicates"]}
    assert "https://github.com/NousResearch/hermes-agent" in duplicate_repositories
    assert "https://github.com/ginlix-ai/LangAlpha" in duplicate_repositories
