# SkillOps Demo Inputs

These files are stable, minimal QA rows for the SkillOps demo suite.

They intentionally separate two evaluation roles:

- Accuracy benchmark: `cross_company_benchmark_v1_1`, 40 QA cases across Zeekr, Lotus Technology, and NVIDIA.
- SkillOps demo suite: five auditable cases that exercise evidence preview, failure diagnosis, skill proposal, and promotion-gate logic.

The demo suite is not a statistical accuracy benchmark. Four cases include explicit repair/audit trace fields so the failure explainer can reproduce the same taxonomy labels from a clean clone.

