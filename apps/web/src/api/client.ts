import {
  projectSchema,
  sessionEventSchema,
  type SessionEvent,
  researchDocumentSchema,
  sessionSchema,
  type CreateProjectRequest,
  type CreateSessionRequest,
  type Project,
  type ResearchDocument,
  type SendMessageRequest,
  type Session,
} from "@private-fund/contracts";
import { z } from "zod";

import { query, request, requestJson } from "./http";

export const serverInfoSchema = z
  .object({
    auth_mode: z.string(),
    accounts_enabled: z.boolean(),
    registration_mode: z.string().nullable(),
    durable_jobs: z.boolean(),
    research_store: z.boolean(),
    workflow_store: z.boolean(),
    insights_store: z.boolean(),
  })
  .loose();

export type ServerInfo = z.infer<typeof serverInfoSchema>;

export function fetchInfo(): Promise<ServerInfo> {
  return requestJson("/v1/info", serverInfoSchema);
}

const authUserSchema = z
  .object({
    id: z.string(),
    email: z.string().optional(),
    nick_name: z.string().nullable().optional(),
  })
  .loose();

const authSessionSchema = z.object({ user: authUserSchema }).loose();

export type AuthUser = z.infer<typeof authUserSchema>;

export function login(email: string, password: string): Promise<{ user: AuthUser }> {
  return requestJson("/auth/login", authSessionSchema, {
    method: "POST",
    body: { email, password },
  });
}

export async function logout(): Promise<void> {
  await request("/auth/logout", { method: "POST" });
}

export function fetchMe(): Promise<{ user: AuthUser }> {
  return requestJson("/auth/me", authSessionSchema);
}

export async function sendRegisterCode(email: string): Promise<void> {
  await request("/auth/register/send-code", { method: "POST", body: { email } });
}

export function register(input: {
  email: string;
  code: string;
  password: string;
  nick_name?: string;
}): Promise<{ user: AuthUser }> {
  return requestJson("/auth/register", authSessionSchema, {
    method: "POST",
    body: input,
  });
}

export async function sendPasswordResetCode(email: string): Promise<void> {
  await request("/auth/password/reset/send-code", {
    method: "POST",
    body: { email },
  });
}

export async function resetPassword(input: {
  email: string;
  code: string;
  password: string;
}): Promise<void> {
  await request("/auth/password/reset", { method: "POST", body: input });
}

function page<Schema extends z.ZodType>(item: Schema) {
  return z
    .object({
      items: z.array(item),
      total: z.number().int().nonnegative(),
      limit: z.number().int().positive(),
      offset: z.number().int().nonnegative(),
      hasMore: z.boolean(),
    })
    .loose();
}

export type { Project, ResearchDocument, Session };

export function listProjects(): Promise<Project[]> {
  return requestJson("/v1/projects", z.object({ projects: z.array(projectSchema) })).then(
    (result) => result.projects,
  );
}

export function createProject(input: CreateProjectRequest): Promise<Project> {
  return requestJson("/v1/projects", projectSchema, { method: "POST", body: input });
}

export async function deleteProject(projectId: string): Promise<void> {
  await request(`/v1/projects/${projectId}`, { method: "DELETE" });
}

export function listDocuments(
  projectId: string,
  options: { limit?: number; offset?: number } = {},
): Promise<z.infer<ReturnType<typeof page<typeof researchDocumentSchema>>>> {
  return requestJson(
    `/v1/projects/${projectId}/documents${query(options)}`,
    page(researchDocumentSchema),
  );
}

export function listSessions(projectId?: string, includeArchived = false): Promise<Session[]> {
  return requestJson(
    `/v1/sessions${query({ projectId, includeArchived })}`,
    z.object({ sessions: z.array(sessionSchema) }),
  ).then((result) => result.sessions);
}

export function createSession(input: CreateSessionRequest): Promise<Session> {
  return requestJson("/v1/sessions", sessionSchema, { method: "POST", body: input });
}

export function fetchSession(sessionId: string): Promise<Session> {
  return requestJson(`/v1/sessions/${sessionId}`, sessionSchema);
}

export function sendMessage(
  sessionId: string,
  input: SendMessageRequest,
): Promise<{ operationId: string | null }> {
  return requestJson(
    `/v1/sessions/${sessionId}/messages`,
    z.object({ operationId: z.string().nullable() }).loose(),
    { method: "POST", body: input },
  );
}

export async function interruptSession(sessionId: string): Promise<void> {
  await request(`/v1/sessions/${sessionId}/interrupt`, { method: "POST" });
}

export function uploadProjectDocuments(
  projectId: string,
  files: File[],
): Promise<{ uploads: unknown[] }> {
  const form = new FormData();
  for (const file of files) form.append("files", file);
  return requestJson(
    `/v1/projects/${projectId}/documents/upload`,
    z.object({ uploads: z.array(z.unknown()) }).loose(),
    { method: "POST", form },
  );
}

export function deleteDocuments(
  projectId: string,
  documentIds: string[],
): Promise<unknown> {
  return requestJson(`/v1/projects/${projectId}/documents/delete`, z.unknown(), {
    method: "POST",
    body: { documentIds },
  });
}

import { sessionResourcePageSchema, type SessionResource } from "@private-fund/contracts";

export function listSessionResources(sessionId: string): Promise<SessionResource[]> {
  return requestJson(`/v1/sessions/${sessionId}/resources`, sessionResourcePageSchema).then(
    (page) => page.items,
  );
}

export async function deleteSessionResource(
  sessionId: string,
  resourceId: string,
): Promise<void> {
  await request(`/v1/sessions/${sessionId}/resources/${resourceId}`, { method: "DELETE" });
}

export function fetchSessionEventsPage(
  sessionId: string,
  after = 0,
  limit = 1000,
): Promise<SessionEvent[]> {
  return requestJson(
    `/v1/sessions/${sessionId}/events${query({ stream: 0, after, limit })}`,
    z.object({ events: z.array(sessionEventSchema) }),
  ).then((result) => result.events);
}

export function forkSession(sessionId: string, title?: string): Promise<Session> {
  return requestJson(`/v1/sessions/${sessionId}/fork`, sessionSchema, {
    method: "POST",
    body: title === undefined ? {} : { title },
  });
}
