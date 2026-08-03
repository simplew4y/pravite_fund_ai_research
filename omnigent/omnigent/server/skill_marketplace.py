"""Search, install, list, and remove user-managed Agent Skills.

The marketplace is deliberately a server-side integration.  The browser never
writes files and an install request contains only the stable id of an item that
this process previously returned from SkillsMP.  Skill payloads are downloaded
from the corresponding public GitHub tree with strict path and size limits,
validated as an Omnigent ``SKILL.md`` bundle, and then moved atomically into the
user's ``.agents/skills`` directory.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import tempfile
import time
from collections import OrderedDict
from datetime import UTC, datetime
from pathlib import Path, PurePosixPath
from typing import Any
from urllib.parse import quote, unquote, urlparse

import httpx

from omnigent.errors import OmnigentError
from omnigent.spec.parser import _parse_skill

SKILLSMP_BASE_URL = "https://skillsmp.com"
MANIFEST_FILENAME = ".private-fund-marketplace.json"
MAX_SKILL_FILES = 250
MAX_SKILL_BYTES = 20 * 1024 * 1024
MAX_SINGLE_FILE_BYTES = 5 * 1024 * 1024
_CACHE_TTL_SECONDS = 10 * 60
_MAX_CACHE_ENTRIES = 128
_GITHUB_NAME_RE = re.compile(r"^[A-Za-z0-9_.-]+$")
_GITHUB_REF_RE = re.compile(r"^[A-Za-z0-9_.-]+$")
_SAFE_INSTALL_ID_RE = re.compile(r"[^a-z0-9-]+")


class SkillMarketplaceError(RuntimeError):
    """Expected marketplace/install failure with an HTTP-friendly status."""

    def __init__(self, message: str, *, code: str, status_code: int) -> None:
        super().__init__(message)
        self.code = code
        self.status_code = status_code


# Kept small on purpose: these make the settings page useful during a
# marketplace outage, while normal operation always uses live SkillsMP search.
_FINANCE_FALLBACK: tuple[dict[str, Any], ...] = (
    {
        "id": "anthropics-financial-services-dcf-model",
        "name": "dcf-model",
        "author": "anthropics",
        "description": (
            "Build a complete discounted cash-flow valuation model with projections, "
            "WACC, terminal value, and sensitivity analysis."
        ),
        "githubUrl": (
            "https://github.com/anthropics/financial-services/tree/main/"
            "plugins/agent-plugins/model-builder/skills/dcf-model"
        ),
        "skillUrl": "https://skillsmp.com/creators/anthropics/financial-services/skills-dcf-model",
        "stars": 33807,
        "updatedAt": 1777993098,
    },
    {
        "id": "anthropics-financial-services-datapack-builder",
        "name": "datapack-builder",
        "author": "anthropics",
        "description": (
            "Turn CIMs, offering memorandums, SEC filings, and other sources into "
            "investment-committee-ready financial data packs."
        ),
        "githubUrl": (
            "https://github.com/anthropics/financial-services/tree/main/"
            "plugins/vertical-plugins/investment-banking/skills/datapack-builder"
        ),
        "skillUrl": (
            "https://skillsmp.com/creators/anthropics/financial-services/"
            "plugins-vertical-plugins-investment-banking-skills-datapack-builder"
        ),
        "stars": 33807,
        "updatedAt": 1777993098,
    },
    {
        "id": "bytedance-deer-flow-consulting-analysis",
        "name": "consulting-analysis",
        "author": "bytedance",
        "description": (
            "Create structured market, industry, competitive, financial, and investment "
            "due-diligence reports."
        ),
        "githubUrl": (
            "https://github.com/bytedance/deer-flow/tree/main/skills/public/consulting-analysis"
        ),
        "skillUrl": (
            "https://skillsmp.com/creators/bytedance/deer-flow/skills-public-consulting-analysis"
        ),
        "stars": 77885,
        "updatedAt": 1772029523,
    },
    {
        "id": "hkuds-vibe-trading-edgar-sec-filings",
        "name": "edgar-sec-filings",
        "author": "HKUDS",
        "description": (
            "Analyze 10-K, 10-Q, 8-K, proxy statements, and Form 4 filings from SEC EDGAR."
        ),
        "githubUrl": (
            "https://github.com/HKUDS/Vibe-Trading/tree/main/agent/src/skills/edgar-sec-filings"
        ),
        "skillUrl": (
            "https://skillsmp.com/creators/hkuds/vibe-trading/agent-src-skills-edgar-sec-filings"
        ),
        "stars": 27819,
        "updatedAt": 1775713393,
    },
    {
        "id": "nousresearch-hermes-agent-excel-author",
        "name": "excel-author",
        "author": "NousResearch",
        "description": "Build auditable financial workbooks headlessly with openpyxl.",
        "githubUrl": (
            "https://github.com/NousResearch/hermes-agent/tree/main/"
            "optional-skills/finance/excel-author"
        ),
        "skillUrl": (
            "https://skillsmp.com/creators/nousresearch/hermes-agent/"
            "optional-skills-finance-excel-author"
        ),
        "stars": 220904,
        "updatedAt": 1784866036,
    },
)

_CHINESE_FINANCE_QUERIES: tuple[tuple[tuple[str, ...], str], ...] = (
    (("估值", "现金流", "dcf"), "DCF valuation"),
    (("尽调", "尽职调查"), "investment due diligence"),
    (("财报", "报表", "sec", "披露"), "SEC filings"),
    (("私募", "投资研究", "行业研究"), "investment research"),
    (("财务", "金融", "模型"), "financial analysis"),
)


def normalized_marketplace_query(query: str) -> str:
    """Map common Chinese finance searches to terms SkillsMP indexes well."""

    normalized = " ".join(query.strip().split())
    lowered = normalized.lower()
    for needles, replacement in _CHINESE_FINANCE_QUERIES:
        if any(needle in lowered for needle in needles):
            return replacement
    return normalized


def parse_github_tree_url(value: str) -> tuple[str, str, str, str]:
    """Validate a SkillsMP GitHub tree URL and return owner/repo/ref/path."""

    parsed = urlparse(value)
    if parsed.scheme != "https" or parsed.hostname not in {"github.com", "www.github.com"}:
        raise SkillMarketplaceError(
            "技能来源必须是公开的 GitHub HTTPS 地址。",
            code="unsupported_source",
            status_code=400,
        )
    segments = [unquote(part) for part in parsed.path.split("/") if part]
    if len(segments) < 5 or segments[2] != "tree":
        raise SkillMarketplaceError(
            "技能来源不是可安装的 GitHub 目录。",
            code="invalid_source",
            status_code=400,
        )
    owner, repo, ref = segments[0], segments[1].removesuffix(".git"), segments[3]
    skill_path = "/".join(segments[4:])
    if not _GITHUB_NAME_RE.fullmatch(owner) or not _GITHUB_NAME_RE.fullmatch(repo):
        raise SkillMarketplaceError(
            "GitHub 仓库名称无效。", code="invalid_source", status_code=400
        )
    # A slash-containing branch is ambiguous in a /tree/... URL without a
    # repository API lookup. SkillsMP currently indexes canonical main/master
    # trees; reject ambiguous refs instead of guessing the wrong subtree.
    if not _GITHUB_REF_RE.fullmatch(ref):
        raise SkillMarketplaceError(
            "GitHub 分支名称无效。", code="invalid_source", status_code=400
        )
    pure_path = PurePosixPath(skill_path)
    if (
        not skill_path
        or pure_path.is_absolute()
        or any(part in {"", ".", ".."} for part in pure_path.parts)
    ):
        raise SkillMarketplaceError(
            "GitHub 技能目录无效。", code="invalid_source", status_code=400
        )
    return owner, repo, ref, skill_path


def _safe_marketplace_item(raw: Any) -> dict[str, Any] | None:
    if not isinstance(raw, dict):
        return None
    required = ("id", "name", "description", "githubUrl")
    if any(not isinstance(raw.get(key), str) or not raw[key].strip() for key in required):
        return None
    try:
        parse_github_tree_url(raw["githubUrl"])
    except SkillMarketplaceError:
        return None
    return {
        "id": raw["id"].strip()[:500],
        "name": raw["name"].strip()[:200],
        "author": str(raw.get("author") or "GitHub").strip()[:200],
        "description": raw["description"].strip()[:4000],
        "githubUrl": raw["githubUrl"].strip(),
        "skillUrl": str(raw.get("skillUrl") or "").strip(),
        "stars": max(0, int(raw.get("stars") or 0)),
        "updatedAt": max(0, int(raw.get("updatedAt") or 0)),
    }


class SkillsMarketplaceClient:
    """Small cached client for the SkillsMP public search API."""

    def __init__(self, *, base_url: str | None = None) -> None:
        configured_url = (
            base_url or os.environ.get("SKILLS_MARKETPLACE_BASE_URL") or SKILLSMP_BASE_URL
        )
        self.base_url = configured_url.rstrip("/")
        self._cache: OrderedDict[str, tuple[float, dict[str, Any]]] = OrderedDict()
        self._catalog: dict[str, dict[str, Any]] = {}

    def catalog_item(self, marketplace_id: str) -> dict[str, Any] | None:
        item = self._catalog.get(marketplace_id)
        return dict(item) if item is not None else None

    def _fallback(self, query: str, *, page: int, limit: int) -> dict[str, Any]:
        terms = {part for part in re.split(r"\W+", query.lower()) if len(part) >= 2}
        matches = []
        for candidate in _FINANCE_FALLBACK:
            haystack = " ".join(
                str(candidate.get(key) or "") for key in ("name", "author", "description")
            ).lower()
            if not terms or any(term in haystack for term in terms):
                matches.append(dict(candidate))
        if not matches:
            matches = [dict(candidate) for candidate in _FINANCE_FALLBACK]
        start = (page - 1) * limit
        items = matches[start : start + limit]
        for item in items:
            self._catalog[item["id"]] = item
        return {
            "skills": items,
            "page": page,
            "limit": limit,
            "hasNext": start + limit < len(matches),
            "total": len(matches),
            "source": "curated-fallback",
            "warning": "技能市场暂时不可用，当前展示内置的金融技能精选。",
        }

    async def search(
        self,
        query: str,
        *,
        page: int = 1,
        limit: int = 12,
        language: str | None = None,
    ) -> dict[str, Any]:
        effective_query = normalized_marketplace_query(query)
        cache_key = json.dumps(
            [effective_query.lower(), page, limit, language or ""], separators=(",", ":")
        )
        cached = self._cache.get(cache_key)
        if cached is not None and time.monotonic() - cached[0] < _CACHE_TTL_SECONDS:
            self._cache.move_to_end(cache_key)
            return json.loads(json.dumps(cached[1]))

        params: dict[str, str | int] = {
            "q": effective_query,
            "page": page,
            "limit": limit,
            "sortBy": "stars",
        }
        if language:
            params["language"] = language
        headers = {"User-Agent": "PrivateFundWorkbench/0.3 (+https://skillsmp.com)"}
        api_key = os.environ.get("SKILLSMP_API_KEY", "").strip()
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"
        try:
            async with httpx.AsyncClient(
                timeout=httpx.Timeout(20.0, connect=8.0),
                follow_redirects=False,
                headers=headers,
            ) as client:
                response = await client.get(f"{self.base_url}/api/v1/skills/search", params=params)
            response.raise_for_status()
            payload = response.json()
            raw_data = payload.get("data") if isinstance(payload, dict) else None
            raw_skills = raw_data.get("skills") if isinstance(raw_data, dict) else None
            if not isinstance(raw_skills, list):
                raise ValueError("marketplace response is missing data.skills")
        except (httpx.HTTPError, ValueError, json.JSONDecodeError):
            return self._fallback(effective_query, page=page, limit=limit)

        items: list[dict[str, Any]] = []
        seen_sources: set[str] = set()
        for raw in raw_skills:
            item = _safe_marketplace_item(raw)
            if item is None or item["githubUrl"] in seen_sources:
                continue
            seen_sources.add(item["githubUrl"])
            items.append(item)
            self._catalog[item["id"]] = item

        pagination = raw_data.get("pagination")
        result = {
            "skills": items,
            "page": page,
            "limit": limit,
            "hasNext": bool(pagination.get("hasNext")) if isinstance(pagination, dict) else False,
            "total": int(pagination.get("total") or len(items))
            if isinstance(pagination, dict)
            else len(items),
            "source": "skillsmp",
            "warning": None,
        }
        self._cache[cache_key] = (time.monotonic(), result)
        self._cache.move_to_end(cache_key)
        while len(self._cache) > _MAX_CACHE_ENTRIES:
            self._cache.popitem(last=False)
        return json.loads(json.dumps(result))


def _github_headers() -> dict[str, str]:
    headers = {
        "Accept": "application/vnd.github+json",
        "User-Agent": "PrivateFundWorkbench/0.3",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    token = os.environ.get("GITHUB_TOKEN", "").strip()
    if token:
        headers["Authorization"] = f"Bearer {token}"
    return headers


def _safe_relative_file(path: PurePosixPath) -> Path:
    if path.is_absolute() or any(part in {"", ".", ".."} for part in path.parts):
        raise SkillMarketplaceError(
            "技能包含不安全的文件路径。", code="unsafe_skill", status_code=400
        )
    if path.name == MANIFEST_FILENAME or ".git" in path.parts:
        raise SkillMarketplaceError("技能包含保留文件。", code="unsafe_skill", status_code=400)
    return Path(*path.parts)


async def download_github_skill(
    github_url: str,
    destination: Path,
    *,
    client: httpx.AsyncClient | None = None,
) -> None:
    """Download one public GitHub tree into ``destination`` safely."""

    owner, repo, ref, skill_path = parse_github_tree_url(github_url)
    destination.mkdir(parents=True, exist_ok=True)
    owns_client = client is None
    active_client = client or httpx.AsyncClient(
        timeout=httpx.Timeout(30.0, connect=10.0),
        follow_redirects=False,
        headers=_github_headers(),
    )
    queue: list[tuple[str, PurePosixPath]] = [(skill_path, PurePosixPath("."))]
    file_count = 0
    total_bytes = 0
    try:
        while queue:
            remote_dir, relative_dir = queue.pop(0)
            api_path = quote(remote_dir, safe="/")
            try:
                response = await active_client.get(
                    f"https://api.github.com/repos/{owner}/{repo}/contents/{api_path}",
                    params={"ref": ref},
                )
                response.raise_for_status()
                entries = response.json()
            except (httpx.HTTPError, ValueError, json.JSONDecodeError) as exc:
                raise SkillMarketplaceError(
                    "无法从 GitHub 下载该技能，请稍后重试。",
                    code="github_unavailable",
                    status_code=502,
                ) from exc
            if not isinstance(entries, list):
                raise SkillMarketplaceError(
                    "GitHub 地址没有指向技能目录。",
                    code="invalid_source",
                    status_code=400,
                )
            for entry in entries:
                if not isinstance(entry, dict):
                    continue
                name = entry.get("name")
                entry_type = entry.get("type")
                if not isinstance(name, str) or not name:
                    continue
                relative = relative_dir / name
                safe_relative = _safe_relative_file(relative)
                if entry_type == "dir":
                    queue.append((f"{remote_dir}/{name}", relative))
                    continue
                if entry_type != "file":
                    raise SkillMarketplaceError(
                        "技能包含不支持的符号链接或子模块。",
                        code="unsafe_skill",
                        status_code=400,
                    )
                file_count += 1
                declared_size = int(entry.get("size") or 0)
                if (
                    file_count > MAX_SKILL_FILES
                    or declared_size < 0
                    or declared_size > MAX_SINGLE_FILE_BYTES
                    or total_bytes + declared_size > MAX_SKILL_BYTES
                ):
                    raise SkillMarketplaceError(
                        "技能文件过多或总体积超过 20 MB 限制。",
                        code="skill_too_large",
                        status_code=400,
                    )
                download_url = entry.get("download_url")
                parsed_download = urlparse(download_url) if isinstance(download_url, str) else None
                if (
                    parsed_download is None
                    or parsed_download.scheme != "https"
                    or parsed_download.hostname != "raw.githubusercontent.com"
                ):
                    raise SkillMarketplaceError(
                        "技能文件下载地址无效。",
                        code="invalid_source",
                        status_code=400,
                    )
                try:
                    file_response = await active_client.get(download_url)
                    file_response.raise_for_status()
                except httpx.HTTPError as exc:
                    raise SkillMarketplaceError(
                        "GitHub 技能文件下载失败，请稍后重试。",
                        code="github_unavailable",
                        status_code=502,
                    ) from exc
                contents = file_response.content
                if (
                    len(contents) > MAX_SINGLE_FILE_BYTES
                    or total_bytes + len(contents) > MAX_SKILL_BYTES
                ):
                    raise SkillMarketplaceError(
                        "技能总体积超过 20 MB 限制。",
                        code="skill_too_large",
                        status_code=400,
                    )
                total_bytes += len(contents)
                target = destination / safe_relative
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(contents)
    finally:
        if owns_client:
            await active_client.aclose()

    if file_count == 0 or not (destination / "SKILL.md").is_file():
        raise SkillMarketplaceError(
            "该目录不包含有效的 SKILL.md。", code="invalid_skill", status_code=400
        )


def _install_id(name: str, marketplace_id: str) -> str:
    slug = name.strip().lower().replace("_", "-")
    slug = _SAFE_INSTALL_ID_RE.sub("-", slug).strip("-")[:64]
    if not slug:
        slug = f"skill-{hashlib.sha256(marketplace_id.encode()).hexdigest()[:12]}"
    return slug


def _skill_digest(root: Path) -> str:
    digest = hashlib.sha256()
    for file_path in sorted(path for path in root.rglob("*") if path.is_file()):
        relative = file_path.relative_to(root).as_posix()
        if relative == MANIFEST_FILENAME:
            continue
        digest.update(relative.encode("utf-8"))
        digest.update(b"\0")
        digest.update(file_path.read_bytes())
        digest.update(b"\0")
    return digest.hexdigest()


def _read_manifest(skill_dir: Path) -> dict[str, Any] | None:
    path = skill_dir / MANIFEST_FILENAME
    try:
        parsed = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError, json.JSONDecodeError):
        return None
    return parsed if isinstance(parsed, dict) else None


def list_installed_skills(skills_root: Path) -> list[dict[str, Any]]:
    """Return every valid skill in the selected user's managed root."""

    if not skills_root.is_dir():
        return []
    installed: list[dict[str, Any]] = []
    try:
        entries = sorted(skills_root.iterdir())
    except OSError:
        return []
    for skill_dir in entries:
        if (
            skill_dir.is_symlink()
            or not skill_dir.is_dir()
            or not (skill_dir / "SKILL.md").is_file()
        ):
            continue
        try:
            spec = _parse_skill(skill_dir / "SKILL.md")
        except (OmnigentError, OSError):
            continue
        manifest = _read_manifest(skill_dir) or {}
        installed.append(
            {
                "installId": skill_dir.name,
                "name": spec.name,
                "description": spec.description,
                "marketplaceId": manifest.get("marketplaceId"),
                "author": manifest.get("author"),
                "githubUrl": manifest.get("githubUrl"),
                "skillUrl": manifest.get("skillUrl"),
                "installedAt": manifest.get("installedAt"),
                "contentHash": manifest.get("contentHash"),
                "managed": bool(manifest.get("marketplaceId")),
            }
        )
    installed.sort(
        key=lambda item: (str(item.get("installedAt") or ""), item["name"]),
        reverse=True,
    )
    return installed


