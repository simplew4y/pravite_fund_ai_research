from __future__ import annotations

import json

from omnigent.tools.builtins import private_fund_dataset as module
from omnigent.tools.builtins.private_fund_dataset import _DatasetStore


class _Response:
    def __init__(self, payload: dict) -> None:
        self._payload = json.dumps(payload).encode("utf-8")

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False

    def read(self, _limit: int) -> bytes:
        return self._payload


def test_evidence_fusion_bridge_is_disabled_without_endpoint(monkeypatch) -> None:
    monkeypatch.delenv("FINSAGENT_EVIDENCE_FUSION_URL", raising=False)

    assert _DatasetStore._fetch_evidence_fusion(query="q", dataset_id="d") == {
        "enabled": False,
        "available": False,
    }


def test_evidence_fusion_bridge_returns_bounded_policy_trace(monkeypatch) -> None:
    monkeypatch.setenv(
        "FINSAGENT_EVIDENCE_FUSION_URL",
        "http://127.0.0.1:5012/retrieval/evidence-fusion",
    )
    captured = {}

    def fake_urlopen(request, timeout):
        captured["body"] = json.loads(request.data.decode("utf-8"))
        captured["timeout"] = timeout
        return _Response(
            {
                "context": "[RAG EVIDENCE]\nscoped report evidence",
                "retrieval_scope": {"dataset_id": "demo", "source_doc_ids": ["doc-1"]},
                "retrieval_policy": {
                    "query_type": "research_report",
                    "run_rag": True,
                    "reason_codes": ["REPORT_REQUIRES_RAG"],
                },
                "rag_executed": True,
                "rag_succeeded": True,
            }
        )

    monkeypatch.setattr(module, "urlopen", fake_urlopen)
    result = _DatasetStore._fetch_evidence_fusion(
        query="生成研报",
        dataset_id="demo",
    )

    assert captured["body"]["dataset_id"] == "demo"
    assert result["available"] is True
    assert result["rag_executed"] is True
    assert result["rag_succeeded"] is True
    assert result["retrieval_policy"]["reason_codes"] == ["REPORT_REQUIRES_RAG"]
