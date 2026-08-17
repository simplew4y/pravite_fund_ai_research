import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { renderWithQuery, stubFetch } from "../../test-utils";
import { useUiStore } from "../../store/ui";
import { ProjectRail } from "./ProjectRail";

const project = {
  id: "p-1",
  name: "恒瑞医药",
  companyName: "恒瑞医药股份",
  ticker: "600276.SH",
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
};

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
  useUiStore.setState({
    selectedProjectId: null,
    expandedSessionId: null,
    lang: "zh",
  });
});

describe("ProjectRail", () => {
  it("lists projects and selects on click", async () => {
    stubFetch({ "GET /v1/projects": { projects: [project] } });
    renderWithQuery(<ProjectRail />);
    const item = await screen.findByText("恒瑞医药");
    await userEvent.click(item);
    expect(useUiStore.getState().selectedProjectId).toBe("p-1");
    expect(screen.getByText("600276.SH")).toBeInTheDocument();
  });

  it("creates a project through the dialog", async () => {
    const calls = stubFetch({
      "GET /v1/projects": { projects: [] },
      "POST /v1/projects": { ...project, id: "p-2", name: "新项目" },
    });
    renderWithQuery(<ProjectRail />);
    await userEvent.click(await screen.findByRole("button", { name: /新建项目/ }));
    await userEvent.type(screen.getByLabelText("项目名称"), "新项目");
    await userEvent.click(screen.getByRole("button", { name: "创建" }));
    await waitFor(() =>
      expect(calls.some((call) => call.method === "POST" && call.path === "/v1/projects")).toBe(
        true,
      ),
    );
    expect(useUiStore.getState().selectedProjectId).toBe("p-2");
  });

  it("lists the selected project's sessions in the rail and opens one", async () => {
    useUiStore.setState({ selectedProjectId: "p-1" });
    stubFetch({
      "GET /v1/projects": { projects: [{ ...project, id: "p-1" }] },
      "GET /v1/sessions": { sessions: [session] },
      "GET /v1/uploads/items": { items: [] },
    });
    renderWithQuery(<ProjectRail />);
    const row = await screen.findByText("集采对 2026 毛利率的影响");
    await userEvent.click(row);
    expect(useUiStore.getState().expandedSessionId).toBe("s-1");
  });

  it("hides the session section until a project is selected", async () => {
    stubFetch({
      "GET /v1/projects": { projects: [{ ...project, id: "p-1" }] },
      "GET /v1/uploads/items": { items: [] },
    });
    renderWithQuery(<ProjectRail />);
    await screen.findByText("恒瑞医药");
    expect(
      screen.queryByRole("region", { name: "研究会话" }),
    ).not.toBeInTheDocument();
  });
});
