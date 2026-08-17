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

afterEach(() => {
  vi.unstubAllGlobals();
  useUiStore.setState({ selectedProjectId: null, lang: "zh" });
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
});
