import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { renderWithQuery, stubFetch } from "../../test-utils";
import { useUiStore } from "../../store/ui";
import { Workbench } from "./Workbench";

const session = {
  id: "s-1",
  projectId: "p-1",
  title: "集采对 2026 毛利率的影响",
  status: "idle",
  archivedAt: null,
  forkedFromSessionId: null,
  createdAt: "2026-08-14T00:00:00.000Z",
  updatedAt: "2026-08-14T00:00:00.000Z",
  lastSequence: 14,
};

afterEach(() => {
  vi.unstubAllGlobals();
  useUiStore.setState({ expandedSessionId: null, lang: "zh" });
});

describe("Workbench", () => {
  it("shows the project header counts and opens the expanded session", async () => {
    useUiStore.setState({ expandedSessionId: "s-1" });
    stubFetch({
      "GET /v1/projects": { projects: [] },
      "GET /v1/projects/p-1/documents": {
        items: [],
        total: 128,
        limit: 200,
        offset: 0,
        hasMore: false,
      },
      "GET /v1/sessions": { sessions: [session] },
      "GET /v1/sessions/s-1/events": { events: [] },
      "GET /v1/sessions/s-1/resources": {
        items: [],
        total: 0,
        limit: 50,
        offset: 0,
        hasMore: false,
      },
    });
    renderWithQuery(<Workbench projectId="p-1" />);
    expect(await screen.findByText(/128/)).toBeInTheDocument();
    // The expanded session renders in the centre; its history now lives in the rail.
    expect(
      await screen.findByText("集采对 2026 毛利率的影响"),
    ).toBeInTheDocument();
    // The centre no longer hosts a session-history section.
    expect(
      screen.queryByRole("region", { name: "研究会话" }),
    ).not.toBeInTheDocument();
  });

  it("creates a session via the new chat button", async () => {
    const calls = stubFetch({
      "GET /v1/projects": { projects: [] },
      "GET /v1/projects/p-1/documents": {
        items: [],
        total: 0,
        limit: 200,
        offset: 0,
        hasMore: false,
      },
      "GET /v1/sessions": { sessions: [] },
      "POST /v1/sessions": { ...session, id: "s-2" },
      "GET /v1/sessions/s-2/events": { events: [] },
    });
    renderWithQuery(<Workbench projectId="p-1" />);
    await userEvent.click(await screen.findByRole("button", { name: "新会话" }));
    expect(
      calls.some((call) => call.method === "POST" && call.path === "/v1/sessions"),
    ).toBe(true);
  });
});
