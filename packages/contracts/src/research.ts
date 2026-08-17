import { z } from "zod";

import { identifierSchema } from "./api.js";
import { evidenceIdSchema } from "./agent-tools.js";

export const researchMetadataSchema = z.record(z.string(), z.unknown());

export const documentStatusSchema = z.enum([
  "active",
  "removed",
  "archived",
]);

export const documentVersionStatusSchema = z.enum([
  "parsing",
  "indexed",
  "needs_ocr",
  "failed",
  "review_required",
]);

export const documentLifecycleSchema = z.enum([
  "pending",
  "active",
  "superseded",
  "removed",
  "failed_attempt",
]);

export const researchDocumentSchema = z.object({
  id: identifierSchema,
  logicalKey: z.string().min(1).max(1_000),
  sourceRoot: z.string().nullable(),
  sourceRelpath: z.string().min(1).max(4_000),
  title: z.string().min(1).max(500),
  status: documentStatusSchema,
  currentVersionId: identifierSchema.nullable(),
  currentVersionNo: z.number().int().nonnegative(),
  metadata: researchMetadataSchema,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  deletedAt: z.iso.datetime().nullable(),
});

export const researchDocumentVersionSchema = z.object({
  id: identifierSchema,
  documentId: identifierSchema,
  versionNo: z.number().int().positive(),
  supersedesVersionId: identifierSchema.nullable(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  originalFilename: z.string().min(1).max(1_000),
  storedPath: z.string().min(1).max(8_000),
  fileType: z.string().min(1).max(100),
  mimeType: z.string().max(300).nullable(),
  fileSize: z.number().int().nonnegative(),
  status: documentVersionStatusSchema,
  lifecycle: documentLifecycleSchema,
  parserName: z.string().max(200).nullable(),
  parserVersion: z.string().max(200).nullable(),
  metadata: researchMetadataSchema,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const registerDocumentVersionRequestSchema = z.object({
  documentId: identifierSchema.optional(),
  logicalKey: z.string().min(1).max(1_000).optional(),
  sourceRoot: z.string().max(4_000).nullable().optional(),
  sourceRelpath: z.string().min(1).max(4_000),
  title: z.string().trim().min(1).max(500),
  originalFilename: z.string().trim().min(1).max(1_000),
  storedPath: z.string().min(1).max(8_000),
  fileType: z.string().min(1).max(100),
  mimeType: z.string().max(300).nullable().optional(),
  sha256: z.string().regex(/^[a-fA-F0-9]{64}$/),
  fileSize: z.number().int().nonnegative(),
  status: documentVersionStatusSchema.default("parsing"),
  parserName: z.string().max(200).nullable().optional(),
  parserVersion: z.string().max(200).nullable().optional(),
  metadata: researchMetadataSchema.default({}),
  activate: z.boolean().optional(),
});

export const documentFileQuerySchema = z
  .object({
    versionId: identifierSchema.optional(),
  })
  .strict();

export const documentTextPreviewQuerySchema = z
  .object({
    versionId: identifierSchema.optional(),
  })
  .strict();

export const documentTextPreviewSchema = z.object({
  kind: z.literal("document_text"),
  documentId: identifierSchema,
  documentVersionId: identifierSchema,
  fileName: z.string().min(1).max(1_000),
  fileType: z.string().min(1).max(100),
  chunkCount: z.number().int().min(0).max(400),
  contentMarkdown: z.string().max(200_000),
  truncated: z.boolean(),
});

export const deleteResearchDocumentsRequestSchema = z
  .object({
    documentIds: z.array(identifierSchema).min(1).max(500),
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.documentIds).size !== value.documentIds.length) {
      context.addIssue({
        code: "custom",
        path: ["documentIds"],
        message: "documentIds must not contain duplicates",
      });
    }
  });

export const deleteResearchDocumentsResponseSchema = z.object({
  documents: z.array(researchDocumentSchema).min(1).max(500),
  deletedDocumentIds: z.array(identifierSchema).max(500),
  alreadyRemovedDocumentIds: z.array(identifierSchema).max(500),
});

export const researchEvidenceKindSchema = z.enum([
  "chunk",
  "fact",
  "cell",
  "page",
]);

export const researchEvidenceLocatorSchema = z.object({
  displayText: z.string().max(2_000).optional(),
  sourceRef: z.string().max(4_000).optional(),
  pageStart: z.number().int().positive().optional(),
  pageEnd: z.number().int().positive().optional(),
  pageNumbers: z.array(z.number().int().positive()).max(10_000).optional(),
  bbox: z.tuple([
    z.number().finite(),
    z.number().finite(),
    z.number().finite(),
    z.number().finite(),
  ]).optional(),
  slideStart: z.number().int().positive().optional(),
  slideEnd: z.number().int().positive().optional(),
  sheetName: z.string().max(500).optional(),
  cellRange: z.string().max(200).optional(),
  cellRef: z.string().max(100).optional(),
  headingPath: z.string().max(2_000).optional(),
  formula: z.string().max(20_000).optional(),
  displayValue: z.string().max(20_000).optional(),
  rawValue: z.string().max(100_000).optional(),
});

export const researchEvidenceSchema = z.object({
  evidenceId: evidenceIdSchema,
  kind: researchEvidenceKindSchema,
  documentVersionId: identifierSchema,
  title: z.string().nullable(),
  summary: z.string().nullable(),
  originalText: z.string(),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  locator: researchEvidenceLocatorSchema,
  pageStart: z.number().int().positive().nullable(),
  pageEnd: z.number().int().positive().nullable(),
  bbox: z.tuple([
    z.number().finite(),
    z.number().finite(),
    z.number().finite(),
    z.number().finite(),
  ]).nullable(),
  sheetName: z.string().nullable(),
  cellRange: z.string().nullable(),
  cellRef: z.string().nullable(),
  formula: z.string().nullable(),
  displayValue: z.string().nullable(),
  rawValue: z.string().nullable(),
  metadata: researchMetadataSchema,
  createdAt: z.iso.datetime(),
});

export const researchEvidenceTraceSchema = researchEvidenceSchema.extend({
  document: researchDocumentSchema,
  documentVersion: researchDocumentVersionSchema,
});

export const excelSourceQuerySchema = z
  .object({
    sheetName: z.string().trim().min(1).max(500).optional(),
    rangeRef: z.string().trim().min(1).max(80).optional(),
    windowRow: z.coerce.number().int().min(1).max(1_048_576).optional(),
    windowColumn: z.coerce.number().int().min(1).max(16_384).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.rangeRef !== undefined && value.sheetName === undefined) {
      context.addIssue({
        code: "custom",
        path: ["sheetName"],
        message: "sheetName is required when rangeRef is supplied",
      });
    }
    if (
      (value.windowRow !== undefined || value.windowColumn !== undefined) &&
      value.rangeRef === undefined
    ) {
      context.addIssue({
        code: "custom",
        path: ["rangeRef"],
        message: "rangeRef is required when a window cursor is supplied",
      });
    }
  });

