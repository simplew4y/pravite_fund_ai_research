# SkillOps Review Console Frontend Note

Date: 2026-06-10

## Purpose

The frontend is a minimal Industry Track demo surface for Human-Governed SkillOps. It is not a generic chat UI. It is a review console showing how one or two reviewers can maintain cross-company SEC QA skills by inspecting evidence packets and approving or rejecting candidate skills.

## Route

When the FastAPI static frontend is running, open:

```text
/skillops_console.html
```

Files:

```text
deploy/frontend/skillops_console.html
deploy/frontend/skillops_console.css
deploy/frontend/skillops_console.js
deploy/frontend/skillops_console_data.json
```

## What It Demonstrates

1. Cross-company validation status: Zeekr, Lotus, NVIDIA.
2. Review queue of pending skill candidates.
3. Evidence packet with exact anchors and diagnosis.
4. Structured skill card: trigger, scope, evidence requirements, action, known risks.
5. Promotion gate: targeted short, core protected, cross-company guard, failure bank, profile precedence, manual review.
6. Manual approve / reject / request-more-tests actions.
7. Fair auto-promotion baseline comparison.

## Current Data Mode

The first version uses `skillops_console_data.json` as a static demo data source. This is intentional for a stable paper/demo artifact. It can later be replaced with a FastAPI endpoint that reads live runner outputs.

## Next Integration Step

Add a backend endpoint such as:

```text
GET /api/skillops/review-console
POST /api/skillops/candidates/{id}/decision
```

The first endpoint should assemble the same JSON shape from:

- latest architecture validation report
- SkillOps demo runner output
- gate report
- fair auto baseline summary
- skill card registry

The second endpoint should record reviewer decisions in a small JSONL or SQLite audit log.

## Paper Framing

Use this wording:

> The SkillOps Review Console operationalizes the human-governed workflow: failures are converted into evidence packets and skill cards, while reviewers only approve promotion after regression gates pass. The interface is designed to reduce maintenance from manual filing inspection and code edits to evidence-based approve/reject decisions.
