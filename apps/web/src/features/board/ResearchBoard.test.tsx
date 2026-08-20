import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { renderWithQuery, stubFetch } from "../../test-utils";
import { useUiStore } from "../../store/ui";
import { ResearchBoard } from "./ResearchBoard";

const documentRow = {
  id: "d-1",
  logicalKey: "annual-2025",
  sourceRoot: null,
  sourceRelpath: "docs/2025年报.pdf",
  title: "2025 年年度报告.pdf",
  status: "active",
  currentVersionId: "v-1",
  currentVersionNo: 1,
  metadata: {},
  createdAt: "2026-08-16T00:00:00.000Z",
  updatedAt: "2026-08-16T00:00:00.000Z",
  deletedAt: null,
};

const info = {
  auth_mode: "development",
  accounts_enabled: false,
  registration_mode: null,
  durable_jobs: true,
  research_store: true,
  insights_store: false,
};

afterEach(() => {
  vi.unstubAllGlobals();
  useUiStore.setState({ expandedSessionId: null, lang: "zh" });
});

describe("ResearchBoard", () => {
  it("lists documents and filters by search", async () => {
    stubFetch({
      "GET /v1/info": info,
      "GET /v1/projects/p-1/documents": {
        items: [documentRow, { ...documentRow, id: "d-2", title: "DCF_v3.xlsx" }],
        total: 2,
        limit: 200,
        offset: 0,
        hasMore: false,
      },
    });
    renderWithQuery(<ResearchBoard projectId="p-1" />);
    expect(await screen.findByText("2025 年年度报告.pdf")).toBeInTheDocument();
    await userEvent.type(screen.getByPlaceholderText("搜索资料…"), "dcf");
    expect(screen.queryByText("2025 年年度报告.pdf")).not.toBeInTheDocument();
    expect(screen.getByText("DCF_v3.xlsx")).toBeInTheDocument();
  });

  it("shows the disabled notice on memo tab when insights_store is off", async () => {
    stubFetch({
      "GET /v1/info": info,
      "GET /v1/projects/p-1/documents": {
        items: [],
        total: 0,
        limit: 200,
        offset: 0,
        hasMore: false,
      },
    });
    renderWithQuery(<ResearchBoard projectId="p-1" />);
    const notices = await screen.findAllByText("Memo 服务未启用");
    expect(notices.length).toBeGreaterThan(0);
  });
});
