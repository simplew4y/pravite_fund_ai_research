#!/usr/bin/env python3
"""Import Qwen DianJin finance workflows as governed FinSagent candidates.

The importer keeps an exact upstream copy under ``references/`` for review, but
builds a bounded FinSagent-specific ``SKILL.md`` for runtime injection. Imported
packages are experimental, private, network-disabled, and therefore cannot be
activated by the production allowlist until they pass downstream evaluations.
"""

from __future__ import annotations

import argparse
import concurrent.futures
import hashlib
import json
import re
import shutil
import subprocess
import sys
import urllib.request
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Iterable

import yaml


UPSTREAM_REPOSITORY = "https://github.com/aliyun/qwen-dianjin"
DEFAULT_REF = "fd9b51167d6574470404b30e426bcb3357615f89"
ADAPTER_VERSION = "0.1.0"
IMPORT_CATEGORY = "dianjin"

# Securities / asset-management roles are imported in full. Cross-domain
# workflows are intentionally explicit so insurance and sales automation do not
# leak into a private-fund research product.
FULL_ROLES = {
    "investment-researcher",
    "investment-advisor",
    "financial-engineering-expert",
}
CROSS_DOMAIN_SKILLS = {
    "corporate-banker/pre-visit-plan",
    "corporate-banker/visit-memo",
    "corporate-banker/credit-due-diligence",
    "corporate-banker/credit-industry-analysis",
    "corporate-banker/equity-penetration-analysis",
    "corporate-banker/financial-report-analysis",
    "credit-review-expert/ai_risk_planning",
    "credit-review-expert/pre-visit-credit-analysis",
    "credit-review-expert/credit-case-intake-check",
    "credit-review-expert/credit-related-party-detection",
    "credit-risk-manager/credit-industry-rule-gen",
    "credit-risk-manager/credit-large-exposure-mgmt",
    "credit-risk-manager/credit-policy-analysis",
    "credit-risk-manager/credit-risk-cot",
    "credit-risk-manager/credit-risk-extraction",
    "credit-risk-manager/vlm-verifier",
    "wealth-copilot/L2-3_strategy/competitor-product-compare",
    "wealth-copilot/L2-4_qa/market-insight-qa",
    "wealth-copilot/L2-5_diagnosis/fund-deep-research",
    "wealth-copilot/L2-5_diagnosis/portfolio-health-check",
    "wealth-copilot/L2-5_diagnosis/portfolio-risk-radar",
    "wealth-copilot/L2-6_allocation/asset-allocation-optimizer",
    "wealth-copilot/L2-6_allocation/investment-simulation",
    "wealth-copilot/L2-6_allocation/smart-product-matching",
    "wealth-copilot/L2-8_companion/market-hotspot-digest",
    "wealth-copilot/L2-8_companion/portfolio-alert-narrator",
}

