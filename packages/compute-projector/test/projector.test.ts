import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  afterEach,
  describe,
  expect,
  it,
} from "vitest";

import type { ComputeResponse } from "@private-fund/contracts";
import {
  createResearchStore,
  openProjectDatabase,
} from "@private-fund/research-store";

import {
  ComputeProjectionError,
  ComputeResultProjector,
  type GenericDocumentFormat,
  type ProjectionJob,
} from "../src/index.js";

const TENANT = "00000000-0000-4000-8000-000000000001";
const OTHER_TENANT = "00000000-0000-4000-8000-000000000002";
const PROJECT = "project-1";
const temporaryDirectories: string[] = [];

interface Fixture {
  readonly dataRoot: string;
  readonly projectRoot: string;
  readonly outputDirectory: string;
  readonly inputPath: string;
  readonly sourceSha256: string;
  readonly sourceSize: number;
  readonly documentId: string;
  readonly documentVersionId: string;
  readonly job: ProjectionJob;
}

function sha256(contents: string | Buffer): string {
  return createHash("sha256").update(contents).digest("hex");
}

async function fixture(
  extension: string,
  contents: string | Buffer = "registered-source",
): Promise<Fixture> {
  const dataRoot = await mkdtemp(
    path.join(tmpdir(), "compute-projector-"),
  );
  temporaryDirectories.push(dataRoot);
  const projectRoot = path.join(
    dataRoot,
    "users",
    TENANT,
    "projects",
    PROJECT,
  );
  const sourceDirectory = path.join(projectRoot, "sources");
  const outputDirectory = path.join(projectRoot, "artifacts", "job-1");
  await Promise.all([
    mkdir(sourceDirectory, { recursive: true }),
    mkdir(outputDirectory, { recursive: true }),
  ]);
  const inputPath = path.join(sourceDirectory, `source${extension}`);
  await writeFile(inputPath, contents);
  const sourceSha256 = sha256(contents);
  const sourceSize = Buffer.byteLength(contents);
  const database = openProjectDatabase({
    projectRoot,
    databasePath: path.join("data", "research.sqlite3"),
    preferredSearchBackend: "deterministic",
  });
  let registration;
  try {
    registration = createResearchStore(database).documents.registerVersion({
      logicalKey: `fixture:${extension}`,
      sourceRoot: "test",
      sourceRelpath: `source${extension}`,
      title: `Source ${extension}`,
      originalFilename: `source${extension}`,
      storedPath: path.relative(projectRoot, inputPath),
      fileType: extension.slice(1),
      sha256: sourceSha256,
      fileSize: sourceSize,
      status: "parsing",
      activate: false,
    });
  } finally {
    database.close();
  }
  const job: ProjectionJob = {
    id: "job-1",
    type: "document.ingest",
    tenantNamespace: TENANT,
    projectId: PROJECT,
    payload: {
      inputPath,
      outputDirectory,
      documentId: registration.document.id,
      documentVersionId: registration.version.id,
      sourceSha256,
    },
  };
  return {
    dataRoot,
    projectRoot,
    outputDirectory,
    inputPath,
    sourceSha256,
    sourceSize,
    documentId: registration.document.id,
    documentVersionId: registration.version.id,
    job,
  };
}

