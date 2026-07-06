import sys
from pathlib import Path
import re

from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "src"))

from pdf_research_demo.web_app import create_app


def _sample_pdf_pair(tmp_path: Path) -> tuple[Path, Path]:
    pdf = tmp_path / "sample_10k.pdf"
    pdf.write_bytes(b"%PDF-1.4\n% demo fixture\n")
    text = tmp_path / "sample_10k.txt"
    text.write_text(
        "\n".join(
            [
                "Tesla designs and manufactures electric vehicles and energy storage products.",
                "",
                "Robotaxi service was launched in June 2025 and uses the company's FSD capabilities.",
                "\f",
                "Risk factors include competition, regulatory uncertainty, supply constraints and demand volatility.",
                "",
                "Revenue increased while operating cash flow and capital expenditures remained important to liquidity.",
            ]
        ),
        encoding="utf-8",
    )
    return pdf, text


def test_web_api_runs_qa_memo_and_trace(tmp_path: Path) -> None:
    pdf, text = _sample_pdf_pair(tmp_path)
    app = create_app(pdf, text)
    client = TestClient(app)

    health = client.get("/api/health")
    assert health.status_code == 200
    assert health.json()["evidence_count"] >= 2

    qa = client.post("/api/ask", json={"question": "What does the PDF say about Robotaxi and FSD?"})
    assert qa.status_code == 200
    qa_payload = qa.json()
    assert qa_payload["citations"]
    assert qa_payload["traces"]
    citation_id = qa_payload["citations"][0]["citation_id"]

    trace = client.get(f"/api/trace/{citation_id}")
    assert trace.status_code == 200
    trace_payload = trace.json()
    assert trace_payload["citation"]["citation_id"] == citation_id
    assert trace_payload["document"]["file_name"] == "sample_10k.pdf"
    assert trace_payload["location"]["page_no"] == 1

    memo = client.post("/api/memo", json={"company_name": "Tesla, Inc.", "ticker": "TSLA"})
    assert memo.status_code == 200
    memo_payload = memo.json()
    assert "Tesla, Inc. (TSLA) PDF Evidence Memo" in memo_payload["markdown"]
    assert memo_payload["citations"]
    assert memo_payload["traces"]
    assert memo_payload["pdf_url"].endswith(f"/api/memo/{memo_payload['memo_id']}/pdf")

    memo_pdf = client.get(memo_payload["pdf_url"])
    assert memo_pdf.status_code == 200
    assert memo_pdf.content.startswith(b"%PDF-")


class FakeLLM:
    def __init__(self) -> None:
        self.calls: list[list[dict[str, str]]] = []

    def chat(
        self,
        messages: list[dict[str, str]],
        *,
        max_tokens: int | None = None,
        temperature: float | None = None,
    ) -> str:
        self.calls.append(messages)
        joined = "\n".join(message["content"] for message in messages)
        citation_id = re.search(r"cit_[a-f0-9]{16}", joined).group(0)
        if "Section title:" in joined:
            return f"- LLM memo bullet grounded in local PDF evidence [{citation_id}]"
        return f"LLM answer grounded in local PDF evidence [{citation_id}]"


def test_web_api_can_use_injected_llm_without_breaking_trace(tmp_path: Path) -> None:
    pdf, text = _sample_pdf_pair(tmp_path)
    fake_llm = FakeLLM()
    app = create_app(pdf, text, llm_client=fake_llm)
    client = TestClient(app)

    health = client.get("/api/health").json()
    assert health["llm"]["enabled"] is True

    qa = client.post("/api/ask", json={"question": "What does the PDF say about Robotaxi and FSD?"}).json()
    assert qa["llm_used"] is True
    assert qa["llm_error"] == ""
    assert "LLM answer" in qa["answer"]
    assert qa["citations"][0]["citation_id"] in qa["answer"]

    memo = client.post("/api/memo", json={}).json()
    assert memo["llm_used"] is True
    assert "LLM memo bullet" in memo["markdown"]
    assert fake_llm.calls
