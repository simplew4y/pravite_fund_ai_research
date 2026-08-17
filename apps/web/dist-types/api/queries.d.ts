export declare function useServerInfo(): import("@tanstack/react-query").UseQueryResult<{
    [x: string]: unknown;
    auth_mode: string;
    accounts_enabled: boolean;
    registration_mode: string | null;
    durable_jobs: boolean;
    research_store: boolean;
    workflow_store: boolean;
    insights_store: boolean;
}, Error>;
export declare function useMe(accountsEnabled: boolean): import("@tanstack/react-query").UseQueryResult<{
    user: import("./client").AuthUser;
}, Error>;
export declare function useProjects(enabled?: boolean): import("@tanstack/react-query").UseQueryResult<{
    id: string;
    name: string;
    companyName: string | null;
    ticker: string | null;
    createdAt: string;
    updatedAt: string;
}[], Error>;
export declare function useCreateProject(): import("@tanstack/react-query").UseMutationResult<{
    id: string;
    name: string;
    companyName: string | null;
    ticker: string | null;
    createdAt: string;
    updatedAt: string;
}, Error, {
    name: string;
    companyName?: string | undefined;
    ticker?: string | undefined;
}, unknown>;
export declare function useDeleteProject(): import("@tanstack/react-query").UseMutationResult<void, Error, string, unknown>;
export declare function useProjectDocuments(projectId: string | null, limit?: number): import("@tanstack/react-query").UseQueryResult<{
    [x: string]: unknown;
    items: {
        id: string;
        logicalKey: string;
        sourceRoot: string | null;
        sourceRelpath: string;
        title: string;
        status: "active" | "removed" | "archived";
        currentVersionId: string | null;
        currentVersionNo: number;
        metadata: Record<string, unknown>;
        createdAt: string;
        updatedAt: string;
        deletedAt: string | null;
    }[];
    total: number;
    limit: number;
    offset: number;
    hasMore: boolean;
}, Error>;
export declare function useProjectSessions(projectId: string | null): import("@tanstack/react-query").UseQueryResult<{
    id: string;
    projectId: string;
    title: string;
    status: "idle" | "running" | "interrupted" | "failed";
    archivedAt: string | null;
    forkedFromSessionId: string | null;
    createdAt: string;
    updatedAt: string;
    lastSequence: number;
}[], Error>;
export declare function useCreateSession(): import("@tanstack/react-query").UseMutationResult<{
    id: string;
    projectId: string;
    title: string;
    status: "idle" | "running" | "interrupted" | "failed";
    archivedAt: string | null;
    forkedFromSessionId: string | null;
    createdAt: string;
    updatedAt: string;
    lastSequence: number;
}, Error, {
    projectId: string;
    title?: string | undefined;
    model?: string | undefined;
}, unknown>;
//# sourceMappingURL=queries.d.ts.map