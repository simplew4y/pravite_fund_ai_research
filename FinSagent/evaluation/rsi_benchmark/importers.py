from __future__ import annotations

import hashlib
import re
from pathlib import Path

from .io_utils import read_json
from .models import BenchmarkItem, EvidenceRef, Provenance


CAPABILITY_RULES = (
    ("temporal_reasoning", ("year", "quarter", "fiscal", "同比", "年度", "季度", "截至", "202")),
    ("numeric_reasoning", ("revenue", "margin", "loss", "cash", "收入", "利润", "毛利", "%", "增长")),
    ("risk_analysis", ("risk", "control", "regulation", "风险", "管制", "监管")),
    ("corporate_structure", ("vie", "holding", "ownership", "股权", "架构", "控股")),
    ("business_analysis", ("business", "product", "market", "业务", "产品", "市场")),
)


def stable_id(company: str, question: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", company.lower()).strip("-") or "company"
    suffix = hashlib.sha256(question.strip().encode("utf-8")).hexdigest()[:12]
    return f"{slug}-{suffix}"


def infer_language(question: str) -> str:
    return "zh" if re.search(r"[\u4e00-\u9fff]", question) else "en"


def infer_capabilities(question: str, metadata: dict | None = None) -> tuple[str, ...]:
    text = question.lower()
    found = [name for name, markers in CAPABILITY_RULES if any(marker in text for marker in markers)]
    category = str((metadata or {}).get("category", "")).strip()
    if category:
        found.append(category)
    return tuple(dict.fromkeys(found or ["evidence_retrieval"]))


def _make_item(
    *, company: str, question: str, answer: str, key_points: list[str], source: Path,
    source_record: str, metadata: dict | None = None,
) -> BenchmarkItem:
    return BenchmarkItem(
        item_id=stable_id(company, question),
        company=company,
        question=question.strip(),
        answer_key=answer.strip(),
        key_points=tuple(x.strip() for x in key_points if x.strip()) or (answer.strip(),),
        capabilities=infer_capabilities(question, metadata),
        language=infer_language(question),
        temporal_scope=str((metadata or {}).get("evidence_cutoff", "")),
        evidence=(EvidenceRef(source_id=source.name, uri=str(source), locator=source_record),),
        provenance=Provenance(
            origin="finsagent_seed", generator="imported", source_record=source_record
        ),
    )


def import_dataset(path: Path, company: str = "") -> list[BenchmarkItem]:
    """Import FinSAgent flat QA, judge results, or screenshot QA output."""
    data = read_json(path)
    rows = data.get("items", data) if isinstance(data, dict) else data
    if not isinstance(rows, list):
        raise ValueError(f"Unsupported dataset shape: {path}")
    items: list[BenchmarkItem] = []
    for row_index, row in enumerate(rows):
        if isinstance(row.get("qa_pairs"), list):
            row_company = company or _company_from_text(" ".join(x.get("query", "") for x in row["qa_pairs"]))
            for qa_index, qa in enumerate(row["qa_pairs"]):
                question = str(qa.get("query", ""))
                answer = str(qa.get("ground_truth_answer", ""))
                items.append(_make_item(
                    company=row_company or "unknown", question=question, answer=answer,
                    key_points=[answer], source=path, source_record=f"{row_index}.qa_pairs.{qa_index}",
                ))
            continue
        question = str(row.get("question") or row.get("original_question") or "")
        answer = str(
            row.get("ground_truth_answer") or row.get("gt_answer") or row.get("original_answer") or row.get("answer") or ""
        )
        metadata = row.get("diagnostic_meta") or {}
        row_company = company or str(metadata.get("company", "")) or _company_from_text(question)
        key_points = row.get("key_points") or ([answer] if answer else [])
        items.append(_make_item(
            company=row_company or "unknown", question=question, answer=answer,
            key_points=[str(x) for x in key_points], source=path,
            source_record=str(row.get("qid", row_index)), metadata=metadata,
        ))
    return items


def _company_from_text(text: str) -> str:
    lowered = text.lower()
    for marker, company in (
        ("zeekr", "Zeekr"), ("极氪", "Zeekr"), ("lotus", "Lotus Technology"),
        ("路特斯", "Lotus Technology"), ("nvidia", "NVIDIA"), ("英伟达", "NVIDIA"),
    ):
        if marker in lowered:
            return company
    return ""
