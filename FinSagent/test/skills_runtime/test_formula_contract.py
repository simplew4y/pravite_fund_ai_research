import pytest

from skills_runtime.evidence_contract import validate_evidence_contract
from skills_runtime.formula_engine import FormulaError, evaluate_formula
from skills_runtime.models import EvidenceContract, SkillContext


def test_formula_engine_calculates_yoy() -> None:
    assert evaluate_formula("(current - prior) / abs(prior)", {"current": 120, "prior": 100}) == 0.2


@pytest.mark.parametrize(
    "expression",
    [
        "__import__('os').system('id')",
        "value.__class__",
        "open('/tmp/x')",
        "[x for x in (1, 2)]",
    ],
)
def test_formula_engine_rejects_arbitrary_code(expression: str) -> None:
    with pytest.raises(FormulaError):
        evaluate_formula(expression, {"value": 1})


def test_evidence_contract_blocks_out_of_scope_documents() -> None:
    context = SkillContext(
        allowed_doc_ids=["porsche-doc"],
        metric_facts=[
            {
                "metric": "net_profit",
                "value": 10,
                "source_doc_id": "sungrow-doc",
                "unit": "EUR million",
            }
        ],
    )

    decision = validate_evidence_contract(EvidenceContract(unit_required=True), context)

    assert decision.valid is False
    assert "evidence_outside_allowed_doc_ids" in decision.errors


def test_evidence_contract_distinguishes_actual_and_estimate() -> None:
    context = SkillContext(
        allowed_doc_ids=["porsche-doc"],
        metric_facts=[
            {
                "value": 10,
                "source_doc_id": "porsche-doc",
                "actual_or_estimate": "actual",
            },
            {
                "value": 12,
                "source_doc_id": "porsche-doc",
                "actual_or_estimate": "estimate",
            },
        ],
    )

    decision = validate_evidence_contract(EvidenceContract(), context)

    assert decision.valid is False
    assert "actual_estimate_mixed" in decision.errors
