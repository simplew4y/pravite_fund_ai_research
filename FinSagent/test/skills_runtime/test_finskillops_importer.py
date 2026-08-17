import json
from pathlib import Path

import pytest

from scripts.import_finskillops_skills import audit_source, main
from skills_runtime.loader import SkillLoader
from skills_runtime.registry import RuntimeSkillRegistry


RECIPE = {
    "schema_version": "finskillops_portable_skill_recipe_v2",
    "kind": "portable_instruction_recipe",
    "subject": "issuer",
    "capability_summary": "Extract and verify a source-grounded financial value.",
    "applicability_conditions": ["The request concerns an issuer and a period."],
    "evidence_requirements": ["Use only provided source evidence."],
    "input_roles": ["metric", "period", "source_evidence"],
    "ordered_steps": [
        "Identify the metric and period requested for the issuer.",
        "Validate the value and preserve its unit.",
        "Return the value, unit, and source reference.",
    ],
    "output_roles": ["value", "unit", "source_reference"],
    "origin_family": "numeric_request",
}


def _metadata(path: Path, **overrides: object) -> Path:
    payload = {
        "tag_name": "v0.1.0",
        "draft": False,
        "prerelease": False,
        "repository_full_name": "YanzhangMa/finskillops-skill-seeds",
    }
    payload.update(overrides)
    path.write_text(json.dumps(payload), encoding="utf-8")
    return path


def test_release_import_compiles_private_experimental_package(tmp_path: Path) -> None:
    source = tmp_path / "source"
    recipe_path = source / "skills" / "verify-financial-numbers" / "skill-recipe.json"
    recipe_path.parent.mkdir(parents=True)
    recipe_path.write_text(json.dumps(RECIPE, ensure_ascii=False), encoding="utf-8")
    output = tmp_path / "output"

    assert main([
        "--source-root", str(source),
        "--release-metadata", str(_metadata(tmp_path / "release.json")),
        "--release-tag", "v0.1.0",
        "--output-root", str(output),
    ]) == 0

    skills = SkillLoader([output]).discover()
    assert len(skills) == 1
    skill = skills[0]
    assert skill.manifest.status == "experimental"
    assert skill.manifest.public is False
    assert skill.manifest.permissions.network is False
    assert skill.manifest.evidence_contract.same_company_required is True
    assert skill.manifest.implementation["release_only"] is True
    assert skill.manifest.implementation["upstream_ref"] == "v0.1.0"
    assert "active dataset and allowed doc_id set" in skill.instruction
    assert RuntimeSkillRegistry(skills, promoted_only=True).summary()["enabled"] == 0
    assert (skill.directory / "references" / "UPSTREAM_RECIPE.json").read_text(
        encoding="utf-8"
    ) == recipe_path.read_text(encoding="utf-8")


def test_candidate_zone_is_audited_but_never_imported(tmp_path: Path) -> None:
    source = tmp_path / "source"
    candidate = source / "candidates" / "proposed" / "seed_x" / "event_x"
    candidate.mkdir(parents=True)
    (candidate / "candidate-record.json").write_text(json.dumps({
        "status": "proposed", "payload_state": "included"
    }), encoding="utf-8")
    (candidate / "skill-recipe.json").write_text(json.dumps(RECIPE), encoding="utf-8")

    audit = audit_source(source)
    assert audit["candidate_records"] == 1
    assert audit["included_candidate_recipes"] == 1
    assert audit["normalized_release_recipes"] == 0
    with pytest.raises(SystemExit, match="contains no normalized recipes"):
        main([
            "--source-root", str(source),
            "--release-metadata", str(_metadata(tmp_path / "release.json")),
            "--output-root", str(tmp_path / "output"),
        ])


@pytest.mark.parametrize("field", ["draft", "prerelease"])
def test_unstable_github_release_is_rejected(tmp_path: Path, field: str) -> None:
    source = tmp_path / "source"
    recipe = source / "skills" / "one" / "skill-recipe.json"
    recipe.parent.mkdir(parents=True)
    recipe.write_text(json.dumps(RECIPE), encoding="utf-8")
    metadata = _metadata(tmp_path / "release.json", **{field: True})
    with pytest.raises(SystemExit, match=field):
        main([
            "--source-root", str(source),
            "--release-metadata", str(metadata),
            "--output-root", str(tmp_path / "output"),
        ])
