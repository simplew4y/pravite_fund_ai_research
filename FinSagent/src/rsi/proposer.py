"""Generate multiple bounded hypotheses per failure cluster; never self-apply patches."""

from __future__ import annotations

import hashlib
from dataclasses import dataclass

from .models import CandidatePatch, FailureCluster, MutationLevel


@dataclass(frozen=True)
class ProposalTemplate:
    level: MutationLevel
    target_path: str
    mechanism: str
    payload: dict


TEMPLATES: dict[str, tuple[ProposalTemplate, ...]] = {
    "period_mismatch": (
        ProposalTemplate(MutationLevel.PARAMETER, "configs/rsi/candidates/period_alignment.yaml", "Tighten explicit period/source compatibility thresholds before synthesis.", {"strategy": "period_compatibility_threshold"}),
        ProposalTemplate(MutationLevel.SKILL, "src/utils/period_source_conflict_repair.py", "Generalize period extraction and reject later-period substitutions when compatible evidence is absent.", {"strategy": "generalize_period_guard"}),
    ),
    "source_conflict": (
        ProposalTemplate(MutationLevel.PARAMETER, "configs/rsi/candidates/source_conflict.yaml", "Require corroboration and compatible source dates before conflict arbitration.", {"strategy": "source_arbitration_threshold"}),
        ProposalTemplate(MutationLevel.SKILL, "src/utils/period_source_conflict_repair.py", "Replace company-specific conflict handling with evidence-scoped arbitration.", {"strategy": "evidence_scoped_arbitration"}),
    ),
    "table_alignment_error": (
        ProposalTemplate(MutationLevel.PARAMETER, "configs/rsi/candidates/table_verification.yaml", "Raise table-verifier confidence requirements for unit and row/column alignment.", {"strategy": "table_confidence_threshold"}),
        ProposalTemplate(MutationLevel.SKILL, "src/utils/table_fact_verifier.py", "Add negative controls for neighboring rows, units, and subtotals.", {"strategy": "table_negative_controls"}),
    ),
    "answer_coverage_failure": (
        ProposalTemplate(MutationLevel.PROMPT, "src/agents/company_researcher/prompts.py", "Make required comparison atoms explicit without injecting answer facts.", {"strategy": "atomic_coverage_prompt"}),
        ProposalTemplate(MutationLevel.SKILL, "src/utils/answer_coverage_repair.py", "Trigger only when evidence supports each missing answer atom.", {"strategy": "evidence_bound_coverage"}),
    ),
    "retrieval_miss": (
        ProposalTemplate(MutationLevel.PARAMETER, "configs/rsi/candidates/retrieval.yaml", "Tune retrieval breadth inside the existing budget.", {"strategy": "retrieval_budget"}),
        ProposalTemplate(MutationLevel.PROMPT, "src/agents/shared.py", "Generate filing-specific metric aliases and period anchors.", {"strategy": "retrieval_query_rewrite"}),
    ),
}

DEFAULT_TEMPLATES = (
    ProposalTemplate(MutationLevel.PROMPT, "src/agents/shared.py", "Clarify evidence, scope, and refusal requirements for the failed capability.", {"strategy": "bounded_prompt"}),
    ProposalTemplate(MutationLevel.SKILL, "src/utils/rsi_candidate_skill.py", "Prototype an isolated skill with explicit trigger/no-op traces.", {"strategy": "isolated_skill"}),
)


def propose_candidates(cluster: FailureCluster, *, max_candidates: int = 3) -> list[CandidatePatch]:
    templates = TEMPLATES.get(cluster.failure_type, DEFAULT_TEMPLATES)
    proposals: list[CandidatePatch] = []
    for index, template in enumerate(templates[:max_candidates], start=1):
        suffix = hashlib.sha256(f"{cluster.cluster_id}|{index}|{template.mechanism}".encode()).hexdigest()[:10]
        proposals.append(CandidatePatch(
            candidate_id=f"cand-{suffix}",
            cluster_id=cluster.cluster_id,
            mutation_level=template.level,
            hypothesis=f"Reducing {cluster.failure_type} in {cluster.capability} will improve targeted cases without protected-set regression.",
            expected_mechanism=template.mechanism,
            target_paths=(template.target_path,),
            target_capabilities=(cluster.capability,),
            target_failure_types=(cluster.failure_type,),
            patch_payload={**template.payload, "source_case_ids": list(cluster.case_ids)},
            requires_human_approval=template.level == MutationLevel.WORKFLOW,
        ))
    return proposals
