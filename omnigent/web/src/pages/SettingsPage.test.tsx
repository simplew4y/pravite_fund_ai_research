// Tests for the Settings content panel. The section nav lives in the sidebar
// card (see settingsNav); the page renders only the section named by the URL.
// Covers the Appearance theme picker, the auth-gated Account section, and the
// Archived sessions list (which moved here out of the sidebar).

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { Conversation } from "@/hooks/useConversations";

const mocks = vi.hoisted(() => ({
  setTheme: vi.fn(),
  theme: "system" as string,
  archiveMutate: vi.fn(),
  deleteMutate: vi.fn(),
  accountsEnabled: true,
  me: { id: "alice", is_admin: false } as { id: string; is_admin: boolean } | null,
  conversations: [] as Conversation[],
  llmConfig: {
    preset: "dashscope",
    provider: "dashscope",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    model: "qwen3-max",
    hasApiKey: true,
    maskedApiKey: "sk-bab*****************d2",
    configured: true,
  },
  llmApplyStatus: { busy: false, applying: false },
  refreshLlm: vi.fn(),
  testLlm: vi.fn(),
  saveLlm: vi.fn(),
}));

vi.mock("next-themes", () => ({
  useTheme: () => ({ theme: mocks.theme, systemTheme: "light", setTheme: mocks.setTheme }),
}));
vi.mock("@/lib/embedded", () => ({ useIsEmbedded: () => false }));
vi.mock("@/lib/CapabilitiesContext", () => ({
  useServerInfo: () => ({ accounts_enabled: mocks.accountsEnabled }),
}));
vi.mock("@/lib/accountsApi", () => ({
  getMe: () => Promise.resolve(mocks.me),
  logout: vi.fn(),
  changePassword: vi.fn(),
}));
vi.mock("@/hooks/useConversations", () => ({
  useConversations: () => ({
    data: { pages: [{ data: mocks.conversations }] },
    isLoading: false,
  }),
  useArchiveConversation: () => ({ mutate: mocks.archiveMutate, isPending: false }),
  useStopAndDeleteConversation: () => ({ mutate: mocks.deleteMutate, isPending: false }),
}));
vi.mock("@/lib/LlmConfigContext", () => ({
  useLlmConfiguration: () => ({
    enabled: true,
    config: mocks.llmConfig,
    applyStatus: mocks.llmApplyStatus,
    loading: false,
    requireConfiguration: () => true,
    refresh: mocks.refreshLlm,
  }),
}));
vi.mock("@/lib/llmConfigApi", () => ({
  getLlmApplyStatus: () => Promise.resolve({ busy: false, applying: false }),
  testLlmConfig: mocks.testLlm,
  saveLlmConfig: mocks.saveLlm,
}));

import { SettingsPage } from "./SettingsPage";

function conv(id: string, partial: Partial<Conversation> = {}): Conversation {
  return {
    id,
    object: "conversation",
    title: id,
    created_at: 0,
    updated_at: 0,
    labels: {},
    permission_level: null,
    ...partial,
  };
}

function renderPage(path = "/settings") {
  return render(
    <TooltipProvider>
      <MemoryRouter initialEntries={[path]}>
        <SettingsPage />
      </MemoryRouter>
    </TooltipProvider>,
  );
}

beforeEach(() => {
  mocks.setTheme.mockReset();
  mocks.archiveMutate.mockReset();
  mocks.deleteMutate.mockReset();
  mocks.theme = "system";
  mocks.accountsEnabled = true;
  mocks.me = { id: "alice", is_admin: false };
  mocks.conversations = [];
  mocks.refreshLlm.mockReset();
  mocks.testLlm.mockReset();
  mocks.saveLlm.mockReset();
  mocks.testLlm.mockResolvedValue({ ok: true });
  mocks.saveLlm.mockResolvedValue({ ok: true, config: mocks.llmConfig });
});
afterEach(cleanup);

