# Compute result projector

This package is the TypeScript trust boundary between pure Python compute
artifacts and the per-project ResearchStore.

For `document.ingest`, it:

- derives the only allowed project root from
  `dataRoot/users/{tenantNamespace}/projects/{projectId}`;
- binds the queue job to the registered document version, exact source path,
  file size and SHA-256;
- opens only project-contained, regular NDJSON artifacts and streams them with
  byte, line and record limits;
- validates record structure and compute metrics before committing;
- writes Evidence and the document-version status in one project-database
  transaction;
- uses stable Evidence IDs so replay after a crash between projection commit
  and `queue.complete` is idempotent.

Projection failures roll back all Evidence. A parsing version is then marked
`failed` in a separate transaction; the Job Worker does not call
`queue.complete`.

## Evidence mapping

| Compute record | Evidence |
| --- | --- |
| PDF page | `page` with page range and page bbox |
| Workbook cell | `cell` with sheet, cell, formula, raw and display values |
| DOCX paragraph / table | `chunk` |
| DOCX table cell | `cell` |
| PPTX slide / slide text | `page` / `chunk` |
| CSV row / cell | `chunk` / `cell` |
| Markdown heading / block | `chunk` |
| Plain-text line | `chunk` |

Format-specific source locators are preserved in Evidence metadata as
`sourceRecordLocator`; supported canonical locator fields are also populated
for citation and UI navigation.
