"""Generate a vertical-slice SkillOps demo report."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

try:
    import yaml
except Exception:  # pragma: no cover
    yaml = None


STEP_ARTIFACTS = [
    {
        "step": "Step 1",
        "name": "Skill Registry",
        "summary": "Wrapped existing SEC-specific patches as governed skill cards with status, scope, risk, and eval metadata.",
        "artifacts": [
            "configs/skill_cards/",
            "reports/skill_registry_report.md",
        ],
    },
    {
        "step": "Step 2",
        "name": "Grep Evidence Probe",
        "summary": "Added structured lexical evidence anchors: exact phrase, regex, metric alias, period phrase, and nearby number.",
        "artifacts": [
            "src/grep/grep_probe.py",
            "test/colm/retrieval/GREP_PROBE_STEP2_REPORT_20260605.md",
            "test/colm/retrieval/grep_probe_step2_20260605/lotus_q1_probe_report.md",
        ],
    },
    {
        "step": "Step 3",
        "name": "Evidence Preview",
        "summary": "Unified retrieval chunks, grep anchors, final answer, and skill traces into auditable JSON/Markdown previews.",
        "artifacts": [
            "src/preview/evidence_preview.py",
            "test/colm/retrieval/EVIDENCE_PREVIEW_STEP3_REPORT_20260605.md",
            "test/colm/retrieval/evidence_preview_step3_20260605/lotus_q1_success_preview.md",
            "test/colm/retrieval/evidence_preview_step3_20260605/nvidia_q15_source_conflict_preview.md",
        ],
    },
    {
        "step": "Step 4",
        "name": "Failure Explainer",
        "summary": "Added rule-based failure diagnosis over evidence previews and run rows.",
        "artifacts": [
            "configs/failure_taxonomy.yaml",
            "src/diagnosis/failure_explainer.py",
            "test/colm/retrieval/FAILURE_EXPLAINER_STEP4_REPORT_20260605.md",
            "test/colm/retrieval/failure_explainer_step4_20260605/nvidia_q15_source_conflict_failure_report.md",
        ],
    },
    {
        "step": "Step 5",
        "name": "Skill Candidate Proposal",
        "summary": "Generated proposal-only YAML/Markdown candidate skills from FailureReport without writing production code.",
        "artifacts": [
            "src/diagnosis/skill_candidate_generator.py",
            "test/colm/retrieval/SKILL_CANDIDATE_STEP5_REPORT_20260605.md",
            "test/colm/retrieval/skill_candidate_step5_20260605/nvidia_q15_skill_candidates.md",
        ],
    },
    {
        "step": "Step 6",
        "name": "Regression Gate",
        "summary": "Added conservative gate decisions over proposals and eval summaries; candidates stay proposed without human review.",
        "artifacts": [
            "src/skillops/gate_runner.py",
            "test/colm/retrieval/REGRESSION_GATE_STEP6_REPORT_20260605.md",
            "test/colm/retrieval/skill_candidate_step6_20260605/nvidia_q15_gate_decisions.md",
        ],
    },
]


def build_demo_manifest(repo_root: str | Path = ".") -> dict[str, Any]:
    root = Path(repo_root)
    manifest = {
        "demo_id": "skillops_vertical_slice_20260605",
        "title": "Human-Governed SkillOps Vertical Slice for SEC QA",
        "loop": [
            "Question",
            "Retrieval",
            "Grep Probe",
            "Evidence Preview",
            "Failure Diagnosis",
            "Skill Candidate Proposal",
            "Regression Gate",
        ],
        "steps": [],
        "case_studies": _case_studies(root),
        "benchmark_context": _benchmark_context(root),
        "known_gaps": _known_gaps(),
    }
    for item in STEP_ARTIFACTS:
        artifacts = []
        for artifact in item["artifacts"]:
            path = root / artifact
            artifacts.append(
                {
                    "path": artifact,
                    "exists": path.exists(),
                    "kind": "directory" if path.is_dir() else "file",
                }
            )
        manifest["steps"].append({**item, "artifacts": artifacts})
    return manifest


def render_demo_report(manifest: dict[str, Any]) -> str:
    lines = [
        "# Human-Governed SkillOps Vertical Slice",
        "",
        "## One-Line Claim",
        "",
        "Static RAG and structure-aware retrieval are not enough for reliable SEC QA; a governed SkillOps layer can make evidence, failures, candidate skills, and promotion decisions auditable.",
        "",
        "## End-to-End Loop",
        "",
        " -> ".join(manifest["loop"]),
        "",
        "## Completed Steps",
        "",
        "| Step | Component | What It Adds | Key Artifacts |",
        "| --- | --- | --- | --- |",
    ]
    for step in manifest["steps"]:
        artifact_text = "<br>".join(
            f"{'[OK]' if artifact['exists'] else '[MISSING]'} `{artifact['path']}`" for artifact in step["artifacts"]
        )
        lines.append(
            "| "
            + " | ".join(
                [
                    step["step"],
                    step["name"],
                    _escape(step["summary"]),
                    artifact_text,
                ]
            )
            + " |"
        )
    lines.extend(["", "## Case Studies", ""])
    for case in manifest["case_studies"]:
        lines.extend(
            [
                f"### {case['name']}",
                "",
                f"- QID: `{case['qid']}`",
                f"- Role: {case['role']}",
                f"- Result: {case['result']}",
                f"- Key artifacts: {', '.join(f'`{item}`' for item in case['artifacts'])}",
                "",
                case["interpretation"],
                "",
            ]
        )
    lines.extend(["## Benchmark Context", ""])
    for item in manifest["benchmark_context"]:
        lines.append(f"- {item}")
    lines.extend(["", "## Known Gaps / Next Work", ""])
    for item in manifest["known_gaps"]:
        lines.append(f"- {item}")
    lines.extend(
        [
            "",
            "## Paper Framing",
            "",
            "The current artifact is a minimal vertical slice, not a full production platform. Its contribution is a controlled loop that transforms ad hoc SEC QA fixes into governed, inspectable SkillOps objects.",
            "",
            "Recommended next engineering step: add a single command that runs this loop on new examples and appends results to a rolling benchmark report.",
        ]
    )
    return "\n".join(lines).rstrip() + "\n"


def _case_studies(root: Path) -> list[dict[str, Any]]:
    return [
        {
            "name": "Success Control: Lotus Revenue Question",
            "qid": "lotus_gen_01",
            "role": "Correct answer with aligned retrieval and grep anchors",
            "result": "Failure explainer returns no_failure_detected; no skill proposal is generated.",
            "artifacts": [
                "test/colm/retrieval/evidence_preview_step3_20260605/lotus_q1_success_preview.md",
                "test/colm/retrieval/failure_explainer_step4_20260605/lotus_q1_success_failure_report.md",
                "test/colm/retrieval/skill_candidate_step5_20260605/lotus_q1_success_skill_candidates.md",
            ],
            "interpretation": "This case shows the loop does not hallucinate failures or propose unnecessary skills for a clean successful answer.",
        },
        {
            "name": "Failure/Repair: NVIDIA FY2025 Export-Control Source Conflict",
            "qid": "qa_kp_000015",
            "role": "Previously incorrect answer repaired by source-conflict skill and diagnosed by Failure Explainer",
            "result": "Failure explainer classifies source_conflict with 0.95 confidence; proposal generator emits two proposed skills.",
            "artifacts": [
                "test/colm/retrieval/evidence_preview_step3_20260605/nvidia_q15_source_conflict_preview.md",
                "test/colm/retrieval/failure_explainer_step4_20260605/nvidia_q15_source_conflict_failure_report.md",
                "test/colm/retrieval/skill_candidate_step5_20260605/nvidia_q15_skill_candidates.md",
                "test/colm/retrieval/skill_candidate_step6_20260605/nvidia_q15_gate_decisions.md",
            ],
            "interpretation": "This case demonstrates the research loop: evidence preview exposes the issue, diagnosis classifies it, candidate generation proposes bounded fixes, and the gate keeps them proposed until review.",
        },
    ]


def _benchmark_context(root: Path) -> list[str]:
    summary_path = root / "test/colm/retrieval/cross_company_benchmark_v1_1_20260605/cross_company_benchmark_v1_1_summary.json"
    if not summary_path.exists():
        return ["Cross-company benchmark v1.1 summary not found in this checkout."]
    try:
        summary = json.loads(summary_path.read_text(encoding="utf-8"))
        overall = summary.get("overall") or {}
        return [
            f"Cross-company v1.1: {overall.get('correct')}/{overall.get('evaluated_qas')} correct, weighted score {overall.get('weighted_correctness_score')}.",
            "Companies: " + ", ".join(overall.get("companies") or []),
        ]
    except Exception as exc:
        return [f"Could not parse benchmark summary: {exc}"]


def _known_gaps() -> list[str]:
    return [
        "The loop currently summarizes existing run artifacts; it is not yet a single end-to-end command over arbitrary new questions.",
        "Failure explainer is rule-based and should later be evaluated for diagnosis precision/recall.",
        "Grep probe is a lexical audit side-channel, not an answerer; aliases and Chinese-English expansion need systematic company-profile support.",
        "Regression gate uses protected-set summaries and manual-review flags; full implementation-specific reruns are still future work.",
        "Candidate proposals are proposal-only by design and require human review before implementation.",
    ]


def _write_yaml(path: Path, payload: dict[str, Any]) -> None:
    if yaml is None:
        path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    else:
        path.write_text(yaml.safe_dump(payload, allow_unicode=True, sort_keys=False), encoding="utf-8")


def _escape(value: str) -> str:
    return value.replace("|", "\\|").replace("\n", " ")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo_root", default=".")
    parser.add_argument("--out_json", default="reports/skillops_vertical_slice_manifest_20260605.json")
    parser.add_argument("--out_md", default="reports/skillops_vertical_slice_report_20260605.md")
    args = parser.parse_args()

    manifest = build_demo_manifest(args.repo_root)
    out_json = Path(args.out_json)
    out_md = Path(args.out_md)
    out_json.parent.mkdir(parents=True, exist_ok=True)
    out_md.parent.mkdir(parents=True, exist_ok=True)
    out_json.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    out_md.write_text(render_demo_report(manifest), encoding="utf-8")
    print(out_json)
    print(out_md)


if __name__ == "__main__":
    main()

