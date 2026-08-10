# macOS 0.2.1 Migration Handoff

## Scope

The macOS build branch must inherit the latest `release_build` before packaging.
Keep the existing Apple Silicon runtime, Keychain integration, ad-hoc signing,
DMG, and ZIP logic. Do not reimplement the migration engine in shell or Electron.

## Merge Order

1. Merge the latest `release_build` into the macOS packaging branch.
2. Resolve product and database behavior in favor of `release_build`.
3. Preserve macOS-specific runtime paths, signing, and arm64 sidecar logic.
4. Keep `omnigent` Python package version `0.3.0.dev0`; the desktop product
   version is `0.2.1`.

## Required Runtime Layout

Use `app.getPath("userData")`, which resolves under macOS Application Support,
as the only persistent desktop root:

```text
~/Library/Application Support/私募研究工作台/
├── data/
├── config/
├── logs/
├── backups/
└── data-manifest.json
```

Set these variables for every server, host, worker, and migration process:

```text
OMNIGENT_DATA_DIR=<userData>/data
OMNIGENT_CONFIG_HOME=<userData>/config
OMNIGENT_LOG_DIR=<userData>/logs
PRIVATE_FUND_USER_DATA_ROOT=<userData>/data/users
PRIVATE_FUND_DATASET_WORKSPACE=<userData>/data/users
PRIVATE_FUND_MIGRATION_DATA_ROOT=<userData>/data
PRIVATE_FUND_MIGRATION_BACKUP_ROOT=<userData>/backups
PRIVATE_FUND_DATA_MANIFEST=<userData>/data-manifest.json
```

Do not use `~/.omnigent` for the packaged app. Never delete Application Support
data during an upgrade, uninstall, packaging retry, or failed migration.

## Startup Contract

Before LiteLLM, Omnigent Server, workers, or Host are started, run:

```bash
python -m omnigent.server.private_fund_data_migrations migrate \
  --app-version 0.2.1 \
  --data-root "$PRIVATE_FUND_MIGRATION_DATA_ROOT" \
  --backup-root "$PRIVATE_FUND_MIGRATION_BACKUP_ROOT" \
  --manifest "$PRIVATE_FUND_DATA_MANIFEST"
```

Show migration progress on the existing boot page. A migration failure must stop
startup and point users to `<userData>/logs`. The CLI restores the affected
SQLite database from the one-time backup and is safe to retry. Data newer than
the app must be rejected; never attempt a downgrade.

## Packaging

Produce these arm64 artifacts with product version `0.2.1`:

```text
PrivateFundWorkbench-0.2.1-arm64.dmg
PrivateFundWorkbench-0.2.1-arm64-mac.zip
BUILD_INFO.txt
RELEASE_MANIFEST.json
SHA256SUMS
```

`BUILD_INFO.txt` and `RELEASE_MANIFEST.json` must include the Git commit, UTC
build time, platform, architecture, product version, database change flag, and
migration target. Keep automatic update checks disabled in this release.

## Acceptance

1. Seed an Application Support directory from an unversioned build; it must be
   treated as data version `0.1.1`.
2. Launch `0.2.1` and verify the backup, migration history, and
   `data-manifest.json` are created before services start.
3. Verify old risks/catalysts remain visible as legacy data and create no alerts.
4. Verify explicit rebuild is the only action that invokes the model.
5. Compare original PDF and Excel sizes and SHA-256 hashes before and after.
6. Re-launch to prove migration idempotency and no duplicate backup.
7. Verify Host state and logs never appear under `~/.omnigent`.
8. Run Electron tests, package smoke tests, `codesign --verify`, `hdiutil verify`,
   and SHA-256 verification on Apple Silicon or the GitHub macOS runner.

Expected failure logs are under `<userData>/logs`; migration state and backup
location are recorded in `<userData>/data-manifest.json`.
