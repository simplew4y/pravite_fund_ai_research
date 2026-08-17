from __future__ import annotations

import hashlib
import json
import re
from collections import defaultdict
from pathlib import Path
from typing import Any, Iterable

from .io_utils import read_json, sha256_file, write_json, write_jsonl
from .report_models import ClaimRubric, ResearchTask, SourceDocument


DATASET_POLICY = {
    "lotus": {"visibility": "internal", "mode": "company_capability", "entity": "Lotus Technology", "batch_size": 15},
    "zeekr": {"visibility": "internal", "mode": "company_capability", "entity": "Zeekr", "batch_size": 15},
    "financebench": {"visibility": "public", "mode": "entity", "min_claims": 3},
    "finder": {"visibility": "public", "mode": "entity", "min_claims": 2},
    "secque": {"visibility": "public", "mode": "category_batch", "batch_size": 10},
}


SECTIONS = {
    "company_overview": ("Executive Summary", "Company and Business Overview", "Investment View", "Sources"),
    "financial_analysis": ("Executive Summary", "Historical Financial Performance", "Key Drivers", "Investment View", "Sources"),
    "ownership_governance": ("Executive Summary", "Ownership and Governance", "Transaction or Listing Structure", "Risks", "Sources"),
    "risk_outlook": ("Executive Summary", "Material Risks", "Catalysts and Outlook", "Investment View", "Sources"),
    "comparison": ("Executive Summary", "Cross-company Comparison", "Drivers and Interpretation", "Risks and Limitations", "Sources"),
}


def _digest(value: str, length: int = 12) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()[:length]


def _dataset_name(raw: dict[str, Any], path: Path) -> str:
    value = str(raw.get("dataset") or path.stem).lower()
    if "zeekr" in value:
        return "zeekr"
    if "lotus" in value:
        return "lotus"
    if "finance" in value:
        return "financebench"
    if "finder" in value:
        return "finder"
    if "sec" in value:
        return "secque"
    return path.stem.lower()


def _capability(question: str, extra: dict[str, Any]) -> str:
    text = question.casefold()
    if any(x in text for x in ("compare", "versus", " vs ", "对比", "比较")):
        return "comparison"
    if any(x in text for x in ("revenue", "margin", "cash", "income", "expense", "ratio", "收入", "利润", "毛利", "现金", "%")):
        return "financial_analysis"
    if any(x in text for x in ("ownership", "shareholder", "vie", "holding", "股权", "持股", "架构", "上市")):
        return "ownership_governance"
    if any(x in text for x in ("risk", "outlook", "regulation", "control", "风险", "展望", "监管", "管制")):
        return "risk_outlook"
    category = str(extra.get("category", "")).casefold()
    if any(x in category for x in ("risk", "footnote")):
        return "risk_outlook"
    return "company_overview"


def _entities(dataset: str, row: dict[str, Any]) -> tuple[str, ...]:
    extra = row.get("extra") or {}
    if dataset in {"lotus", "zeekr"}:
        return (DATASET_POLICY[dataset]["entity"],)
    if dataset == "financebench":
        return (str(extra.get("company") or "Unknown"),)
    paths = [str(x.get("path") or "") for x in row.get("source_pdfs", [])]
    if dataset == "finder":
        found = [m.group(1) for path in paths if (m := re.search(r"/magic_pdf_out/([^/]+)/", path))]
        return tuple(dict.fromkeys(found or ["Unknown"]))
    # SEC-QA often embeds both companies in the natural-language requirement;
    # keep the primary filing entity plus the full requirement for judge context.
    found = []
    for path in paths:
        name = Path(path).stem
        name = re.split(r"_(?:10K|10Q)_\d", name, maxsplit=1)[0]
        if name:
            found.append(name.replace("_", " ").title())
    return tuple(dict.fromkeys(found or ["Cross-company set"]))


def _documents(row: dict[str, Any]) -> tuple[SourceDocument, ...]:
    merged: dict[str, SourceDocument] = {}
    for raw in row.get("source_pdfs", []):
        path = str(raw.get("path") or "")
        source_file = str(raw.get("source_file") or "")
        if not path and not source_file:
            continue
        key = path or f"unresolved:{source_file}"
        doc_id = f"doc-{_digest(key)}"
        pages = tuple(dict.fromkeys(str(x) for x in (raw.get("pages") or [])))
        prior = merged.get(doc_id)
        if prior:
            pages = tuple(dict.fromkeys((*prior.pages, *pages)))
        merged[doc_id] = SourceDocument(doc_id, path, pages, source_file)
    return tuple(merged.values())


def import_claims(path: Path, visibility: str | None = None) -> tuple[str, list[ClaimRubric]]:
    raw = read_json(path)
    dataset = _dataset_name(raw, path)
    policy = DATASET_POLICY.get(dataset, {})
    visibility = visibility or str(policy.get("visibility", "internal"))
    claims = []
    for index, row in enumerate(raw.get("entries", [])):
        question = str(row.get("question") or "").strip()
        answer = str(row.get("ground_truth") or "").strip()
        uid = str(row.get("uid") or index)
        if not question or not answer:
            continue
        extra = row.get("extra") or {}
        claims.append(ClaimRubric(
            claim_id=f"{dataset}-{uid}", dataset=dataset, question=question,
            expected_answer=answer, entities=_entities(dataset, row),
            capability=_capability(question, extra), source_documents=_documents(row),
            visibility=visibility, metadata={"source_uid": uid, "extra": extra, "status": row.get("status")},
        ))
    return dataset, claims