async def install_marketplace_skill(
    item: dict[str, Any],
    skills_root: Path,
    *,
    client: httpx.AsyncClient | None = None,
) -> dict[str, Any]:
    """Download, validate, and atomically install one catalog item."""

    safe_item = _safe_marketplace_item(item)
    if safe_item is None:
        raise SkillMarketplaceError(
            "技能市场条目无效，请重新搜索。", code="invalid_catalog_item", status_code=400
        )
    skills_root.mkdir(parents=True, exist_ok=True, mode=0o700)
    root = skills_root.resolve()
    temp_path = Path(tempfile.mkdtemp(prefix=".skill-install-", dir=root))
    try:
        await download_github_skill(safe_item["githubUrl"], temp_path, client=client)
        try:
            spec = _parse_skill(temp_path / "SKILL.md")
        except (OmnigentError, OSError) as exc:
            raise SkillMarketplaceError(
                "技能的 SKILL.md 格式无效。", code="invalid_skill", status_code=400
            ) from exc
        install_id = _install_id(spec.name, safe_item["id"])
        target = (root / install_id).resolve()
        if target.parent != root:
            raise SkillMarketplaceError("技能安装目录无效。", code="unsafe_skill", status_code=400)
        if target.exists():
            existing = _read_manifest(target)
            if existing and existing.get("marketplaceId") == safe_item["id"]:
                raise SkillMarketplaceError(
                    "该技能已经安装。", code="already_installed", status_code=409
                )
            raise SkillMarketplaceError(
                f"已存在同名技能“{spec.name}”，为避免覆盖未执行安装。",
                code="name_conflict",
                status_code=409,
            )
        installed_at = datetime.now(UTC).isoformat()
        manifest = {
            "schemaVersion": 1,
            "marketplace": "skillsmp",
            "marketplaceId": safe_item["id"],
            "marketplaceName": safe_item["name"],
            "name": spec.name,
            "description": spec.description,
            "author": safe_item["author"],
            "githubUrl": safe_item["githubUrl"],
            "skillUrl": safe_item["skillUrl"],
            "installedAt": installed_at,
            "contentHash": _skill_digest(temp_path),
        }
        (temp_path / MANIFEST_FILENAME).write_text(
            json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        for directory in (path for path in temp_path.rglob("*") if path.is_dir()):
            directory.chmod(0o700)
        for file_path in (path for path in temp_path.rglob("*") if path.is_file()):
            file_path.chmod(0o600)
        temp_path.chmod(0o700)
        temp_path.replace(target)
        return {
            "installId": install_id,
            "name": spec.name,
            "description": spec.description,
            "marketplaceId": safe_item["id"],
            "author": safe_item["author"],
            "githubUrl": safe_item["githubUrl"],
            "skillUrl": safe_item["skillUrl"],
            "installedAt": installed_at,
            "contentHash": manifest["contentHash"],
            "managed": True,
        }
    finally:
        if temp_path.exists():
            shutil.rmtree(temp_path)


def uninstall_skill(skills_root: Path, install_id: str) -> dict[str, str]:
    """Remove exactly one installed skill directory from ``skills_root``."""

    if not install_id or install_id in {".", ".."} or "/" in install_id or "\\" in install_id:
        raise SkillMarketplaceError("技能标识无效。", code="invalid_install_id", status_code=400)
    root = skills_root.resolve()
    target = (root / install_id).resolve()
    if target.parent != root or target.is_symlink():
        raise SkillMarketplaceError("技能目录无效。", code="invalid_install_id", status_code=400)
    if not target.is_dir() or not (target / "SKILL.md").is_file():
        raise SkillMarketplaceError(
            "没有找到这个已安装技能。", code="skill_not_found", status_code=404
        )
    shutil.rmtree(target)
    return {"installId": install_id, "status": "uninstalled"}
