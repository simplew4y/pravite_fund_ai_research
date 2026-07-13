from pathlib import Path

import fitz

from omnigent.tools.builtins.private_fund_finrobot_report import (
    FINROBOT_SECTION_KEYS,
    render_finrobot_aligned_report,
)


def test_render_finrobot_aligned_report_writes_complete_package(tmp_path: Path) -> None:
    project_root = Path(__file__).resolve().parents[4]
    info = {
        "dataset_id": "dataset-demo",
        "name": "示例公司资料库",
        "company_name": "示例公司",
        "company_ticker": "300000",
    }
    report_payload = {
        "sector": "新能源",
        "rating": "BUY",
        "market_snapshot": {"share_price": "10.00", "target_price": "15.00"},
        "financial_metrics": [
            {"metric": "Revenue", "values": {"2024A": 1_000_000_000, "2025E": 1_300_000_000}},
            {"metric": "EBITDA", "values": {"2024A": 200_000_000, "2025E": 280_000_000}},
            {"metric": "EPS", "values": {"2024A": 1.2, "2025E": 1.5}},
            {"metric": "PE Ratio", "values": {"2024A": 18, "2025E": 15}},
        ],
        "sections": {key: f"Verified {key}." for key in FINROBOT_SECTION_KEYS},
    }
    section_payloads = [
        {
            "section": "company_overview",
            "evidence": [
                {
                    "evidence_id": "chunk:demo",
                    "citation": "source.pdf p.1",
                    "excerpt": "Verified source excerpt.",
                }
            ],
        }
    ]

    artifacts, package = render_finrobot_aligned_report(
        project_root=project_root,
        info=info,
        report_payload=report_payload,
        section_payloads=section_payloads,
        output_dir=tmp_path,
        run_id="eqr_demo12345678",
        version_no=1,
    )

    assert all(
        path.is_file()
        for path in (
            artifacts.markdown_path,
            artifacts.html_path,
            artifacts.pdf_path,
            artifacts.package_path,
        )
    )
    assert len(artifacts.chart_paths) == 2
    assert "Evidence Index" in artifacts.html_path.read_text(encoding="utf-8")
    assert "chunk:demo" in artifacts.markdown_path.read_text(encoding="utf-8")
    assert package["render_engine"] == artifacts.render_engine
    with fitz.open(artifacts.pdf_path) as document:
        assert len(document) >= 1