def _task(group_id: str, claims: list[ClaimRubric], capability: str, visibility: str) -> ResearchTask:
    entities = tuple(dict.fromkeys(entity for claim in claims for entity in claim.entities))
    documents = tuple(dict.fromkeys(doc.document_id for claim in claims for doc in claim.source_documents))
    entity_label = ", ".join(entities[:4]) + (" et al." if len(entities) > 4 else "")
    title = f"{entity_label} — {capability.replace('_', ' ').title()} Research Note"
    objective = (
        f"Prepare an evidence-grounded investment research report on {entity_label}. "
        "Synthesize the supplied filings into an investment-relevant view, distinguish facts from inference, "
        "respect reporting-period boundaries, and cite every material quantitative claim."
    )
    return ResearchTask(
        task_id=f"report-{_digest(group_id)}", title=title, objective=objective,
        entities=entities, as_of_date="source_bundle_cutoff", audience="private-fund investment committee",
        required_sections=SECTIONS.get(capability, SECTIONS["company_overview"]),
        research_requirements=tuple(claim.question for claim in claims),
        source_document_ids=documents, claim_ids=tuple(claim.claim_id for claim in claims),
        visibility=visibility, evaluation_split="hidden" if visibility == "internal" else "dev",
    )


def build_tasks(dataset: str, claims: list[ClaimRubric]) -> tuple[list[ResearchTask], list[str]]:
    policy = DATASET_POLICY.get(dataset, {"mode": "category_batch", "batch_size": 10})
    grouped: dict[str, list[ClaimRubric]] = defaultdict(list)
    if policy["mode"] == "company_capability":
        by_capability: dict[str, list[ClaimRubric]] = defaultdict(list)
        for claim in claims:
            by_capability[claim.capability].append(claim)
        batch_size = int(policy.get("batch_size", 15))
        for capability, rows in by_capability.items():
            for start in range(0, len(rows), batch_size):
                grouped[f"{capability}-{start // batch_size + 1}"] = rows[start:start + batch_size]
    elif policy["mode"] == "entity":
        for claim in claims:
            grouped[claim.entities[0]].append(claim)
    else:
        by_capability: dict[str, list[ClaimRubric]] = defaultdict(list)
        for claim in claims:
            by_capability[claim.capability].append(claim)
        batch_size = int(policy.get("batch_size", 10))
        for capability, rows in by_capability.items():
            for start in range(0, len(rows), batch_size):
                grouped[f"{capability}-{start // batch_size + 1}"] = rows[start:start + batch_size]
    tasks, unassigned = [], []
    minimum = int(policy.get("min_claims", 3))
    for name, rows in sorted(grouped.items()):
        if len(rows) < minimum:
            unassigned.extend(claim.claim_id for claim in rows)
            continue
        capability = rows[0].capability if policy["mode"] != "entity" else _dominant_capability(rows)
        tasks.append(_task(f"{dataset}:{name}", rows, capability, rows[0].visibility))
    return tasks, unassigned


def _dominant_capability(claims: Iterable[ClaimRubric]) -> str:
    counts: dict[str, int] = defaultdict(int)
    for claim in claims:
        counts[claim.capability] += 1
    return max(counts, key=lambda key: (counts[key], key))


def bootstrap_report_benchmark(sources: list[Path], out_dir: Path) -> dict[str, Any]:
    claims: list[ClaimRubric] = []
    tasks: list[ResearchTask] = []
    source_meta = []
    unassigned: list[str] = []
    for path in sources:
        dataset, imported = import_claims(path)
        dataset_tasks, dataset_unassigned = build_tasks(dataset, imported)
        claims.extend(imported)
        tasks.extend(dataset_tasks)
        unassigned.extend(dataset_unassigned)
        source_meta.append({"dataset": dataset, "file": path.name, "sha256": sha256_file(path), "claims": len(imported), "tasks": len(dataset_tasks)})
    public_tasks = [task.to_dict(hidden=False) for task in tasks if task.visibility == "public"]
    internal_tasks = [task.to_dict(hidden=False) for task in tasks if task.visibility == "internal"]
    hidden_tasks = [task.to_dict(hidden=True) for task in tasks]
    hidden_claims = [claim.to_dict(hidden=True) for claim in claims]
    documents = {doc.document_id: doc for claim in claims for doc in claim.source_documents}
    write_jsonl(out_dir / "public" / "tasks.jsonl", public_tasks)
    write_jsonl(out_dir / "internal" / "tasks.jsonl", internal_tasks)
    write_jsonl(out_dir / "hidden" / "tasks_with_claim_ids.jsonl", hidden_tasks)
    write_jsonl(out_dir / "hidden" / "claim_rubrics.jsonl", hidden_claims)
    write_jsonl(out_dir / "hidden" / "source_documents.jsonl", [doc.to_dict(public=False) for doc in documents.values()])
    manifest = {
        "schema_version": "private-fund-report-benchmark/v1",
        "benchmark_unit": "complete_research_report",
        "claims_are": "hidden report-level scoring rubrics, not standalone benchmark tasks",
        "sources": source_meta,
        "counts": {
            "claims": len(claims), "tasks": len(tasks), "public_tasks": len(public_tasks),
            "internal_tasks": len(internal_tasks), "source_documents": len(documents),
            "unassigned_claims": len(unassigned),
        },
        "unassigned_claim_ids": unassigned,
        "security": "hidden/ and internal/ must not be mounted into the target agent runtime",
    }
    write_json(out_dir / "manifest.json", manifest)
    return manifest
