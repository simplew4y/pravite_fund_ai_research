"""Deterministically cluster independently-confirmed failures by mechanism."""

from __future__ import annotations

import hashlib
from collections import defaultdict
from typing import Iterable

from .models import FailureCluster, FailureRecord


def cluster_failures(records: Iterable[FailureRecord], *, min_cluster_size: int = 1) -> list[FailureCluster]:
    buckets: dict[tuple[str, ...], list[FailureRecord]] = defaultdict(list)
    for record in records:
        if not record.confirmed:
            continue
        signature = (
            record.failure_type,
            record.capability,
            record.stage,
            record.scope or "any_scope",
            record.temporal_scope or "any_period",
            record.evidence_type or "any_evidence",
        )
        buckets[signature].append(record)
    clusters: list[FailureCluster] = []
    for signature, rows in sorted(buckets.items()):
        if len(rows) < min_cluster_size:
            continue
        digest = hashlib.sha256("|".join(signature).encode("utf-8")).hexdigest()[:12]
        clusters.append(FailureCluster(
            cluster_id=f"fc-{digest}",
            signature=signature,
            failure_type=signature[0],
            capability=signature[1],
            stage=signature[2],
            count=len(rows),
            case_ids=tuple(sorted({row.case_id for row in rows})),
            companies=tuple(sorted({row.company for row in rows if row.company})),
            temporal_scopes=tuple(sorted({row.temporal_scope for row in rows if row.temporal_scope})),
            evidence_types=tuple(sorted({row.evidence_type for row in rows if row.evidence_type})),
        ))
    return clusters
