import { z } from "zod";

import { identifierSchema } from "./api.js";

export const GLOBAL_UPLOAD_FILE_LIMIT_BYTES = 256 * 1024 * 1024;
export const GLOBAL_UPLOAD_BATCH_LIMIT_BYTES = 1024 * 1024 * 1024;

export const globalUploadBatchIdSchema = z
  .string()
  .regex(/^upb_[a-f0-9]{32}$/u);

export const globalUploadItemIdSchema = z
  .string()
  .regex(/^upi_[a-f0-9]{32}$/u);

export const globalUploadAuditIdSchema = z
  .string()
  .regex(/^upa_[a-f0-9]{32}$/u);

export const globalUploadBatchStatusSchema = z.enum([
  "queued",
  "identifying",
  "routing",
  "indexing",
  "needs_review",
  "completed",
  "completed_with_errors",
  "failed",
]);

export const globalUploadItemStatusSchema = z.enum([
  "uploaded",
  "identifying",
  "needs_review",
  "routing",
  "routed",
  "indexing",
  "completed",
  "completed_with_warnings",
  "duplicate",
  "failed",
]);

export const globalUploadFileTypeSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .transform((value) => value.toLowerCase())
  .pipe(z.string().regex(/^[a-z0-9][a-z0-9.+_-]*$/u));

export const globalUploadSha256Schema = z
  .string()
  .trim()
  .regex(/^[a-fA-F0-9]{64}$/u)
  .transform((value) => value.toLowerCase());

export const globalUploadOriginalFilenameSchema = z
  .string()
  .trim()
  .min(1)
  .max(1_000)
  .superRefine((value, context) => {
    if (
      value === "." ||
      value === ".." ||
      value.includes("/") ||
      value.includes("\\") ||
      /[\u0000-\u001f\u007f]/u.test(value)
    ) {
      context.addIssue({
        code: "custom",
        message: "originalFilename must be a safe basename",
      });
    }
  });

/**
 * Server-owned path relative to a tenant staging root. This deliberately
 * excludes drive letters, URI syntax, whitespace, backslashes and traversal.
 */
export const globalUploadStagedRelativePathSchema = z
  .string()
  .min(1)
  .max(4_000)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/u)
  .superRefine((value, context) => {
    const segments = value.split("/");
    if (
      value.startsWith("/") ||
      value.endsWith("/") ||
      segments.some(
        (segment) =>
          segment.length === 0 ||
          segment === "." ||
          segment === "..",
      )
    ) {
      context.addIssue({
        code: "custom",
        message:
          "stagedRelativePath must be a normalized relative server path",
      });
    }
  });

export const globalUploadMimeTypeSchema = z
  .string()
  .trim()
  .min(1)
  .max(300)
  .regex(/^[^\u0000-\u001f\u007f]+$/u);

export const globalUploadProjectCandidateSchema = z
  .object({
    projectId: identifierSchema,
    projectName: z.string().min(1).max(200),
    companyName: z.string().max(300).nullable().default(null),
    ticker: z.string().max(40).nullable().default(null),
    score: z.number().min(0).max(1),
    method: z.string().min(1).max(160),
  })
  .strict();

export const createGlobalUploadItemSchema = z
  .object({
    originalFilename: globalUploadOriginalFilenameSchema,
    stagedRelativePath: globalUploadStagedRelativePathSchema,
    fileType: globalUploadFileTypeSchema,
    mimeType: globalUploadMimeTypeSchema,
    fileSize: z
      .number()
      .int()
      .positive()
      .max(GLOBAL_UPLOAD_FILE_LIMIT_BYTES),
    sha256: globalUploadSha256Schema,
  })
  .strict();