SECTION_PATTERN = re.compile(
    r"(执行流程|工作流程|workflow|输出格式|输出模板|报告结构|output|"
    r"约束条件|注意事项|分析原则|特殊场景|constraints?|gotchas?|踩坑)",
    re.IGNORECASE,
)
QUOTED_TRIGGER_PATTERN = re.compile(r"[\"“](.{2,32}?)[\"”]")
HEADING_PATTERN = re.compile(r"^(#{1,6})\s+(.+?)\s*$")
FORBIDDEN_RUNTIME_TOOLS = {
    "gildata-aidata": "上游外部金融数据服务",
    "asset-service": "上游工商数据服务",
    "web_search": "外部联网检索",
    "web_fetch": "外部网页读取",
    "message_notify_user": "上游消息发送工具",
    "finx": "上游工具命令",
}
CORE_INTENT_TERMS = (
    "公司深度分析", "投资价值分析", "公司一页纸", "业绩点评", "财报点评",
    "公告解读", "公告分析", "调研提纲", "行业深度分析", "行业一页纸",
    "宏观数据速览", "宏观政策分析", "宏观日报", "宏观周报", "宏观风险监测",
    "全球宏观联动", "宏观资产配置", "策略日报", "板块配置", "市场情绪监测",
    "市场趋势", "政策快评", "估值景气", "市场复盘", "金工日报", "金工周报",
    "因子表现", "策略回测", "另类因子", "资金面", "利率债", "城投债",
    "产业债", "可转债估值", "固收日报", "固收周报", "可比公司",
    "股票资金面", "股票行情", "股票技术面", "股东股本", "股票多因子",
    "基金多因子", "基金诊断", "市场热点", "财务报表分析", "财务分析",
    "尽职调查", "股权穿透", "关联方", "行业风险", "风险分析", "组合风险",
    "持仓诊断", "基金尽调", "资产配置", "投资收益模拟", "数据轮廓",
    "单变量分析", "特征分析", "模型解释", "模型对比", "自主实验",
)
ROUTING_ALIASES = {
    "announcement-analysis": ("公告", "重大公告", "解读公告", "公告解读", "公告分析"),
    "earnings-commentary-generator": ("业绩点评", "财报点评", "年报点评", "季报点评"),
    "company-deep-analysis": ("公司深度分析", "公司深度研究", "投资价值分析"),
    "company-one-page-analysis": ("公司一页纸", "一页纸分析", "一页纸报告"),
    "institutional-research-outline": ("调研提纲", "访谈提纲", "管理层问题"),
    "industry-deep-analysis": ("行业深度分析", "行业深度研究", "行业报告"),
    "industry-one-page-analysis": ("行业一页纸", "行业摘要"),
    "comparable-company-analysis": ("可比公司", "同业对比", "可比估值"),
    "financial-report-analysis": ("财报分析", "财务报表分析", "财务分析"),
    "credit-due-diligence": ("尽职调查", "公司尽调", "企业尽调"),
    "equity-penetration-analysis": ("股权穿透", "关联方分析", "实际控制人"),
    "fund-deep-research": ("基金尽调", "基金深度研究"),
    "portfolio-health-check": ("持仓诊断", "组合诊断", "组合健康"),
    "portfolio-risk-radar": ("组合风险", "持仓风险", "风险雷达"),
    "asset-allocation-optimizer": ("资产配置", "配置优化"),
}


@dataclass(frozen=True)
class UpstreamSkill:
    relative_path: str
    role: str
    slug: str
    source_text: str
    metadata: dict
    body: str

    @property
    def upstream_key(self) -> str:
        return str(PurePosixPath(self.relative_path).parent)

    @property
    def skill_id(self) -> str:
        return _identifier(f"dianjin_{self.role}_{self.slug}")

    @property
    def package_name(self) -> str:
        return f"{self.role}--{self.slug}"


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--catalog",
        type=Path,
        help="Optional text file containing upstream SKILL.md paths, one per line.",
    )
    parser.add_argument(
        "--output-root",
        type=Path,
        default=Path(__file__).resolve().parents[1] / "skills",
    )
    parser.add_argument("--source-root", type=Path)
    parser.add_argument(
        "--cache-root",
        type=Path,
        default=Path("/tmp/finsagent-dianjin-cache"),
        help="Resumable download cache outside the product worktree.",
    )
    parser.add_argument("--ref", default=DEFAULT_REF)
    parser.add_argument("--replace", action="store_true")
    parser.add_argument("--workers", type=int, default=8)
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv or sys.argv[1:])
    if args.catalog:
        catalog_paths = _catalog_paths(args.catalog)
    elif args.source_root:
        source_root = args.source_root.resolve()
        catalog_paths = [
            path.relative_to(source_root).as_posix()
            for path in source_root.rglob("SKILL.md")
        ]
    else:
        catalog_paths = _github_catalog(args.ref)
    selected_paths = [path for path in catalog_paths if _is_selected(path)]
    if not selected_paths:
        raise SystemExit("catalog contains no selected DianJin skills")

    texts = _read_sources(
        selected_paths,
        source_root=args.source_root,
        ref=args.ref,
        workers=max(1, args.workers),
        cache_root=args.cache_root,
    )
    skills = [_parse_skill(path, texts[path]) for path in selected_paths]
    target_root = args.output_root.resolve() / IMPORT_CATEGORY
    target_root.mkdir(parents=True, exist_ok=True)
    expected_packages = {skill.package_name for skill in skills}
    if args.replace:
        _remove_stale_generated_packages(target_root, expected_packages)
    for skill in skills:
        _write_package(target_root, skill, ref=args.ref)

    print(
        f"Imported {len(skills)} DianJin candidate skills from {args.ref} "
        f"into {target_root}"
    )
    return 0


