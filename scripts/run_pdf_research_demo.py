#!/usr/bin/env python3
"""Run the PDF-only QA + memo + provenance demo.

Example:
  python scripts/run_pdf_research_demo.py \
    --pdf tesla_extracted/20260129_10-K_0001628280-26-003952.pdf \
    --question "What does Tesla say about Robotaxi?"
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from pdf_research_demo import PdfResearchDemo  # noqa: E402
from pdf_research_demo.llm import OpenAICompatibleChatClient, load_llm_config  # noqa: E402
from pdf_research_demo.memo_pdf import DEFAULT_OUTPUT_DIR, render_memo_pdf  # noqa: E402


def main() -> None:
    parser = argparse.ArgumentParser(description="PDF-only private fund research demo")
    parser.add_argument("--pdf", required=True, help="Source PDF path")
    parser.add_argument("--text", default="", help="Optional cached PDF text path with form-feed page separators")
    parser.add_argument("--question", required=True, help="QA question")
    parser.add_argument("--company", default="Tesla, Inc.")
    parser.add_argument("--ticker", default="TSLA")
    parser.add_argument("--memo-out", default="", help="Optional markdown output path")
    parser.add_argument("--memo-pdf-out", default="", help="Optional memo PDF output path")
    parser.add_argument("--no-llm", action="store_true", help="Disable configured LLM drafting")
    args = parser.parse_args()

    llm_config = None if args.no_llm else load_llm_config()
    llm_client = OpenAICompatibleChatClient(llm_config) if llm_config else None
    demo = PdfResearchDemo(llm_client=llm_client)
    document = demo.ingest_pdf(args.pdf, args.text or None)
    qa = demo.answer_question(args.question)
    memo = demo.generate_memo(args.company, args.ticker)
    memo_pdf = (
        render_memo_pdf(memo, Path(args.memo_pdf_out).parent, filename=Path(args.memo_pdf_out).name)
        if args.memo_pdf_out
        else render_memo_pdf(memo, DEFAULT_OUTPUT_DIR)
    )

    if args.memo_out:
        out = Path(args.memo_out)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(memo.to_markdown(), encoding="utf-8")

    payload = {
        "document": document.to_dict(),
        "qa": {
            "answer": qa.answer,
            "needs_review": qa.needs_review,
            "llm_used": qa.llm_used,
            "llm_error": qa.llm_error,
            "citations": [citation.to_dict() for citation in qa.citations],
        },
        "memo": {
            "memo_id": memo.memo_id,
            "title": memo.title,
            "section_count": len(memo.sections),
            "citation_count": len(memo.citations),
            "llm_used": memo.llm_used,
            "llm_error": memo.llm_error,
            "pdf_path": str(memo_pdf),
        },
        "first_trace": (
            demo.trace_citation((qa.citations or memo.citations)[0].citation_id)
            if qa.citations or memo.citations
            else {}
        ),
    }
    print(json.dumps(payload, ensure_ascii=False, indent=2, default=lambda obj: obj.to_dict()))


if __name__ == "__main__":
    main()
