"""Evidence-fusion retrieval policy and context composition."""

from retrieval_control.evidence_fusion import fuse_evidence
from retrieval_control.models import EvidenceConflict, EvidenceFusionResult, RetrievalPolicy
from retrieval_control.policy import decide_retrieval_policy

__all__ = [
    "EvidenceConflict",
    "EvidenceFusionResult",
    "RetrievalPolicy",
    "decide_retrieval_policy",
    "fuse_evidence",
]

