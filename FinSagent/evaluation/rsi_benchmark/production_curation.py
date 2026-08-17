"""Deterministically freeze an evaluator-only full-agent RSI suite."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any, Iterable


PERIOD_RE = re.compile(
    r"(?:fiscal\s+year|quarter|year\s+ended|months?\s+ended|as\s+of|actual|pro\s+forma|"
    r"20\d{2}\s*q[1-4]|20\d{2}年|20\d{2}财年|一季度|二季度|三季度|四季度|前三季度|"
    r"前[0-9一二三四五六七八九十]+个月|上半年|截至)", re.I,
)
TARGET_SCOPE_RE = re.compile(r"nvidia.*(?:china|中国).*(?:data center|数据中心).*(?:export|出口)|(?:export|出口).*(?:china|中国).*nvidia", re.I)


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def normalized_question(value: str) -> str:
    return re.sub(r"\W+", "", value.casefold())


def stable_rank(salt: str, row: dict[str, Any]) -> str:
    return hashlib.sha256(f"{salt}:{row.get('id')}:{row.get('question')}".encode()).hexdigest()


def explicit_company(row: dict[str, Any]) -> str:
    value = str(row.get("company") or "").strip().casefold()
    if value:
        return value
    question = str(row.get("question") or "").casefold()
    for markers, company in (("zeekr 极氪", "zeekr"), ("lotus 路特斯", "lotus"), ("nvidia 英伟达", "nvidia")):
        if any(marker in question for marker in markers.split()):
            return company
    return "unknown"


def base_eligible(row: dict[str, Any]) -> bool:
    return bool(
        str(row.get("id") or "").strip()
        and len(str(row.get("question") or "").strip()) >= 8
        and str(row.get("ground_truth_answer") or "").strip()
        and row.get("key_points")
        and row.get("retrieved_chunks")
        and row.get("pre_rerank_candidates")
    )


def period_eligible(row: dict[str, Any]) -> bool:
    return base_eligible(row) and bool(PERIOD_RE.search(str(row.get("question") or "")))


def period_complexity(row: dict[str, Any]) -> int:
    evidence = " ".join(str(x.get("page_content") or "")[:1200] for x in row.get("retrieved_chunks", [])[:5])
    text = " ".join((str(row.get("question") or ""), str(row.get("ground_truth_answer") or ""), evidence))
    tokens = {match.group(0).casefold() for match in PERIOD_RE.finditer(text)}
    years = set(re.findall(r"20\d{2}", text))
    return len(tokens) + len(years)


def diverse_take(rows: list[dict[str, Any]], count: int, *, salt: str, score_first: bool = False) -> list[dict[str, Any]]:
    groups: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        groups[explicit_company(row)].append(row)
    for company, values in groups.items():
        values.sort(key=lambda row: ((-period_complexity(row)) if score_first else 0, stable_rank(salt, row)))
    selected: list[dict[str, Any]] = []
    companies = sorted(groups)
    while len(selected) < count and any(groups.values()):
        for company in companies:
            if groups[company] and len(selected) < count:
                selected.append(groups[company].pop(0))
    if len(selected) < count:
        raise ValueError(f"only {len(selected)} eligible rows for requested {count}")
    return selected


def evidence_refs(row: dict[str, Any]) -> list[dict[str, Any]]:
    refs = []
    for position, chunk in enumerate(row.get("retrieved_chunks", [])):
        metadata = chunk.get("metadata") if isinstance(chunk.get("metadata"), dict) else {}
        content = str(chunk.get("page_content") or "")
        refs.append({
            "position": position,
            "content_sha256": hashlib.sha256(content.encode()).hexdigest(),
            "filename": str(metadata.get("filename") or metadata.get("source") or ""),
            "page": str(metadata.get("page_number") or metadata.get("page") or ""),
            "date_published": str(metadata.get("date_published") or ""),
        })
    return refs


def private_case(row: dict[str, Any], suite: str, source_path: Path) -> dict[str, Any]:
    question = str(row["question"]).strip()
    expected_trigger = False if suite == "negative_noop" else "conditional_on_generated_leakage"
    return {
        "case_id": f"prod-{suite}-{row['id']}",
        "suite": suite,
        "capability": "period_source_control",
        "company": explicit_company(row),
        "target": {"question": question},
        "rubric": {
            "ground_truth_answer": str(row["ground_truth_answer"]),
            "key_points": [str(x) for x in row.get("key_points", [])],
            "expected_period_markers": sorted(set(match.group(0) for match in PERIOD_RE.finditer(question))),
            "expected_skill_trigger": expected_trigger,
            "critical_errors": [
                "company_confusion", "period_confusion", "actual_estimate_confusion",
                "unit_or_currency_error", "unsupported_claim", "forbidden_source",
            ],
        },
        "evidence_refs": evidence_refs(row),
        "provenance": {
            "source_dataset": str(source_path),
            "source_dataset_sha256": sha256_file(source_path),
            "source_record_id": str(row["id"]),
            "source_doc": str(row.get("source_doc") or ""),
            "source_file": str(row.get("source_file") or ""),
        },
    }


def freeze_suite(*, train_path: Path, test_path: Path, out_dir: Path, salt: str = "prod-period-source-v2") -> dict[str, Any]:
    train_all = [row for row in json.loads(train_path.read_text()) if base_eligible(row)]
    test_all = [row for row in json.loads(test_path.read_text()) if base_eligible(row)]
    train = [row for row in train_all if period_eligible(row)]
    test = [row for row in test_all if period_eligible(row)]
    seen: set[str] = set()

    targeted_pool = [row for row in train if not TARGET_SCOPE_RE.search(str(row.get("question") or ""))]
    targeted = diverse_take(targeted_pool, 20, salt=salt + ":targeted", score_first=True)
    seen.update(normalized_question(row["question"]) for row in targeted)
    negative_pool = [
        row for row in train_all
        if normalized_question(row["question"]) not in seen and not TARGET_SCOPE_RE.search(str(row["question"]))
    ]
    negative = diverse_take(negative_pool, 20, salt=salt + ":negative")
    seen.update(normalized_question(row["question"]) for row in negative)
    fresh_pool = [
        row for row in test
        if normalized_question(row["question"]) not in seen and not TARGET_SCOPE_RE.search(str(row["question"]))
    ]
    fresh = diverse_take(fresh_pool, 30, salt=salt + ":fresh", score_first=True)

    cases = [
        *(private_case(row, "targeted", train_path) for row in targeted),
        *(private_case(row, "negative_noop", train_path) for row in negative),
        *(private_case(row, "fresh_internal", test_path) for row in fresh),
    ]
    validation = validate_frozen_cases(cases)
    if not validation["valid"]:
        raise ValueError(json.dumps(validation, ensure_ascii=False))
    out_dir.mkdir(parents=True, exist_ok=False)
    private_path = out_dir / "cases.private.jsonl"
    target_path = out_dir / "target_questions.jsonl"
    private_path.write_text("".join(json.dumps(case, ensure_ascii=False, sort_keys=True) + "\n" for case in cases), encoding="utf-8")
    target_path.write_text("".join(json.dumps({"case_id": case["case_id"], **case["target"]}, ensure_ascii=False, sort_keys=True) + "\n" for case in cases), encoding="utf-8")
    manifest = {
        "schema_version": "rsi-production-evaluator/v2",
        "suite_id": "period_source_full_agent_v2_2",
        "salt": salt,
        "sources": {"train": {"sha256": sha256_file(train_path)}, "test": {"sha256": sha256_file(test_path)}},
        "counts": dict(Counter(case["suite"] for case in cases)),
        "companies": dict(Counter(case["company"] for case in cases)),
        "validation": validation,
        "private_cases_sha256": sha256_file(private_path),
        "target_questions_sha256": sha256_file(target_path),
        "hidden_content_committed": False,
    }
    (out_dir / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return manifest


def validate_frozen_cases(cases: list[dict[str, Any]]) -> dict[str, Any]:
    errors: list[str] = []
    ids = [case["case_id"] for case in cases]
    questions = [normalized_question(case["target"]["question"]) for case in cases]
    if len(ids) != len(set(ids)): errors.append("duplicate case ids")
    if len(questions) != len(set(questions)): errors.append("duplicate normalized questions")
    expected = {"targeted": 20, "negative_noop": 20, "fresh_internal": 30}
    counts = Counter(case["suite"] for case in cases)
    if dict(counts) != expected: errors.append(f"unexpected suite counts: {dict(counts)}")
    for case in cases:
        if not case["rubric"]["ground_truth_answer"]: errors.append(f"{case['case_id']}: missing GT")
        if not case["rubric"]["key_points"]: errors.append(f"{case['case_id']}: missing key points")
        if not case["evidence_refs"]: errors.append(f"{case['case_id']}: missing evidence")
    return {"valid": not errors, "errors": errors, "case_count": len(cases)}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--train", type=Path, required=True)
    parser.add_argument("--test", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--salt", default="prod-period-source-v2")
    args = parser.parse_args()
    print(json.dumps(freeze_suite(train_path=args.train, test_path=args.test, out_dir=args.out, salt=args.salt), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