export const createGlobalUploadBatchRequestSchema = z
  .object({
    idempotencyKey: z.string().trim().min(1).max(500),
    actorId: z.string().trim().min(1).max(320).optional(),
    items: z.array(createGlobalUploadItemSchema).min(1).max(1_000),
  })
  .strict()
  .superRefine((value, context) => {
    const paths = new Set<string>();
    let totalBytes = 0;
    for (const [index, item] of value.items.entries()) {
      totalBytes += item.fileSize;
      if (paths.has(item.stagedRelativePath)) {
        context.addIssue({
          code: "custom",
          path: ["items", index, "stagedRelativePath"],
          message: "stagedRelativePath must be unique within a batch",
        });
      }
      paths.add(item.stagedRelativePath);
    }
    if (totalBytes > GLOBAL_UPLOAD_BATCH_LIMIT_BYTES) {
      context.addIssue({
        code: "custom",
        path: ["items"],
        message: "Upload batch exceeds the 1 GiB limit",
      });
    }
  });

export const globalUploadBatchSchema = z.object({
  batchId: globalUploadBatchIdSchema,
  tenantNamespace: z.uuid(),
  status: globalUploadBatchStatusSchema,
  fileCount: z.number().int().nonnegative(),
  message: z.string().max(4_000),
  idempotencyKey: z.string().min(1).max(500),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
});

