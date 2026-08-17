import { z } from "zod";

const normalizedEmailSchema = z
  .string()
  .trim()
  .transform((value) => value.toLowerCase())
  .pipe(z.email());

/**
 * The public cloud-user shape exposed by the local TypeScript BFF.
 *
 * The upstream `is_admin` bit is a platform-level privilege and must never
 * grant authority in the local research control plane. It is therefore
 * surfaced as `is_platform_admin` while local `is_admin` remains false.
 */
export const cloudUserSchema = z
  .object({
    id: z.uuid(),
    email: normalizedEmailSchema,
    nick_name: z.string().nullable().optional(),
    status: z.literal("active"),
    is_admin: z.boolean().optional(),
    is_platform_admin: z.boolean().optional(),
    data_namespace: z.uuid(),
    balance_cny: z.union([z.string(), z.number()]).optional(),
    last_login_at: z.union([z.string(), z.number(), z.null()]).optional(),
    created_at: z.union([z.string(), z.number(), z.null()]).optional(),
  })
  .transform((user) => ({
    id: user.id,
    email: user.email,
    nick_name: user.nick_name ?? null,
    status: "active" as const,
    is_admin: false as const,
    is_platform_admin: user.is_platform_admin ?? user.is_admin ?? false,
    data_namespace: user.data_namespace,
    balance_cny: String(user.balance_cny ?? "0.000000"),
    last_login_at: user.last_login_at ?? null,
    created_at: user.created_at ?? null,
  }));

export const cloudTokenResponseSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  expires_in: z.number().int().positive().default(900),
  user: cloudUserSchema,
});

const modelGatewayUrlSchema = z
  .url()
  .refine((value) => {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === ""
    );
  }, "Model gateway URL must be a credential-free HTTPS URL");

/**
 * Short-lived model credential issued by the cloud account service.
 *
 * The token remains server-side and is never part of a browser response.
 */
export const cloudModelAccessTokenResponseSchema = z.object({
  access_token: z
    .string()
    .min(16)
    .max(16_384)
    .regex(/^pfm_[^\s]+$/, "Invalid model access token"),
  expires_in: z.coerce.number().int().positive().max(31 * 24 * 60 * 60),
  gateway_base_url: modelGatewayUrlSchema,
});

export const cloudModelCatalogItemSchema = z.object({
  id: z.string().trim().min(1).max(200),
  display_name: z.string().trim().min(1).max(300).optional(),
  provider: z.string().trim().min(1).max(100).optional(),
  input_price_cny_per_million: z.union([z.string(), z.number()]).optional(),
  output_price_cny_per_million: z.union([z.string(), z.number()]).optional(),
  default_max_tokens: z.coerce.number().int().positive().optional(),
  max_output_tokens: z.coerce.number().int().positive().optional(),
});

export const cloudModelCatalogSchema = z.object({
  object: z.string().optional(),
  available: z.boolean(),
  default_model: z.string().trim().min(1).max(200),
  data: z.array(cloudModelCatalogItemSchema),
});

export const sealedCloudSessionSchema = z.object({
  version: z.literal(1),
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  accessExpiresAt: z.number().int().positive(),
  sessionExpiresAt: z.number().int().positive(),
  user: cloudUserSchema,
});

export type CloudUser = z.infer<typeof cloudUserSchema>;
export type CloudTokenResponse = z.infer<typeof cloudTokenResponseSchema>;
export type CloudModelAccessTokenResponse = z.infer<
  typeof cloudModelAccessTokenResponseSchema
>;
export type CloudModelCatalog = z.infer<typeof cloudModelCatalogSchema>;
export type CloudModelCatalogItem = z.infer<
  typeof cloudModelCatalogItemSchema
>;
export type SealedCloudSession = z.infer<typeof sealedCloudSessionSchema>;

export interface ShadowAccountStore {
  upsertCloudUser(user: CloudUser, loggedInAt: number): Promise<void>;
}
