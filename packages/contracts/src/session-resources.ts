import { z } from "zod";

import { identifierSchema } from "./api.js";

export const SESSION_ATTACHMENT_MAX_COUNT = 20;
export const SESSION_ATTACHMENT_MAX_TOTAL_BYTES = 100 * 1024 * 1024;
export const SESSION_ATTACHMENT_MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
export const SESSION_ATTACHMENT_MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const SESSION_ATTACHMENT_MAX_PDF_BYTES = 20 * 1024 * 1024;
export const SESSION_ATTACHMENT_MAX_TEXT_BYTES = 10 * 1024 * 1024;

/**
 * Resource IDs are server-generated capabilities. They deliberately carry no
 * filesystem, project, user, or runner information.
 */
export const sessionResourceIdSchema = z
  .string()
  .regex(/^resource_[a-f0-9]{32}$/u);

export const sessionResourceKindSchema = z.enum([
  "attachment",
  "research_asset",
  "document_reference",
]);

export const sessionResourceLifecycleSchema = z.enum([
  "active",
  "deleted",
]);

export const sessionResourceLifecycleFilterSchema = z.enum([
  "active",
  "deleted",
  "all",
]);

export const sessionAttachmentFilenameSchema = z
  .string()
  .min(1)
  .max(255)
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
        message: "filename must be a safe basename",
      });
    }
    if (new TextEncoder().encode(value).byteLength > 1_000) {
      context.addIssue({
        code: "custom",
        message: "filename must not exceed 1000 UTF-8 bytes",
      });
    }
  });

export const sessionAttachmentMimeTypeSchema = z
  .string()
  .trim()
  .min(1)
  .max(300)
  .regex(/^[^\u0000-\u001f\u007f]+$/u)
  .transform((value) => value.toLowerCase());

const sessionResourceBaseShape = {
  id: sessionResourceIdSchema,
  object: z.literal("session.resource"),
  sessionId: identifierSchema,
  projectId: identifierSchema,
  lifecycle: sessionResourceLifecycleSchema,
  name: z.string().min(1).max(500),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  deletedAt: z.iso.datetime().nullable(),
};

export const sessionAttachmentResourceSchema = z
  .object({
    ...sessionResourceBaseShape,
    kind: z.literal("attachment"),
    attachment: z
      .object({
        filename: sessionAttachmentFilenameSchema,
        mimeType: sessionAttachmentMimeTypeSchema,
        bytes: z
          .number()
          .int()
          .positive()
          .max(SESSION_ATTACHMENT_MAX_UPLOAD_BYTES),
        sha256: z.string().regex(/^[a-f0-9]{64}$/u),
      })
      .strict(),
  })
  .strict();

export const sessionResearchAssetResourceSchema = z
  .object({
    ...sessionResourceBaseShape,
    kind: z.literal("research_asset"),
    researchAsset: z
      .object({
        assetId: identifierSchema,
        versionId: identifierSchema,
      })
      .strict(),
  })
  .strict();

export const sessionDocumentReferenceResourceSchema = z
  .object({
    ...sessionResourceBaseShape,
    kind: z.literal("document_reference"),
    documentReference: z
      .object({
        documentId: identifierSchema,
        versionId: identifierSchema,
      })
      .strict(),
  })
  .strict();

export const sessionResourceSchema = z.discriminatedUnion("kind", [
  sessionAttachmentResourceSchema,
  sessionResearchAssetResourceSchema,
  sessionDocumentReferenceResourceSchema,
]);

export const listSessionResourcesQuerySchema = z
  .object({
    kind: sessionResourceKindSchema.optional(),
    lifecycle: sessionResourceLifecycleFilterSchema.default("active"),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .strict();

export const listSessionAttachmentsQuerySchema = z
  .object({
    lifecycle: sessionResourceLifecycleFilterSchema.default("active"),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .strict();

export const sessionResourcePageSchema = z
  .object({
    items: z.array(sessionResourceSchema),
    total: z.number().int().nonnegative(),
    limit: z.number().int().positive(),
    offset: z.number().int().nonnegative(),
    hasMore: z.boolean(),
  })
  .strict();

export const sessionAttachmentPageSchema = z
  .object({
    items: z.array(sessionAttachmentResourceSchema),
    total: z.number().int().nonnegative(),
    limit: z.number().int().positive(),
    offset: z.number().int().nonnegative(),
    hasMore: z.boolean(),
  })
  .strict();

export const uploadSessionAttachmentMetadataSchema = z
  .object({
    filename: sessionAttachmentFilenameSchema,
    mimeType: sessionAttachmentMimeTypeSchema,
  })
  .strict();

export const createSessionResearchAssetResourceRequestSchema = z
  .object({
    assetId: identifierSchema,
    versionId: identifierSchema.optional(),
  })
  .strict();

export const createSessionDocumentReferenceResourceRequestSchema = z
  .object({
    documentId: identifierSchema,
    versionId: identifierSchema.optional(),
  })
  .strict();

export const deleteSessionResourceResponseSchema = z
  .object({
    id: sessionResourceIdSchema,
    object: z.literal("session.resource.deleted"),
    kind: sessionResourceKindSchema,
    deleted: z.literal(true),
    deletedAt: z.iso.datetime(),
  })
  .strict();

export const deleteSessionResourcesResponseSchema = z
  .object({
    sessionId: identifierSchema,
    object: z.literal("session.resources.cleaned"),
    cleaned: z.literal(true),
    deletedCount: z.number().int().nonnegative(),
    deletedAt: z.iso.datetime(),
  })
  .strict();

export type SessionResourceId = z.infer<typeof sessionResourceIdSchema>;
export type SessionResourceKind = z.infer<
  typeof sessionResourceKindSchema
>;
export type SessionResourceLifecycle = z.infer<
  typeof sessionResourceLifecycleSchema
>;
export type SessionResourceLifecycleFilter = z.infer<
  typeof sessionResourceLifecycleFilterSchema
>;
export type SessionAttachmentResource = z.infer<
  typeof sessionAttachmentResourceSchema
>;
export type SessionResearchAssetResource = z.infer<
  typeof sessionResearchAssetResourceSchema
>;
export type SessionDocumentReferenceResource = z.infer<
  typeof sessionDocumentReferenceResourceSchema
>;
export type SessionResource = z.infer<typeof sessionResourceSchema>;
export type ListSessionResourcesQuery = z.infer<
  typeof listSessionResourcesQuerySchema
>;
export type ListSessionAttachmentsQuery = z.infer<
  typeof listSessionAttachmentsQuerySchema
>;
export type SessionResourcePage = z.infer<
  typeof sessionResourcePageSchema
>;
export type SessionAttachmentPage = z.infer<
  typeof sessionAttachmentPageSchema
>;
export type UploadSessionAttachmentMetadata = z.infer<
  typeof uploadSessionAttachmentMetadataSchema
>;
export type CreateSessionResearchAssetResourceRequest = z.infer<
  typeof createSessionResearchAssetResourceRequestSchema
>;
export type CreateSessionDocumentReferenceResourceRequest = z.infer<
  typeof createSessionDocumentReferenceResourceRequestSchema
>;
export type DeleteSessionResourceResponse = z.infer<
  typeof deleteSessionResourceResponseSchema
>;
export type DeleteSessionResourcesResponse = z.infer<
  typeof deleteSessionResourcesResponseSchema
>;