export const globalUploadItemSchema = z.object({
  itemId: globalUploadItemIdSchema,
  batchId: globalUploadBatchIdSchema,
  tenantNamespace: z.uuid(),
  originalFilename: globalUploadOriginalFilenameSchema,
  stagedRelativePath: globalUploadStagedRelativePathSchema,
  fileType: globalUploadFileTypeSchema,
  mimeType: globalUploadMimeTypeSchema,
  fileSize: z.number().int().positive(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  status: globalUploadItemStatusSchema,
  companyName: z.string().max(300).nullable(),
  ticker: z.string().max(40).nullable(),
  companyConfidence: z.number().min(0).max(1),
  companyDetectionMethod: z.string().max(160).nullable(),
  targetProjectId: identifierSchema.nullable(),
  routeConfidence: z.number().min(0).max(1),
  routeMethod: z.string().max(160).nullable(),
  candidateProjects: z.array(globalUploadProjectCandidateSchema).max(100),
  pipelineJobId: identifierSchema.nullable(),
  documentId: identifierSchema.nullable(),
  errorMessage: z.string().max(20_000).nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
});

export const globalUploadItemStatusCountsSchema = z.partialRecord(
  globalUploadItemStatusSchema,
  z.number().int().nonnegative(),
);

export const globalUploadBatchDetailSchema = globalUploadBatchSchema.extend({
  counts: globalUploadItemStatusCountsSchema,
  items: z.array(globalUploadItemSchema),
});

export const listGlobalUploadBatchesQuerySchema = z
  .object({
    status: globalUploadBatchStatusSchema.optional(),
    limit: z.coerce.number().int().min(1).max(500).default(50),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .strict();

export const listGlobalUploadItemsQuerySchema = z
  .object({
    batchId: globalUploadBatchIdSchema.optional(),
    status: globalUploadItemStatusSchema.optional(),
    projectId: identifierSchema.optional(),
    limit: z.coerce.number().int().min(1).max(1_000).default(100),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .strict();

export const listGlobalUploadAuditQuerySchema = z
  .object({
    batchId: globalUploadBatchIdSchema.optional(),
    itemId: globalUploadItemIdSchema.optional(),
    limit: z.coerce.number().int().min(1).max(1_000).default(100),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .strict();

export const routeGlobalUploadItemRequestSchema = z
  .object({
    projectId: identifierSchema,
    idempotencyKey: z.string().trim().min(1).max(500),
    actorId: z.string().trim().min(1).max(320).optional(),
  })
  .strict();

export const transitionGlobalUploadBatchRequestSchema = z
  .object({
    status: globalUploadBatchStatusSchema,
    message: z.string().max(4_000).default(""),
    idempotencyKey: z.string().trim().min(1).max(500),
    actorId: z.string().trim().min(1).max(320).optional(),
  })
  .strict();

export const transitionGlobalUploadItemRequestSchema = z
  .object({
    status: globalUploadItemStatusSchema,
    idempotencyKey: z.string().trim().min(1).max(500),
    actorId: z.string().trim().min(1).max(320).optional(),
    companyName: z.string().trim().max(300).nullable().optional(),
    ticker: z.string().trim().max(40).nullable().optional(),
    companyConfidence: z.number().min(0).max(1).optional(),
    companyDetectionMethod: z
      .string()
      .trim()
      .max(160)
      .nullable()
      .optional(),
    targetProjectId: identifierSchema.nullable().optional(),
    routeConfidence: z.number().min(0).max(1).optional(),
    routeMethod: z.string().trim().max(160).nullable().optional(),
    candidateProjects: z
      .array(globalUploadProjectCandidateSchema)
      .max(100)
      .optional(),
    pipelineJobId: identifierSchema.nullable().optional(),
    documentId: identifierSchema.nullable().optional(),
    errorMessage: z.string().max(20_000).nullable().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.status === "failed" &&
      (value.errorMessage === undefined ||
        value.errorMessage === null ||
        value.errorMessage.trim().length === 0)
    ) {
      context.addIssue({
        code: "custom",
        path: ["errorMessage"],
        message: "failed upload items require errorMessage",
      });
    }
  });

export const globalUploadAuditEventSchema = z.object({
  auditId: globalUploadAuditIdSchema,
  tenantNamespace: z.uuid(),
  batchId: globalUploadBatchIdSchema,
  itemId: globalUploadItemIdSchema.nullable(),
  action: z.string().min(1).max(120),
  fromStatus: z.string().max(80).nullable(),
  toStatus: z.string().max(80).nullable(),
  projectId: identifierSchema.nullable(),
  actorId: z.string().max(320).nullable(),
  idempotencyKey: z.string().min(1).max(500),
  requestHash: z.string().regex(/^[a-f0-9]{64}$/u),
  details: z.record(z.string(), z.unknown()),
  createdAt: z.iso.datetime(),
});

function pageSchema<T extends z.ZodType>(item: T) {
  return z.object({
    items: z.array(item),
    total: z.number().int().nonnegative(),
    limit: z.number().int().positive(),
    offset: z.number().int().nonnegative(),
    hasMore: z.boolean(),
  });
}

export const globalUploadBatchPageSchema = pageSchema(
  globalUploadBatchSchema,
);
export const globalUploadItemPageSchema = pageSchema(globalUploadItemSchema);
export const globalUploadAuditPageSchema = pageSchema(
  globalUploadAuditEventSchema,
);

export type GlobalUploadBatchStatus = z.infer<
  typeof globalUploadBatchStatusSchema
>;
export type GlobalUploadItemStatus = z.infer<
  typeof globalUploadItemStatusSchema
>;
export type GlobalUploadProjectCandidate = z.infer<
  typeof globalUploadProjectCandidateSchema
>;
export type CreateGlobalUploadItem = z.infer<
  typeof createGlobalUploadItemSchema
>;
export type CreateGlobalUploadBatchRequest = z.infer<
  typeof createGlobalUploadBatchRequestSchema
>;
export type GlobalUploadBatch = z.infer<typeof globalUploadBatchSchema>;
export type GlobalUploadItem = z.infer<typeof globalUploadItemSchema>;
export type GlobalUploadBatchDetail = z.infer<
  typeof globalUploadBatchDetailSchema
>;
export type ListGlobalUploadBatchesQuery = z.infer<
  typeof listGlobalUploadBatchesQuerySchema
>;
export type ListGlobalUploadItemsQuery = z.infer<
  typeof listGlobalUploadItemsQuerySchema
>;
export type ListGlobalUploadAuditQuery = z.infer<
  typeof listGlobalUploadAuditQuerySchema
>;
export type RouteGlobalUploadItemRequest = z.infer<
  typeof routeGlobalUploadItemRequestSchema
>;
export type TransitionGlobalUploadBatchRequest = z.infer<
  typeof transitionGlobalUploadBatchRequestSchema
>;
export type TransitionGlobalUploadItemRequest = z.infer<
  typeof transitionGlobalUploadItemRequestSchema
>;
export type GlobalUploadAuditEvent = z.infer<
  typeof globalUploadAuditEventSchema
>;
export type GlobalUploadBatchPage = z.infer<
  typeof globalUploadBatchPageSchema
>;
export type GlobalUploadItemPage = z.infer<
  typeof globalUploadItemPageSchema
>;
export type GlobalUploadAuditPage = z.infer<
  typeof globalUploadAuditPageSchema
>;