def _catalog_paths(path: Path) -> list[str]:
    rows = []
    for raw in path.read_text(encoding="utf-8").splitlines():
        value = raw.strip()
        if value and not value.startswith("#") and value.endswith("/SKILL.md"):
            rows.append(value)
    return sorted(set(rows))


def _github_catalog(ref: str) -> list[str]:
    url = f"https://api.github.com/repos/aliyun/qwen-dianjin/git/trees/{ref}?recursive=1"
    request = urllib.request.Request(url, headers={"User-Agent": "FinSagent-SkillImporter/1"})
    with urllib.request.urlopen(request, timeout=120) as response:
        payload = json.loads(response.read().decode("utf-8"))
    if payload.get("truncated"):
        raise RuntimeError("GitHub tree response is truncated; use --catalog or --source-root")
    return sorted(
        str(row["path"])
        for row in payload.get("tree", [])
        if row.get("type") == "blob" and str(row.get("path") or "").endswith("/SKILL.md")
    )


def _is_selected(path: str) -> bool:
    parts = PurePosixPath(path).parts
    try:
        root_index = parts.index("DianJin-SKILLS")
    except ValueError:
        return False
    relative = parts[root_index + 1 : -1]
    if len(relative) < 2 or relative[-1] == "_template":
        return False
    role = relative[0]
    if role in FULL_ROLES:
        return True
    return "/".join(relative) in CROSS_DOMAIN_SKILLS


def _read_sources(
    paths: Iterable[str],
    *,
    source_root: Path | None,
    ref: str,
    workers: int,
    cache_root: Path,
) -> dict[str, str]:
    paths = list(paths)
    if source_root is not None:
        root = source_root.resolve()
        return {
            path: (root / path).read_text(encoding="utf-8")
            for path in paths
        }

    cache = cache_root.expanduser().resolve() / ref

    def fetch(path: str) -> tuple[str, str, bool]:
        cached_path = cache / path
        if cached_path.is_file():
            return path, cached_path.read_text(encoding="utf-8"), True
        # github.com/raw is materially more reliable from the deployment region
        # than raw.githubusercontent.com while still resolving the immutable ref.
        url = f"https://github.com/aliyun/qwen-dianjin/raw/{ref}/{path}"
        last_error: Exception | None = None
        for _attempt in range(3):
            try:
                completed = subprocess.run(
                    [
                        "curl", "--compressed", "--silent", "--show-error",
                        "--location", "--fail", "--max-time", "45", url,
                    ],
                    check=True,
                    capture_output=True,
                    timeout=50,
                )
                payload = completed.stdout
                text = payload.decode("utf-8")
                cached_path.parent.mkdir(parents=True, exist_ok=True)
                temporary = cached_path.with_suffix(cached_path.suffix + ".tmp")
                temporary.write_bytes(payload)
                temporary.replace(cached_path)
                return path, text, False
            except (subprocess.SubprocessError, UnicodeDecodeError) as exc:
                last_error = exc
        raise RuntimeError(f"failed to fetch {path}: {last_error}")

    output: dict[str, str] = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
        futures = [pool.submit(fetch, path) for path in paths]
        for index, future in enumerate(concurrent.futures.as_completed(futures), start=1):
            path, text, cached = future.result()
            output[path] = text
            state = "cached" if cached else "downloaded"
            print(f"[{index}/{len(paths)}] {state}: {path}", flush=True)
    return output


def _parse_skill(path: str, source_text: str) -> UpstreamSkill:
    metadata, body = _split_frontmatter(source_text)
    parts = PurePosixPath(path).parts
    root_index = parts.index("DianJin-SKILLS")
    role = parts[root_index + 1]
    slug = parts[-2]
    return UpstreamSkill(path, role, slug, source_text, metadata, body)


