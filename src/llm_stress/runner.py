"""Evidence-aware pressure and quality testing for OpenAI-compatible LLMs.

The runner intentionally uses only read-only private-fund tool schemas. Tool
results are simulated locally, so a load run cannot mutate production data.
"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import csv
import json
import math
import os
import platform
import random
import re
import secrets
import sqlite3
import subprocess
import sys
import time
import zipfile
from collections import defaultdict
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

import httpx
import yaml

ROOT_DIR = Path(__file__).resolve().parents[2]
DEFAULT_GOLDEN_CASES = ROOT_DIR / "test" / "llm_stress" / "golden_cases.jsonl"
DEFAULT_TOOL_CASES = ROOT_DIR / "test" / "llm_stress" / "tool_cases.jsonl"
DEFAULT_CONFIG = ROOT_DIR / "FinSagent" / "config" / "production.yaml"
DEFAULT_OUTPUT_ROOT = ROOT_DIR / "output" / "llm_stress_runs"

CITATION_RE = re.compile(r"\[((?:chunk|fact|cell|page):[^\]\s]+)\]")
REQUEST_NONCE_RE = re.compile(r"\[request:([a-zA-Z0-9_-]+)\]")
CHINESE_RE = re.compile(r"[\u3400-\u9fff]")
REASONING_PATTERNS = (
    re.compile(r"<\/?think>", re.IGNORECASE),
    re.compile(r"here(?:'|’)s a thinking process", re.IGNORECASE),
    re.compile(r"\bwe need (?:to )?(?:answer|analy[sz]e|reason)\b", re.IGNORECASE),
    re.compile(r"(?:让我|我需要)(?:先)?(?:分析|思考|推理)"),
    re.compile(r"(?:思考过程|推理过程)[:：]"),
)
TOOL_BLOCKED_PATTERNS = (
    "auto tool choice",
    "tool-call-parser",
    "tool call parser",
    "enable-auto-tool-choice",
    "does not support tools",
)


READ_ONLY_TOOL_SCHEMAS: list[dict[str, Any]] = [
    {
        "type": "function",
        "function": {
            "name": "private_fund_dataset_status",
            "description": "检查指定私募研究数据集的就绪状态、文档与索引覆盖。",
            "parameters": {
                "type": "object",
                "properties": {
                    "dataset_id": {"type": "string", "description": "数据集 ID"}
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "private_fund_dataset_search",
            "description": "在私募研究数据集中检索 PDF、Excel 与指标证据。",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "检索问题"},
                    "dataset_id": {"type": "string", "description": "数据集 ID"},
                    "top_k": {"type": "integer", "minimum": 1, "maximum": 20},
                    "include_metric_facts": {"type": "boolean"},
                },
                "required": ["query"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "private_fund_source_detail",
            "description": "根据 evidence_id 打开原文、页码或 Excel 单元格上下文。",
            "parameters": {
                "type": "object",
                "properties": {
                    "evidence_id": {"type": "string", "description": "证据 ID"},
                    "dataset_id": {"type": "string", "description": "数据集 ID"},
                    "context_radius": {"type": "integer", "minimum": 0, "maximum": 10},
                },
                "required": ["evidence_id"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "private_fund_tracking_list",
            "description": "读取当前风险、催化剂、假设、提醒和后台任务状态。",
            "parameters": {
                "type": "object",
                "properties": {
                    "dataset_id": {"type": "string", "description": "数据集 ID"},
                    "view": {"type": "string"},
                    "item_type": {"type": "string"},
                    "status": {"type": "string"},
                },
                "required": ["dataset_id"],
            },
        },
    },
]


@dataclass(frozen=True)
class Target:
    name: str
    base_url: str
    model: str
    api_key: str
    enable_thinking: bool | None = None

    def safe_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "base_url": self.base_url,
            "model": self.model,
            "api_key_configured": bool(self.api_key),
            "enable_thinking": self.enable_thinking,
        }


class ArtifactStore:
    """Append-only local artifact writer with restrictive permissions."""

    def __init__(self, output_root: Path, run_id: str) -> None:
        self.run_dir = output_root.resolve() / run_id
        self.responses_dir = self.run_dir / "responses"
        self.stream_dir = self.run_dir / "stream_chunks"
        self.tool_dir = self.run_dir / "tool_traces"
        for path in (self.run_dir, self.responses_dir, self.stream_dir, self.tool_dir):
            path.mkdir(parents=True, exist_ok=True)
            path.chmod(0o700)
        self._lock = asyncio.Lock()

    @staticmethod
    def _json_text(value: Any) -> str:
        return json.dumps(value, ensure_ascii=False, sort_keys=True, default=str)

    @staticmethod
    def _secure(path: Path) -> None:
        path.chmod(0o600)

    def write_json(self, relative: str, value: Any) -> Path:
        path = self.run_dir / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True, default=str) + "\n",
            encoding="utf-8",
        )
        self._secure(path)
        return path

    def write_text(self, relative: str, value: str) -> Path:
        path = self.run_dir / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(value, encoding="utf-8")
        self._secure(path)
        return path

    async def append_jsonl(self, relative: str, value: Any) -> Path:
        path = self.run_dir / relative
        async with self._lock:
            with path.open("a", encoding="utf-8") as handle:
                handle.write(self._json_text(value) + "\n")
            self._secure(path)
        return path

    async def save_response(self, request_id: str, value: Any) -> Path:
        async with self._lock:
            path = self.responses_dir / f"{request_id}.json"
            path.write_text(
                json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True, default=str)
                + "\n",
                encoding="utf-8",
            )
            self._secure(path)
        return path

    async def save_tool_trace(self, request_id: str, value: Any) -> Path:
        async with self._lock:
            path = self.tool_dir / f"{request_id}.json"
            path.write_text(
                json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True, default=str)
                + "\n",
                encoding="utf-8",
            )
            self._secure(path)
        return path


def utc_iso(epoch: float | None = None) -> str:
    value = time.time() if epoch is None else epoch
    return datetime.fromtimestamp(value).astimezone().isoformat(timespec="milliseconds")


def percentile(values: Sequence[float], quantile: float) -> float | None:
    """Return an interpolated percentile without requiring NumPy."""

    if not values:
        return None
    ordered = sorted(float(value) for value in values)
    if len(ordered) == 1:
        return ordered[0]
    position = min(1.0, max(0.0, quantile)) * (len(ordered) - 1)
    lower = math.floor(position)
    upper = math.ceil(position)
    if lower == upper:
        return ordered[lower]
    fraction = position - lower
    return ordered[lower] * (1 - fraction) + ordered[upper] * fraction


def extract_json_object(text: str) -> dict[str, Any] | None:
    """Extract a JSON object, accepting a fenced response but no trailing prose."""

    stripped = text.strip()
    fenced = re.fullmatch(r"```(?:json)?\s*(.*?)\s*```", stripped, re.DOTALL | re.IGNORECASE)
    if fenced:
        stripped = fenced.group(1).strip()
    try:
        value = json.loads(stripped)
    except json.JSONDecodeError:
        return None
    return value if isinstance(value, dict) else None


def _check(name: str, passed: bool, detail: Any = None) -> dict[str, Any]:
    return {"name": name, "passed": bool(passed), "detail": detail}


def score_content(content: str, case: dict[str, Any], nonce: str) -> dict[str, Any]:
    """Apply deterministic instruction, citation and leakage checks."""

    expected = dict(case.get("expect") or {})
    checks: list[dict[str, Any]] = []
    checks.append(_check("non_empty", bool(content.strip()), len(content)))

    parsed_json: dict[str, Any] | None = None
    if expected.get("json"):
        parsed_json = extract_json_object(content)
        checks.append(_check("valid_json_object", parsed_json is not None))
        if parsed_json is not None:
            exact_keys = expected.get("exact_json_keys")
            if exact_keys:
                checks.append(
                    _check(
                        "exact_json_keys",
                        set(parsed_json) == set(exact_keys),
                        {"actual": sorted(parsed_json), "expected": sorted(exact_keys)},
                    )
                )
            for key, wanted in (expected.get("json_values") or {}).items():
                checks.append(
                    _check(
                        f"json_value:{key}",
                        parsed_json.get(key) == wanted,
                        {"actual": parsed_json.get(key), "expected": wanted},
                    )
                )
            checks.append(
                _check(
                    "request_nonce",
                    parsed_json.get("request_nonce") == nonce,
                    parsed_json.get("request_nonce"),
                )
            )
            claim_contract = expected.get("claim_contract")
            if isinstance(claim_contract, dict):
                raw_claims = parsed_json.get("claims")
                claims = raw_claims if isinstance(raw_claims, list) else []
                required_claim_keys = {"claim_id", "text", "status", "evidence_ids"}
                valid_structure = bool(claims) and all(
                    isinstance(claim, dict)
                    and required_claim_keys.issubset(claim)
                    and isinstance(claim.get("evidence_ids"), list)
                    for claim in claims
                )
                checks.append(
                    _check(
                        "claim_contract_structure",
                        valid_structure,
                        len(claims),
                    )
                )
                if valid_structure:
                    statuses = {str(claim.get("status") or "") for claim in claims}
                    claim_evidence_ids = {
                        str(evidence_id)
                        for claim in claims
                        for evidence_id in claim.get("evidence_ids") or []
                    }
                    required_claim_ids = set(
                        claim_contract.get("required_evidence_ids") or []
                    )
                    allowed_claim_ids = set(
                        claim_contract.get("allowed_evidence_ids") or []
                    )
                    supported_have_evidence = all(
                        claim.get("status") != "supported"
                        or bool(claim.get("evidence_ids"))
                        for claim in claims
                    )
                    text_has_citation_syntax = any(
                        CITATION_RE.search(str(claim.get("text") or ""))
                        for claim in claims
                    )
                    checks.extend(
                        [
                            _check(
                                "claim_statuses",
                                statuses.issubset(
                                    {"supported", "not_covered", "needs_review"}
                                ),
                                sorted(statuses),
                            ),
                            _check(
                                "supported_claim_evidence",
                                supported_have_evidence,
                            ),
                            _check(
                                "claim_required_evidence",
                                required_claim_ids.issubset(claim_evidence_ids),
                                {
                                    "actual": sorted(claim_evidence_ids),
                                    "required": sorted(required_claim_ids),
                                },
                            ),
                            _check(
                                "claim_evidence_allowlist",
                                not allowed_claim_ids
                                or claim_evidence_ids.issubset(allowed_claim_ids),
                                {
                                    "actual": sorted(claim_evidence_ids),
                                    "allowed": sorted(allowed_claim_ids),
                                },
                            ),
                            _check(
                                "claim_text_without_citation_syntax",
                                not text_has_citation_syntax,
                            ),
                        ]
                    )
    else:
        wanted_token = f"[request:{nonce}]"
        checks.append(
            _check("request_nonce", content.count(wanted_token) == 1, content.count(wanted_token))
        )
        foreign_nonces = sorted(
            {found for found in REQUEST_NONCE_RE.findall(content) if found != nonce}
        )
        checks.append(_check("no_foreign_nonce", not foreign_nonces, foreign_nonces))

    for required in expected.get("contains", []):
        checks.append(_check(f"contains:{required}", str(required) in content))
    for forbidden in expected.get("forbidden", []):
        checks.append(_check(f"forbidden:{forbidden}", str(forbidden) not in content))

    if expected.get("require_chinese"):
        checks.append(_check("contains_chinese", CHINESE_RE.search(content) is not None))
    if expected.get("max_lines"):
        line_count = len([line for line in content.splitlines() if line.strip()])
        checks.append(
            _check("max_lines", line_count <= int(expected["max_lines"]), line_count)
        )
    if expected.get("no_reasoning"):
        leaked = [pattern.pattern for pattern in REASONING_PATTERNS if pattern.search(content)]
        checks.append(_check("no_reasoning_leak", not leaked, leaked))

    citations = CITATION_RE.findall(content)
    citation_set = set(citations)
    required_ids = set(expected.get("required_evidence_ids") or [])
    allowed_ids = set(expected.get("allowed_evidence_ids") or [])
    forbidden_ids = set(expected.get("forbidden_evidence_ids") or [])
    if required_ids:
        checks.append(
            _check(
                "required_citations",
                required_ids.issubset(citation_set),
                {"actual": sorted(citation_set), "required": sorted(required_ids)},
            )
        )
    if allowed_ids:
        checks.append(
            _check(
                "citation_allowlist",
                citation_set.issubset(allowed_ids),
                {"actual": sorted(citation_set), "allowed": sorted(allowed_ids)},
            )
        )
    if forbidden_ids:
        checks.append(
            _check(
                "forbidden_citations",
                not citation_set.intersection(forbidden_ids),
                sorted(citation_set.intersection(forbidden_ids)),
            )
        )
    if "min_citations" in expected:
        checks.append(
            _check(
                "min_citations",
                len(citation_set) >= int(expected["min_citations"]),
                len(citation_set),
            )
        )

    failed = [item["name"] for item in checks if not item["passed"]]
    return {
        "passed": not failed,
        "score": sum(item["passed"] for item in checks) / max(1, len(checks)),
        "checks": checks,
        "failed_checks": failed,
        "citations": citations,
        "parsed_json": parsed_json,
    }


def _argument_matches(actual: Any, expected: Any) -> bool:
    if isinstance(expected, dict):
        return isinstance(actual, dict) and all(
            key in actual and _argument_matches(actual[key], value)
            for key, value in expected.items()
        )
    if isinstance(expected, list):
        return isinstance(actual, list) and actual == expected
    return actual == expected


def score_tool_trace(trace: dict[str, Any], case: dict[str, Any]) -> dict[str, Any]:
    expected_tools = list(case.get("expected_tools") or [])
    expected_args = list(case.get("expected_args") or [])
    calls = list(trace.get("calls") or [])
    names = [str(call.get("name") or "") for call in calls]
    matched_indexes: list[int] = []
    search_from = 0
    for expected_name in expected_tools:
        try:
            matched_index = names.index(expected_name, search_from)
        except ValueError:
            matched_indexes = []
            break
        matched_indexes.append(matched_index)
        search_from = matched_index + 1

    sequence_mode = str(case.get("tool_sequence_mode") or "exact")
    allowed_extra_tools = {
        str(name) for name in (case.get("allowed_extra_tools") or [])
    }
    matched_index_set = set(matched_indexes)
    extra_calls = [
        {"index": index, "name": name}
        for index, name in enumerate(names)
        if index not in matched_index_set
    ]
    unexpected_extra_calls = [
        item for item in extra_calls if item["name"] not in allowed_extra_tools
    ]
    if sequence_mode == "ordered":
        sequence_passed = (
            len(matched_indexes) == len(expected_tools) and not unexpected_extra_calls
        )
    else:
        sequence_passed = names == expected_tools
    checks = [
        _check(
            "tool_sequence",
            sequence_passed,
            {
                "actual": names,
                "expected": expected_tools,
                "mode": sequence_mode,
                "allowed_extra_tools": sorted(allowed_extra_tools),
                "unexpected_extra_calls": unexpected_extra_calls,
            },
        )
    ]
    for index, expected in enumerate(expected_args):
        matched_index = (
            matched_indexes[index] if index < len(matched_indexes) else None
        )
        actual = (
            calls[matched_index].get("arguments")
            if matched_index is not None and matched_index < len(calls)
            else None
        )
        checks.append(
            _check(
                f"tool_arguments:{index}",
                _argument_matches(actual, expected),
                {
                    "actual": actual,
                    "expected": expected,
                    "matched_call_index": matched_index,
                },
            )
        )
    for required in case.get("contains", []):
        checks.append(
            _check(f"final_contains:{required}", str(required) in str(trace.get("final_content")))
        )
    failed = [item["name"] for item in checks if not item["passed"]]
    return {
        "passed": not failed,
        "score": sum(item["passed"] for item in checks) / max(1, len(checks)),
        "checks": checks,
        "failed_checks": failed,
        "matched_call_indexes": matched_indexes,
        "extra_calls": extra_calls,
    }


def load_jsonl(path: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    with path.open(encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, start=1):
            stripped = line.strip()
            if not stripped or stripped.startswith("#"):
                continue
            try:
                value = json.loads(stripped)
            except json.JSONDecodeError as exc:
                raise ValueError(f"Invalid JSONL at {path}:{line_number}: {exc}") from exc
            if not isinstance(value, dict) or not value.get("id"):
                raise ValueError(f"Case at {path}:{line_number} needs an id")
            rows.append(value)
    return rows


def load_real_evidence_cases(limit: int) -> list[dict[str, Any]]:
    """Build read-only grounding cases from current local collection databases."""

    if limit <= 0:
        return []
    cases: list[dict[str, Any]] = []
    pattern = ROOT_DIR / "output" / "private_fund_datasets"
    for db_path in sorted(pattern.glob("*/meta/collection.sqlite3")):
        if len(cases) >= limit:
            break
        dataset_id = db_path.parent.parent.name
        try:
            connection = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
            connection.row_factory = sqlite3.Row
            row = connection.execute(
                """
                SELECT c.chunk_id, c.content, c.source_ref, c.title_path,
                       d.original_filename, d.company_name
                FROM chunks c
                JOIN documents d ON d.doc_id = c.doc_id
                WHERE LENGTH(TRIM(c.content)) BETWEEN 180 AND 3500
                  AND COALESCE(d.is_current, 1) = 1
                ORDER BY COALESCE(c.token_count, 0) DESC, c.chunk_index ASC
                LIMIT 1
                """
            ).fetchone()
            connection.close()
        except sqlite3.Error:
            continue
        if row is None:
            continue
        evidence_id = f"chunk:{row['chunk_id']}"
        content = str(row["content"]).strip()[:3500]
        company = str(row["company_name"] or dataset_id)
        cases.append(
            {
                "id": f"real_evidence_{dataset_id}",
                "category": "real_evidence",
                "system": (
                    "你是私募研究助手。只能基于给出的本地真实证据回答，不得补充常识，"
                    "每个事实必须紧跟原样 evidence_id；严格只输出两条简短要点；"
                    "不要输出思考过程。"
                ),
                "user": (
                    f"公司/数据集：{company}（{dataset_id}）\n"
                    f"证据：\n[{evidence_id}] {content}\n"
                    "请严格用两条简短要点概括证据明确表达的内容，不要展开第三条。"
                ),
                "max_tokens": 512,
                "stream": False,
                "output_shape": "two_cited_bullets",
                "expect": {
                    "required_evidence_ids": [evidence_id],
                    "allowed_evidence_ids": [evidence_id],
                    "min_citations": 1,
                    "require_chinese": True,
                    "no_reasoning": True,
                    "max_lines": 2,
                },
                "source": {
                    "dataset_id": dataset_id,
                    "collection_db": str(db_path.resolve()),
                    "original_filename": row["original_filename"],
                    "source_ref": row["source_ref"],
                    "title_path": row["title_path"],
                    "evidence_id": evidence_id,
                },
            }
        )
    return cases


def parse_bool(value: Any) -> bool | None:
    if value is None or value == "":
        return None
    if isinstance(value, bool):
        return value
    lowered = str(value).strip().lower()
    if lowered in {"1", "true", "yes", "on"}:
        return True
    if lowered in {"0", "false", "no", "off"}:
        return False
    return None


def load_targets(args: argparse.Namespace) -> list[Target]:
    config_path = Path(args.upstream_config).expanduser().resolve()
    config = yaml.safe_load(config_path.read_text(encoding="utf-8")) or {}
    model = str(config.get("llm_model_name") or "").strip()
    upstream_base = str(config.get("llm_base_url") or "").strip().rstrip("/")
    upstream_key = str(config.get("llm_api_key") or "").strip()
    thinking = parse_bool(config.get("llm_chat_template_enable_thinking"))
    if not model:
        raise ValueError(f"llm_model_name is missing in {config_path}")

    targets: list[Target] = []
    if args.target in {"proxy", "both"}:
        targets.append(
            Target(
                name="proxy",
                base_url=args.proxy_url.rstrip("/"),
                model=args.proxy_model or model,
                api_key=args.proxy_api_key,
                enable_thinking=None,
            )
        )
    if args.target in {"upstream", "both"}:
        if not upstream_base or not upstream_key:
            raise ValueError(f"llm_base_url or llm_api_key is missing in {config_path}")
        targets.append(
            Target(
                name="upstream",
                base_url=upstream_base,
                model=args.upstream_model or model,
                api_key=upstream_key,
                enable_thinking=thinking,
            )
        )
    return targets


def _redact(value: str, secrets_to_hide: Iterable[str]) -> str:
    result = value
    for secret in secrets_to_hide:
        if secret and secret.upper() != "EMPTY":
            result = result.replace(secret, "[REDACTED]")
    return result


def _headers(target: Target) -> dict[str, str]:
    return {"Authorization": f"Bearer {target.api_key}", "Content-Type": "application/json"}


def _payload_for_case(target: Target, case: dict[str, Any], nonce: str) -> dict[str, Any]:
    expected = case.get("expect") or {}
    contract_lines = ["硬性输出契约（优先级最高，提交前逐项自检）："]
    if expected.get("json"):
        nonce_instruction = f"JSON 的 request_nonce 字段必须严格等于“{nonce}”。"
        contract_lines.extend(
            [
                "- 只输出一个合法 JSON 对象，不要 Markdown 代码围栏或解释文字。",
                f"- {nonce_instruction}",
            ]
        )
    else:
        nonce_instruction = (
            f"在回答最后原样附加 [request:{nonce}]，只允许出现这一个 request 标识；"
            "如果有行数限制，标识与最后一行正文放在同一行。"
        )
        contract_lines.append(
            f"- 无论正常回答还是回答“资料未覆盖”，都必须在最后原样附加 "
            f"[request:{nonce}]，且只能出现一次。"
        )
    if expected.get("max_lines"):
        contract_lines.append(
            f"- 包含 request 标识在内，总非空行数不得超过 "
            f"{int(expected['max_lines'])}；request 标识必须与最后一行正文同一行。"
        )
    required_evidence_ids = [
        str(item) for item in (expected.get("required_evidence_ids") or [])
    ]
    if required_evidence_ids:
        rendered_ids = "、".join(f"[{item}]" for item in required_evidence_ids)
        contract_lines.append(
            "- 每条受证据支持的事实必须在句末原样附加证据标识；本回答必须出现："
            f"{rendered_ids}。这些标识是输出要求，不得省略或改写。"
        )
    allowed_evidence_ids = [
        str(item) for item in (expected.get("allowed_evidence_ids") or [])
    ]
    if allowed_evidence_ids:
        rendered_allowed = "、".join(f"[{item}]" for item in allowed_evidence_ids)
        contract_lines.append(f"- 只能使用以下证据标识：{rendered_allowed}。")
    if expected.get("no_reasoning"):
        contract_lines.append("- 只输出答案，不输出分析、思考过程或自检过程。")
    shape_instruction = ""
    if (
        case.get("output_shape") == "two_cited_bullets"
        and len(required_evidence_ids) == 1
        and not expected.get("json")
    ):
        evidence_token = f"[{required_evidence_ids[0]}]"
        shape_instruction = (
            "\n\n严格使用下面两行骨架，只替换尖括号内的简短正文；"
            "方括号中的证据 ID 和 request 标识必须逐字符保留，不得另起第三行：\n"
            f"要点一：<不超过45个汉字> {evidence_token}\n"
            f"要点二：<不超过45个汉字> {evidence_token} [request:{nonce}]"
        )
    system_contract = "\n".join(contract_lines)
    base_system = str(case.get("system") or "").strip()
    payload: dict[str, Any] = {
        "model": target.model,
        "messages": [
            {
                "role": "system",
                "content": f"{base_system}\n\n{system_contract}".strip(),
            },
            {
                "role": "user",
                "content": (
                    f"{case.get('user', '')}\n\n{nonce_instruction}{shape_instruction}"
                ),
            },
        ],
        "temperature": 0.0,
        "max_tokens": int(case.get("max_tokens") or 256),
        "stream": bool(case.get("stream")),
    }
    if payload["stream"]:
        payload["stream_options"] = {"include_usage": True}
    if target.enable_thinking is not None:
        payload["chat_template_kwargs"] = {"enable_thinking": target.enable_thinking}
    return payload


async def request_completion(
    client: httpx.AsyncClient,
    target: Target,
    payload: dict[str, Any],
    *,
    stream_file: Path | None = None,
) -> dict[str, Any]:
    """Execute one request and retain the complete response envelope."""

    started_epoch = time.time()
    started = time.perf_counter()
    content_parts: list[str] = []
    reasoning_parts: list[str] = []
    chunks: list[dict[str, Any]] = []
    usage: dict[str, Any] = {}
    finish_reason: str | None = None
    raw_response: Any = None
    status_code: int | None = None
    ttft_ms: float | None = None
    response_headers: dict[str, str] = {}
    error: dict[str, Any] | None = None
    try:
        if payload.get("stream"):
            async with client.stream(
                "POST",
                f"{target.base_url}/chat/completions",
                headers=_headers(target),
                json=payload,
            ) as response:
                status_code = response.status_code
                response_headers = {
                    key: value
                    for key, value in response.headers.items()
                    if key.lower()
                    in {"content-type", "x-request-id", "request-id", "server", "date"}
                }
                if response.status_code >= 400:
                    body = (await response.aread()).decode("utf-8", errors="replace")
                    error = {"type": "http_error", "message": body}
                else:
                    async for line in response.aiter_lines():
                        if not line.startswith("data:"):
                            continue
                        data = line[5:].strip()
                        if not data or data == "[DONE]":
                            continue
                        elapsed_ms = (time.perf_counter() - started) * 1000
                        try:
                            chunk = json.loads(data)
                        except json.JSONDecodeError:
                            chunks.append({"t_ms": elapsed_ms, "raw": data})
                            continue
                        choices = chunk.get("choices") or []
                        delta = choices[0].get("delta") or {} if choices else {}
                        piece = delta.get("content")
                        reasoning_piece = delta.get("reasoning_content") or delta.get(
                            "reasoning"
                        )
                        if piece:
                            if ttft_ms is None:
                                ttft_ms = elapsed_ms
                            content_parts.append(str(piece))
                        if reasoning_piece:
                            reasoning_parts.append(str(reasoning_piece))
                        if choices and choices[0].get("finish_reason") is not None:
                            finish_reason = choices[0]["finish_reason"]
                        if isinstance(chunk.get("usage"), dict):
                            usage = chunk["usage"]
                        chunks.append(
                            {
                                "t_ms": round(elapsed_ms, 3),
                                "content": piece,
                                "reasoning_content": reasoning_piece,
                                "finish_reason": (
                                    choices[0].get("finish_reason") if choices else None
                                ),
                                "usage": chunk.get("usage"),
                                "raw": chunk,
                            }
                        )
            raw_response = {"stream_chunks": chunks}
            if stream_file is not None:
                with stream_file.open("w", encoding="utf-8") as handle:
                    for chunk in chunks:
                        handle.write(json.dumps(chunk, ensure_ascii=False, default=str) + "\n")
                stream_file.chmod(0o600)
        else:
            response = await client.post(
                f"{target.base_url}/chat/completions",
                headers=_headers(target),
                json=payload,
            )
            status_code = response.status_code
            response_headers = {
                key: value
                for key, value in response.headers.items()
                if key.lower()
                in {"content-type", "x-request-id", "request-id", "server", "date"}
            }
            try:
                raw_response = response.json()
            except json.JSONDecodeError:
                raw_response = {"raw_text": response.text}
            if response.status_code >= 400:
                error = {"type": "http_error", "message": response.text}
            else:
                choices = raw_response.get("choices") or []
                if not choices:
                    error = {"type": "protocol_error", "message": "choices is empty"}
                else:
                    message = choices[0].get("message") or {}
                    content_parts.append(str(message.get("content") or ""))
                    reasoning_parts.append(
                        str(
                            message.get("reasoning_content")
                            or message.get("reasoning")
                            or ""
                        )
                    )
                    finish_reason = choices[0].get("finish_reason")
                    usage = raw_response.get("usage") or {}
        total_ms = (time.perf_counter() - started) * 1000
    except Exception as exc:  # noqa: BLE001 - every failed request must be persisted
        total_ms = (time.perf_counter() - started) * 1000
        error = {"type": type(exc).__name__, "message": str(exc)}

    if error:
        error["message"] = _redact(str(error.get("message") or ""), [target.api_key])
    content = "".join(content_parts)
    reasoning_content = "".join(reasoning_parts)
    completion_tokens = usage.get("completion_tokens")
    active_generation_ms = total_ms - (ttft_ms or 0.0)
    tokens_per_second: float | None = None
    if isinstance(completion_tokens, (int, float)) and active_generation_ms > 0:
        tokens_per_second = float(completion_tokens) / (active_generation_ms / 1000)
    ended_epoch = time.time()
    return {
        "status": "success" if error is None else "error",
        "status_code": status_code,
        "content": content,
        "reasoning_content": reasoning_content,
        "finish_reason": finish_reason,
        "usage": usage,
        "started_at": utc_iso(started_epoch),
        "ended_at": utc_iso(ended_epoch),
        "started_epoch": started_epoch,
        "ended_epoch": ended_epoch,
        "ttft_ms": round(ttft_ms, 3) if ttft_ms is not None else None,
        "total_latency_ms": round(total_ms, 3),
        "tokens_per_second": round(tokens_per_second, 3) if tokens_per_second else None,
        "response_headers": response_headers,
        "error": error,
        "raw_response": raw_response,
    }


def _extract_tool_calls(result: dict[str, Any]) -> list[dict[str, Any]]:
    raw = result.get("raw_response") or {}
    choices = raw.get("choices") or [] if isinstance(raw, dict) else []
    if not choices:
        return []
    message = choices[0].get("message") or {}
    calls: list[dict[str, Any]] = []
    for item in message.get("tool_calls") or []:
        function = item.get("function") or {}
        raw_arguments = function.get("arguments") or "{}"
        try:
            arguments = json.loads(raw_arguments)
        except (json.JSONDecodeError, TypeError):
            arguments = {"_invalid_json": raw_arguments}
        calls.append(
            {
                "id": item.get("id") or f"call_{secrets.token_hex(4)}",
                "type": item.get("type") or "function",
                "name": function.get("name"),
                "arguments": arguments,
                "raw_arguments": raw_arguments,
                "raw": item,
            }
        )
    return calls


def _classify_tool_capability(result: dict[str, Any]) -> tuple[str, str]:
    if result.get("status") == "success":
        calls = _extract_tool_calls(result)
        if calls:
            return "AVAILABLE", f"model returned {len(calls)} tool call(s)"
        return "FAILED", "request succeeded but the model did not select the required tool"
    message = str((result.get("error") or {}).get("message") or "").lower()
    if any(pattern in message for pattern in TOOL_BLOCKED_PATTERNS):
        return "BLOCKED", "server is not configured for automatic tool choice/tool parsing"
    return "FAILED", message[:500]


async def run_preflight(
    client: httpx.AsyncClient,
    target: Target,
    store: ArtifactStore,
) -> dict[str, Any]:
    result: dict[str, Any] = {"target": target.safe_dict(), "started_at": utc_iso()}
    try:
        response = await client.get(f"{target.base_url}/models", headers=_headers(target))
        try:
            body: Any = response.json()
        except json.JSONDecodeError:
            body = {"raw_text": response.text}
        result["models"] = {"status_code": response.status_code, "body": body}
    except Exception as exc:  # noqa: BLE001
        result["models"] = {"error": _redact(str(exc), [target.api_key])}

    basic_payload: dict[str, Any] = {
        "model": target.model,
        "messages": [
            {"role": "system", "content": "你是中文助手，不输出思考过程。"},
            {"role": "user", "content": "只回复：预检通过"},
        ],
        "temperature": 0.0,
        "max_tokens": 32,
        "stream": False,
    }
    if target.enable_thinking is not None:
        basic_payload["chat_template_kwargs"] = {
            "enable_thinking": target.enable_thinking
        }
    result["basic"] = await request_completion(client, target, basic_payload)

    stream_payload = dict(basic_payload)
    stream_payload["messages"] = [
        {"role": "user", "content": "流式回复三个字：春天好"}
    ]
    stream_payload["stream"] = True
    stream_payload["stream_options"] = {"include_usage": True}
    result["stream"] = await request_completion(
        client,
        target,
        stream_payload,
        stream_file=store.stream_dir / f"preflight-{target.name}.jsonl",
    )

    tool_payload = dict(basic_payload)
    tool_payload["messages"] = [
        {
            "role": "user",
            "content": (
                "必须调用 private_fund_dataset_status 检查 stress-sandbox，"
                "不要直接回答。"
            ),
        }
    ]
    tool_payload["tools"] = READ_ONLY_TOOL_SCHEMAS
    tool_payload["tool_choice"] = "auto"
    tool_payload["max_tokens"] = 160
    result["tool"] = await request_completion(client, target, tool_payload)
    tool_status, tool_reason = _classify_tool_capability(result["tool"])
    result["tool_capability"] = {"status": tool_status, "reason": tool_reason}
    result["basic_ready"] = result["basic"].get("status") == "success"
    result["stream_ready"] = result["stream"].get("status") == "success"
    result["ended_at"] = utc_iso()
    store.write_json(f"preflight_{target.name}.json", result)
    return result


class TokenBudget:
    def __init__(self, maximum: int) -> None:
        self.maximum = maximum
        self.used = 0

    @property
    def exhausted(self) -> bool:
        return self.maximum > 0 and self.used >= self.maximum

    def add(self, result: dict[str, Any]) -> None:
        total = (result.get("usage") or {}).get("total_tokens")
        if isinstance(total, int):
            self.used += total


async def execute_case(
    client: httpx.AsyncClient,
    target: Target,
    case: dict[str, Any],
    concurrency: int,
    sequence: int,
    store: ArtifactStore,
    token_budget: TokenBudget,
) -> dict[str, Any]:
    nonce = secrets.token_hex(8)
    request_id = f"{target.name}-c{concurrency}-{sequence:05d}-{nonce[:8]}"
    payload = _payload_for_case(target, case, nonce)
    request_record = {
        "request_id": request_id,
        "target": target.name,
        "model": target.model,
        "case_id": case["id"],
        "category": case.get("category"),
        "concurrency": concurrency,
        "nonce": nonce,
        "source": case.get("source"),
        "payload": payload,
        "created_at": utc_iso(),
    }
    await store.append_jsonl("requests.jsonl", request_record)
    if token_budget.exhausted:
        result = {
            "status": "skipped",
            "error": {"type": "token_budget", "message": "run token budget exhausted"},
            "content": "",
            "usage": {},
            "started_epoch": time.time(),
            "ended_epoch": time.time(),
        }
    else:
        stream_path = (
            store.stream_dir / f"{request_id}.jsonl" if payload.get("stream") else None
        )
        result = await request_completion(
            client, target, payload, stream_file=stream_path
        )
        token_budget.add(result)
    result.update(
        {
            "request_id": request_id,
            "target": target.name,
            "model": target.model,
            "case_id": case["id"],
            "category": case.get("category"),
            "concurrency": concurrency,
            "nonce": nonce,
            "source": case.get("source"),
        }
    )
    if result["status"] == "success":
        result["evaluation"] = score_content(str(result.get("content") or ""), case, nonce)
        if (case.get("expect") or {}).get("no_reasoning") and str(
            result.get("reasoning_content") or ""
        ).strip():
            result["evaluation"]["checks"].append(
                _check(
                    "no_reasoning_field",
                    False,
                    {"character_count": len(str(result["reasoning_content"]))},
                )
            )
            result["evaluation"]["failed_checks"].append("no_reasoning_field")
            result["evaluation"]["passed"] = False
            result["evaluation"]["score"] = sum(
                check["passed"] for check in result["evaluation"]["checks"]
            ) / len(result["evaluation"]["checks"])
    else:
        result["evaluation"] = {
            "passed": False,
            "score": 0.0,
            "checks": [],
            "failed_checks": ["request_failed"],
            "citations": [],
        }
    await store.append_jsonl("responses.jsonl", result)
    await store.save_response(request_id, result)
    return result


async def run_concurrency_level(
    client: httpx.AsyncClient,
    target: Target,
    cases: list[dict[str, Any]],
    concurrency: int,
    request_count: int,
    sequence_start: int,
    store: ArtifactStore,
    token_budget: TokenBudget,
) -> list[dict[str, Any]]:
    semaphore = asyncio.Semaphore(concurrency)

    async def bounded(index: int) -> dict[str, Any]:
        async with semaphore:
            return await execute_case(
                client,
                target,
                cases[index % len(cases)],
                concurrency,
                sequence_start + index,
                store,
                token_budget,
            )

    tasks = [asyncio.create_task(bounded(index)) for index in range(request_count)]
    results: list[dict[str, Any]] = []
    for task in asyncio.as_completed(tasks):
        results.append(await task)
    return results


async def run_soak(
    client: httpx.AsyncClient,
    target: Target,
    cases: list[dict[str, Any]],
    concurrency: int,
    duration_seconds: int,
    store: ArtifactStore,
    token_budget: TokenBudget,
) -> list[dict[str, Any]]:
    deadline = time.monotonic() + duration_seconds
    counter = 0
    counter_lock = asyncio.Lock()

    async def worker(worker_id: int) -> list[dict[str, Any]]:
        nonlocal counter
        worker_results: list[dict[str, Any]] = []
        while time.monotonic() < deadline and not token_budget.exhausted:
            async with counter_lock:
                sequence = counter
                counter += 1
            case = cases[(sequence + worker_id) % len(cases)]
            worker_results.append(
                await execute_case(
                    client,
                    target,
                    case,
                    concurrency,
                    sequence,
                    store,
                    token_budget,
                )
            )
        return worker_results

    groups = await asyncio.gather(*(worker(index) for index in range(concurrency)))
    return [item for group in groups for item in group]


def _simulated_tool_result(name: str, arguments: dict[str, Any]) -> dict[str, Any]:
    dataset_id = str(arguments.get("dataset_id") or "stress-sandbox")
    if name == "private_fund_dataset_status":
        return {
            "dataset_id": dataset_id,
            "status": "ready",
            "document_count": 3,
            "chunk_count": 128,
            "simulated": True,
        }
    if name == "private_fund_dataset_search":
        return {
            "dataset_id": dataset_id,
            "query": arguments.get("query"),
            "results": [
                {
                    "evidence_id": "chunk:stress-tool-001",
                    "excerpt": "星河样本公司 2025 年收入同比增长 17.4%。",
                    "citation": "[chunk:stress-tool-001]",
                }
            ],
            "simulated": True,
        }
    if name == "private_fund_source_detail":
        return {
            "dataset_id": dataset_id,
            "evidence_id": arguments.get("evidence_id"),
            "text": "星河样本公司 2025 年收入同比增长 17.4%。",
            "source": "stress_fixture.pdf#page=7",
            "simulated": True,
        }
    if name == "private_fund_tracking_list":
        return {
            "dataset_id": dataset_id,
            "items": [],
            "jobs": [],
            "simulated": True,
        }
    return {"error": "unknown or disallowed tool", "tool": name, "simulated": True}


async def run_tool_case(
    client: httpx.AsyncClient,
    target: Target,
    case: dict[str, Any],
    sequence: int,
    store: ArtifactStore,
    token_budget: TokenBudget,
) -> dict[str, Any]:
    nonce = secrets.token_hex(8)
    trace_id = f"{target.name}-tool-{sequence:04d}-{nonce[:8]}"
    base_system = str(case.get("system") or "").strip()
    tool_completion_contract = (
        "工具执行硬约束（优先级最高）：只调用完成当前请求所必需的工具；"
        "严格遵守用户指定的调用顺序；不要自动追加状态检查或来源详情；"
        "所需工具结果返回后，下一轮必须立即给出最终回答，不得继续调用工具；"
        f"最终回答必须以 [request:{nonce}] 结尾且只出现一次。"
    )
    messages: list[dict[str, Any]] = [
        {
            "role": "system",
            "content": f"{base_system}\n\n{tool_completion_contract}".strip(),
        },
        {
            "role": "user",
            "content": (
                f"{case.get('user', '')}\n\n"
                f"最终回答末尾必须原样附加 [request:{nonce}]。"
            ),
        },
    ]
    trace: dict[str, Any] = {
        "trace_id": trace_id,
        "target": target.name,
        "model": target.model,
        "case_id": case["id"],
        "category": "tool_calling",
        "nonce": nonce,
        "calls": [],
        "steps": [],
        "started_at": utc_iso(),
    }
    max_steps = max(1, int(case.get("max_steps") or 3))
    final_content = ""
    for step in range(max_steps):
        if token_budget.exhausted:
            trace["status"] = "skipped"
            trace["error"] = "run token budget exhausted"
            break
        request_id = f"{trace_id}-s{step + 1}"
        payload: dict[str, Any] = {
            "model": target.model,
            "messages": messages,
            "tools": READ_ONLY_TOOL_SCHEMAS,
            "tool_choice": "auto",
            "temperature": 0.0,
            "max_tokens": 320,
            "stream": False,
        }
        if target.enable_thinking is not None:
            payload["chat_template_kwargs"] = {
                "enable_thinking": target.enable_thinking
            }
        await store.append_jsonl(
            "requests.jsonl",
            {
                "request_id": request_id,
                "trace_id": trace_id,
                "target": target.name,
                "model": target.model,
                "case_id": case["id"],
                "category": "tool_calling",
                "nonce": nonce,
                "payload": payload,
                "created_at": utc_iso(),
                "tool_results_are_simulated": True,
            },
        )
        result = await request_completion(client, target, payload)
        token_budget.add(result)
        result.update(
            {
                "request_id": request_id,
                "trace_id": trace_id,
                "target": target.name,
                "model": target.model,
                "case_id": case["id"],
                "category": "tool_calling",
                "nonce": nonce,
            }
        )
        await store.append_jsonl("responses.jsonl", result)
        await store.save_response(request_id, result)
        step_calls = _extract_tool_calls(result)
        trace["steps"].append(
            {
                "step": step + 1,
                "request_id": request_id,
                "status": result.get("status"),
                "status_code": result.get("status_code"),
                "content": result.get("content"),
                "reasoning_content": result.get("reasoning_content"),
                "tool_calls": step_calls,
                "latency_ms": result.get("total_latency_ms"),
                "usage": result.get("usage"),
                "error": result.get("error"),
            }
        )
        if result.get("status") != "success":
            trace["status"] = "error"
            trace["error"] = result.get("error")
            break
        if not step_calls:
            final_content = str(result.get("content") or "")
            trace["status"] = "success"
            break

        raw = result.get("raw_response") or {}
        assistant_message = ((raw.get("choices") or [{}])[0].get("message") or {}).copy()
        assistant_message["role"] = "assistant"
        messages.append(assistant_message)
        for call in step_calls:
            compact_call = {
                "step": step + 1,
                "id": call["id"],
                "name": call["name"],
                "arguments": call["arguments"],
            }
            trace["calls"].append(compact_call)
            simulated = _simulated_tool_result(
                str(call.get("name") or ""), dict(call.get("arguments") or {})
            )
            compact_call["simulated_result"] = simulated
            messages.append(
                {
                    "role": "tool",
                    "tool_call_id": call["id"],
                    "name": call["name"],
                    "content": json.dumps(simulated, ensure_ascii=False),
                }
            )
    else:
        trace["status"] = "max_steps"

    trace["final_content"] = final_content
    trace["ended_at"] = utc_iso()
    trace["evaluation"] = score_tool_trace(trace, case)
    final_nonce_count = final_content.count(f"[request:{nonce}]")
    trace["evaluation"]["checks"].append(
        _check("request_nonce", final_nonce_count == 1, final_nonce_count)
    )
    reasoning_characters = sum(
        len(str(step.get("reasoning_content") or "")) for step in trace["steps"]
    )
    trace["evaluation"]["checks"].append(
        _check("no_reasoning_field", reasoning_characters == 0, reasoning_characters)
    )
    failed_checks = [
        item["name"]
        for item in trace["evaluation"]["checks"]
        if not item["passed"]
    ]
    trace["evaluation"]["failed_checks"] = failed_checks
    trace["evaluation"]["passed"] = not failed_checks
    passed_count = sum(
        item["passed"] for item in trace["evaluation"]["checks"]
    )
    trace["evaluation"]["score"] = passed_count / len(
        trace["evaluation"]["checks"]
    )
    await store.append_jsonl("tool_traces.jsonl", trace)
    await store.save_tool_trace(trace_id, trace)
    return trace


async def sample_local_processes(
    stop_event: asyncio.Event,
    samples: list[dict[str, Any]],
) -> None:
    markers = ("litellm", "omnigent", "private_fund", "pdf_research_demo")
    while not stop_event.is_set():
        row: dict[str, Any] = {
            "timestamp": utc_iso(),
            "cpu_percent": 0.0,
            "rss_mb": 0.0,
            "process_count": 0,
        }
        try:
            process = await asyncio.create_subprocess_exec(
                "ps",
                "-axo",
                "pcpu=,rss=,command=",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.DEVNULL,
            )
            stdout, _ = await process.communicate()
            matched: list[str] = []
            for line in stdout.decode("utf-8", errors="replace").splitlines():
                lowered = line.lower()
                if not any(marker in lowered for marker in markers):
                    continue
                parts = line.strip().split(maxsplit=2)
                if len(parts) < 3:
                    continue
                try:
                    row["cpu_percent"] += float(parts[0])
                    row["rss_mb"] += float(parts[1]) / 1024
                except ValueError:
                    continue
                row["process_count"] += 1
                command_name = Path(parts[2].split(maxsplit=1)[0]).name
                matched.append(command_name[:80])
            row["cpu_percent"] = round(row["cpu_percent"], 3)
            row["rss_mb"] = round(row["rss_mb"], 3)
            row["commands"] = matched
        except Exception as exc:  # noqa: BLE001
            row["error"] = str(exc)
        samples.append(row)
        with contextlib.suppress(TimeoutError):
            await asyncio.wait_for(stop_event.wait(), timeout=1.0)


def _metrics_url(target: Target) -> str:
    base = target.base_url.rstrip("/")
    if base.endswith("/v1"):
        base = base[:-3]
    return f"{base}/metrics"


def _select_provider_metrics(text: str) -> list[str]:
    wanted = (
        "vllm:num_requests_running",
        "vllm:num_requests_waiting",
        "vllm:gpu_cache_usage_perc",
        "vllm:request_success_total",
        "vllm:time_to_first_token_seconds",
        "vllm:e2e_request_latency_seconds",
        "litellm_",
    )
    return [
        line
        for line in text.splitlines()
        if line and not line.startswith("#") and line.startswith(wanted)
    ]


async def sample_provider_metrics(
    target: Target,
    stop_event: asyncio.Event,
    store: ArtifactStore,
) -> None:
    timeout = httpx.Timeout(5.0)
    async with httpx.AsyncClient(timeout=timeout, verify=True) as client:
        failure_count = 0
        while not stop_event.is_set():
            record: dict[str, Any] = {"timestamp": utc_iso(), "target": target.name}
            try:
                response = await client.get(_metrics_url(target))
                record["status_code"] = response.status_code
                if response.status_code == 200:
                    record["metrics"] = _select_provider_metrics(response.text)
                else:
                    failure_count += 1
                    record["error"] = response.text[:1000]
            except Exception as exc:  # noqa: BLE001
                failure_count += 1
                record["error"] = _redact(str(exc), [target.api_key])
            await store.append_jsonl("provider_metrics.jsonl", record)
            if failure_count >= 2:
                return
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(stop_event.wait(), timeout=2.0)


def _round(value: float | None, digits: int = 3) -> float | None:
    return round(value, digits) if value is not None else None


def _metric_group(rows: list[dict[str, Any]]) -> dict[str, Any]:
    successes = [row for row in rows if row.get("status") == "success"]
    latencies = [
        float(row["total_latency_ms"])
        for row in successes
        if row.get("total_latency_ms") is not None
    ]
    ttfts = [
        float(row["ttft_ms"])
        for row in successes
        if row.get("ttft_ms") is not None
    ]
    rates = [
        float(row["tokens_per_second"])
        for row in successes
        if row.get("tokens_per_second") is not None
    ]
    quality = [
        row["evaluation"] for row in successes if isinstance(row.get("evaluation"), dict)
    ]
    starts = [float(row["started_epoch"]) for row in rows if row.get("started_epoch")]
    ends = [float(row["ended_epoch"]) for row in rows if row.get("ended_epoch")]
    wall_seconds = max(ends) - min(starts) if starts and ends else 0.0
    usage_totals: dict[str, int] = defaultdict(int)
    for row in successes:
        for key in ("prompt_tokens", "completion_tokens", "total_tokens"):
            value = (row.get("usage") or {}).get(key)
            if isinstance(value, int):
                usage_totals[key] += value
    return {
        "request_count": len(rows),
        "success_count": len(successes),
        "error_count": len(rows) - len(successes),
        "success_rate": _round(len(successes) / len(rows) if rows else 0.0, 4),
        "throughput_rps": _round(len(successes) / wall_seconds if wall_seconds else None),
        "latency_ms": {
            "p50": _round(percentile(latencies, 0.50)),
            "p95": _round(percentile(latencies, 0.95)),
            "p99": _round(percentile(latencies, 0.99)),
            "mean": _round(sum(latencies) / len(latencies) if latencies else None),
        },
        "ttft_ms": {
            "p50": _round(percentile(ttfts, 0.50)),
            "p95": _round(percentile(ttfts, 0.95)),
            "p99": _round(percentile(ttfts, 0.99)),
        },
        "tokens_per_second": {
            "p50": _round(percentile(rates, 0.50)),
            "p95": _round(percentile(rates, 0.95)),
        },
        "quality_pass_rate": _round(
            sum(bool(item.get("passed")) for item in quality) / len(quality)
            if quality
            else None,
            4,
        ),
        "quality_mean_score": _round(
            sum(float(item.get("score") or 0.0) for item in quality) / len(quality)
            if quality
            else None,
            4,
        ),
        "usage": dict(usage_totals),
        "wall_seconds": _round(wall_seconds),
    }


def _gate(name: str, status: str, actual: Any, threshold: Any, detail: str) -> dict[str, Any]:
    return {
        "name": name,
        "status": status,
        "actual": actual,
        "threshold": threshold,
        "detail": detail,
    }


def build_summary(
    results: list[dict[str, Any]],
    tool_traces: list[dict[str, Any]],
    preflights: list[dict[str, Any]],
    started_epoch: float,
    ended_epoch: float,
) -> dict[str, Any]:
    grouped: dict[tuple[str, int], list[dict[str, Any]]] = defaultdict(list)
    categories: dict[str, list[dict[str, Any]]] = defaultdict(list)
    targets: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in results:
        grouped[(str(row.get("target")), int(row.get("concurrency") or 0))].append(row)
        categories[str(row.get("category"))].append(row)
        targets[str(row.get("target"))].append(row)

    concurrency_metrics = [
        {
            "target": target,
            "concurrency": concurrency,
            **_metric_group(rows),
        }
        for (target, concurrency), rows in sorted(grouped.items())
    ]
    category_metrics = [
        {"category": category, **_metric_group(rows)}
        for category, rows in sorted(categories.items())
    ]
    target_metrics = [
        {"target": target, **_metric_group(rows)}
        for target, rows in sorted(targets.items())
    ]
    overall = _metric_group(results)
    overall["duration_seconds"] = _round(ended_epoch - started_epoch)

    evaluated = [row for row in results if isinstance(row.get("evaluation"), dict)]
    provenance = [
        row
        for row in evaluated
        if row.get("category") in {"provenance", "real_evidence"}
    ]
    instructions = [
        row
        for row in evaluated
        if row.get("category") in {"instruction_following", "safety"}
    ]

    def pass_rate(rows: list[dict[str, Any]]) -> float | None:
        if not rows:
            return None
        return sum(bool(row["evaluation"].get("passed")) for row in rows) / len(rows)

    def check_rate(check_name: str) -> float | None:
        matching: list[bool] = []
        for row in evaluated:
            for check in row["evaluation"].get("checks") or []:
                if check.get("name") == check_name:
                    matching.append(bool(check.get("passed")))
        return sum(matching) / len(matching) if matching else None

    tool_completed = [
        trace
        for trace in tool_traces
        if isinstance(trace.get("evaluation"), dict)
    ]
    tool_accuracy = (
        sum(bool(trace["evaluation"].get("passed")) for trace in tool_completed)
        / len(tool_completed)
        if tool_completed
        else None
    )
    tool_capabilities = [
        (preflight.get("tool_capability") or {}).get("status") for preflight in preflights
    ]

    gates: list[dict[str, Any]] = []
    if results:
        availability = float(overall["success_rate"] or 0.0)
        gates.append(
            _gate(
                "request_success_rate",
                "PASS" if availability >= 0.98 else "FAIL",
                availability,
                ">= 0.98",
                "所有被测普通/流式请求的成功率",
            )
        )
    else:
        gates.append(
            _gate(
                "request_success_rate",
                "BLOCKED",
                None,
                ">= 0.98",
                "本套件未运行普通请求",
            )
        )

    instruction_rate = pass_rate(instructions)
    gates.append(
        _gate(
            "instruction_following",
            "PASS"
            if instruction_rate is not None and instruction_rate >= 0.85
            else ("BLOCKED" if instruction_rate is None else "FAIL"),
            _round(instruction_rate, 4),
            ">= 0.85",
            "JSON、格式、数值计算和注入抵抗的整项通过率",
        )
    )
    provenance_rate = pass_rate(provenance)
    gates.append(
        _gate(
            "provenance",
            "PASS"
            if provenance_rate is not None and provenance_rate >= 0.90
            else ("BLOCKED" if provenance_rate is None else "FAIL"),
            _round(provenance_rate, 4),
            ">= 0.90",
            "引用完整性、白名单与跨公司隔离的整项通过率",
        )
    )
    nonce_rate = check_rate("no_foreign_nonce")
    gates.append(
        _gate(
            "request_isolation",
            "PASS"
            if nonce_rate is not None and nonce_rate == 1.0
            else ("BLOCKED" if nonce_rate is None else "FAIL"),
            _round(nonce_rate, 4),
            "= 1.0",
            "并发响应中不得出现其他请求的 nonce",
        )
    )
    reasoning_outcomes: list[bool] = []
    for row in evaluated:
        reasoning_checks = [
            bool(check.get("passed"))
            for check in row["evaluation"].get("checks") or []
            if str(check.get("name") or "").startswith("no_reasoning")
        ]
        if reasoning_checks:
            reasoning_outcomes.append(all(reasoning_checks))
    reasoning_rate = (
        sum(reasoning_outcomes) / len(reasoning_outcomes) if reasoning_outcomes else None
    )
    gates.append(
        _gate(
            "no_reasoning_leak",
            "PASS"
            if reasoning_rate is not None and reasoning_rate == 1.0
            else ("BLOCKED" if reasoning_rate is None else "FAIL"),
            _round(reasoning_rate, 4),
            "= 1.0",
            "最终内容不得泄露明显的内部推理标记",
        )
    )

    if tool_completed:
        gates.append(
            _gate(
                "tool_call_accuracy",
                "PASS" if tool_accuracy is not None and tool_accuracy >= 0.90 else "FAIL",
                _round(tool_accuracy, 4),
                ">= 0.90",
                "只读工具的选择、顺序、参数和工具后最终回答",
            )
        )
    elif tool_capabilities and all(status == "BLOCKED" for status in tool_capabilities):
        gates.append(
            _gate(
                "tool_call_accuracy",
                "BLOCKED",
                None,
                ">= 0.90",
                "上游未开启自动工具选择或工具调用解析器",
            )
        )
    else:
        gates.append(
            _gate(
                "tool_call_accuracy",
                "BLOCKED",
                None,
                ">= 0.90",
                "本套件未执行工具准确性测试或预检失败",
            )
        )

    for target, rows in sorted(targets.items()):
        by_concurrency: dict[int, list[dict[str, Any]]] = defaultdict(list)
        for row in rows:
            by_concurrency[int(row.get("concurrency") or 0)].append(row)
        levels = sorted(level for level in by_concurrency if level > 0)
        if len(levels) < 2:
            continue
        low, high = levels[0], levels[-1]
        low_p95 = _metric_group(by_concurrency[low])["latency_ms"]["p95"]
        high_p95 = _metric_group(by_concurrency[high])["latency_ms"]["p95"]
        ratio = high_p95 / low_p95 if low_p95 and high_p95 else None
        gates.append(
            _gate(
                f"latency_degradation:{target}",
                "PASS" if ratio is not None and ratio <= 3.0 else "FAIL",
                _round(ratio),
                "<= 3.0x",
                f"并发 {high} 的 p95 总延迟相对并发 {low} 的倍数",
            )
        )

    statuses = {gate["status"] for gate in gates}
    if "FAIL" in statuses:
        verdict = "FAIL"
    elif "BLOCKED" in statuses:
        verdict = "COMPLETED_WITH_BLOCKED_CAPABILITY"
    else:
        verdict = "PASS"
    return {
        "verdict": verdict,
        "started_at": utc_iso(started_epoch),
        "ended_at": utc_iso(ended_epoch),
        "overall": overall,
        "targets": target_metrics,
        "concurrency": concurrency_metrics,
        "categories": category_metrics,
        "tools": {
            "capabilities": tool_capabilities,
            "trace_count": len(tool_completed),
            "accuracy": _round(tool_accuracy, 4),
        },
        "gates": gates,
    }


def write_csv(path: Path, rows: list[dict[str, Any]], columns: list[str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=columns, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(rows)
    path.chmod(0o600)


def write_metrics_csv(store: ArtifactStore, summary: dict[str, Any]) -> None:
    rows: list[dict[str, Any]] = []
    for item in summary.get("concurrency") or []:
        rows.append(
            {
                "target": item["target"],
                "concurrency": item["concurrency"],
                "request_count": item["request_count"],
                "success_rate": item["success_rate"],
                "throughput_rps": item["throughput_rps"],
                "latency_p50_ms": item["latency_ms"]["p50"],
                "latency_p95_ms": item["latency_ms"]["p95"],
                "latency_p99_ms": item["latency_ms"]["p99"],
                "ttft_p50_ms": item["ttft_ms"]["p50"],
                "ttft_p95_ms": item["ttft_ms"]["p95"],
                "tokens_per_second_p50": item["tokens_per_second"]["p50"],
                "quality_pass_rate": item["quality_pass_rate"],
                "prompt_tokens": item["usage"].get("prompt_tokens", 0),
                "completion_tokens": item["usage"].get("completion_tokens", 0),
                "total_tokens": item["usage"].get("total_tokens", 0),
            }
        )
    write_csv(
        store.run_dir / "metrics.csv",
        rows,
        [
            "target",
            "concurrency",
            "request_count",
            "success_rate",
            "throughput_rps",
            "latency_p50_ms",
            "latency_p95_ms",
            "latency_p99_ms",
            "ttft_p50_ms",
            "ttft_p95_ms",
            "tokens_per_second_p50",
            "quality_pass_rate",
            "prompt_tokens",
            "completion_tokens",
            "total_tokens",
        ],
    )


def write_system_metrics(store: ArtifactStore, samples: list[dict[str, Any]]) -> None:
    rows = [
        {
            "timestamp": sample.get("timestamp"),
            "cpu_percent": sample.get("cpu_percent"),
            "rss_mb": sample.get("rss_mb"),
            "process_count": sample.get("process_count"),
            "error": sample.get("error"),
            "commands": " | ".join(sample.get("commands") or []),
        }
        for sample in samples
    ]
    write_csv(
        store.run_dir / "system_metrics.csv",
        rows,
        ["timestamp", "cpu_percent", "rss_mb", "process_count", "error", "commands"],
    )


def summary_markdown(summary: dict[str, Any], run_id: str) -> str:
    lines = [
        "# 📝 LLM 压力测试报告",
        "",
        f"- Run ID：`{run_id}`",
        f"- 结论：`{summary['verdict']}`",
        f"- 请求数：{summary['overall']['request_count']}",
        f"- 成功率：{summary['overall']['success_rate']}",
        f"- 总耗时：{summary['overall']['duration_seconds']} 秒",
        f"- 总 Token：{summary['overall']['usage'].get('total_tokens', 0)}",
        "",
        "## 📝 验收门槛",
        "",
        "| 指标 | 状态 | 实际值 | 门槛 | 说明 |",
        "| --- | --- | ---: | --- | --- |",
    ]
    for gate in summary.get("gates") or []:
        lines.append(
            f"| {gate['name']} | {gate['status']} | {gate['actual']} | "
            f"{gate['threshold']} | {gate['detail']} |"
        )
    lines.extend(
        [
            "",
            "## 📝 并发指标",
            "",
            (
                "| 目标 | 并发 | 请求 | 成功率 | RPS | p50(ms) | p95(ms) | "
                "TTFT p95(ms) | 质量通过率 |"
            ),
            "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
        ]
    )
    for item in summary.get("concurrency") or []:
        lines.append(
            f"| {item['target']} | {item['concurrency']} | {item['request_count']} | "
            f"{item['success_rate']} | {item['throughput_rps']} | "
            f"{item['latency_ms']['p50']} | {item['latency_ms']['p95']} | "
            f"{item['ttft_ms']['p95']} | {item['quality_pass_rate']} |"
        )
    lines.extend(
        [
            "",
            "## 📝 结果解释",
            "",
            "- `FAIL`：至少一个硬门槛未通过。",
            (
                "- `COMPLETED_WITH_BLOCKED_CAPABILITY`：可运行项已完成，"
                "但某项能力（常见为工具解析）无法测试。"
            ),
            "- `BLOCKED` 不会被静默算作通过；请先补齐服务能力后重跑对应套件。",
            "- 原始请求、完整响应、流式分片、工具轨迹和评分细项都在同目录，可离线复核。",
            "",
        ]
    )
    return "\n".join(lines)


def create_bundle(store: ArtifactStore) -> Path:
    readme = """# 📝 给分析助手的说明