export const excelSourceSheetSchema = z.object({
  sheetName: z.string().min(1).max(500),
  sheetRole: z.string().min(1).max(100),
  usedRange: z.string().max(80).nullable(),
  rowCount: z.number().int().min(0).max(1_048_576),
  columnCount: z.number().int().min(0).max(16_384),
  nonEmptyCellCount: z.number().int().nonnegative(),
  formulaCount: z.number().int().nonnegative(),
  formulaDensity: z.number().min(0).max(1),
  summary: z.string().max(20_000).nullable(),
});

export const excelSourceRegionSchema = z.object({
  regionType: z.string().min(1).max(100),
  cellRange: z.string().min(1).max(80),
  rowCount: z.number().int().positive(),
  columnCount: z.number().int().positive(),
  nonEmptyCellCount: z.number().int().nonnegative(),
  formulaCount: z.number().int().nonnegative(),
  summary: z.string().max(20_000).nullable(),
});

export const excelSourceCellSchema = z.object({
  evidenceId: evidenceIdSchema,
  cellRef: z.string().min(1).max(100),
  rowIndex: z.number().int().min(1).max(1_048_576),
  columnIndex: z.number().int().min(1).max(16_384),
  displayValue: z.string().max(20_000).nullable(),
  rawValue: z.string().max(100_000).nullable(),
  numericValue: z.number().finite().nullable(),
  formula: z.string().max(20_000).nullable(),
  cachedValue: z.string().max(100_000).nullable(),
  numberFormat: z.string().max(2_000).nullable(),
  rowLabel: z.string().max(20_000).nullable(),
  columnLabel: z.string().max(20_000).nullable(),
  period: z.string().max(2_000).nullable(),
  unit: z.string().max(2_000).nullable(),
  isFormula: z.boolean(),
});

export const excelSourceWindowSchema = z.object({
  rowStart: z.number().int().min(1).max(1_048_576),
  rowEnd: z.number().int().min(1).max(1_048_576),
  columnStart: z.number().int().min(1).max(16_384),
  columnEnd: z.number().int().min(1).max(16_384),
  rowCount: z.number().int().positive(),
  columnCount: z.number().int().positive(),
  truncated: z.boolean(),
  displayRangeRef: z.string().min(1).max(80),
  previousRowStart: z.number().int().positive().nullable(),
  nextRowStart: z.number().int().positive().nullable(),
  previousColumnStart: z.number().int().positive().nullable(),
  nextColumnStart: z.number().int().positive().nullable(),
});

