# FinSagent Skill Packages

`skills/` is the single installation root for FinSagent runtime skills. A skill is
self-contained and lives at:

```text
skills/<category>/<package>/
  SKILL.md
  manifest.yaml
  handler.py          # optional; disabled by default
  references/         # optional
  tests/              # optional
```

## Required contracts

- `SKILL.md` starts with YAML frontmatter containing `name` and `version`.
- `name` equals `skill_id` (underscores or hyphens are accepted).
- `manifest.yaml` declares routing, phase, evidence constraints, implementation,
  permissions, publication status, and governance metadata.
- Packages and manifest files must be regular files below a configured root;
  symlinked packages are rejected.
- Duplicate `skill_id` values are a startup error.

The runtime discovers packages automatically; copying a valid directory below
`skills/<category>/` installs it. Production activation is independent of
installation and is controlled by `config/production.yaml`:

```yaml
skills:
  runtime_enabled: true
  execution_mode: shadow       # shadow first, active after regression gates
  promoted_only: true
  allow: [my_skill]
  deny: []
```

An ID listed in `allow` but missing from discovery is a startup error. `deny`
wins over `allow`. The public `/skills` API only returns packages with
`public: true`; it never returns instructions, owner information, or package
hashes.

## Phases and implementation types

Supported phases are `query_parse`, `pre_retrieval`, `post_retrieval`,
`calculation`, `pre_answer`, and `post_answer`. Supported implementation types:

- `prompt`: contributes bounded instructions; it cannot directly call tools.
- `formula`: evaluates a restricted arithmetic AST and emits evidence-linked
  derived facts.
- `builtin`: calls a reviewed adapter registered in source code.
- `python`: trusted plug-in code only. It is disabled by default and is not an
  operating-system sandbox. Never enable it for unreviewed packages.

## Adding a finance skill

1. Copy the package to `skills/finance/<package>/`.
2. Keep `status: experimental` and `public: false` initially.
3. Add its ID to the non-production allowlist and run discovery/unit tests.
4. Run the server in `shadow`, inspect `skill_traces`, and compare evaluation
   results with the baseline.
5. Review evidence-scope, period, unit, currency, and actual/estimate contracts.
6. Promote and switch to `active` only after the configured regression gates.

Legacy files in `configs/skill_cards/` remain readable for old reports during
the migration, but new or changed governance metadata belongs in the package
manifest under `governance`.