async function responseFor(
  value: Fixture,
  records: readonly Record<string, unknown>[],
  metrics: Readonly<Record<string, unknown>>,
): Promise<ComputeResponse> {
  const recordsFile = "records.ndjson";
  const contents =
    records.length === 0
      ? ""
      : `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
  await writeFile(
    path.join(value.outputDirectory, recordsFile),
    contents,
    "utf8",
  );
  return {
    protocolVersion: 1,
    requestId: "request-1",
    status: "completed",
    recordsFile,
    artifacts: [
      {
        path: recordsFile,
        mediaType: "application/x-ndjson",
        checksum: `sha256:${sha256(contents)}`,
        size: Buffer.byteLength(contents),
      },
    ],
    metrics: {
      inputChecksum: `sha256:${value.sourceSha256}`,
      recordCount: records.length,
      recordsBytes: Buffer.byteLength(contents),
      ...metrics,
    },
    error: null,
  };
}

function codePointLength(value: string): number {
  return [...value].length;
}

function genericMetrics(
  fixtureValue: Fixture,
  format: GenericDocumentFormat,
  records: readonly Record<string, unknown>[],
  additional: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  const texts = records
    .filter((record) => record.recordType === "text")
    .map((record) => String(record.text));
  const recordTypeCounts: Record<string, number> = {};
  for (const record of records) {
    const recordType = String(record.recordType);
    recordTypeCounts[recordType] =
      (recordTypeCounts[recordType] ?? 0) + 1;
  }
  return {
    inputBytes: fixtureValue.sourceSize,
    format,
    textRecordCount: texts.length,
    textChars: texts.reduce(
      (total, text) => total + codePointLength(text),
      0,
    ),
    recordTypeCounts,
    ...additional,
  };
}

function withStore<T>(
  value: Fixture,
  callback: (
    store: ReturnType<typeof createResearchStore>,
    database: ReturnType<typeof openProjectDatabase>,
  ) => T,
): T {
  const database = openProjectDatabase({
    projectRoot: value.projectRoot,
    databasePath: path.join("data", "research.sqlite3"),
    preferredSearchBackend: "deterministic",
  });
  try {
    return callback(createResearchStore(database), database);
  } finally {
    database.close();
  }
}

function evidenceCount(
  database: ReturnType<typeof openProjectDatabase>,
): number {
  const row = database.connection
    .prepare("SELECT COUNT(*) AS count FROM evidence")
    .get();
  return Number(row?.count ?? -1);
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("ComputeResultProjector", () => {
  it("streams PDF pages transactionally and is idempotent after a crash-before-complete retry", async () => {
    const value = await fixture(".pdf", "%PDF-projector-fixture");
    const records = [
      {
        recordType: "pdf_page",
        sourceName: "source.pdf",
        pageNumber: 1,
        width: 612,
        height: 792,
        rotation: 0,
        text: "Page one",
      },
      {
        recordType: "pdf_page",
        sourceName: "source.pdf",
        pageNumber: 2,
        width: 612,
        height: 792,
        rotation: 0,
        text: "Page two",
      },
    ];
    const response = await responseFor(value, records, {
      pageCount: 2,
      extractedPageCount: 2,
    });
    const projector = new ComputeResultProjector({
      dataRoot: value.dataRoot,
    });

    await expect(projector.project(value.job, response)).resolves.toMatchObject({
      kind: "document",
      evidenceCount: 2,
      status: "indexed",
    });
    await expect(projector.project(value.job, response)).resolves.toMatchObject({
      kind: "document",
      evidenceCount: 2,
      status: "indexed",
    });

    withStore(value, (store, database) => {
      expect(evidenceCount(database)).toBe(2);
      expect(
        store.evidence.get(`page:${value.documentVersionId}.1`),
      ).toMatchObject({
        kind: "page",
        originalText: "Page one",
        pageStart: 1,
        pageEnd: 1,
      });
      expect(store.documents.getVersion(value.documentVersionId)).toMatchObject({
        status: "indexed",
        lifecycle: "active",
      });
    });
  });

  it("projects lossless workbook cells including formula, cached value and stable locator", async () => {
    const value = await fixture(".xlsx", "fake-xlsx-source");
    const records = [
      {
        recordType: "workbook",
        sourceName: "source.xlsx",
        sheetNames: ["Model"],
        keepVba: false,
      },
      {
        recordType: "worksheet",
        sheet: "Model",
        maxRow: 1,
        maxColumn: 2,
      },
      {
        recordType: "cell",
        sheet: "Model",
        coordinate: "A1",
        row: 1,
        column: 1,
        value: 21,
        formula: null,
        cachedValue: null,
        dataType: "n",
        numberFormat: "0",
      },
      {
        recordType: "cell",
        sheet: "Model",
        coordinate: "B1",
        row: 1,
        column: 2,
        value: "=SUM(A1)",
        formula: "=SUM(A1)",
        cachedValue: 42,
        dataType: "f",
        numberFormat: "0.00",
      },
    ];
    const response = await responseFor(value, records, {
      sheetCount: 1,
      cellCount: 2,
      visitedCellCount: 2,
      macrosPresent: false,
    });

    await new ComputeResultProjector({
      dataRoot: value.dataRoot,
    }).project(value.job, response);

    withStore(value, (store, database) => {
      const row = database.connection
        .prepare(
          `SELECT evidence_id AS evidenceId
           FROM evidence
           WHERE kind = 'cell' AND sheet_name = 'Model' AND cell_ref = 'B1'`,
        )
        .get();
      const evidence = store.evidence.get(String(row?.evidenceId));
      expect(evidence).toMatchObject({
        kind: "cell",
        formula: "=SUM(A1)",
        displayValue: "42",
        rawValue: "=SUM(A1)",
      });
      expect(evidence.metadata).toMatchObject({
        recordType: "cell",
        dataType: "f",
        numberFormat: "0.00",
        numericValue: 42,
        cachedValue: "42",
        cachedValueTruncated: false,
      });
      expect(
        store.documents.getVersion(value.documentVersionId).metadata,
      ).toMatchObject({
        sourcePreview: {
          version: 1,
          kind: "excel",
          sheets: [
            {
              sheetName: "Model",
              maxRow: 1,
              maxColumn: 2,
              usedRange: "A1:B1",
              nonEmptyCellCount: 2,
              formulaCount: 1,
            },
          ],
        },
      });
    });
  });

  const genericCases: readonly {
    readonly name: string;
    readonly extension: string;
    readonly format: GenericDocumentFormat;
    readonly records: readonly Record<string, unknown>[];
    readonly additionalMetrics: Readonly<Record<string, unknown>>;
    readonly expectedKinds: Readonly<Record<string, number>>;
    readonly locatorKind: string;
  }[] = [
    {
      name: "DOCX paragraph, table and table cell",
      extension: ".docx",
      format: "docx",
      records: [
        {
          recordType: "document",
          format: "docx",
          sourceName: "source.docx",
        },
        {
          recordType: "text",
          text: "Investment thesis",
          locator: {
            kind: "docx_paragraph",
            paragraphNumber: 1,
          },
          paragraphStyle: "Heading1",
        },
        {
          recordType: "table",
          rowCount: 1,
          locator: { kind: "docx_table", tableNumber: 1 },
        },
        {
          recordType: "text",
          text: "Revenue",
          locator: {
            kind: "docx_table_cell",
            tableNumber: 1,
            rowNumber: 1,
            columnNumber: 1,
            columnSpan: 1,
          },
        },
      ],
      additionalMetrics: {
        paragraphCount: 1,
        tableCount: 1,
        tableCellCount: 1,
      },
      expectedKinds: { chunk: 2, cell: 1 },
      locatorKind: "docx_table_cell",
    },
    {
      name: "PPTX slide and slide text",
      extension: ".pptx",
      format: "pptx",
      records: [
        {
          recordType: "document",
          format: "pptx",
          sourceName: "source.pptx",
        },
        {
          recordType: "slide",
          textBlockCount: 1,
          locator: {
            kind: "pptx_slide",
            slideNumber: 1,
            part: "ppt/slides/slide1.xml",
          },
        },
        {
          recordType: "text",
          text: "Market opportunity",
          locator: {
            kind: "pptx_slide_text",
            slideNumber: 1,
            textNumber: 1,
          },
        },
      ],
      additionalMetrics: { slideCount: 1, slideTextCount: 1 },
      expectedKinds: { page: 1, chunk: 1 },
      locatorKind: "pptx_slide_text",
    },
    {
      name: "CSV row and cells",
      extension: ".csv",
      format: "csv",
      records: [
        {
          recordType: "document",
          format: "csv",
          sourceName: "source.csv",
        },
        {
          recordType: "row",
          cellCount: 2,
          locator: {
            kind: "csv_row",
            rowNumber: 1,
            lineStart: 1,
            lineEnd: 1,
          },
        },
        {
          recordType: "text",
          text: "Ticker",
          locator: {
            kind: "csv_cell",
            rowNumber: 1,
            columnNumber: 1,
            lineStart: 1,
            lineEnd: 1,
          },
        },
        {
          recordType: "text",
          text: "600519.SH",
          locator: {
            kind: "csv_cell",
            rowNumber: 1,
            columnNumber: 2,
            lineStart: 1,
            lineEnd: 1,
          },
        },
      ],
      additionalMetrics: { rowCount: 1, cellCount: 2 },
      expectedKinds: { chunk: 1, cell: 2 },
      locatorKind: "csv_cell",
    },
    {
      name: "Markdown heading and block",
      extension: ".md",
      format: "markdown",
      records: [
        {
          recordType: "document",
          format: "markdown",
          sourceName: "source.md",
        },
        {
          recordType: "text",
          text: "Risks",
          locator: {
            kind: "text_heading",
            headingNumber: 1,
            level: 1,
            lineStart: 1,
            lineEnd: 1,
          },
          headingPath: ["Risks"],
        },
        {
          recordType: "text",
          text: "Demand may slow.",
          locator: {
            kind: "text_block",
            blockNumber: 1,
            lineStart: 2,
            lineEnd: 2,
          },
          headingPath: ["Risks"],
        },
      ],
      additionalMetrics: { headingCount: 1, blockCount: 1 },
      expectedKinds: { chunk: 2 },
      locatorKind: "text_heading",
    },
    {
      name: "plain text lines",
      extension: ".txt",
      format: "text",
      records: [
        {
          recordType: "document",
          format: "text",
          sourceName: "source.txt",
        },
        {
          recordType: "text",
          text: "first",
          locator: {
            kind: "text_line",
            lineNumber: 1,
            lineStart: 1,
            lineEnd: 1,
          },
        },
        {
          recordType: "text",
          text: "",
          locator: {
            kind: "text_line",
            lineNumber: 2,
            lineStart: 2,
            lineEnd: 2,
          },
        },
      ],
      additionalMetrics: { lineCount: 2 },
      expectedKinds: { chunk: 2 },
      locatorKind: "text_line",
    },
  ];

  it.each(genericCases)(
    "projects $name into stable generic Evidence",
    async (testCase) => {
      const value = await fixture(
        testCase.extension,
        `generic-${testCase.format}-source`,
      );
      const response = await responseFor(
        value,
        testCase.records,
        genericMetrics(
          value,
          testCase.format,
          testCase.records,
          testCase.additionalMetrics,
        ),
      );
      const projector = new ComputeResultProjector({
        dataRoot: value.dataRoot,
      });

      const first = await projector.project(value.job, response);
      const second = await projector.project(value.job, response);
      expect(second).toEqual(first);

      withStore(value, (store, database) => {
        const rows = database.connection
          .prepare(
            `SELECT kind, COUNT(*) AS count
             FROM evidence
             GROUP BY kind`,
          )
          .all();
        expect(
          Object.fromEntries(
            rows.map((row) => [String(row.kind), Number(row.count)]),
          ),
        ).toEqual(testCase.expectedKinds);
        const matching = database.connection
          .prepare(
            `SELECT evidence_id AS evidenceId
             FROM evidence
             WHERE json_extract(metadata_json, '$.sourceRecordLocator.kind') = ?
             LIMIT 1`,
          )
          .get(testCase.locatorKind);
        expect(
          store.evidence.get(String(matching?.evidenceId)).metadata,
        ).toMatchObject({
          sourceRecordLocator: { kind: testCase.locatorKind },
        });
        expect(
          store.documents.getVersion(value.documentVersionId).status,
        ).toBe("indexed");
      });
    },
  );

  it("rolls back partial Evidence and marks the version failed when a later record is invalid", async () => {
    const value = await fixture(".pdf", "%PDF-rollback-fixture");
    const records = [
      {
        recordType: "pdf_page",
        sourceName: "source.pdf",
        pageNumber: 1,
        width: 100,
        height: 100,
        rotation: 0,
        text: "first",
      },
      {
        recordType: "pdf_page",
        sourceName: "source.pdf",
        pageNumber: 1,
        width: 100,
        height: 100,
        rotation: 0,
        text: "duplicate",
      },
    ];
    const response = await responseFor(value, records, {
      pageCount: 2,
      extractedPageCount: 2,
    });

    await expect(
      new ComputeResultProjector({
        dataRoot: value.dataRoot,
      }).project(value.job, response),
    ).rejects.toMatchObject({
      code: "projection_record_invalid",
      retryable: false,
    } satisfies Partial<ComputeProjectionError>);

    withStore(value, (store, database) => {
      expect(evidenceCount(database)).toBe(0);
      expect(store.documents.getVersion(value.documentVersionId)).toMatchObject({
        status: "failed",
        lifecycle: "failed_attempt",
      });
    });
  });

  it("attests the actual registered source bytes instead of trusting task and worker checksums", async () => {
    const value = await fixture(".pdf", "original");
    await writeFile(value.inputPath, "tampered");
    const response = await responseFor(
      value,
      [
        {
          recordType: "pdf_page",
          sourceName: "source.pdf",
          pageNumber: 1,
          width: 100,
          height: 100,
          rotation: 0,
          text: "content",
        },
      ],
      { pageCount: 1, extractedPageCount: 1 },
    );

    await expect(
      new ComputeResultProjector({
        dataRoot: value.dataRoot,
      }).project(value.job, response),
    ).rejects.toMatchObject({
      code: "projection_integrity_mismatch",
      retryable: false,
    } satisfies Partial<ComputeProjectionError>);
    withStore(value, (store, database) => {
      expect(evidenceCount(database)).toBe(0);
      expect(
        store.documents.getVersion(value.documentVersionId).status,
      ).toBe("failed");
    });
  });

  it("rejects a cross-tenant job before opening the other tenant's document store", async () => {
    const value = await fixture(".pdf");
    await mkdir(
      path.join(
        value.dataRoot,
        "users",
        OTHER_TENANT,
        "projects",
        PROJECT,
      ),
      { recursive: true },
    );
    const response = await responseFor(value, [], {
      pageCount: 0,
      extractedPageCount: 0,
    });
    const crossTenantJob: ProjectionJob = {
      ...value.job,
      tenantNamespace: OTHER_TENANT,
    };

    await expect(
      new ComputeResultProjector({
        dataRoot: value.dataRoot,
      }).project(crossTenantJob, response),
    ).rejects.toMatchObject({
      code: "projection_path_violation",
      retryable: false,
    } satisfies Partial<ComputeProjectionError>);
    withStore(value, (store, database) => {
      expect(evidenceCount(database)).toBe(0);
      expect(
        store.documents.getVersion(value.documentVersionId).status,
      ).toBe("parsing");
    });
  });

  it("requires inputPath to be the exact file registered by documentVersionId", async () => {
    const value = await fixture(".pdf", "same-content");
    const substitutePath = path.join(
      value.projectRoot,
      "sources",
      "substitute.pdf",
    );
    await writeFile(substitutePath, "same-content", "utf8");
    const response = await responseFor(value, [], {
      pageCount: 0,
      extractedPageCount: 0,
    });

    await expect(
      new ComputeResultProjector({
        dataRoot: value.dataRoot,
      }).project(
        {
          ...value.job,
          payload: {
            ...value.job.payload,
            inputPath: substitutePath,
          },
        },
        response,
      ),
    ).rejects.toMatchObject({
      code: "projection_integrity_mismatch",
      retryable: false,
    } satisfies Partial<ComputeProjectionError>);
    withStore(value, (store, database) => {
      expect(evidenceCount(database)).toBe(0);
      expect(
        store.documents.getVersion(value.documentVersionId).status,
      ).toBe("failed");
    });
  });

  it("enforces streamed line limits and never leaves partially committed Evidence", async () => {
    const value = await fixture(".pdf");
    const response = await responseFor(
      value,
      [
        {
          recordType: "pdf_page",
          sourceName: "source.pdf",
          pageNumber: 1,
          width: 100,
          height: 100,
          rotation: 0,
          text: "bounded",
        },
      ],
      { pageCount: 1, extractedPageCount: 1 },
    );

    await expect(
      new ComputeResultProjector({
        dataRoot: value.dataRoot,
        maxLineBytes: 32,
      }).project(value.job, response),
    ).rejects.toMatchObject({
      code: "projection_limit_exceeded",
      retryable: false,
    } satisfies Partial<ComputeProjectionError>);
    withStore(value, (_store, database) => {
      expect(evidenceCount(database)).toBe(0);
    });
  });

  it("treats an unknown documentVersionId as a non-retryable integrity failure", async () => {
    const value = await fixture(".pdf");
    const response = await responseFor(value, [], {
      pageCount: 0,
      extractedPageCount: 0,
    });
    await expect(
      new ComputeResultProjector({
        dataRoot: value.dataRoot,
      }).project(
        {
          ...value.job,
          payload: {
            ...value.job.payload,
            documentVersionId: "ver_unknown",
          },
        },
        response,
      ),
    ).rejects.toMatchObject({
      code: "projection_integrity_mismatch",
      retryable: false,
    } satisfies Partial<ComputeProjectionError>);
  });
});