这是一次 LLM 压力测试的完整本地结果包。优先读取 `summary.json`、`metrics.csv`、
`failures.jsonl` 和 `evidence_checks.jsonl`，再按 request_id 到 `responses/`、
`stream_chunks/`、`tool_traces/` 定位原始内容。`manifest.json` 不含 API Key。

请分析：容量拐点、p95/p99 与 TTFT、吞吐、错误模式、指令遵循、推理泄露、
引用/跨公司隔离、工具选择/顺序/参数，以及上线并发与限流建议。
"""
    store.write_text("README_FOR_ANALYSIS.md", readme)
    bundle = store.run_dir / "analysis_bundle.zip"
    with zipfile.ZipFile(bundle, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for path in sorted(store.run_dir.rglob("*")):
            if path.is_file() and path != bundle:
                archive.write(path, path.relative_to(store.run_dir))
    bundle.chmod(0o600)
    return bundle


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="一键执行 LLM 并发、内容质量、溯源与工具调用压力测试"
    )
    parser.add_argument(
        "--suite",
        choices=("smoke", "quality", "load", "tools", "full", "soak"),
        default="full",
        help="测试套件；默认 full",
    )
    parser.add_argument(
        "--target",
        choices=("proxy", "upstream", "both"),
        default="proxy",
        help="测试 LiteLLM 代理、当前上游或两者；默认 proxy",
    )
    parser.add_argument("--proxy-url", default="http://127.0.0.1:4000/v1")
    parser.add_argument("--proxy-model", default=None)
    parser.add_argument(
        "--proxy-api-key", default=os.environ.get("LLM_STRESS_PROXY_API_KEY", "sk-local-stress")
    )
    parser.add_argument("--upstream-config", default=str(DEFAULT_CONFIG))
    parser.add_argument("--upstream-model", default=None)
    parser.add_argument(
        "--concurrency",
        default="1,2,4,8,16",
        help="逗号分隔的并发阶梯；默认 1,2,4,8,16",
    )
    parser.add_argument(
        "--requests-per-level",
        type=int,
        default=20,
        help="每个并发阶梯的请求数；full/load 默认 20",
    )
    parser.add_argument(
        "--tool-repetitions", type=int, default=2, help="每条工具用例重复次数"
    )
    parser.add_argument(
        "--duration-seconds", type=int, default=300, help="soak 套件持续秒数"
    )
    parser.add_argument("--timeout", type=float, default=120.0)
    parser.add_argument(
        "--max-total-tokens",
        type=int,
        default=2_000_000,
        help="单次运行的实际总 Token 软上限，0 表示不限",
    )
    parser.add_argument(
        "--real-evidence-cases",
        type=int,
        default=4,
        help="从本地 SQLite 只读抽取的真实证据用例数；0 表示关闭",
    )
    parser.add_argument("--golden-cases", default=str(DEFAULT_GOLDEN_CASES))
    parser.add_argument("--tool-cases", default=str(DEFAULT_TOOL_CASES))
    parser.add_argument("--output-root", default=str(DEFAULT_OUTPUT_ROOT))
    parser.add_argument("--run-id", default=None)
    parser.add_argument("--seed", type=int, default=20260721)
    parser.add_argument(
        "--fail-on-gate",
        action="store_true",
        help="有硬门槛失败时以状态码 2 退出；默认仍生成完整结果并以 0 退出",
    )
    parser.add_argument(
        "--list-cases", action="store_true", help="列出用例后退出，不发送请求"
    )
    return parser


def _parse_concurrency(value: str) -> list[int]:
    try:
        levels = sorted({int(item.strip()) for item in value.split(",") if item.strip()})
    except ValueError as exc:
        raise ValueError("--concurrency must contain comma-separated integers") from exc
    if not levels or any(level <= 0 for level in levels):
        raise ValueError("all concurrency levels must be positive")
    return levels


def _git_metadata() -> dict[str, Any]:
    metadata: dict[str, Any] = {}
    try:
        metadata["commit"] = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=ROOT_DIR,
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()
        status = subprocess.run(
            ["git", "status", "--porcelain"],
            cwd=ROOT_DIR,
            check=True,
            capture_output=True,
            text=True,
        ).stdout
        metadata["dirty"] = bool(status.strip())
        metadata["changed_path_count"] = len(status.splitlines())
    except (OSError, subprocess.SubprocessError):
        metadata["available"] = False
    return metadata


async def execute_run(args: argparse.Namespace) -> tuple[int, Path, Path]:
    random.seed(args.seed)
    concurrency_levels = _parse_concurrency(args.concurrency)
    if args.requests_per_level <= 0:
        raise ValueError("--requests-per-level must be positive")
    if args.tool_repetitions <= 0:
        raise ValueError("--tool-repetitions must be positive")
    cases = load_jsonl(Path(args.golden_cases).expanduser().resolve())
    real_cases = load_real_evidence_cases(args.real_evidence_cases)
    cases.extend(real_cases)
    tool_cases = load_jsonl(Path(args.tool_cases).expanduser().resolve())
    targets = load_targets(args)

    run_id = args.run_id or (
        datetime.now().astimezone().strftime("%Y%m%d-%H%M%S") + f"-{secrets.token_hex(3)}"
    )
    store = ArtifactStore(Path(args.output_root).expanduser(), run_id)
    started_epoch = time.time()
    manifest: dict[str, Any] = {
        "schema_version": "1.0",
        "run_id": run_id,
        "status": "running",
        "started_at": utc_iso(started_epoch),
        "suite": args.suite,
        "targets": [target.safe_dict() for target in targets],
        "settings": {
            "concurrency": concurrency_levels,
            "requests_per_level": args.requests_per_level,
            "tool_repetitions": args.tool_repetitions,
            "duration_seconds": args.duration_seconds,
            "timeout_seconds": args.timeout,
            "max_total_tokens": args.max_total_tokens,
            "seed": args.seed,
            "real_evidence_cases": len(real_cases),
            "production_write_tools_enabled": False,
            "tool_results_are_simulated": True,
        },
        "cases": [case["id"] for case in cases],
        "tool_cases": [case["id"] for case in tool_cases],
        "host": {
            "platform": platform.platform(),
            "python": sys.version,
            "cpu_count": os.cpu_count(),
        },
        "git": _git_metadata(),
        "security": {
            "api_keys_persisted": False,
            "artifact_permissions": "directories 0700, files 0600",
            "real_evidence_local_only": True,
        },
    }
    store.write_json("manifest.json", manifest)
    store.write_text(
        "cases/golden_cases.snapshot.jsonl",
        "".join(json.dumps(case, ensure_ascii=False) + "\n" for case in cases),
    )
    store.write_text(
        "cases/tool_cases.snapshot.jsonl",
        "".join(json.dumps(case, ensure_ascii=False) + "\n" for case in tool_cases),
    )

    print(f"Run ID: {run_id}", flush=True)
    print(f"结果目录: {store.run_dir}", flush=True)
    print(
        f"套件: {args.suite}; 目标: {', '.join(target.name for target in targets)}; "
        f"并发: {concurrency_levels}",
        flush=True,
    )

    results: list[dict[str, Any]] = []
    tool_traces: list[dict[str, Any]] = []
    preflights: list[dict[str, Any]] = []
    token_budget = TokenBudget(args.max_total_tokens)
    system_samples: list[dict[str, Any]] = []
    stop_system = asyncio.Event()
    system_task = asyncio.create_task(sample_local_processes(stop_system, system_samples))
    interrupted = False
    run_error: str | None = None

    try:
        sequence = 0
        for target in targets:
            print(f"\n[{target.name}] 预检 {target.base_url} / {target.model}", flush=True)
            limits = httpx.Limits(
                max_connections=max(concurrency_levels) + 8,
                max_keepalive_connections=max(concurrency_levels) + 4,
            )
            timeout = httpx.Timeout(args.timeout, connect=min(args.timeout, 20.0))
            async with httpx.AsyncClient(
                timeout=timeout, limits=limits, follow_redirects=True
            ) as client:
                preflight = await run_preflight(client, target, store)
                preflights.append(preflight)
                print(
                    f"[{target.name}] 基础={preflight['basic_ready']} "
                    f"流式={preflight['stream_ready']} "
                    f"工具={preflight['tool_capability']['status']}",
                    flush=True,
                )
                if not preflight["basic_ready"]:
                    print(f"[{target.name}] 基础预检失败，跳过该目标的负载。", flush=True)
                    continue

                stop_provider = asyncio.Event()
                provider_task = asyncio.create_task(
                    sample_provider_metrics(target, stop_provider, store)
                )
                try:
                    if args.suite == "smoke":
                        smoke_cases = cases[: min(2, len(cases))]
                        print(f"[{target.name}] smoke: {len(smoke_cases)} 个请求", flush=True)
                        level_results = await run_concurrency_level(
                            client,
                            target,
                            smoke_cases,
                            1,
                            len(smoke_cases),
                            sequence,
                            store,
                            token_budget,
                        )
                        results.extend(level_results)
                        sequence += len(smoke_cases)
                    elif args.suite == "quality":
                        print(f"[{target.name}] quality: {len(cases)} 个用例", flush=True)
                        level_results = await run_concurrency_level(
                            client,
                            target,
                            cases,
                            1,
                            len(cases),
                            sequence,
                            store,
                            token_budget,
                        )
                        results.extend(level_results)
                        sequence += len(cases)
                    elif args.suite in {"load", "full"}:
                        count = max(args.requests_per_level, len(cases))
                        for level in concurrency_levels:
                            print(
                                f"[{target.name}] 并发 {level}: {count} 个请求",
                                flush=True,
                            )
                            level_results = await run_concurrency_level(
                                client,
                                target,
                                cases,
                                level,
                                count,
                                sequence,
                                store,
                                token_budget,
                            )
                            results.extend(level_results)
                            sequence += count
                            level_metric = _metric_group(level_results)
                            print(
                                f"[{target.name}] c={level} 成功率="
                                f"{level_metric['success_rate']} p95="
                                f"{level_metric['latency_ms']['p95']}ms RPS="
                                f"{level_metric['throughput_rps']}",
                                flush=True,
                            )
                            if token_budget.exhausted:
                                print("Token 预算已用尽，停止后续并发阶梯。", flush=True)
                                break
                    elif args.suite == "soak":
                        level = concurrency_levels[-1]
                        print(
                            f"[{target.name}] soak: 并发 {level}，"
                            f"持续 {args.duration_seconds} 秒",
                            flush=True,
                        )
                        soak_results = await run_soak(
                            client,
                            target,
                            cases,
                            level,
                            args.duration_seconds,
                            store,
                            token_budget,
                        )
                        results.extend(soak_results)
                        sequence += len(soak_results)

                    if args.suite in {"full", "tools"}:
                        capability = preflight["tool_capability"]["status"]
                        if capability == "AVAILABLE":
                            expanded_tool_cases = [
                                case
                                for _ in range(args.tool_repetitions)
                                for case in tool_cases
                            ]
                            print(
                                f"[{target.name}] 工具准确性: "
                                f"{len(expanded_tool_cases)} 条轨迹（本地模拟返回）",
                                flush=True,
                            )
                            tool_tasks = [
                                asyncio.create_task(
                                    run_tool_case(
                                        client,
                                        target,
                                        case,
                                        index,
                                        store,
                                        token_budget,
                                    )
                                )
                                for index, case in enumerate(expanded_tool_cases)
                            ]
                            for task in asyncio.as_completed(tool_tasks):
                                tool_traces.append(await task)
                        else:
                            block = {
                                "target": target.name,
                                "status": capability,
                                "reason": preflight["tool_capability"]["reason"],
                                "timestamp": utc_iso(),
                            }
                            await store.append_jsonl("tool_capability_blocks.jsonl", block)
                            print(
                                f"[{target.name}] 工具测试 {capability}: {block['reason']}",
                                flush=True,
                            )
                finally:
                    stop_provider.set()
                    await provider_task
    except asyncio.CancelledError:
        interrupted = True
    except Exception as exc:  # noqa: BLE001 - preserve a partial analysis bundle
        run_error = _redact(str(exc), [target.api_key for target in targets])
    finally:
        stop_system.set()
        await system_task

    ended_epoch = time.time()
    summary = build_summary(results, tool_traces, preflights, started_epoch, ended_epoch)
    if interrupted:
        summary["verdict"] = "INTERRUPTED"
    if run_error:
        summary["verdict"] = "ERROR"
        summary["run_error"] = run_error
    store.write_json("summary.json", summary)
    store.write_text("summary.md", summary_markdown(summary, run_id))
    write_metrics_csv(store, summary)
    write_system_metrics(store, system_samples)

    for relative in (
        "failures.jsonl",
        "tool_traces.jsonl",
        "tool_capability_blocks.jsonl",
        "evidence_checks.jsonl",
        "provider_metrics.jsonl",
    ):
        path = store.run_dir / relative
        if not path.exists():
            path.touch(mode=0o600)
            path.chmod(0o600)

    for row in results:
        evaluation = row.get("evaluation") or {}
        await store.append_jsonl(
            "evidence_checks.jsonl",
            {
                "request_id": row.get("request_id"),
                "target": row.get("target"),
                "case_id": row.get("case_id"),
                "category": row.get("category"),
                "concurrency": row.get("concurrency"),
                "passed": evaluation.get("passed"),
                "score": evaluation.get("score"),
                "failed_checks": evaluation.get("failed_checks"),
                "checks": evaluation.get("checks"),
                "citations": evaluation.get("citations"),
            },
        )
        if row.get("status") != "success" or not evaluation.get("passed"):
            await store.append_jsonl(
                "failures.jsonl",
                {
                    "request_id": row.get("request_id"),
                    "target": row.get("target"),
                    "case_id": row.get("case_id"),
                    "concurrency": row.get("concurrency"),
                    "status": row.get("status"),
                    "status_code": row.get("status_code"),
                    "error": row.get("error"),
                    "failed_checks": evaluation.get("failed_checks"),
                    "response_file": f"responses/{row.get('request_id')}.json",
                },
            )
    for trace in tool_traces:
        if not (trace.get("evaluation") or {}).get("passed"):
            await store.append_jsonl(
                "failures.jsonl",
                {
                    "trace_id": trace.get("trace_id"),
                    "target": trace.get("target"),
                    "case_id": trace.get("case_id"),
                    "status": trace.get("status"),
                    "failed_checks": (trace.get("evaluation") or {}).get(
                        "failed_checks"
                    ),
                    "trace_file": f"tool_traces/{trace.get('trace_id')}.json",
                },
            )

    manifest.update(
        {
            "status": (
                "interrupted"
                if interrupted
                else ("error" if run_error else "completed")
            ),
            "ended_at": utc_iso(ended_epoch),
            "verdict": summary["verdict"],
            "actual_total_tokens": token_budget.used,
            "request_count": len(results),
            "tool_trace_count": len(tool_traces),
            "run_error": run_error,
        }
    )
    store.write_json("manifest.json", manifest)
    bundle = create_bundle(store)

    print("\n测试完成", flush=True)
    print(f"结论: {summary['verdict']}", flush=True)
    print(f"报告: {store.run_dir / 'summary.md'}", flush=True)
    print(f"分析包: {bundle}", flush=True)
    if interrupted:
        return 130, store.run_dir, bundle
    if run_error or not any(item.get("basic_ready") for item in preflights):
        return 1, store.run_dir, bundle
    if args.fail_on_gate and summary["verdict"] == "FAIL":
        return 2, store.run_dir, bundle
    return 0, store.run_dir, bundle


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if args.list_cases:
        cases = load_jsonl(Path(args.golden_cases).expanduser().resolve())
        cases.extend(load_real_evidence_cases(args.real_evidence_cases))
        tool_cases = load_jsonl(Path(args.tool_cases).expanduser().resolve())
        print("普通/质量用例：")
        for case in cases:
            print(f"  {case['id']}: {case.get('category')}")
        print("工具用例：")
        for case in tool_cases:
            print(f"  {case['id']}: {' -> '.join(case.get('expected_tools') or ['不调用'])}")
        return 0
    try:
        code, _, _ = asyncio.run(execute_run(args))
        return code
    except (OSError, ValueError, yaml.YAMLError) as exc:
        parser.error(str(exc))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
