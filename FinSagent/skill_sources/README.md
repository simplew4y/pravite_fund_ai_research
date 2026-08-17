# External skill sources

This directory registers upstream skill feeds without making their review or
candidate zones runtime-discoverable. Runtime packages exist only under
`skills/<category>/<package>/`.

FinSkillOps follows a release-only consumer policy. `inbox/`, `candidates/`,
and `exports/` are audit inputs only; they are never scanned by the FinSagent
skill loader.

A product owner may explicitly select a portable candidate for a downstream
private pilot. Such adaptations are copied into a normal FinSagent package,
record every candidate/event/hash and local change, and never make the upstream
candidate directory itself a runtime feed.