describe("SettingsPage", () => {
  it("renders the Appearance section and applies a theme on card click", () => {
    renderPage("/settings/appearance");
    expect(screen.getByRole("heading", { name: "Appearance" })).toBeInTheDocument();
    // System is selected (theme = "system").
    expect(screen.getByTestId("theme-system")).toHaveAttribute("aria-checked", "true");
    fireEvent.click(screen.getByTestId("theme-dark"));
    expect(mocks.setTheme).toHaveBeenCalledWith("dark");
  });

  it("defaults bare /settings to Account when accounts is on, else Appearance", async () => {
    // Accounts on → Account leads, so /settings lands on it.
    renderPage("/settings");
    await waitFor(() => expect(screen.getByText("alice")).toBeInTheDocument());

    // Accounts off → no Account section; default falls back to Appearance.
    cleanup();
    mocks.accountsEnabled = false;
    renderPage("/settings");
    expect(screen.getByRole("heading", { name: "Appearance" })).toBeInTheDocument();
  });

  it("renders the Account section at /settings/account when auth is enabled", async () => {
    renderPage("/settings/account");
    await waitFor(() => expect(screen.getByText("alice")).toBeInTheDocument());

    // With accounts off, the section renders nothing even at its URL.
    cleanup();
    mocks.accountsEnabled = false;
    renderPage("/settings/account");
    expect(screen.queryByText("alice")).toBeNull();
  });

  it("lists archived sessions and unarchives on click", () => {
    mocks.conversations = [
      conv("conv_active"),
      conv("conv_archived", { archived: true, title: "Old chat" }),
    ];
    renderPage("/settings/archived");

    const rows = screen.getAllByTestId("archived-row");
    expect(rows).toHaveLength(1);
    expect(within(rows[0]).getByText("Old chat")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("unarchive-conversation"));
    expect(mocks.archiveMutate).toHaveBeenCalledWith({ id: "conv_archived", archived: false });
  });

  it("deletes an archived session after confirming, with no row-click navigation", () => {
    mocks.conversations = [conv("conv_archived", { archived: true, title: "Old chat" })];
    renderPage("/settings/archived");

    // The row text isn't a link/button target — there's nothing to click into.
    expect(screen.queryByRole("link", { name: /Old chat/ })).toBeNull();

    // Trash → confirm dialog → Delete fires the delete mutation.
    fireEvent.click(screen.getByTestId("delete-archived"));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(mocks.deleteMutate).toHaveBeenCalledWith({ id: "conv_archived" });
  });

  it("shows a masked API key and supports whole-value edit cancellation", async () => {
    renderPage("/settings/llm");

    const masked = await screen.findByDisplayValue("sk-bab*****************d2");
    expect(masked).not.toBeDisabled();
    fireEvent.click(masked);
    expect(screen.getByPlaceholderText("请输入完整的新 API Key")).toHaveValue("");

    fireEvent.change(screen.getByPlaceholderText("请输入完整的新 API Key"), {
      target: { value: "sk-replacement" },
    });
    fireEvent.click(screen.getByRole("button", { name: "取消" }));

    expect(screen.getByDisplayValue("sk-bab*****************d2")).toBeInTheDocument();
    expect(screen.queryByDisplayValue("sk-replacement")).toBeNull();
  });

  it("keeps credentials scoped to the saved provider when switching presets", async () => {
    renderPage("/settings/llm");
    await screen.findByDisplayValue("sk-bab*****************d2");

    fireEvent.keyDown(screen.getByTestId("llm-provider-select"), { key: "ArrowDown" });
    fireEvent.click(screen.getByRole("option", { name: "DeepSeek" }));

    expect(screen.getByDisplayValue("https://api.deepseek.com/v1")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("例如 qwen3-max")).toHaveValue("");
    expect(screen.getByPlaceholderText("请输入完整的新 API Key")).toHaveValue("");
    expect(screen.queryByDisplayValue("sk-bab*****************d2")).toBeNull();

    fireEvent.keyDown(screen.getByTestId("llm-provider-select"), { key: "ArrowDown" });
    fireEvent.click(screen.getByRole("option", { name: "通义千问（DashScope）" }));

    expect(
      screen.getByDisplayValue("https://dashscope.aliyuncs.com/compatible-mode/v1"),
    ).toBeInTheDocument();
    expect(screen.getByDisplayValue("qwen3-max")).toBeInTheDocument();
    expect(screen.getByDisplayValue("sk-bab*****************d2")).toBeInTheDocument();
  });

  it("tests and saves without resending an unchanged masked key", async () => {
    renderPage("/settings/llm");
    await screen.findByDisplayValue("sk-bab*****************d2");

    fireEvent.click(screen.getByRole("button", { name: "测试连接" }));
    await waitFor(() =>
      expect(mocks.testLlm).toHaveBeenCalledWith(
        expect.objectContaining({ model: "qwen3-max", apiKey: "" }),
      ),
    );

    fireEvent.click(screen.getByRole("button", { name: "保存配置" }));
    await waitFor(() =>
      expect(mocks.saveLlm).toHaveBeenCalledWith(
        expect.objectContaining({ model: "qwen3-max", apiKey: "" }),
      ),
    );
    expect(mocks.refreshLlm).toHaveBeenCalled();
  });
});
