"""Filesystem discovery for self-contained FinSagent skill packages."""

from __future__ import annotations

import hashlib
from pathlib import Path
from typing import Iterable

import yaml

from skills_runtime.models import RegisteredSkill, SkillManifest, SkillValidationError


class SkillLoader:
    def __init__(self, roots: Iterable[str | Path], *, strict: bool = True) -> None:
        self.roots = tuple(Path(root).expanduser().resolve() for root in roots)
        self.strict = strict
        self.errors: list[str] = []

    def discover(self) -> list[RegisteredSkill]:
        discovered: list[RegisteredSkill] = []
        self.errors = []
        for root in self.roots:
            if not root.exists():
                continue
            for manifest_path in sorted(root.glob("*/*/manifest.yaml")):
                try:
                    discovered.append(self._load_one(root, manifest_path))
                except Exception as exc:
                    message = f"{manifest_path}: {exc}"
                    self.errors.append(message)
                    if self.strict:
                        raise SkillValidationError(message) from exc
        return discovered

    def _load_one(self, root: Path, manifest_path: Path) -> RegisteredSkill:
        skill_dir = manifest_path.parent
        if skill_dir.is_symlink() or manifest_path.is_symlink():
            raise SkillValidationError("symlinked skill packages are not allowed")
        if root not in skill_dir.resolve().parents:
            raise SkillValidationError("skill directory escapes configured root")
        skill_md_path = skill_dir / "SKILL.md"
        if not skill_md_path.is_file() or skill_md_path.is_symlink():
            raise SkillValidationError("missing regular SKILL.md")

        payload = yaml.safe_load(manifest_path.read_text(encoding="utf-8"))
        manifest = SkillManifest.from_dict(payload, source=str(manifest_path))
        instruction = skill_md_path.read_text(encoding="utf-8")
        frontmatter = _parse_frontmatter(instruction, skill_md_path)
        front_name = str(frontmatter.get("name") or "").strip()
        front_version = str(frontmatter.get("version") or "").strip()
        accepted_names = {manifest.skill_id, manifest.skill_id.replace("_", "-")}
        if front_name not in accepted_names:
            raise SkillValidationError(
                f"SKILL.md name={front_name!r} does not match skill_id={manifest.skill_id!r}"
            )
        if front_version != manifest.version:
            raise SkillValidationError(
                f"SKILL.md version={front_version!r} does not match manifest version={manifest.version!r}"
            )
        return RegisteredSkill(
            manifest=manifest,
            directory=skill_dir,
            instruction=instruction,
            package_hash=_package_hash(skill_dir),
        )


def _parse_frontmatter(text: str, path: Path) -> dict:
    if not text.startswith("---\n"):
        raise SkillValidationError(f"{path}: SKILL.md must start with YAML frontmatter")
    try:
        _, raw, _body = text.split("---", 2)
    except ValueError as exc:
        raise SkillValidationError(f"{path}: malformed YAML frontmatter") from exc
    payload = yaml.safe_load(raw)
    if not isinstance(payload, dict):
        raise SkillValidationError(f"{path}: frontmatter must be a mapping")
    return payload


def _package_hash(skill_dir: Path) -> str:
    digest = hashlib.sha256()
    for path in sorted(p for p in skill_dir.rglob("*") if p.is_file() and not p.is_symlink()):
        digest.update(str(path.relative_to(skill_dir)).encode("utf-8"))
        digest.update(b"\0")
        digest.update(path.read_bytes())
        digest.update(b"\0")
    return digest.hexdigest()
