#!/usr/bin/env python3
"""Import released FinSkillOps portable recipes into FinSagent.

This consumer deliberately ignores ``inbox/``, ``candidates/`` and ``exports/``.
Only normalized recipes under ``skills/`` from a non-draft, non-prerelease
GitHub Release may become local, experimental FinSagent packages.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any

import yaml


UPSTREAM_REPOSITORY = "YanzhangMa/finskillops-skill-seeds"
UPSTREAM_URL = f"https://github.com/{UPSTREAM_REPOSITORY}"
IMPORT_CATEGORY = "finskillops"
ADAPTER_VERSION = "0.1.0"
RECIPE_SCHEMA = "finskillops_portable_skill_recipe_v2"


@dataclass(frozen=True)
class ReleasedRecipe:
    path: str
    payload: dict[str, Any]
    source_text: str

    @property
    def slug(self) -> str:
        parent = PurePosixPath(self.path).parent.name
        return _identifier(parent or PurePosixPath(self.path).stem)

    @property
    def skill_id(self) -> str:
        return _identifier(f"finskillops_{self.slug}")


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-root", type=Path)
    parser.add_argument("--release-metadata", type=Path)
    parser.add_argument("--release-tag")
    parser.add_argument(
        "--output-root",
        type=Path,
        default=Path(__file__).resolve().parents[1] / "skills",
    )
    parser.add_argument(
        "--cache-root",
        type=Path,
        default=Path("/tmp/finsagent-finskillops-cache"),
    )
    parser.add_argument("--audit-only", action="store_true")
    parser.add_argument("--replace", action="store_true")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv or sys.argv[1:])
    if args.audit_only:
        if not args.source_root:
            raise SystemExit("--audit-only requires --source-root")
        print(json.dumps(audit_source(args.source_root), ensure_ascii=False, sort_keys=True))
        return 0

    source_root, metadata = _resolve_release(args)
    tag = _validate_release_metadata(metadata, expected_tag=args.release_tag)
    recipes = _discover_released_recipes(source_root)
    if not recipes:
        raise SystemExit(
            f"release {tag!r} contains no normalized recipes under skills/; "
            "candidate and export zones are never imported"
        )

    target_root = args.output_root.resolve() / IMPORT_CATEGORY
    target_root.mkdir(parents=True, exist_ok=True)
    expected = {recipe.slug for recipe in recipes}
    if args.replace:
        _remove_stale_generated_packages(target_root, expected)
    for recipe in recipes:
        _write_package(target_root, recipe, tag=tag)

    print(f"Imported {len(recipes)} released FinSkillOps skills from {tag} into {target_root}")
    return 0


def audit_source(source_root: Path) -> dict[str, Any]:
    """Describe a checkout without making it runtime-discoverable."""
    root = source_root.resolve()
    records = []
    for path in sorted((root / "candidates").glob("*/*/*/candidate-record.json")):
        records.append(_read_json(path))
    return {
        "candidate_records": len(records),
        "candidate_statuses": _counts(str(row.get("status") or "unknown") for row in records),
        "included_candidate_recipes": sum(
            1 for row in records if row.get("payload_state") == "included"
        ),
        "withheld_candidates": sum(
            1 for row in records if str(row.get("payload_state") or "").startswith("withheld")
        ),
        "normalized_release_recipes": len(_recipe_paths(root / "skills")),
        "release_manifests": len(list((root / "releases").glob("*/manifest.json"))),
        "forbidden_runtime_zones": ["inbox", "candidates", "exports"],
    }


def _resolve_release(args: argparse.Namespace) -> tuple[Path, dict[str, Any]]:
    if args.source_root:
        if not args.release_metadata:
            raise SystemExit("offline import requires --release-metadata from the GitHub Releases API")
        return args.source_root.resolve(), _read_json(args.release_metadata)

    metadata = _github_release_metadata(args.release_tag)
    tag = _validate_release_metadata(metadata, expected_tag=args.release_tag)
    cache = args.cache_root.resolve() / _identifier(tag)
    if not cache.exists():
        cache.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run(
            ["gh", "repo", "clone", UPSTREAM_REPOSITORY, str(cache), "--", "--depth=1", "--branch", tag],
            check=True,
        )
    return cache, metadata


def _github_release_metadata(tag: str | None) -> dict[str, Any]:
    endpoint = (
        f"repos/{UPSTREAM_REPOSITORY}/releases/tags/{tag}"
        if tag else f"repos/{UPSTREAM_REPOSITORY}/releases/latest"
    )
    completed = subprocess.run(
        ["gh", "api", endpoint], check=True, capture_output=True, text=True
    )
    return json.loads(completed.stdout)


def _validate_release_metadata(metadata: dict[str, Any], *, expected_tag: str | None) -> str:
    if metadata.get("draft") is not False:
        raise SystemExit("draft GitHub Releases cannot be imported")
    if metadata.get("prerelease") is not False:
        raise SystemExit("prerelease GitHub Releases cannot be imported")
    tag = str(metadata.get("tag_name") or "").strip()
    if not tag:
        raise SystemExit("release metadata is missing tag_name")
    if expected_tag and tag != expected_tag:
        raise SystemExit(f"release tag mismatch: expected {expected_tag!r}, got {tag!r}")
    repository = str(metadata.get("repository_full_name") or UPSTREAM_REPOSITORY)
    if repository != UPSTREAM_REPOSITORY:
        raise SystemExit(f"unexpected release repository: {repository!r}")
    return tag


def _discover_released_recipes(source_root: Path) -> list[ReleasedRecipe]:
    root = source_root.resolve()
    skills_root = root / "skills"
    recipes = []
    for path in _recipe_paths(skills_root):
        resolved = path.resolve()
        if path.is_symlink() or skills_root.resolve() not in resolved.parents:
            raise SystemExit(f"unsafe recipe path: {path}")
        source_text = path.read_text(encoding="utf-8")
        payload = json.loads(source_text)
        _validate_recipe(payload, path)
        recipes.append(
            ReleasedRecipe(
                path=path.relative_to(root).as_posix(),
                payload=payload,
                source_text=source_text,
            )
        )
    slugs = [recipe.slug for recipe in recipes]
    if len(slugs) != len(set(slugs)):
        raise SystemExit("released recipe package names are not unique")
    return recipes


def _recipe_paths(skills_root: Path) -> list[Path]:
    if not skills_root.is_dir():
        return []
    return sorted(
        path for path in skills_root.rglob("*.json")
        if path.name in {"skill-recipe.json", "recipe.json"}
    )


def _validate_recipe(payload: Any, path: Path) -> None:
    if not isinstance(payload, dict):
        raise SystemExit(f"{path}: recipe must be an object")
    if payload.get("schema_version") != RECIPE_SCHEMA:
        raise SystemExit(f"{path}: unsupported recipe schema {payload.get('schema_version')!r}")
    kind = payload.get("kind")
    if kind not in {
        "portable_instruction_recipe", "numeric_request_recipe", "source_family_recipe"
    }:
        raise SystemExit(f"{path}: unsupported recipe kind {kind!r}")
    if payload.get("subject") != "issuer":
        raise SystemExit(f"{path}: only issuer-scoped recipes are supported")


def _write_package(root: Path, recipe: ReleasedRecipe, *, tag: str) -> None:
    package = root / recipe.slug
    package.mkdir(parents=True, exist_ok=True)
    references = package / "references"
    references.mkdir(exist_ok=True)
    recipe_sha = hashlib.sha256(recipe.source_text.encode("utf-8")).hexdigest()
    version = f"{ADAPTER_VERSION}+{_identifier(tag)}"
    manifest = {
        "schema_version": 1,
        "skill_id": recipe.skill_id,
        "version": version,
        "name": _title(recipe),
        "description": _summary(recipe),
        "category": IMPORT_CATEGORY,
        "type": "prompt",
        "phase": "pre_answer",
        "priority": 260,
        "status": "experimental",
        "owner": "finsagent",
        "agents": [],
        "routing": {"intents": [], "keywords": _routing_keywords(recipe)},
        "evidence_contract": {
            "company_scope_required": True,
            "same_company_required": True,
            "source_evidence_required": True,
            "allow_cross_company": False,
            "allow_actual_estimate_mix": False,
        },
        "implementation": {
            "kind": "prompt", "source": "finskillops-skill-seeds",
            "upstream_repository": UPSTREAM_URL, "upstream_ref": tag,
            "upstream_path": recipe.path, "upstream_sha256": recipe_sha,
            "adapter_version": ADAPTER_VERSION, "release_only": True,
            "max_instruction_chars": 6000,
        },
        "permissions": {
            "network": False, "filesystem_read": False,
            "filesystem_write": False, "external_tools": [],
        },
        "public": False,
        "governance": {
            "scope": "Released FinSkillOps portable recipe adapted to scoped Evidence Fusion.",
            "failure_types": ["wrong_source", "period_mismatch", "unsupported_claim"],
            "trigger": "Only after downstream routing evaluation and explicit allowlist promotion.",
            "inputs": ["question", "active_dataset", "retrieved_evidence"],
            "outputs": list(recipe.payload.get("output_roles") or ["supported_answer"]),
            "risks": [
                "Portable structural validation is not proof of downstream answer quality.",
                "The recipe must not broaden the active company or document scope.",
            ],
            "eval_sets": ["finskillops_release_candidate"],
            "local_changes": [
                "compiled portable JSON into a FinSagent prompt skill",
                "bound execution to active_dataset Evidence Fusion evidence",
                "disabled network, filesystem, and external tools",
            ],
        },
    }
    (package / "manifest.yaml").write_text(
        yaml.safe_dump(manifest, allow_unicode=True, sort_keys=False), encoding="utf-8"
    )
    (package / "SKILL.md").write_text(
        _compile_instruction(recipe, version=version), encoding="utf-8"
    )
    (references / "UPSTREAM_RECIPE.json").write_text(recipe.source_text, encoding="utf-8")
    (package / "PROVENANCE.md").write_text(
        "\n".join([
            "# FinSkillOps release provenance", "",
            f"- Repository: `{UPSTREAM_REPOSITORY}`", f"- GitHub Release: `{tag}`",
            f"- Path: `{recipe.path}`", f"- SHA256: `{recipe_sha}`",
            f"- Adapter: `{ADAPTER_VERSION}`", "",
            "This is a downstream FinSagent adaptation. Upstream candidate zones were not consumed.", "",
        ]), encoding="utf-8",
    )


def _compile_instruction(recipe: ReleasedRecipe, *, version: str) -> str:
    payload = recipe.payload
    lines = [
        "---", f"name: {recipe.skill_id}",
        f"version: {version}", "---", "",
        f"# {_title(recipe)}", "", _summary(recipe), "",
        "## FinSagent execution boundary", "",
        "- Use only evidence already admitted by the active dataset and allowed doc_id set.",
        "- Never retrieve, infer, or cite another company merely because it is semantically similar.",
        "- Preserve period, unit, currency, source, and actual/estimate labels.",
        "- If required evidence is missing or conflicting, state the gap; do not fabricate a value or conclusion.",
        "- This recipe has no network, filesystem, or external-tool authority.", "",
        "## Released portable workflow", "",
    ]
    if payload["kind"] == "portable_instruction_recipe":
        for index, step in enumerate(payload.get("ordered_steps") or [], start=1):
            lines.append(f"{index}. {_clean(step)}")
        requirements = payload.get("evidence_requirements") or []
        if requirements:
            lines.extend(["", "Evidence requirements:"])
            lines.extend(f"- {_clean(item)}" for item in requirements)
    elif payload["kind"] == "numeric_request_recipe":
        lines.extend([
            "1. Identify the requested metric, period, comparison basis, unit, value, and source span.",
            "2. Validate that the numeric value is explicitly supported by the admitted evidence.",
            "3. Return a concise numeric statement with period, unit, and source reference.",
        ])
        for slot in (payload.get("body") or {}).get("slots") or []:
            if isinstance(slot, dict) and slot.get("required"):
                lines.append(f"- Required role: `{_clean(slot.get('role'))}`")
    else:
        lines.extend([
            "1. Identify the requested issuer information and required evidence concepts.",
            "2. Include only claims supported by the admitted evidence.",
            "3. Return the supporting source reference; preserve the original answer if evidence is absent.",
        ])
    return "\n".join(lines).rstrip() + "\n"


def _title(recipe: ReleasedRecipe) -> str:
    return _summary(recipe)[:96] or recipe.slug.replace("_", " ").title()


def _summary(recipe: ReleasedRecipe) -> str:
    value = recipe.payload.get("capability_summary") or recipe.payload.get("capability") or recipe.slug
    return _clean(value)


def _routing_keywords(recipe: ReleasedRecipe) -> list[str]:
    payload = recipe.payload
    terms = [payload.get("capability_summary"), payload.get("capability"), payload.get("origin_family")]
    return [_clean(term) for term in terms if _clean(term)]


def _remove_stale_generated_packages(root: Path, expected: set[str]) -> None:
    for package in root.iterdir():
        if not package.is_dir() or package.name in expected:
            continue
        manifest = package / "manifest.yaml"
        if not manifest.is_file():
            continue
        payload = yaml.safe_load(manifest.read_text(encoding="utf-8")) or {}
        if (payload.get("implementation") or {}).get("source") == "finskillops-skill-seeds":
            shutil.rmtree(package)


def _read_json(path: Path) -> dict[str, Any]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise SystemExit(f"{path}: expected a JSON object")
    return payload


def _identifier(value: str) -> str:
    return re.sub(r"_+", "_", re.sub(r"[^a-zA-Z0-9]+", "_", value)).strip("_").lower()


def _clean(value: Any) -> str:
    return " ".join(str(value or "").split())


def _counts(values: Any) -> dict[str, int]:
    output: dict[str, int] = {}
    for value in values:
        output[value] = output.get(value, 0) + 1
    return output


if __name__ == "__main__":
    raise SystemExit(main())
