import { type SessionEvent, researchDocumentSchema, type CreateProjectRequest, type CreateSessionRequest, type Project, type ResearchDocument, type SendMessageRequest, type Session } from "@private-fund/contracts";
import { z } from "zod";
export declare const serverInfoSchema: z.ZodObject<{
    auth_mode: z.ZodString;
    accounts_enabled: z.ZodBoolean;
    registration_mode: z.ZodNullable<z.ZodString>;
    durable_jobs: z.ZodBoolean;
    research_store: z.ZodBoolean;
    workflow_store: z.ZodBoolean;
    insights_store: z.ZodBoolean;
}, z.core.$loose>;
export type ServerInfo = z.infer<typeof serverInfoSchema>;
export declare function fetchInfo(): Promise<ServerInfo>;
declare const authUserSchema: z.ZodObject<{
    id: z.ZodString;
    email: z.ZodOptional<z.ZodString>;
    nick_name: z.ZodOptional<z.ZodNullable<z.ZodString>>;
}, z.core.$loose>;
export type AuthUser = z.infer<typeof authUserSchema>;
export declare function login(email: string, password: string): Promise<{
    user: AuthUser;
}>;
export declare function logout(): Promise<void>;
export declare function fetchMe(): Promise<{
    user: AuthUser;
}>;
export declare function sendRegisterCode(email: string): Promise<void>;
export declare function register(input: {
    email: string;
    code: string;
    password: string;
    nick_name?: string;
}): Promise<{
    user: AuthUser;
}>;
export declare function sendPasswordResetCode(email: string): Promise<void>;
export declare function resetPassword(input: {
    email: string;
    code: string;
    password: string;
}): Promise<void>;
declare function page<Schema extends z.ZodType>(item: Schema): z.ZodObject<{
    items: z.ZodArray<Schema>;
    total: z.ZodNumber;
    limit: z.ZodNumber;
    offset: z.ZodNumber;
    hasMore: z.ZodBoolean;
}, z.core.$loose>;
export type { Project, ResearchDocument, Session };
export declare function listProjects(): Promise<Project[]>;
export declare function createProject(input: CreateProjectRequest): Promise<Project>;
export declare function deleteProject(projectId: string): Promise<void>;
export declare function listDocuments(projectId: string, options?: {
    limit?: number;
    offset?: number;
}): Promise<z.infer<ReturnType<typeof page<typeof researchDocumentSchema>>>>;
export declare function listSessions(projectId?: string, includeArchived?: boolean): Promise<Session[]>;
export declare function createSession(input: CreateSessionRequest): Promise<Session>;
export declare function fetchSession(sessionId: string): Promise<Session>;
export declare function sendMessage(sessionId: string, input: SendMessageRequest): Promise<{
    operationId: string | null;
}>;
export declare function steerSession(sessionId: string, content: string): Promise<void>;
export declare function interruptSession(sessionId: string): Promise<void>;
export declare function uploadProjectDocuments(projectId: string, files: File[]): Promise<{
    uploads: unknown[];
}>;
export declare function deleteDocuments(projectId: string, documentIds: string[]): Promise<unknown>;
import { type SessionResource } from "@private-fund/contracts";
export declare function listSessionResources(sessionId: string): Promise<SessionResource[]>;
export declare function deleteSessionResource(sessionId: string, resourceId: string): Promise<void>;
export declare function fetchSessionEventsPage(sessionId: string, after?: number, limit?: number): Promise<SessionEvent[]>;
export declare function forkSession(sessionId: string, title?: string): Promise<Session>;
//# sourceMappingURL=client.d.ts.map