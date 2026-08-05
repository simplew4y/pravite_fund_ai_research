"""Fail-closed validation of financial evidence supplied to a skill."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from skills_runtime.models import EvidenceContract, SkillContext
from utils.retrieval_scope import metadata_source_doc_id


@dataclass(frozen=True)
class ContractDecision:
    valid: bool
    errors: list[str] = field(default_factory=list)


def validate_evidence_contract(
    contract: EvidenceContract,
    context: SkillContext,
    facts: list[dict[str, Any]] | None = None,
) -> ContractDecision:
    errors: list[str] = []
    selected_facts = list(facts if facts is not None else context.metric_facts)
    allowed_ids = {str(doc_id) for doc_id in context.allowed_doc_ids if doc_id}

    if contract.company_scope_required and not allowed_ids:
        errors.append("company_scope_missing")

    evidence_doc_ids: set[str] = set()
    for fact in selected_facts:
        doc_id = str(fact.get("source_doc_id") or fact.get("doc_id") or "")
        if doc_id:
            evidence_doc_ids.add(doc_id)
    for chunk in context.retrieved_chunks:
        doc_id = metadata_source_doc_id(chunk.get("metadata") or {})
        if doc_id:
            evidence_doc_ids.add(doc_id)
    if allowed_ids and evidence_doc_ids - allowed_ids:
        errors.append("evidence_outside_allowed_doc_ids")
    if not contract.allow_cross_company and allowed_ids and evidence_doc_ids - allowed_ids:
        errors.append("cross_company_evidence")
    if contract.source_evidence_required and not evidence_doc_ids:
        errors.append("source_evidence_missing")

    if selected_facts:
        periods = {_normalized(fact.get("period")) for fact in selected_facts if fact.get("period")}
        units = {_normalized(fact.get("unit")) for fact in selected_facts if fact.get("unit")}
        currencies = {_normalized(fact.get("currency")) for fact in selected_facts if fact.get("currency")}
        estimate_types = {
            _normalized(fact.get("actual_or_estimate"))
            for fact in selected_facts
            if fact.get("actual_or_estimate")
        }
        if contract.same_period_required and len(periods) > 1:
            errors.append("period_mismatch")
        if contract.unit_required and (not units or len(units) > 1):
            errors.append("unit_missing_or_mismatched")
        if contract.currency_required and (not currencies or len(currencies) > 1):
            errors.append("currency_missing_or_mismatched")
        if not contract.allow_actual_estimate_mix and len(estimate_types) > 1:
            errors.append("actual_estimate_mixed")

    return ContractDecision(valid=not errors, errors=list(dict.fromkeys(errors)))


def _normalized(value: Any) -> str:
    return str(value or "").strip().lower()
