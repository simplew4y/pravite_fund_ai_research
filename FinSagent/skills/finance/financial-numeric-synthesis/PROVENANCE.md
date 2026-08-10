# Explicit FinSkillOps downstream selection

This private FinSagent variant combines two `proposed` portable recipes selected
by the product owner on 2026-08-10. It is not represented as an upstream
FinSkillOps Release.

- Upstream ref: `1e1a0f75d955f3f1dd2c6a83bd5b92ce37f296ee`
- Candidate `seed_7647...`: event `8b768c...`, recipe SHA256 `a060f39289a0d72ee4d6156c2f79ed3a102fb5d2d32d7f20cdb6087ba9ebe525`
- Candidate `seed_c974...`: event `a68d1c...`, recipe SHA256 `c06f348905d23b3d13292dd7c64b1790561012c3ab848564687b9d89ff67aa87`
- Downstream variant: `0.1.0-pf1`

Local changes bind the recipes to Evidence Fusion, preserve qualified metric
semantics, and prohibit cross-company or cross-document fallback.
