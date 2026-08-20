import { z } from "zod";

export const identifierSchema = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);

export const tenantIdentitySchema = z.object({
  userId: z.string().min(1).max(320),
  dataNamespace: z.uuid(),
});

export const projectSchema = z.object({
  id: identifierSchema,
  name: z.string().min(1).max(200),
  companyName: z.string().max(300).nullable(),
  ticker: z.string().max(40).nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const createProjectRequestSchema = z.object({
  name: z.string().trim().min(1).max(200),
  companyName: z.string().trim().max(300).optional(),
  ticker: z.string().trim().max(40).optional(),
});

export const updateProjectRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    companyName: z.string().trim().max(300).nullable().optional(),
    ticker: z.string().trim().max(40).nullable().optional(),
  })
  .strict()
  .refine(
    (value) => Object.values(value).some((field) => field !== undefined),
    { message: "At least one field must be provided" },
  );

export const sessionSchema = z.object({
  id: identifierSchema,
  projectId: identifierSchema,
  title: z.string().max(300),
  status: z.enum(["idle", "running", "interrupted", "failed"]),
  archivedAt: z.iso.datetime().nullable(),
  forkedFromSessionId: identifierSchema.nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  lastSequence: z.number().int().nonnegative(),
});

export const listSessionChildrenQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(500).default(100),
    offset: z.coerce.number().int().min(0).default(0),
    includeArchived: z
      .union([
        z.boolean(),
        z.enum(["true", "false", "1", "0"]).transform(
          (value) => value === "true" || value === "1",
        ),
      ])
      .default(true),
  })
  .strict();

export const sessionChildSchema = sessionSchema.extend({
  forkedFromSessionId: identifierSchema,
});

export const sessionChildrenPageSchema = z.object({
  parentSessionId: identifierSchema,
  items: z.array(sessionChildSchema),
  total: z.number().int().nonnegative(),
  limit: z.number().int().positive().max(500),
  offset: z.number().int().nonnegative(),
  hasMore: z.boolean(),
});

export const sessionSystemLabelsSchema = z
  .object({
    "private_fund.project_id": identifierSchema,
    "private_fund.lifecycle": z.enum(["active", "archived"]),
    "private_fund.lineage": z.enum(["root", "fork"]),
    "private_fund.forked_from_session_id": identifierSchema.optional(),
  })
  .strict()
  .superRefine((labels, context) => {
    const forkSource = labels["private_fund.forked_from_session_id"];
    if (
      (labels["private_fund.lineage"] === "fork") !==
      (forkSource !== undefined)
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Fork lineage must include private_fund.forked_from_session_id",
      });
    }
  });

export const sessionLabelsResponseSchema = z.object({
  id: identifierSchema,
  labels: sessionSystemLabelsSchema,
});

export const listSessionsQuerySchema = z
  .object({
    projectId: identifierSchema.optional(),
    includeArchived: z
      .union([
        z.boolean(),
        z.enum(["true", "false", "1", "0"]).transform(
          (value) => value === "true" || value === "1",
        ),
      ])
      .default(false),
  })
  .strict();

export const createSessionRequestSchema = z.object({
  projectId: identifierSchema,
  title: z.string().trim().max(300).optional(),
  model: z.string().trim().max(200).optional(),
});

export const updateSessionRequestSchema = z
  .object({
    title: z.string().trim().max(300).optional(),
    archived: z.boolean().optional(),
  })
  .strict()
  .refine(
    (value) => value.title !== undefined || value.archived !== undefined,
    { message: "At least one session field is required" },
  );

export const forkSessionRequestSchema = z
  .object({
    title: z.string().trim().max(300).optional(),
    model: z.string().trim().max(200).optional(),
  })
  .strict();

export const deleteSessionResponseSchema = z.object({
  sessionId: identifierSchema,
  deleted: z.literal(true),
  deletedAt: z.iso.datetime(),
});

export const sendMessageRequestSchema = z.object({
  content: z.string().min(1).max(1_000_000),
  clientMessageId: identifierSchema.optional(),
});

export const steerSessionRequestSchema = z.object({
  content: z.string().min(1).max(100_000),
});

export const compactSessionRequestSchema = z
  .object({
    customInstructions: z.string().trim().min(1).max(20_000).optional(),
  })
  .strict();

export type TenantIdentity = z.infer<typeof tenantIdentitySchema>;
export type Project = z.infer<typeof projectSchema>;
export type CreateProjectRequest = z.infer<typeof createProjectRequestSchema>;
export type UpdateProjectRequest = z.infer<typeof updateProjectRequestSchema>;
export type Session = z.infer<typeof sessionSchema>;
export type ListSessionChildrenQuery = z.infer<
  typeof listSessionChildrenQuerySchema
>;
export type SessionChild = z.infer<typeof sessionChildSchema>;
export type SessionChildrenPage = z.infer<
  typeof sessionChildrenPageSchema
>;
export type SessionSystemLabels = z.infer<
  typeof sessionSystemLabelsSchema
>;
export type SessionLabelsResponse = z.infer<
  typeof sessionLabelsResponseSchema
>;
export type ListSessionsQuery = z.infer<typeof listSessionsQuerySchema>;
export type CreateSessionRequest = z.infer<typeof createSessionRequestSchema>;
export type UpdateSessionRequest = z.infer<typeof updateSessionRequestSchema>;
export type ForkSessionRequest = z.infer<typeof forkSessionRequestSchema>;
export type DeleteSessionResponse = z.infer<
  typeof deleteSessionResponseSchema
>;
export type SendMessageRequest = z.infer<typeof sendMessageRequestSchema>;
export type SteerSessionRequest = z.infer<typeof steerSessionRequestSchema>;
export type CompactSessionRequest = z.infer<
  typeof compactSessionRequestSchema
>;
