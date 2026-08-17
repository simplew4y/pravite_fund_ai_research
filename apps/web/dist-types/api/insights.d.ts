export interface TrackingOverview {
    items: Record<string, unknown>[];
    alerts: Record<string, unknown>[];
    memoVersions: Record<string, unknown>[];
    raw: Record<string, unknown>;
}
export declare function fetchTracking(projectId: string): Promise<TrackingOverview>;
export interface ValuationOverview {
    series: Record<string, unknown>[];
    alerts: Record<string, unknown>[];
    derivedModels: Record<string, unknown>[];
    raw: Record<string, unknown>;
}
export declare function fetchValuation(projectId: string): Promise<ValuationOverview>;
export declare function runTracking(projectId: string): Promise<unknown>;
export declare function runValuation(projectId: string): Promise<unknown>;
export declare function transitionTrackingAlert(projectId: string, alertId: string, status: string): Promise<void>;
export declare function compareMemoVersions(projectId: string, fromVersionId: string, toVersionId: string): Promise<Record<string, unknown>>;
export declare function memoPreviewUrl(projectId: string, memoVersionId: string): string;
export declare function memoDownloadUrl(projectId: string, memoVersionId: string): string;
export declare function addDocumentToSession(sessionId: string, documentId: string): Promise<void>;
//# sourceMappingURL=insights.d.ts.map