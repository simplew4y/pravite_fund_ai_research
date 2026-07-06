#!/usr/bin/env python3
"""Run the local PDF research web app."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

import uvicorn  # noqa: E402

from pdf_research_demo.llm import DEFAULT_CONFIG_PATH  # noqa: E402
from pdf_research_demo.web_app import DEFAULT_PDF_PATH, DEFAULT_TEXT_PATH, create_app  # noqa: E402


def main() -> None:
    parser = argparse.ArgumentParser(description="Local PDF research web app")
    parser.add_argument("--pdf", default=str(DEFAULT_PDF_PATH), help="Source PDF path")
    parser.add_argument(
        "--text",
        default="",
        help=f"Optional cached PDF text path; omit to extract native PDF text directly. Default cache: {DEFAULT_TEXT_PATH}",
    )
    parser.add_argument("--company", default="Tesla, Inc.")
    parser.add_argument("--ticker", default="TSLA")
    parser.add_argument("--llm-config", default=str(DEFAULT_CONFIG_PATH), help="YAML config with llm_model_name/base_url/api_key")
    parser.add_argument("--no-llm", action="store_true", help="Disable real LLM synthesis and use extractive fallback")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()

    app = create_app(
        args.pdf,
        args.text or None,
        company_name=args.company,
        ticker=args.ticker,
        use_llm=not args.no_llm,
        llm_config_path=args.llm_config,
    )
    uvicorn.run(app, host=args.host, port=args.port)


if __name__ == "__main__":
    main()