const excelSourceBaseSchema = z.object({
  kind: z.literal("excel"),
  documentId: identifierSchema,
  documentVersionId: identifierSchema,
  anchorEvidenceId: evidenceIdSchema,
  fileName: z.string().min(1).max(1_000),
});

export const excelSourcePayloadSchema = z.discriminatedUnion("mode", [
  excelSourceBaseSchema.extend({
    mode: z.literal("workbook"),
    sheets: z.array(excelSourceSheetSchema).max(16_384),
  }),
  excelSourceBaseSchema.extend({
    mode: z.literal("sheet"),
    sheet: excelSourceSheetSchema,
    regions: z.array(excelSourceRegionSchema).max(1_000),
  }),
  excelSourceBaseSchema.extend({
    mode: z.literal("range"),
    sheet: excelSourceSheetSchema,
    requestedRangeRef: z.string().min(1).max(80),
    rangeRef: z.string().min(1).max(80),
    requestedRowMin: z.number().int().positive(),
    requestedRowMax: z.number().int().positive(),
    requestedColumnMin: z.number().int().positive(),
    requestedColumnMax: z.number().int().positive(),
    rowMin: z.number().int().positive(),
    rowMax: z.number().int().positive(),
    columnMin: z.number().int().positive(),
    columnMax: z.number().int().positive(),
    columnLabels: z.array(z.string().min(1).max(3)).max(80),
    cells: z.array(excelSourceCellSchema).max(4_000),
    nearbyCells: z.array(excelSourceCellSchema).max(120),
    emptyReason: z
      .enum(["requested_range_empty", "cell_index_unavailable"])
      .nullable(),
    totalNonEmptyCellCount: z.number().int().nonnegative(),
    window: excelSourceWindowSchema,
  }),
]);

export const pdfSourcePageQuerySchema = z
  .object({
    quote: z.string().trim().max(1_200).optional(),
  })
  .strict();

export const pdfSourceHighlightSchema = z.object({
  xPct: z.number().min(0).max(100),
  yPct: z.number().min(0).max(100),
  widthPct: z.number().min(0).max(100),
  heightPct: z.number().min(0).max(100),
});

export const pdfSourcePageSchema = z.object({
  kind: z.literal("pdf"),
  documentId: identifierSchema,
  documentVersionId: identifierSchema,
  anchorEvidenceId: evidenceIdSchema,
  pageEvidenceId: evidenceIdSchema,
  pageNumber: z.number().int().positive(),
  pageCount: z.number().int().positive(),
  fileName: z.string().min(1).max(1_000),
  imageUrl: z.string().min(1).max(8_000),
  imageWidth: z.number().int().positive(),
  imageHeight: z.number().int().positive(),
  pageWidth: z.number().positive(),
  pageHeight: z.number().positive(),
  highlights: z.array(pdfSourceHighlightSchema).max(100),
  matched: z.boolean(),
  highlightSource: z.object({
    mode: z.enum(["evidence_bbox", "page_block", "none"]),
    evidenceId: evidenceIdSchema,
  }),
});

export const researchAssetStatusSchema = z.enum([
  "draft",
  "running",
  "completed",
  "stale",
  "failed",
  "archived",
]);