def _split_frontmatter(text: str) -> tuple[dict, str]:
    normalized = text.replace("\r\n", "\n")
    if not normalized.startswith("---\n"):
        return {}, normalized
    end = normalized.find("\n---", 4)
    if end < 0:
        return {}, normalized
    raw = normalized[4:end]
    payload = yaml.safe_load(raw) or {}
    return (payload if isinstance(payload, dict) else {}), normalized[end + 4 :].lstrip("\n")


def _write_package(root: Path, skill: UpstreamSkill, *, ref: str) -> None:
    package = root / skill.package_name
    references = package / "references"
    references.mkdir(parents=True, exist_ok=True)
    manifest = _manifest(skill, ref=ref)
    instruction = _runtime_instruction(skill, ref=ref)
    provenance = _provenance(skill, ref=ref)
    (package / "SKILL.md").write_text(instruction, encoding="utf-8")
    (package / "manifest.yaml").write_text(
        yaml.safe_dump(manifest, allow_unicode=True, sort_keys=False, width=100),
        encoding="utf-8",
    )
    (package / "PROVENANCE.md").write_text(provenance, encoding="utf-8")
    (references / "UPSTREAM_SKILL.md").write_text(skill.source_text, encoding="utf-8")


def _manifest(skill: UpstreamSkill, *, ref: str) -> dict:
    description = _sanitize_runtime_text(_description(skill))
    keywords = _routing_keywords(skill, description)
    contract = _evidence_contract(skill)
    return {
        "schema_version": 1,
        "skill_id": skill.skill_id,
        "version": ADAPTER_VERSION,
        "name": _display_name(skill),
        "description": description[:500],
        "category": "dianjin_finance",
        "type": "prompt",
        "phase": "pre_answer",
        "priority": 300,
        "status": "experimental",
        "owner": "finsagent-skillops",
        "agents": _agents(skill),
        "routing": {"keywords": keywords, "negative_keywords": []},
        "evidence_contract": contract,
        "implementation": {
            "kind": "prompt",
            "source": "qwen-dianjin",
            "upstream_repository": UPSTREAM_REPOSITORY,
            "upstream_ref": ref,
            "upstream_path": skill.relative_path,
            "upstream_sha256": _upstream_sha256(skill),
            "adapter_version": ADAPTER_VERSION,
            "max_instruction_chars": 9000,
            "external_tools_blocked": True,
            "license_review_required": True,
        },
        "permissions": {
            "network": False,
            "filesystem_read": False,
            "filesystem_write": False,
            "external_tools": [],
        },
        "public": False,
        "governance": {
            "scope": f"Adapted DianJin workflow for {skill.upstream_key}.",
            "failure_types": [
                "unsupported_external_tool",
                "missing_source_evidence",
                "cross_company_contamination",
                "prompt_overreach",
            ],
            "trigger": f"Candidate routing terms: {', '.join(keywords)}",
            "inputs": ["question", "active_dataset", "evidence_fusion_context"],
            "outputs": ["bounded_research_workflow_instruction"],
            "risks": [
                "Upstream external tools are unavailable unless explicitly mapped.",
                "Financial thresholds and recommendations require downstream review.",
                "The candidate must not override dataset or company evidence boundaries.",
                "Upstream repository licensing must be confirmed before product promotion.",
            ],
            "eval_sets": ["dianjin_candidate_routing_v1", "dianjin_evidence_grounding_v1"],
            "last_reviewed": "2026-08-09",
            "implementation_refs": [skill.relative_path, "scripts/import_dianjin_skills.py"],
            "notes": (
                f"Imported from {UPSTREAM_REPOSITORY}/tree/{ref}/{skill.relative_path}; "
                "installed for shadow evaluation, not production activation."
            ),
        },
    }


