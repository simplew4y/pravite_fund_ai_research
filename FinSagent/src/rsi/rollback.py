"""Audited rollback intent. Deployment execution remains an operator action."""

from __future__ import annotations

from dataclasses import asdict, dataclass
from datetime import datetime, timezone


@dataclass(frozen=True)
class RollbackRequest:
    candidate_id: str
    promoted_artifact_digest: str
    restore_artifact_digest: str
    reason: str
    requested_by: str
    approval_ticket: str
    timestamp: str

    def to_dict(self) -> dict:
        return asdict(self)


def request_rollback(*, candidate_id: str, promoted_digest: str, restore_digest: str, reason: str, requested_by: str, approval_ticket: str) -> RollbackRequest:
    if not all(value.strip() for value in (candidate_id, promoted_digest, restore_digest, reason, requested_by, approval_ticket)):
        raise ValueError("rollback requires exact artifacts, rationale, requester, and approval ticket")
    if promoted_digest == restore_digest:
        raise ValueError("restore artifact must differ from promoted artifact")
    return RollbackRequest(candidate_id, promoted_digest, restore_digest, reason, requested_by, approval_ticket, datetime.now(timezone.utc).isoformat())
