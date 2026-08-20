import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { renderWithQuery, stubFetch } from "../../test-utils";
import { JobsBadge } from "./JobsBadge";

function job(overrides: Record<string, unknown>) {
  return {
    id: "job-1",
    tenantNamespace: "00000000-0000-4000-8000-000000000001",
    projectId: "p-1",
    type: "document.ingest",
    status: "queued",
    payload: {},
    attempt: 0,
    maxAttempts: 3,
    leaseOwner: null,
    leaseExpiresAt: null,
    idempotencyKey: "k-1",
    availableAt: "2026-08-18T00:00:00.000Z",
    createdAt: "2026-08-18T00:00:00.000Z",
    updatedAt: "2026-08-18T00:00:00.000Z",
    startedAt: null,
    completedAt: null,
    result: null,
    error: null,
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("JobsBadge", () => {
  it("shows the active count and reveals translated job rows when expanded", async () => {
    stubFetch({
      "GET /v1/jobs": {
        jobs: [
          job({ id: "job-1", status: "running" }),
          job({ id: "job-2", status: "queued", type: "memo.generate" }),
        ],
      },
    });
    renderWithQuery(<JobsBadge projectId="p-1" />);
    const summary = await screen.findByText(/后台任务/);
    expect(summary.closest("summary")?.textContent).toContain("2");
    await userEvent.click(summary);
    expect(screen.getByText("文档解析")).toBeInTheDocument();
    expect(screen.getByText("Memo 生成")).toBeInTheDocument();
    expect(screen.getByText("运行中")).toBeInTheDocument();
    expect(screen.getByText("排队中")).toBeInTheDocument();
  });

  it("still shows recent failures with a truncated error", async () => {
    stubFetch({
      "GET /v1/jobs": {
        jobs: [
          job({
            id: "job-3",
            status: "failed",
            completedAt: new Date().toISOString(),
            error: "x".repeat(120),
          }),
        ],
      },
    });
    renderWithQuery(<JobsBadge projectId="p-1" />);
    expect(await screen.findByText(/后台任务/)).toBeInTheDocument();
    await userEvent.click(screen.getByText(/后台任务/));
    expect(screen.getByText("失败")).toBeInTheDocument();
    expect(screen.getByText(`${"x".repeat(80)}…`)).toBeInTheDocument();
  });

  it("renders nothing when there are no active jobs or recent failures", async () => {
    const calls = stubFetch({ "GET /v1/jobs": { jobs: [] } });
    const { container } = renderWithQuery(<JobsBadge projectId="p-1" />);
    await waitFor(() => {
      expect(calls.some((call) => call.path === "/v1/jobs")).toBe(true);
    });
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when the jobs endpoint is disabled (503)", async () => {
    const calls = stubFetch({
      "GET /v1/jobs": () =>
        new Response(
          JSON.stringify({ error: "jobs_disabled", message: "disabled" }),
          { status: 503, headers: { "content-type": "application/json" } },
        ),
    });
    const { container } = renderWithQuery(<JobsBadge projectId="p-1" />);
    await waitFor(() => {
      expect(calls.some((call) => call.path === "/v1/jobs")).toBe(true);
    });
    expect(container.firstChild).toBeNull();
  });
});
