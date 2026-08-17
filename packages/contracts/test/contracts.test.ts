import { describe, expect, it } from "vitest";

import {
  assignSourceFolderDocumentRequestSchema,
  computeOperationSchema,
  computeRequestSchema,
  computeWorkerHealthSchema,
  createSourceFolderRequestSchema,
  enqueueJobRequestSchema,
  excelSourcePayloadSchema,
  excelSourceQuerySchema,
  jobSchema,
  listWorkflowAssumptionsQuerySchema,
  listSessionChildrenQuerySchema,
  pdfSourcePageQuerySchema,
  pdfSourcePageSchema,
  researchAssetContextSchema,
  sessionChildrenPageSchema,
  sessionEventSchema,
  sessionLabelsResponseSchema,
  updateSourceFolderRequestSchema,
  updateResearchAssetContextRequestSchema,
  updateTrackingWatchRuleRequestSchema,
  updateValuationWatchRuleRequestSchema,
} from "../src/index.js";

describe("shared control-plane contracts", () => {
  it("accepts versionable event names but rejects unsafe names", () => {
    const base = {
      sessionId: "session-1",
      sequence: 1,
      timestamp: new Date().toISOString(),
      operationId: null,
      payload: {},
    };
    expect(
      sessionEventSchema.parse({
        ...base,
        type: "agent.retry.started",
      }).type,
    ).toBe("agent.retry.started");
    expect(() =>
      sessionEventSchema.parse({
        ...base,
        type: "Agent Retry Started",
      }),
    ).toThrow();
  });

  it("requires explicit job idempotency and bounded retry counts", () => {
    expect(
      enqueueJobRequestSchema.parse({
        projectId: "project-1",
        type: "document.ingest",
        idempotencyKey: "document-hash-v1",
      }),
    ).toMatchObject({
      payload: {},
      maxAttempts: 3,
    });
    expect(() =>
      enqueueJobRequestSchema.parse({
        projectId: "project-1",
        type: "document.ingest",
        idempotencyKey: "document-hash-v1",
        maxAttempts: 21,
      }),
    ).toThrow();
  });

  it("bounds workflow assumption history filters", () => {
    expect(
      listWorkflowAssumptionsQuerySchema.parse({
        limit: "25",
        offset: "50",
        status: "resolved",
      }),
    ).toEqual({
      limit: 25,
      offset: 50,
      status: "resolved",
    });
    expect(
      listWorkflowAssumptionsQuerySchema.parse({}),
    ).toEqual({
      limit: 50,
      offset: 0,
    });
    expect(() =>
      listWorkflowAssumptionsQuerySchema.parse({
        limit: "501",
        status: "deleted",
      }),
    ).toThrow();
  });

  it("validates the complete durable job representation", () => {
    const now = new Date().toISOString();
    expect(
      jobSchema.parse({
        id: "job-1",
        tenantNamespace: "00000000-0000-4000-8000-000000000001",
        projectId: "project-1",
        type: "document.ingest",
        status: "queued",
        payload: {},
        attempt: 0,
        maxAttempts: 3,
        leaseOwner: null,
        leaseExpiresAt: null,
        idempotencyKey: "source-v1",
        availableAt: now,
        createdAt: now,
        updatedAt: now,
        startedAt: null,
        completedAt: null,
        result: null,
        error: null,
      }).status,
    ).toBe("queued");
  });

  it("keeps document extraction in the compute request and health contracts", () => {
    expect(computeOperationSchema.parse("extract_document")).toBe(
      "extract_document",
    );
    expect(
      computeRequestSchema.parse({
        protocolVersion: 1,
        requestId: "request-document",
        jobId: "job-document",
        operation: "extract_document",
        inputPath: "/tmp/source.docx",
        outputDirectory: "/tmp/output",
      }).options,
    ).toEqual({});
    const operations = [
      "extract_pdf",
      "extract_document",
      "render_pdf_page",
      "extract_workbook",
      "derive_workbook",
      "fetch_market_data",
      "render_report",
    ] as const;
    expect(
      computeWorkerHealthSchema.parse({
        protocolVersion: 1,
        status: "ok",
        worker: "private-fund-compute-worker",
        pythonVersion: "3.9.6",
        implementedOperations: operations,
        contractOperations: operations,
        capabilities: {
          extract_document: {
            extensions: [
              ".csv",
              ".docx",
              ".markdown",
              ".md",
              ".pptx",
              ".txt",
            ],
            recordsMediaType: "application/x-ndjson",
            boundedExtraction: true,
          },
          fetch_market_data: {
            providers: ["fixture", "akshare"],
            akshareOptional: true,
          },
        },
        dependencies: {
          pymupdf: true,
          openpyxl: true,
          akshare: false,
          reportlab: true,
        },
      }).implementedOperations,
    ).toEqual(operations);
  });

  it("bounds compute paths at the shared protocol boundary", () => {
    const request = {
      protocolVersion: 1,
      requestId: "request-document",
      jobId: "job-document",
      operation: "extract_document",
      outputDirectory: "/tmp/output",
      options: {},
    } as const;
    expect(() =>
      computeRequestSchema.parse({
        ...request,
        inputPath: `/${"x".repeat(32_768)}`,
      }),
    ).toThrow();
  });

  it("validates bounded canonical Excel and PDF source previews", () => {
    expect(
      excelSourceQuerySchema.parse({
        sheetName: " DCF ",
        rangeRef: "A1:B2",
        windowRow: "2",
        windowColumn: "1",
      }),
    ).toEqual({
      sheetName: "DCF",
      rangeRef: "A1:B2",
      windowRow: 2,
      windowColumn: 1,
    });
    expect(() =>
      excelSourceQuerySchema.parse({
        sheetName: "DCF",
        windowRow: 1,
      }),
    ).toThrow();
    expect(
      excelSourcePayloadSchema.parse({
        kind: "excel",
        mode: "workbook",
        documentId: "document-1",
        documentVersionId: "version-1",
        anchorEvidenceId: "cell:anchor",
        fileName: "model.xlsx",
        sheets: [],
      }).mode,
    ).toBe("workbook");
    expect(
      pdfSourcePageQuerySchema.parse({ quote: " operating margin " }),
    ).toEqual({ quote: "operating margin" });
    expect(
      pdfSourcePageSchema.parse({
        kind: "pdf",
        documentId: "document-1",
        documentVersionId: "version-1",
        anchorEvidenceId: "page:anchor",
        pageEvidenceId: "page:anchor",
        pageNumber: 1,
        pageCount: 2,
        fileName: "report.pdf",
        imageUrl:
          "/v1/projects/project-1/evidence/page%3Aanchor/source/pdf/pages/1/image",
        imageWidth: 1224,
        imageHeight: 1584,
        pageWidth: 612,
        pageHeight: 792,
        highlights: [],
        matched: false,
        highlightSource: {
          mode: "none",
          evidenceId: "page:anchor",
        },
      }).pageNumber,
    ).toBe(1);
  });

  it("validates source-folder tree mutations without accepting paths", () => {
    expect(
      createSourceFolderRequestSchema.parse({
        parentId: null,
        name: " 2026 Q2 ",
      }),
    ).toMatchObject({
      name: "2026 Q2",
      folderKind: "manual",
      sortOrder: 0,
      metadata: {},
    });
    expect(() =>
      createSourceFolderRequestSchema.parse({
        name: "../outside",
      }),
    ).toThrow();
    expect(() => updateSourceFolderRequestSchema.parse({})).toThrow();
    expect(
      assignSourceFolderDocumentRequestSchema.parse({
        documentId: "document-1",
      }),
    ).toEqual({
      documentId: "document-1",
      assignmentSource: "manual",
      metadata: {},
    });
  });

  it("does not synthesize omitted watch-rule fields during PATCH parsing", () => {
    expect(
      updateTrackingWatchRuleRequestSchema.parse({
        name: "Only rename this rule",
        active: false,
      }),
    ).toEqual({
      name: "Only rename this rule",
      active: false,
    });
    expect(
      updateValuationWatchRuleRequestSchema.parse({
        minMateriality: "critical",
        active: false,
      }),
    ).toEqual({
      minMateriality: "critical",
      active: false,
    });
    expect(() => updateTrackingWatchRuleRequestSchema.parse({})).toThrow();
    expect(() => updateValuationWatchRuleRequestSchema.parse({})).toThrow();
  });

  it("accepts ordered document and research-asset context ids without duplicates", () => {
    const assetIds = [
      "document:document-1",
      "node:investment-thesis",
      "asset_saved",
    ];
    expect(
      updateResearchAssetContextRequestSchema.parse({ assetIds }),
    ).toEqual({ assetIds });
    expect(
      researchAssetContextSchema.parse({ assetIds }),
    ).toEqual({ assetIds });
    expect(() =>
      updateResearchAssetContextRequestSchema.parse({
        assetIds: ["document:document-1", "document:document-1"],
      }),
    ).toThrow();
    expect(() =>
      updateResearchAssetContextRequestSchema.parse({
        assetIds: ["document:"],
      }),
    ).toThrow();
  });

  it("bounds fork-lineage pages and exposes only canonical system labels", () => {
    expect(
      listSessionChildrenQuerySchema.parse({
        limit: "25",
        offset: "5",
        includeArchived: "0",
      }),
    ).toEqual({
      limit: 25,
      offset: 5,
      includeArchived: false,
    });
    expect(() =>
      listSessionChildrenQuerySchema.parse({ limit: "501" }),
    ).toThrow();

    const now = new Date().toISOString();
    expect(
      sessionChildrenPageSchema.parse({
        parentSessionId: "session-parent",
        items: [
          {
            id: "session-child",
            projectId: "project-1",
            title: "Fork",
            status: "idle",
            archivedAt: null,
            forkedFromSessionId: "session-parent",
            createdAt: now,
            updatedAt: now,
            lastSequence: 1,
          },
        ],
        total: 1,
        limit: 25,
        offset: 0,
        hasMore: false,
      }).items[0]?.forkedFromSessionId,
    ).toBe("session-parent");

    expect(
      sessionLabelsResponseSchema.parse({
        id: "session-child",
        labels: {
          "private_fund.project_id": "project-1",
          "private_fund.lifecycle": "active",
          "private_fund.lineage": "fork",
          "private_fund.forked_from_session_id": "session-parent",
        },
      }).labels["private_fund.lineage"],
    ).toBe("fork");
    expect(() =>
      sessionLabelsResponseSchema.parse({
        id: "session-child",
        labels: {
          "private_fund.project_id": "project-1",
          "private_fund.lifecycle": "active",
          "private_fund.lineage": "fork",
        },
      }),
    ).toThrow();
    expect(() =>
      sessionLabelsResponseSchema.parse({
        id: "session-root",
        labels: {
          "private_fund.project_id": "project-1",
          "private_fund.lifecycle": "active",
          "private_fund.lineage": "root",
          "omnigent.wrapper": "codex-native-ui",
        },
      }),
    ).toThrow();
  });
});
