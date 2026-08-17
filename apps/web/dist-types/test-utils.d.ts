import type { ReactElement } from "react";
export declare function renderWithQuery(element: ReactElement): import("@testing-library/react").RenderResult<typeof import("@testing-library/dom/types/queries"), HTMLElement, HTMLElement>;
type RouteTable = Record<string, unknown | ((init?: RequestInit) => unknown)>;
/**
 * Stub global fetch with a "METHOD /path" → JSON body table.
 * Unmatched requests reject so tests fail loudly.
 */
export declare function stubFetch(routes: RouteTable): {
    method: string;
    path: string;
    body?: unknown;
}[];
export {};
//# sourceMappingURL=test-utils.d.ts.map