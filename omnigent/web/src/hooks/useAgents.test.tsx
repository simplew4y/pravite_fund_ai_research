import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useSessionAgent } from "./useAgents";

const fetchMock = vi.fn();

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("useSessionAgent", () => {
  it("preserves bundled skills returned by the session agent endpoint", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({
        id: "ag_private_fund",
        object: "agent",
        name: "claude-native-ui",
        skills: [
          {
            name: "private-fund-memo",
            description: "Create an evidence-backed investment memo.",
          },
        ],
      }),
    } as Response);

    const { result } = renderHook(() => useSessionAgent("conv_private_fund"), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(fetchMock).toHaveBeenCalledWith(
      "/v1/sessions/conv_private_fund/agent",
      expect.any(Object),
    );
    expect(result.current.data?.skills).toEqual([
      {
        name: "private-fund-memo",
        description: "Create an evidence-backed investment memo.",
      },
    ]);
  });
});