def _runtime_instruction(skill: UpstreamSkill, *, ref: str) -> str:
    compiled = _compile_sections(skill.body)
    safety = """## FinSagent execution boundary

- Treat this package as an analysis workflow, not as authorization to call tools.
- Use only evidence already returned by the active dataset's Evidence Fusion pipeline.
- Never broaden company or document scope and never mix another company's evidence.
- Upstream tool names, shell commands, web search, databases, and message actions are unavailable unless the FinSagent runtime explicitly supplies an audited adapter.
- Preserve metric qualifiers, periods, units, currencies, actual/estimate labels, source document IDs, pages, and chunk citations.
- If required evidence is absent or conflicting, state the gap; do not estimate, fabricate, or silently substitute public data.
- Recommendations, ratings, target prices, compliance decisions, or high-risk actions require human review.
"""
    return (
        "---\n"
        f"name: {skill.skill_id}\n"
        f"description: {_yaml_scalar(_sanitize_runtime_text(_description(skill))[:300])}\n"
        f"version: {ADAPTER_VERSION}\n"
        "category: dianjin_finance\n"
        "---\n\n"
        f"# {_display_name(skill)}\n\n"
        f"> Adapted from `{skill.upstream_key}` at `{ref[:12]}`. "
        "The exact upstream text is retained in `references/UPSTREAM_SKILL.md` for review.\n\n"
        f"{safety}\n"
        "## Adapted workflow\n\n"
        f"{compiled.rstrip()}\n"
    )


def _compile_sections(body: str) -> str:
    lines = body.splitlines()
    sections: list[tuple[str, list[str]]] = []
    current_heading = "Overview"
    current_lines: list[str] = []
    for line in lines:
        match = HEADING_PATTERN.match(line)
        if match:
            if current_lines:
                sections.append((current_heading, current_lines))
            current_heading = match.group(2).strip()
            current_lines = [line]
        else:
            current_lines.append(line)
    if current_lines:
        sections.append((current_heading, current_lines))

    chosen: list[str] = []
    overview = "\n".join(lines[: min(len(lines), 45)]).strip()
    if overview:
        chosen.append(overview[:2200])
    for heading, section_lines in sections:
        if SECTION_PATTERN.search(heading):
            text = "\n".join(section_lines).strip()
            if text and text not in chosen:
                chosen.append(text[:3500])
        if sum(len(item) for item in chosen) >= 8200:
            break
    compiled = "\n\n".join(chosen) or body[:8200]
    return _sanitize_runtime_text(compiled)[:8500].rstrip() + "\n"


def _sanitize_runtime_text(text: str) -> str:
    for tool, replacement in FORBIDDEN_RUNTIME_TOOLS.items():
        text = re.sub(re.escape(tool), replacement, text, flags=re.IGNORECASE)
    return "\n".join(line.rstrip() for line in text.splitlines())


def _routing_keywords(skill: UpstreamSkill, description: str) -> list[str]:
    candidates = list(ROUTING_ALIASES.get(skill.slug, ()))
    candidates.extend(match.strip() for match in QUOTED_TRIGGER_PATTERN.findall(description))
    heading = next(
        (match.group(2).strip() for line in skill.body.splitlines() if (match := HEADING_PATTERN.match(line))),
        "",
    )
    marker_match = re.search(r"当用户提到(.+?)时使用", description)
    if marker_match:
        candidates.extend(re.split(r"[、，,；;]", marker_match.group(1)))
    heading_variants = {
        heading,
        re.sub(r"\s*\([^)]*\)\s*", "", heading),
        re.sub(r"(?:报告)?(?:生成)?技能$|技能$", "", heading),
        re.sub(r"^上市公司", "公司", heading),
    }
    candidates.extend(sorted(value for value in heading_variants if value))
    candidates.extend(term for term in CORE_INTENT_TERMS if term in f"{description}\n{heading}")
    candidates.extend([skill.slug.replace("-", " "), _display_name(skill)])
    output: list[str] = []
    for value in candidates:
        value = re.sub(r"\s+", " ", value).strip(" ：:，,。.;；")
        if 2 <= len(value) <= 40 and value.lower() not in {item.lower() for item in output}:
            output.append(value)
    return output[:16]


