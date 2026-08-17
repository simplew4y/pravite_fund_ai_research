import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import type { ReactElement } from "react";
import { vi } from "vitest";

export function renderWithQuery(element: ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(<QueryClientProvider client={client}>{element}</QueryClientProvider>);
}

type RouteTable = Record<string, unknown | ((init?: RequestInit) => unknown)>;

/**
 * Stub global fetch with a "METHOD /path" → JSON body table.
 * Unmatched requests reject so tests fail loudly.
 */
export function stubFetch(routes: RouteTable) {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const path = url.replace(/^https?:\/\/[^/]+/, "").split("?")[0]!;
      const method = init?.method ?? "GET";
      calls.push({
        method,
        path,
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      });
      const handler = routes[`${method} ${path}`];
      if (handler === undefined) {
        return new Response(JSON.stringify({ error: "not_found", message: path }), {
          status: 404,
          headers: { "content-type": "application/json" },
        });
      }
      const value = typeof handler === "function" ? handler(init) : handler;
      if (value instanceof Response) return value;
      return new Response(JSON.stringify(value), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );
  return calls;
}
