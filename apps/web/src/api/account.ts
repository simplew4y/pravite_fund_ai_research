import { jobSchema, type Job } from "@private-fund/contracts";
import { z } from "zod";

import { query, request, requestJson } from "./http";

/**
 * Account endpoints proxy the cloud service verbatim, so their payloads are
 * not covered by @private-fund/contracts — validate loosely and read what we
 * render. All of them 404 (cloud_accounts_disabled) in development mode.
 */
const usageSchema = z
  .object({
    items: z.array(z.record(z.string(), z.unknown())).default([]),
    summary: z
      .object({
        request_count: z.number().optional(),
        prompt_tokens: z.number().optional(),
        completion_tokens: z.number().optional(),
        total_tokens: z.number().optional(),
        charged_amount_cny: z.string().optional(),
      })
      .loose()
      .optional(),
    page: z.number().optional(),
    page_size: z.number().optional(),
  })
  .loose();

export type AccountUsage = z.infer<typeof usageSchema>;

export function fetchAccountUsage(page = 1, pageSize = 20): Promise<AccountUsage> {
  return requestJson(
    `/v1/account/usage${query({ page, page_size: pageSize })}`,
    usageSchema,
  );
}

const balanceRecordsSchema = z
  .object({
    items: z
      .array(
        z
          .object({ id: z.string().optional(), amount_cny: z.string().optional() })
          .loose(),
      )
      .default([]),
    page: z.number().optional(),
    page_size: z.number().optional(),
  })
  .loose();

export type BalanceRecords = z.infer<typeof balanceRecordsSchema>;

export function fetchBalanceRecords(page = 1, pageSize = 20): Promise<BalanceRecords> {
  return requestJson(
    `/v1/account/balance-records${query({ page, page_size: pageSize })}`,
    balanceRecordsSchema,
  );
}

export async function submitFeedback(input: {
  feedback_type: string;
  title: string;
  content: string;
  rating?: number | null;
}): Promise<void> {
  await request("/v1/account/feedback", { method: "POST", body: input });
}

/**
 * On success the server responds 204 AND clears the session cookie — the
 * caller must route the user back to the login screen afterwards.
 */
export async function changePassword(
  oldPassword: string,
  newPassword: string,
): Promise<void> {
  await request("/auth/users/me/password", {
    method: "POST",
    body: { old_password: oldPassword, new_password: newPassword },
  });
}

export type { Job };

export function listJobs(options: {
  projectId?: string;
  status?: string;
  limit?: number;
}): Promise<Job[]> {
  return requestJson(
    `/v1/jobs${query(options)}`,
    z.object({ jobs: z.array(jobSchema) }),
  ).then((result) => result.jobs);
}
