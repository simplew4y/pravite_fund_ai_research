# Skill Candidate Proposals

## company_profile_boundary_guard

- Candidate ID: `qa_kp_48_company_profile_boundary_guard`
- Suggested status: `proposed`
- Human review required: True
- Failure types: profile_boundary_error

### Observed Failures

- profile_boundary_error (medium): Profile boundary repair trace triggered. Evidence: {'skill_id': 'company_profile_boundary', 'triggered': True, 'trigger_reason': 'profile fact repair for vie_structure', 'output_decision': 'repair_applied', 'supporting_sourc...

### Hypothesis

Stable company-profile questions fail when noisy snippets or latest-event evidence cause the answer to overstate corporate structure, ownership, headquarters, or business-boundary facts.

### Proposed Trigger

Question asks for corporate profile, holding structure, VIE status, headquarters, relationship boundary, or target market, and retrieval evidence is noisy or profile repair trace is triggered.

### Proposed Action

Route the answer through reviewed company-profile metadata with explicit cutoff/scope, while preserving retrieved evidence and preventing global answer memorization.

### Risks

- Highest overfitting risk if profile facts are used as hidden answers instead of scoped metadata.
- Company-specific profile metadata must not leak into cross-company runs.
- Needs manual review for each company profile card before promotion.

### Required Tests

- Profile-boundary questions pass on Zeekr protected set.
- Lotus and NVIDIA sanity cases do not trigger Zeekr-specific profile facts.
- Company profile card clearly separates aliases/metadata from answer facts.

### Notes

This proposal is intentionally scoped to audited company-profile metadata, not a global factbook.
