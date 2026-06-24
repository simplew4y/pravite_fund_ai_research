#!/usr/bin/env python3
"""Create controlled promotion gates for SEC QA skill evolution.

The analyzer says "what skill should we improve?". This script says "what must
be true before that skill is allowed to enter the main pipeline?" It can run in
preflight mode with only a baseline analyzer output, or comparison mode with a
candidate analyzer output after a proposed skill has been tested.
"""

from __future__ import annotations

import argparse
import json
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any


DEFAULT_ROLES = {
    "zeekr_small30_cap2": "protected_regression",
    "zeekr_diagnostic_holdout20": "development_diagnostic",
    "nvidia_mini10_sanity": "cross_company_sanity",
}


@dataclass(frozen=True)
class RunGate:
    role: str
    purpose: str
    preflight_rule: str


RUN_GATES = {
    "protected_regression": RunGate(
        role="protected_regression",
        purpose="Protect known-good behavior from regressions.",
        preflight_rule="Candidate skill must not introduce any new failure on this run.",
    ),
    "development_diagnostic": RunGate(
        role="development_diagnostic",
        purpose="Expose known high-risk cases and measure targeted improvement.",
        preflight_rule="Candidate skill should reduce failures or improve related failure buckets without hiding errors.",
    ),
    "cross_company_sanity": RunGate(
        role="cross_company_sanity",
        purpose="Check that improvements are not overfit to one company.",
        preflight_rule="Candidate skill must not make cross-company sanity worse; ideally it improves related failures.",
    ),
    "blind_holdout": RunGate(
        role="blind_holdout",
        purpose="Final generalization check; never use directly for skill generation.",
        preflight_rule="Run only after candidate passes development and regression gates.",
    ),
}


def load_json(path: Path) -> dict[str, Any]:
    with open(path, encoding="utf-8") as f:
        payload = json.load(f)
    if not isinstance(payload, dict):
        raise ValueError(f"Expected JSON object: {path}")
    return payload


def load_cases(path: Path) -> list[dict[str, str]]:
    import csv

    with open(path, encoding="utf-8", newline="") as f:
        return [dict(row) for row in csv.DictReader(f)]


def verdict_count(run: dict[str, Any], verdict: str) -> int:
    return int((run.get("verdict_counts") or {}).get(verdict, 0))


def role_for(run_name: str, overrides: dict[str, str]) -> str:
    return overrides.get(run_name) or DEFAULT_ROLES.get(run_name) or "development_diagnostic"


def parse_role(value: str) -> tuple[str, str]:
    if "=" not in value:
        raise ValueError(f"Run role must be RUN=ROLE, got {value!r}")
    run, role = value.split("=", 1)
    run = run.strip()
    role = role.strip()
    if role not in RUN_GATES:
        raise ValueError(f"Unknown role {role!r}. Valid roles: {sorted(RUN_GATES)}")
    return run, role


def compare_runs(
    baseline: dict[str, Any],
    candidate: dict[str, Any] | None,
    role_overrides: dict[str, str],
) -> dict[str, Any]:
    out: dict[str, Any] = {"runs": {}, "overall_status": "PREFLIGHT"}
    any_fail = False
    any_warn = False

    baseline_runs = baseline.get("runs") or {}
    candidate_runs = (candidate or {}).get("runs") or {}
    for run_name, base_run in baseline_runs.items():
        role = role_for(run_name, role_overrides)
        gate = RUN_GATES[role]
        cand_run = candidate_runs.get(run_name)
        item: dict[str, Any] = {
            "role": role,
            "purpose": gate.purpose,
            "preflight_rule": gate.preflight_rule,
            "baseline_total": base_run.get("total"),
            "baseline_failure_count": base_run.get("failure_count"),
            "baseline_verdict_counts": base_run.get("verdict_counts"),
        }
        if cand_run is None:
            item["status"] = "PREFLIGHT"
            item["decision"] = gate.preflight_rule
            any_warn = True
        else:
            base_fail = int(base_run.get("failure_count") or 0)
            cand_fail = int(cand_run.get("failure_count") or 0)
            item.update(
                {
                    "candidate_total": cand_run.get("total"),
                    "candidate_failure_count": cand_fail,
                    "candidate_verdict_counts": cand_run.get("verdict_counts"),
                    "failure_delta": cand_fail - base_fail,
                }
            )
            if role == "protected_regression":
                ok = cand_fail <= base_fail and verdict_count(cand_run, "CORRECT") >= verdict_count(base_run, "CORRECT")
                item["status"] = "PASS" if ok else "FAIL"
                item["decision"] = "No regression on protected run." if ok else "Protected run regressed."
            elif role == "cross_company_sanity":
                ok = cand_fail <= base_fail
                item["status"] = "PASS" if ok else "FAIL"
                item["decision"] = "Cross-company sanity did not regress." if ok else "Cross-company sanity regressed."
            elif role == "development_diagnostic":
                if cand_fail < base_fail:
                    item["status"] = "PASS"
                    item["decision"] = "Diagnostic failures decreased."
                elif cand_fail == base_fail:
                    item["status"] = "WARN"
                    item["decision"] = "No diagnostic improvement; inspect skill-targeted cases before promotion."
                    any_warn = True
                else:
                    item["status"] = "FAIL"
                    item["decision"] = "Diagnostic failures increased."
            else:
                ok = cand_fail <= base_fail
                item["status"] = "PASS" if ok else "FAIL"
                item["decision"] = "Blind holdout did not regress." if ok else "Blind holdout regressed."
            if item["status"] == "FAIL":
                any_fail = True
            if item["status"] == "WARN":
                any_warn = True
        out["runs"][run_name] = item

    if candidate is not None:
        out["overall_status"] = "FAIL" if any_fail else ("WARN" if any_warn else "PASS")
    elif any_warn:
        out["overall_status"] = "PREFLIGHT"
    return out


