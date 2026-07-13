import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";

import { ACTIVE_PRIVATE_FUND_PROJECT_STORAGE_KEY } from "@/lib/privateFundApi";
import { PrivateFundWorkbenchRedirect } from "./PrivateFundWorkbenchRedirect";

function WorkbenchLocation() {
  const location = useLocation();
  return <div data-testid="workbench-location">{`${location.pathname}${location.search}`}</div>;
}

function renderRedirect(initialEntry: string) {
  render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <Routes>
        <Route path="/research-projects" element={<PrivateFundWorkbenchRedirect />} />
        <Route path="/research-projects/:datasetId" element={<PrivateFundWorkbenchRedirect />} />
        <Route path="/" element={<WorkbenchLocation />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("PrivateFundWorkbenchRedirect", () => {
  beforeEach(() => window.localStorage.clear());

  it("redirects a legacy project detail URL into the unified workbench", async () => {
    renderRedirect("/research-projects/阳光电源");
    await waitFor(() =>
      expect(screen.getByTestId("workbench-location")).toHaveTextContent(
        "/?private_fund_project=%E9%98%B3%E5%85%89%E7%94%B5%E6%BA%90",
      ),
    );
  });

  it("redirects the legacy project index to the active workbench", async () => {
    window.localStorage.setItem(ACTIVE_PRIVATE_FUND_PROJECT_STORAGE_KEY, "阳光电源");
    renderRedirect("/research-projects");
    await waitFor(() =>
      expect(screen.getByTestId("workbench-location")).toHaveTextContent(
        "/?private_fund_project=%E9%98%B3%E5%85%89%E7%94%B5%E6%BA%90",
      ),
    );
  });
});