def _evidence_contract(skill: UpstreamSkill) -> dict:
    key = skill.upstream_key.lower()
    cross_tokens = (
        "comparable", "industry", "sector", "macro", "market", "global",
        "fund-", "portfolio", "multi-factor", "factor", "bond", "allocation",
        "data-profiling", "model", "experiment", "feature", "univariate",
    )
    allow_cross_company = any(token in key for token in cross_tokens)
    allows_labeled_estimates = any(
        token in key
        for token in (
            "valuation", "company-deep", "earnings", "announcement", "comparable",
            "strategy", "allocation", "forecast", "prosperity",
        )
    )
    return {
        "company_scope_required": not allow_cross_company,
        "same_company_required": not allow_cross_company,
        # Business workflows intentionally compare periods and heterogeneous
        # metrics. Period/unit validation belongs to formula operands and the
        # verification skills, not to the complete report evidence bundle.
        "same_period_required": False,
        "comparable_period_required": "comparable" in key,
        "unit_required": False,
        "currency_required": False,
        "source_evidence_required": True,
        "allow_cross_company": allow_cross_company,
        "allow_actual_estimate_mix": allows_labeled_estimates,
    }


def _agents(skill: UpstreamSkill) -> list[str]:
    if skill.role == "financial-engineering-expert":
        return ["quant"]
    if skill.role == "investment-advisor":
        return ["market_researcher", "quant", "general"]
    if skill.role == "investment-researcher":
        key = skill.slug
        if any(token in key for token in ("quant", "factor", "backtest")):
            return ["quant", "market_researcher"]
        if any(token in key for token in ("macro", "market", "strategy", "sector", "global")):
            return ["market_researcher", "general"]
        return ["company_researcher", "market_researcher", "general"]
    if skill.role in {"credit-review-expert", "credit-risk-manager"}:
        return ["legal_risk", "company_researcher"]
    if skill.role == "wealth-copilot":
        return ["market_researcher", "quant", "general"]
    return ["company_researcher", "legal_risk", "general"]


def _description(skill: UpstreamSkill) -> str:
    value = str(skill.metadata.get("description") or "").strip()
    if value:
        return re.sub(r"\s+", " ", value)
    return f"Adapted Qwen DianJin workflow for {skill.slug.replace('-', ' ')}."


def _display_name(skill: UpstreamSkill) -> str:
    raw = str(skill.metadata.get("name") or "").strip()
    if raw and raw != skill.slug:
        return raw
    heading = next(
        (match.group(2).strip() for line in skill.body.splitlines() if (match := HEADING_PATTERN.match(line))),
        "",
    )
    return heading or skill.slug.replace("-", " ").title()


def _provenance(skill: UpstreamSkill, *, ref: str) -> str:
    return f"""# Provenance

- Source: {UPSTREAM_REPOSITORY}
- Ref: `{ref}`
- Path: `{skill.relative_path}`
- SHA256: `{_upstream_sha256(skill)}`
- Adapter: FinSagent DianJin importer `{ADAPTER_VERSION}`
- Imported status: experimental / shadow-evaluation only

The upstream text is preserved byte-for-byte in `references/UPSTREAM_SKILL.md`.
FinSagent-specific execution boundaries and tool restrictions live in `SKILL.md`.
Product-specific changes must remain downstream; update the exact upstream copy only
through the importer with a reviewed ref.
"""


def _remove_stale_generated_packages(root: Path, expected: set[str]) -> None:
    for package in root.iterdir():
        if not package.is_dir() or package.name in expected:
            continue
        provenance = package / "PROVENANCE.md"
        if provenance.is_file() and UPSTREAM_REPOSITORY in provenance.read_text(encoding="utf-8"):
            shutil.rmtree(package)


def _identifier(value: str) -> str:
    return re.sub(r"[^a-z0-9_]+", "_", value.lower().replace("-", "_")).strip("_")


def _upstream_sha256(skill: UpstreamSkill) -> str:
    return hashlib.sha256(skill.source_text.encode("utf-8")).hexdigest()


def _yaml_scalar(value: str) -> str:
    return json.dumps(value, ensure_ascii=False)


if __name__ == "__main__":
    raise SystemExit(main())
