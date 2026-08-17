"""Human-governed promotion registry; automated gates cannot promote alone."""

from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from pathlib import Path

from .models import CandidatePatch, PromotionDecision


class PromotionRegistry:
    def __init__(self, path: str | Path) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)

    def promote(self, candidate: CandidatePatch, decision: PromotionDecision, *, reviewer: str, approval_ticket: str) -> dict:
        if decision.decision != "eligible_for_human_review":
            raise ValueError("candidate did not pass automated gates")
        if not reviewer.strip() or not approval_ticket.strip():
            raise ValueError("reviewer and approval_ticket are required")
        entry = {
            "schema_version": "rsi-promotion/v1",
            "candidate_id": candidate.candidate_id,
            "status": "promoted",
            "reviewer": reviewer,
            "approval_ticket": approval_ticket,
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "policy_version": decision.policy_version,
            "target_paths": list(candidate.target_paths),
        }
        descriptor = os.open(self.path, os.O_APPEND | os.O_CREAT | os.O_WRONLY, 0o600)
        try:
            os.write(descriptor, (json.dumps(entry, ensure_ascii=False, sort_keys=True) + "\n").encode("utf-8"))
        finally:
            os.close(descriptor)
        return entry
