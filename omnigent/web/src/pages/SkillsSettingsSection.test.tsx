import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  search: vi.fn(),
  installed: vi.fn(),
  install: vi.fn(),
  uninstall: vi.fn(),
}));

vi.mock("@/lib/skillsMarketplaceApi", () => ({
  searchMarketplaceSkills: mocks.search,
  getInstalledSkills: mocks.installed,
  installMarketplaceSkill: mocks.install,
  uninstallSkill: mocks.uninstall,
}));

import { SkillsSettingsSection } from "./SkillsSettingsSection";

const marketResult = {
  skills: [
    {
      id: "anthropics-dcf",
      name: "dcf-model",
      author: "anthropics",
      description: "Build a complete discounted cash-flow valuation model.",
      githubUrl: "https://github.com/anthropics/financial-services/tree/main/skills/dcf-model",
      skillUrl: "https://skillsmp.com/dcf-model",
      stars: 33807,
      updatedAt: 1777993098,
      installed: false,
    },
    {
      id: "hkuds-edgar",
      name: "edgar-sec-filings",
      author: "HKUDS",
      description: "Analyze SEC EDGAR filings.",
      githubUrl: "https://github.com/HKUDS/Vibe-Trading/tree/main/skills/edgar",
      skillUrl: "https://skillsmp.com/edgar",
      stars: 27819,
      updatedAt: 1775713393,
      installed: false,
    },
  ],
  page: 1,
  limit: 12,
  hasNext: false,
  total: 2,
  source: "skillsmp",
  warning: null,
  query: "investment research",
  effectiveQuery: "investment research",
};

beforeEach(() => {
  mocks.search.mockReset().mockResolvedValue(marketResult);
  mocks.installed.mockReset().mockResolvedValue([]);
  mocks.install.mockReset().mockResolvedValue({
    installId: "dcf-model",
    name: "dcf-model",
    description: marketResult.skills[0].description,
    marketplaceId: "anthropics-dcf",
    managed: true,
  });
  mocks.uninstall.mockReset().mockResolvedValue({ status: "uninstalled" });
});

afterEach(cleanup);

describe("SkillsSettingsSection", () => {
  it("renders a two-column-ready marketplace and installs with one click", async () => {
    const { container } = render(<SkillsSettingsSection />);

    expect(await screen.findByText("dcf-model")).toBeInTheDocument();
    expect(screen.getByText("edgar-sec-filings")).toBeInTheDocument();
    expect(container.querySelector(".lg\\:grid-cols-2")).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "安装 dcf-model" }));
    await waitFor(() => expect(mocks.install).toHaveBeenCalledWith("anthropics-dcf"));
    expect(await screen.findByText("“dcf-model”已安装，新建对话即可使用。")).toBeInTheDocument();
  });

  it("lets the user search with their own query", async () => {
    render(<SkillsSettingsSection />);
    await screen.findByText("dcf-model");

    fireEvent.change(screen.getByLabelText("搜索技能"), { target: { value: "私募尽调" } });
    fireEvent.click(screen.getByRole("button", { name: "搜索" }));

    await waitFor(() => expect(mocks.search).toHaveBeenLastCalledWith("私募尽调", 1));
  });

  it("requires an explicit confirmation click before uninstalling", async () => {
    mocks.installed.mockResolvedValue([
      {
        installId: "dcf-model",
        name: "dcf-model",
        description: "Build a complete discounted cash-flow valuation model.",
        marketplaceId: "anthropics-dcf",
        author: "anthropics",
        managed: true,
      },
    ]);
    render(<SkillsSettingsSection />);
    await screen.findByText("dcf-model");
    await waitFor(() =>
      expect(screen.getByRole("tab", { name: "已安装 (1)" })).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("tab", { name: "已安装 (1)" }));

    fireEvent.click(screen.getByRole("button", { name: "卸载 dcf-model" }));
    expect(mocks.uninstall).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "确认卸载 dcf-model" }));
    await waitFor(() => expect(mocks.uninstall).toHaveBeenCalledWith("dcf-model"));
  });
});
