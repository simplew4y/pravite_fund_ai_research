import asyncio
from pathlib import Path

import pytest

from skills_runtime.combo_router import SkillComboRouter
from skills_runtime.models import SkillContext, SkillValidationError
from skills_runtime.runtime import SkillRuntime


PROJECT_ROOT = Path(__file__).resolve().parents[2]


def _runtime() -> SkillRuntime:
    combo_ids = {
        skill_id
        for combo in SkillComboRouter.from_file(
            PROJECT_ROOT / "skills" / "combos.yaml",
            available_skill_ids={row.strip() for row in _all_combo_skill_ids()},
        ).catalog()
        for skill_id in combo["skill_ids"]
    }
    config = {
        "skills": {
            "runtime_enabled": True,
            "execution_mode": "prompt_active",
            "roots": ["./skills"],
            "promoted_only": False,
            "allow": sorted(combo_ids),
            "combo_routing": {
                "enabled": True,
                "path": "./skills/combos.yaml",
                "max_skills_per_combo": 8,
            },
        }
    }
    return SkillRuntime.from_config(config, default_root=PROJECT_ROOT / "skills")


def _all_combo_skill_ids() -> set[str]:
    import yaml

    payload = yaml.safe_load((PROJECT_ROOT / "skills" / "combos.yaml").read_text(encoding="utf-8"))
    return {skill_id for combo in payload["combos"] for skill_id in combo["skills"]}


def test_routes_specific_combos_before_generic_financial_combo() -> None:
    runtime = _runtime()
    cases = [
        ("为这个LBO收购项目写投委会memo", "P20_pe_ic_memo"),
        ("为公司制作首次覆盖完整研究报告", "P21_initiating_coverage"),
        ("检查Excel模型的公式错误和三表勾稽", "P22_model_audit"),
        ("财报后更新模型和目标价调整", "P23_model_update"),
        ("用DCF测算公司内在价值", "P24_dcf_valuation"),
        ("帮我搭一个三表模型", "P26_three_statement_model"),
        ("做一个trading comps估值足球场", "P25_comparable_valuation"),
        ("根据年报写业绩点评", "P06_earnings_commentary"),
        ("解读这份重大公告", "P15_announcement_analysis"),
        ("生成公司一页纸分析", "P07_company_one_page"),
        ("为这家公司写深度研报", "P08_company_deep_research"),
        ("完成新能源行业深度分析", "P12_industry_research"),
        ("准备机构调研提纲", "P16_institutional_research"),
        ("分析公司的2024年净利润", "P02_financial_evidence"),
    ]

    for question, expected in cases:
        selection = runtime.resolve_combo(SkillContext(question=question))
        assert selection is not None
        assert selection.combo_id == expected
        assert len(selection.skill_ids) <= 8
        assert selection.reason_codes


def test_unrelated_question_selects_no_combo_and_no_skill() -> None:
    runtime = _runtime()
    context = SkillContext(question="今天星期几？", agent="general")

    execution = asyncio.run(runtime.execute_phase("pre_answer", context))

    assert context.skill_combo == {}
    assert execution.selected_skill_ids == []


def test_combo_trace_and_agent_constraints_are_preserved() -> None:
    runtime = _runtime()
    context = SkillContext(
        question="用DCF测算公司内在价值",
        agent="quant",
        allowed_doc_ids=["issuer-doc"],
        retrieved_chunks=[{"metadata": {"source_doc_id": "issuer-doc"}}],
    )

    execution = asyncio.run(runtime.execute_phase("pre_answer", context))

    selected = set(execution.selected_skill_ids)
    assert "anthropic_dcf_model" in selected
    assert "anthropic_three_statement_model" in selected
    assert execution.selected_skill_ids.index("finskillops_financial_numeric_synthesis") < execution.selected_skill_ids.index("anthropic_three_statement_model")
    assert execution.selected_skill_ids.index("anthropic_three_statement_model") < execution.selected_skill_ids.index("anthropic_dcf_model")
    assert execution.selected_skill_ids.index("anthropic_dcf_model") < execution.selected_skill_ids.index("anthropic_audit_xls")
    assert all(result.trace["skill_combo"]["combo_id"] == "P24_dcf_valuation" for result in execution.results)


def test_combo_rejects_unknown_or_disabled_skill(tmp_path: Path) -> None:
    combo_file = tmp_path / "combos.yaml"
    combo_file.write_text(
        """schema_version: 1
combos:
  - combo_id: broken
    label: Broken
    priority: 1
    routing: {keywords: [test]}
    skills: [missing_skill]
""",
        encoding="utf-8",
    )

    with pytest.raises(SkillValidationError, match="disabled or missing"):
        SkillComboRouter.from_file(combo_file, available_skill_ids=set())
