# `@private-fund/research-store`

Per-project SQLite persistence for source documents, immutable document
versions, unified evidence, and versioned research assets.

## Legacy schema audit

The migration contract is based on the production Python implementation, not
on a speculative replacement schema:

- `FinSagent/data_pipeline/private_fund_directory_ingest.py`
  - Legacy `documents` stores one row per physical version.
  - `logical_doc_id` groups versions and `(dataset_id, logical_doc_id,
    version_no)` is unique.
  - An unchanged `(source path, checksum)` reuses the current version.
  - A changed checksum creates `version_no + 1`, records
    `supersedes_doc_id`, and marks the prior version `superseded`.
  - Removed sources lose current status, but their parsed evidence remains for
    historical traceability.
- Evidence is distributed across:
  - `chunks` + `chunk_locations` → `chunk:<chunk_id>`
  - `metric_facts` → `fact:<fact_id>`
  - `excel_cells` → `cell:<cell_id>`
  - `pdf_pages` → `page:<page_id>`
- `chunk_locations` carries PDF page ranges, bbox, slide ranges, Excel
  sheet/range, heading path, display label, and parser metadata.
- Excel facts and cells carry the exact sheet/cell, displayed/raw value,
  formula, cached value, period, unit, labels, and quality metadata.
- `omnigent/omnigent/server/private_fund_workflow.py`
  - Saved information lives in `research_saved_assets`.
  - Research-node history lives in `research_node_versions`.
  - `research_node_evidence` links exact Evidence IDs to an immutable node
    version.

Migration version 1 renames the legacy version-row table to
`legacy_documents_v0`, creates the normalized store, and imports all of the
above records transactionally. The legacy tables remain in the database for
audit/recovery.

## Safe open

Production callers must provide both the owning project root and database
path:

```ts
const database = openProjectDatabase({
  projectRoot: "/data/users/ns/projects/project-1",
  databasePath: "data/project.sqlite",
});
```

The resolver rejects lexical traversal, cross-project absolute paths,
symlinked parents that escape the project, and a database-file symlink.
Document `storedPath` values written through `DocumentsRepository` are checked
against the same project root.

`openInMemoryProjectDatabase()` is intentionally separate and intended for
tests.

## Repository API

```ts
const store = createResearchStore(database);

store.documents.registerVersion(...);
store.documents.updateVersionStatus(...);
store.documents.list(...);
store.documents.listVersions(...);

store.evidence.put(...);
store.evidence.putMany(...);
store.evidence.trace("chunk:...");
store.evidence.search({ query, limit, offset });

store.assets.saveVersion(...);
store.assets.resolveVersion(...);
store.assets.list(...);
store.assets.listVersions(...);
```

Every mutation uses an immediate transaction (and nested savepoints), every
JSON column has application validation plus a SQLite `json_valid` constraint,
and all list/search APIs have bounded deterministic pagination.

FTS5 with the trigram tokenizer is selected when available, then FTS5
`unicode61`; otherwise search uses the deterministic in-process scorer. The
chosen backend is persisted in `project_store_settings`.
