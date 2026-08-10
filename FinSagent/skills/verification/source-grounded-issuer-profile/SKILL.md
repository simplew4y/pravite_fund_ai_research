---
name: finskillops-source-grounded-issuer-profile
description: Answer issuer profile and leadership questions only from scoped documentary evidence.
version: 0.1.0-pf1
category: verification
---

# Source-Grounded Issuer Profile

Use this workflow for company facts such as management identity, appointments,
ownership, headquarters and business scope.

## Evidence Fusion workflow

1. Identify the exact issuer, requested fact and the user's time cutoff.
2. Search only the evidence already admitted for the active dataset and allowed
   document IDs; do not use model memory as a substitute for evidence.
3. Match the claim to a direct source concept. For CEO or other executive
   identity, require appointment, resignation, annual-report management or an
   equivalently authoritative disclosure—not a casual mention of a name.
4. Distinguish the person holding the role during the requested period from a
   person appointed later. Report changes when the evidence spans transitions.
5. Return only supported facts with a source reference. If direct evidence is
   absent, preserve any already-supported answer and explicitly identify the
   unresolved field.

## Private-fund boundary

- Never transfer a profile fact across companies with similar names.
- Never turn a retrieved biography or analyst statement into an official
  appointment fact without direct support.
- Company-specific facts belong in governed evidence, not hidden prompt memory.
