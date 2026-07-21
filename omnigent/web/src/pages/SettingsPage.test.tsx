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
  testLlmConfig: vi.fn(),
  saveLlmConfig: vi.fn(),
  getLlmApplyStatus: vi.fn(),
  refreshLlmConfig: vi.fn(),
  llmConfig: null as null | {
    preset: "dashscope" | "deepseek" | "openai" | "anthropic" | "custom";
    provider: string;
    baseUrl: string;
    model: string;
    hasApiKey: boolean;
    maskedApiKey: string;
    configured: boolean;
  },
  llmApplyStatus: { busy: false, applying: false, detail: undefined as string | undefined },
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
vi.mock("@/lib/nativeBridge", () => ({
  isElectronShell: () => true,
  supportsDesktopLlmConfiguration: () => true,
  getCliStatus: vi.fn().mockResolvedValue(null),
  resetCliPath: vi.fn().mockResolvedValue(null),
  testLlmConfig: mocks.testLlmConfig,
  saveLlmConfig: mocks.saveLlmConfig,
  getLlmApplyStatus: mocks.getLlmApplyStatus,
}));
vi.mock("@/lib/LlmConfigContext", () => ({
  useLlmConfiguration: () => ({
    config: mocks.llmConfig,
    applyStatus: mocks.llmApplyStatus,
    loading: false,
    requireConfiguration: () => true,
    refresh: mocks.refreshLlmConfig,
  }),
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
  mocks.testLlmConfig.mockReset();
  mocks.saveLlmConfig.mockReset();
  mocks.getLlmApplyStatus.mockReset();
  mocks.getLlmApplyStatus.mockResolvedValue({ busy: false, applying: false });
  mocks.refreshLlmConfig.mockReset();
  mocks.llmConfig = null;
  mocks.llmApplyStatus = { busy: false, applying: false, detail: undefined };
  mocks.theme = "system";
  mocks.accountsEnabled = true;
  mocks.me = { id: "alice", is_admin: false };
  mocks.conversations = [];
});
afterEach(cleanup);

describe("SettingsPage", () => {
  it("tests a desktop model configuration without exposing it outside the native bridge", async () => {
    mocks.testLlmConfig.mockResolvedValue({ ok: true });
    renderPage("/settings/llm");
    fireEvent.change(screen.getByLabelText("API Key"), { target: { value: "test-key" } });
    fireEvent.click(screen.getByRole("button", { name: "测试连接" }));
    await waitFor(() =>
      expect(mocks.testLlmConfig).toHaveBeenCalledWith(
        expect.objectContaining({ preset: "dashscope", model: "qwen3-max", apiKey: "test-key" }),
      ),
    );
    expect(screen.getByText("连接成功，模型服务可以正常使用。")).toBeInTheDocument();
  });

  it("shows the masked API key as a solid value and replaces it as a whole", () => {
    mocks.llmConfig = {
      preset: "dashscope",
      provider: "dashscope",
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      model: "qwen3-max",
      hasApiKey: true,
      maskedApiKey: "sk-bab*****************d2",
      configured: true,
    };
    renderPage("/settings/llm");

    const maskedInput = screen.getByLabelText("API Key");
    expect(maskedInput).toHaveValue("sk-bab*****************d2");
    expect(maskedInput).toHaveAttribute("readonly");

    fireEvent.click(maskedInput);
    const replacementInput = screen.getByLabelText("API Key");
    expect(replacementInput).toHaveValue("");
    expect(replacementInput).toHaveAttribute("type", "password");
    expect(screen.getByRole("button", { name: "保存配置" })).toBeDisabled();

    fireEvent.change(replacementInput, { target: { value: "sk-new-secret" } });
    expect(screen.getByRole("button", { name: "保存配置" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(screen.getByLabelText("API Key")).toHaveValue("sk-bab*****************d2");
  });

  it("disables model changes while a response is running", () => {
    mocks.llmApplyStatus = {
      busy: true,
      applying: false,
      detail: "当前有回答正在生成，请等待完成后修改。",
    };
    renderPage("/settings/llm");

    expect(screen.getByText("当前有回答正在生成，请等待完成后修改。")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "保存配置" })).toBeDisabled();
  });

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
});
