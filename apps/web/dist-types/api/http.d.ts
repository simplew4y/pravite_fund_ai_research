import type { z } from "zod";
export declare class ApiError extends Error {
    readonly status: number;
    readonly code: string;
    constructor(status: number, code: string, message: string);
}
export interface RequestOptions {
    method?: string;
    body?: unknown;
    form?: FormData;
    signal?: AbortSignal;
    headers?: Record<string, string>;
}
export declare function request(path: string, options?: RequestOptions): Promise<Response>;
export declare function requestJson<Schema extends z.ZodType>(path: string, schema: Schema, options?: RequestOptions): Promise<z.output<Schema>>;
export declare function query(params: Record<string, string | number | boolean | undefined>): string;
//# sourceMappingURL=http.d.ts.map