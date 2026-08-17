import { z } from "zod";

import { identifierSchema } from "./api.js";
import { researchMetadataSchema } from "./research.js";

export const sourceFolderIdSchema = z
  .string()
  .min(1)
  .max(240)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);

export const sourceFolderNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine(
    (value) =>
      value !== "." &&
      value !== ".." &&
      !value.includes("/") &&
      !value.includes("\\") &&
      !value.includes("\0"),
    "Source folder name contains unsupported path characters",
  );

export const sourceFolderSchema = z.object({
  id: sourceFolderIdSchema,
  parentId: sourceFolderIdSchema.nullable(),
  name: sourceFolderNameSchema,
  normalizedName: z.string().min(1).max(200),
  folderKind: z.string().min(1).max(80),
  classificationKey: z.string().min(1).max(240).nullable(),
  sortOrder: z.number().int().min(-1_000_000).max(1_000_000),
  metadata: researchMetadataSchema,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  deletedAt: z.iso.datetime().nullable(),
});

export const sourceFolderTreeEntrySchema = sourceFolderSchema.extend({
  depth: z.number().int().min(0).max(32),
  path: z.array(sourceFolderNameSchema).max(32),
  childCount: z.number().int().nonnegative(),
  documentCount: z.number().int().nonnegative(),
});

export const sourceFolderAssignmentSchema = z.object({
  documentId: identifierSchema,
  folderId: sourceFolderIdSchema,
  assignmentSource: z.string().min(1).max(100),
  classificationKey: z.string().min(1).max(240).nullable(),
  legacyFileName: z.string().min(1).max(1_000).nullable(),
  metadata: researchMetadataSchema,
  assignedAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const createSourceFolderRequestSchema = z
  .object({
    parentId: sourceFolderIdSchema.nullable().optional(),
    name: sourceFolderNameSchema,
    folderKind: z.string().trim().min(1).max(80).default("manual"),
    classificationKey: z.string().trim().min(1).max(240).nullable().optional(),
    sortOrder: z.number().int().min(-1_000_000).max(1_000_000).default(0),
    metadata: researchMetadataSchema.default({}),
  })
  .strict();

export const updateSourceFolderRequestSchema = z
  .object({
    parentId: sourceFolderIdSchema.nullable().optional(),
    name: sourceFolderNameSchema.optional(),
    folderKind: z.string().trim().min(1).max(80).optional(),
    classificationKey: z.string().trim().min(1).max(240).nullable().optional(),
    sortOrder: z.number().int().min(-1_000_000).max(1_000_000).optional(),
    metadata: researchMetadataSchema.optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.parentId !== undefined ||
      value.name !== undefined ||
      value.folderKind !== undefined ||
      value.classificationKey !== undefined ||
      value.sortOrder !== undefined ||
      value.metadata !== undefined,
    "At least one source folder field is required",
  );

export const assignSourceFolderDocumentRequestSchema = z
  .object({
    documentId: identifierSchema,
    assignmentSource: z.string().trim().min(1).max(100).default("manual"),
    classificationKey: z.string().trim().min(1).max(240).nullable().optional(),
    metadata: researchMetadataSchema.default({}),
  })
  .strict();

export type SourceFolder = z.infer<typeof sourceFolderSchema>;
export type SourceFolderTreeEntry = z.infer<
  typeof sourceFolderTreeEntrySchema
>;
export type SourceFolderAssignment = z.infer<
  typeof sourceFolderAssignmentSchema
>;
export type CreateSourceFolderRequest = z.infer<
  typeof createSourceFolderRequestSchema
>;
export type UpdateSourceFolderRequest = z.infer<
  typeof updateSourceFolderRequestSchema
>;
export type AssignSourceFolderDocumentRequest = z.infer<
  typeof assignSourceFolderDocumentRequestSchema
>;