def build_overfit_audit(
    baseline_dir: Path,
    role_overrides: dict[str, str],
) -> dict[str, Any]:
    cases_path = baseline_dir / "failure_cases.csv"
    if not cases_path.exists():
        return {"available": False, "reason": f"Missing {cases_path}"}
    cases = load_cases(cases_path)
    by_skill: dict[str, dict[str, Any]] = {}
    for case in cases:
        skill = case.get("primary_skill") or "unknown"
        run = case.get("run") or "unknown"
        role = role_for(run, role_overrides)
        bucket = by_skill.setdefault(
            skill,
            {
                "trigger_cases": 0,
                "trigger_runs": {},
                "development_cases": 0,
                "protected_or_sanity_cases": 0,
                "risk": "LOW",
                "recommendation": "",
            },
        )
        bucket["trigger_cases"] += 1
        bucket["trigger_runs"][run] = bucket["trigger_runs"].get(run, 0) + 1
        if role == "development_diagnostic":
            bucket["development_cases"] += 1
        else:
            bucket["protected_or_sanity_cases"] += 1

    for skill, bucket in by_skill.items():
        if bucket["protected_or_sanity_cases"] > 0 and bucket["development_cases"] == 0:
            bucket["risk"] = "HIGH"
            bucket["recommendation"] = "Do not generate this skill from protected/sanity cases alone; add a new development diagnostic set."
        elif bucket["protected_or_sanity_cases"] > 0:
            bucket["risk"] = "MEDIUM"
            bucket["recommendation"] = "Use protected/sanity cases only as evidence of generality; validate on fresh rotating diagnostics before promotion."
        else:
            bucket["risk"] = "LOW"
            bucket["recommendation"] = "Candidate can be proposed from development diagnostics, but must pass protected and cross-company gates."
    return {"available": True, "skills": by_skill}


def write_markdown(path: Path, gate_report: dict[str, Any], overfit_audit: dict[str, Any]) -> None:
    lines: list[str] = []
    lines.append("# Skill Evolution Promotion Gate")
    lines.append("")
    lines.append(f"Generated: {datetime.now().strftime('%Y-%m-%d %H:%M')}")
    lines.append("")
    lines.append(f"Overall status: **{gate_report['overall_status']}**")
    lines.append("")
    lines.append("## Run Gates")
    lines.append("")
    lines.append("| run | role | baseline failures | candidate failures | status | decision |")
    lines.append("| --- | --- | ---: | ---: | --- | --- |")
    for run_name, item in gate_report["runs"].items():
        candidate_fail = item.get("candidate_failure_count")
        candidate_text = "" if candidate_fail is None else str(candidate_fail)
        lines.append(
            f"| {run_name} | {item['role']} | {item.get('baseline_failure_count')} | "
            f"{candidate_text} | {item['status']} | {item['decision']} |"
        )
    lines.append("")
    lines.append("## Anti-Overfitting Audit")
    lines.append("")
    if not overfit_audit.get("available"):
        lines.append(f"Audit unavailable: {overfit_audit.get('reason')}")
    else:
        lines.append("| skill | trigger cases | trigger runs | risk | recommendation |")
        lines.append("| --- | ---: | --- | --- | --- |")
        for skill, item in sorted(overfit_audit["skills"].items()):
            runs = ", ".join(f"{run}:{count}" for run, count in sorted(item["trigger_runs"].items()))
            lines.append(
                f"| {skill} | {item['trigger_cases']} | {runs} | {item['risk']} | {item['recommendation']} |"
            )
    lines.append("")
    lines.append("## Promotion Rule")
    lines.append("")
    lines.append("A candidate skill can be promoted only when:")
    lines.append("")
    lines.append("1. Protected regression set does not regress.")
    lines.append("2. Cross-company sanity does not regress.")
    lines.append("3. Development diagnostic set improves or has a documented targeted improvement.")
    lines.append("4. A fresh rotating diagnostic set is run for skills derived from old failures.")
    lines.append("5. Blind holdout remains untouched until final validation.")
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--baseline_dir", required=True)
    parser.add_argument("--candidate_dir", default=None)
    parser.add_argument("--output_dir", default=None)
    parser.add_argument("--run_role", action="append", default=[], help="Override run role as RUN=ROLE.")
    args = parser.parse_args()

    baseline_dir = Path(args.baseline_dir)
    candidate_dir = Path(args.candidate_dir) if args.candidate_dir else None
    output_dir = Path(args.output_dir) if args.output_dir else baseline_dir / "promotion_gate"
    output_dir.mkdir(parents=True, exist_ok=True)

    role_overrides = dict(parse_role(value) for value in args.run_role)
    baseline = load_json(baseline_dir / "skill_evolution_summary.json")
    candidate = load_json(candidate_dir / "skill_evolution_summary.json") if candidate_dir else None
    gate_report = compare_runs(baseline, candidate, role_overrides)
    overfit_audit = build_overfit_audit(baseline_dir, role_overrides)
    payload = {
        "baseline_dir": str(baseline_dir),
        "candidate_dir": str(candidate_dir) if candidate_dir else None,
        "gate_report": gate_report,
        "overfit_audit": overfit_audit,
    }
    with open(output_dir / "promotion_gate.json", "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
    write_markdown(output_dir / "promotion_gate.md", gate_report, overfit_audit)
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    print(f"Wrote {output_dir / 'promotion_gate.md'}")


if __name__ == "__main__":
    main()
