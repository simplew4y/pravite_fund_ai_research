from __future__ import annotations

import hashlib
import re
from collections import Counter, defaultdict
from dataclasses import replace
from difflib import SequenceMatcher

from .models import BenchmarkItem


def normalized_question(value: str) -> str:
    return re.sub(r"\W+", "", value.casefold())


def deduplicate(items: list[BenchmarkItem], threshold: float = 0.92) -> tuple[list[BenchmarkItem], list[dict]]:
    kept: list[BenchmarkItem] = []
    rejected: list[dict] = []
    normalized: list[str] = []
    for item in sorted(items, key=lambda x: x.item_id):
        current = normalized_question(item.question)
        match = next((kept[i] for i, prior in enumerate(normalized) if SequenceMatcher(None, current, prior).ratio() >= threshold), None)
        if match:
            rejected.append({"item_id": item.item_id, "reason": "near_duplicate", "duplicate_of": match.item_id})
        else:
            kept.append(item)
            normalized.append(current)
    return kept, rejected


def assign_splits(items: list[BenchmarkItem], public_ratio: float = 0.4, salt: str = "rsi-v1") -> list[BenchmarkItem]:
    """Deterministic company-stratified split; canonical answers are retained."""
    groups: dict[str, list[BenchmarkItem]] = defaultdict(list)
    for item in items:
        groups[item.company].append(item)
    result: list[BenchmarkItem] = []
    for company_items in groups.values():
        ranked = sorted(
            company_items,
            key=lambda item: hashlib.sha256(f"{salt}:{item.item_id}".encode()).hexdigest(),
        )
        public_count = round(len(ranked) * public_ratio)
        if len(ranked) >= 2 and 0 < public_ratio < 1:
            public_count = min(len(ranked) - 1, max(1, public_count))
        public_ids = {item.item_id for item in ranked[:public_count]}
        result.extend(replace(item, split="public" if item.item_id in public_ids else "internal") for item in ranked)
    return result


def validate_suite(items: list[BenchmarkItem], require_grounding: bool = True) -> dict:
    errors = {item.item_id: item.validation_errors(require_grounding) for item in items}
    errors = {key: value for key, value in errors.items() if value}
    ids = [item.item_id for item in items]
    duplicate_ids = sorted(key for key, count in Counter(ids).items() if count > 1)
    companies = Counter(item.company for item in items)
    capabilities = Counter(capability for item in items for capability in item.capabilities)
    splits = Counter(item.split for item in items)
    return {
        "valid": not errors and not duplicate_ids,
        "item_count": len(items),
        "errors": errors,
        "duplicate_ids": duplicate_ids,
        "coverage": {
            "companies": dict(sorted(companies.items())),
            "capabilities": dict(sorted(capabilities.items())),
            "splits": dict(sorted(splits.items())),
        },
    }


def review_proposals(
    frozen_items: list[BenchmarkItem], proposals: list[BenchmarkItem], novelty_threshold: float = 0.88
) -> tuple[list[BenchmarkItem], list[dict]]:
    """Deterministic critic gate before model/human evidence review."""
    accepted: list[BenchmarkItem] = []
    rejected: list[dict] = []
    reference = list(frozen_items)
    for item in proposals:
        reasons = item.validation_errors(require_grounding=True)
        current = normalized_question(item.question)
        duplicate = next((
            prior for prior in reference
            if SequenceMatcher(None, current, normalized_question(prior.question)).ratio() >= novelty_threshold
        ), None)
        if duplicate:
            reasons.append(f"not novel enough relative to {duplicate.item_id}")
        if item.provenance.generator in {"", "unknown", "imported"}:
            reasons.append("agent proposal must identify its generator")
        if item.provenance.generation_round < 1:
            reasons.append("agent proposal generation_round must be >= 1")
        if reasons:
            rejected.append({"item_id": item.item_id, "reasons": reasons})
        else:
            accepted.append(item)
            reference.append(item)
    return accepted, rejected
