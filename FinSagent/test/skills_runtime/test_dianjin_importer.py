from pathlib import Path
import hashlib

from scripts.import_dianjin_skills import main
from skills_runtime.loader import SkillLoader
from skills_runtime.registry import RuntimeSkillRegistry


UPSTREAM_TEXT = """---
name: company-deep-analysis
description: 深度分析公司。触发词包括："公司深度分析"、"投资价值分析"。
version: 1.0.0
---

# 上市公司深度分析

通过 gildata-aidata 和 web_search 获取数据。

## 执行流程

1. 确认公司和报告期。
2. 分析财务、业务和风险。

## 输出格式

输出有来源的结构化报告。
"""


def _write_source(root: Path, relative: str, text: str = UPSTREAM_TEXT) -> None:
    path = root / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def test_importer_installs_selected_candidates_with_runtime_guardrails(tmp_path: Path) -> None:
    source = tmp_path / "upstream"
    output = tmp_path / "skills"
    selected = "DianJin-SKILLS/investment-researcher/company-deep-analysis/SKILL.md"
    cross_domain = "DianJin-SKILLS/wealth-copilot/L2-5_diagnosis/fund-deep-research/SKILL.md"
    excluded = "DianJin-SKILLS/insurance-agent/social-media/SKILL.md"
    _write_source(source, selected)
    _write_source(source, cross_domain)
    _write_source(source, excluded)

    assert main([
        "--source-root", str(source),
        "--output-root", str(output),
        "--ref", "test-ref",
    ]) == 0

    discovered = SkillLoader([output]).discover()
    assert len(discovered) == 2
    assert {skill.manifest.status for skill in discovered} == {"experimental"}
    assert all(skill.manifest.public is False for skill in discovered)
    assert all(skill.manifest.permissions.network is False for skill in discovered)
    assert all("FinSagent execution boundary" in skill.instruction for skill in discovered)
    assert all("gildata-aidata" not in skill.instruction for skill in discovered)
    assert all("上游外部金融数据服务" in skill.instruction for skill in discovered)

    company = next(skill for skill in discovered if "company_deep_analysis" in skill.manifest.skill_id)
    assert company.manifest.evidence_contract.company_scope_required is True
    assert company.manifest.evidence_contract.same_period_required is False
    assert company.manifest.evidence_contract.unit_required is False
    assert "公司深度分析" in company.manifest.routing.keywords
    assert company.manifest.implementation["upstream_ref"] == "test-ref"
    assert company.manifest.implementation["upstream_sha256"] == hashlib.sha256(
        UPSTREAM_TEXT.encode("utf-8")
    ).hexdigest()
    assert company.manifest.implementation["license_review_required"] is True
    assert (company.directory / "references" / "UPSTREAM_SKILL.md").read_text(
        encoding="utf-8"
    ) == UPSTREAM_TEXT

    registry = RuntimeSkillRegistry(discovered, promoted_only=True)
    assert registry.summary()["enabled"] == 0
    row = registry.catalog()[0]
    assert row["source"] == "qwen-dianjin"
    assert row["upstream_path"].endswith("SKILL.md")


def test_importer_replace_only_removes_generated_dianjin_packages(tmp_path: Path) -> None:
    source = tmp_path / "upstream"
    output = tmp_path / "skills"
    selected = "DianJin-SKILLS/investment-researcher/company-deep-analysis/SKILL.md"
    _write_source(source, selected)
    main(["--source-root", str(source), "--output-root", str(output), "--ref", "one"])

    unrelated = output / "dianjin" / "local-package"
    unrelated.mkdir(parents=True)
    (unrelated / "keep.txt").write_text("keep", encoding="utf-8")

    main([
        "--source-root", str(source),
        "--output-root", str(output),
        "--ref", "two",
        "--replace",
    ])

    assert unrelated.is_dir()
    generated = next(path for path in (output / "dianjin").iterdir() if "company-deep" in path.name)
    assert "Ref: `two`" in (generated / "PROVENANCE.md").read_text(encoding="utf-8")