export const researchAssetSchema = z.object({
  id: identifierSchema,
  assetType: z.string().min(1).max(80),
  title: z.string().min(1).max(500),
  status: researchAssetStatusSchema,
  currentVersionId: identifierSchema.nullable(),
  currentVersionNo: z.number().int().nonnegative(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  archivedAt: z.iso.datetime().nullable(),
  deletedAt: z.iso.datetime().nullable(),
});

export const researchAssetVersionSchema = z.object({
  id: identifierSchema,
  assetId: identifierSchema,
  versionNo: z.number().int().positive(),
  status: researchAssetStatusSchema,
  summary: z.string().max(20_000),
  contentMarkdown: z.string().max(1_000_000),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  sourceResponseId: identifierSchema.nullable(),
  structuredContent: researchMetadataSchema,
  metadata: researchMetadataSchema,
  tags: z.array(z.string().max(80)).max(100),
  createdAt: z.iso.datetime(),
});

export const researchAssetEvidenceReferenceSchema = z.object({
  assetVersionId: identifierSchema,
  evidenceId: evidenceIdSchema,
  relationType: z.string().min(1).max(80),
  quote: z.string().max(20_000).nullable(),
  createdAt: z.iso.datetime(),
});

export const saveResearchAssetRequestSchema = z.object({
  assetId: identifierSchema.optional(),
  assetType: z.string().trim().min(1).max(80),
  title: z.string().trim().min(1).max(500),
  status: researchAssetStatusSchema.default("completed"),
  summary: z.string().max(20_000).default(""),
  contentMarkdown: z.string().max(1_000_000),
  sourceResponseId: identifierSchema.nullable().optional(),
  structuredContent: researchMetadataSchema.default({}),
  metadata: researchMetadataSchema.default({}),
  tags: z.array(z.string().max(80)).max(100).default([]),
  evidence: z.array(
    z.object({
      evidenceId: evidenceIdSchema,
      relationType: z.string().min(1).max(80).default("supports"),
      quote: z.string().max(20_000).nullable().optional(),
    }),
  ).max(1_000).default([]),
});

export const updateResearchAssetLifecycleRequestSchema = z
  .object({
    archived: z.boolean(),
  })
  .strict();

export const researchAssetContextIdSchema = z
  .string()
  .min(1)
  .max(169)
  .superRefine((value, context) => {
    const resourceId = value.startsWith("document:")
      ? value.slice("document:".length)
      : value;
    if (!identifierSchema.safeParse(resourceId).success) {
      context.addIssue({
        code: "custom",
        message: "asset context id must identify a document or research asset",
      });
    }
  });

export const researchAssetContextSchema = z
  .object({
    assetIds: z.array(researchAssetContextIdSchema).max(1_000).superRefine(
      (values, context) => {
        if (new Set(values).size !== values.length) {
          context.addIssue({
            code: "custom",
            message: "assetIds must not contain duplicates",
          });
        }
      },
    ),
  })
  .strict();

export const updateResearchAssetContextRequestSchema = z
  .object({
    assetIds: z.array(researchAssetContextIdSchema).max(1_000).superRefine(
      (values, context) => {
        if (new Set(values).size !== values.length) {
          context.addIssue({
            code: "custom",
            message: "assetIds must not contain duplicates",
          });
        }
      },
    ),
  })
  .strict();

export const deleteResearchAssetsRequestSchema = z
  .object({
    assetIds: z
      .array(identifierSchema)
      .min(1)
      .max(1_000)
      .superRefine((values, context) => {
        if (new Set(values).size !== values.length) {
          context.addIssue({
            code: "custom",
            message: "assetIds must not contain duplicates",
          });
        }
      }),
  })
  .strict();

export type ResearchDocument = z.infer<typeof researchDocumentSchema>;
export type ResearchDocumentVersion = z.infer<
  typeof researchDocumentVersionSchema
>;
export type RegisterDocumentVersionRequest = z.infer<
  typeof registerDocumentVersionRequestSchema
>;
export type DocumentFileQuery = z.infer<typeof documentFileQuerySchema>;
export type DocumentTextPreviewQuery = z.infer<
  typeof documentTextPreviewQuerySchema
>;
export type DocumentTextPreview = z.infer<
  typeof documentTextPreviewSchema
>;
export type DeleteResearchDocumentsRequest = z.infer<
  typeof deleteResearchDocumentsRequestSchema
>;
export type DeleteResearchDocumentsResponse = z.infer<
  typeof deleteResearchDocumentsResponseSchema
>;
export type ResearchEvidence = z.infer<typeof researchEvidenceSchema>;
export type ResearchEvidenceTrace = z.infer<
  typeof researchEvidenceTraceSchema
>;
export type ExcelSourceQuery = z.infer<typeof excelSourceQuerySchema>;
export type ExcelSourceSheet = z.infer<typeof excelSourceSheetSchema>;
export type ExcelSourceRegion = z.infer<typeof excelSourceRegionSchema>;
export type ExcelSourceCell = z.infer<typeof excelSourceCellSchema>;
export type ExcelSourceWindow = z.infer<typeof excelSourceWindowSchema>;
export type ExcelSourcePayload = z.infer<typeof excelSourcePayloadSchema>;
export type PdfSourcePageQuery = z.infer<typeof pdfSourcePageQuerySchema>;
export type PdfSourceHighlight = z.infer<
  typeof pdfSourceHighlightSchema
>;
export type PdfSourcePage = z.infer<typeof pdfSourcePageSchema>;
export type ResearchAsset = z.infer<typeof researchAssetSchema>;
export type ResearchAssetVersion = z.infer<
  typeof researchAssetVersionSchema
>;
export type ResearchAssetEvidenceReference = z.infer<
  typeof researchAssetEvidenceReferenceSchema
>;
export type SaveResearchAssetRequest = z.infer<
  typeof saveResearchAssetRequestSchema
>;
export type UpdateResearchAssetLifecycleRequest = z.infer<
  typeof updateResearchAssetLifecycleRequestSchema
>;
export type ResearchAssetContext = z.infer<
  typeof researchAssetContextSchema
>;
export type UpdateResearchAssetContextRequest = z.infer<
  typeof updateResearchAssetContextRequestSchema
>;
export type DeleteResearchAssetsRequest = z.infer<
  typeof deleteResearchAssetsRequestSchema
>;
