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
  cloudAccounts: false,
  me: {
    id: "alice",
    is_admin: false,
    email: "alice@example.com",
    nick_name: null,
  } as {
    id: string;
    is_admin: boolean;
    email?: string;
    nick_name?: string | null;
    balance_cny?: string;
  } | null,
  platformUsage: {
    items: [],
    summary: {
      request_count: 0,
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
      charged_amount_cny: "0.000000",
    },
    page: 1,
    page_size: 10,
  },
  balanceRecords: {
    items: [] as Array<{
      id: string;
      record_type: string;
      amount_cny: string;
      balance_after_cny: string;
      note: string | null;
      model_display_name?: string | null;
      prompt_tokens?: number | null;
      completion_tokens?: number | null;
      created_at: string;
    }>,
    page: 1,
    page_size: 10,
    total: 0,
    total_pages: 0,
    period: "all" as "all" | "week" | "month",
  },
  balanceRequest: vi.fn(),
  updateProfile: vi.fn(),
  sendPasswordCode: vi.fn(),
  changePassword: vi.fn(),
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
  modelSource: "platform" as "platform" | "byok",
  refreshLlm: vi.fn(),
  setLlmSource: vi.fn(),
  testLlm: vi.fn(),
  saveLlm: vi.fn(),
}));

vi.mock("next-themes", () => ({
  useTheme: () => ({ theme: mocks.theme, systemTheme: "light", setTheme: mocks.setTheme }),
}));
vi.mock("@/lib/embedded", () => ({ useIsEmbedded: () => false }));
vi.mock("@/lib/CapabilitiesContext", () => ({
  useServerInfo: () => ({
    accounts_enabled: mocks.accountsEnabled,
    cloud_accounts_enabled: mocks.cloudAccounts,
  }),
}));
vi.mock("@/lib/accountsApi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/accountsApi")>();
  return {
    ...actual,
    getMe: () => Promise.resolve(mocks.me),
    getPlatformUsage: () => Promise.resolve(mocks.platformUsage),
    getBalanceRecords: (page: number, period: "all" | "week" | "month") => {
      mocks.balanceRequest(page, period);
      return Promise.resolve({ ...mocks.balanceRecords, page, period });
    },
    updateAccountProfile: (nickName: string | null) => mocks.updateProfile(nickName),
    logout: vi.fn(),
    sendChangePasswordCode: () => mocks.sendPasswordCode(),
    changePassword: (body: unknown) => mocks.changePassword(body),
  };
});
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
    cloudAccounts: mocks.cloudAccounts,
    serverScoped: mocks.accountsEnabled,
    config: mocks.llmConfig,
    modelService: mocks.cloudAccounts
      ? {
          userId: "alice",
          source: mocks.modelSource,
          ready: true,
          activeLabel: "Qwen3 Max",
          platform: {
            available: true,
            balanceCny: "12.500000",
            defaultModel: "private-fund-default",
            models: [
              {
                id: "private-fund-default",
                displayName: "Qwen3 Max",
                provider: "dashscope",
                inputPriceCnyPerMillion: "3.200000",
                outputPriceCnyPerMillion: "12.800000",
                defaultMaxTokens: 0,
                maxOutputTokens: 0,
              },
            ],
          },
          byok: mocks.llmConfig,
        }
      : null,
    applyStatus: mocks.llmApplyStatus,
    loading: false,
    requireConfiguration: () => true,
    refresh: mocks.refreshLlm,
    setSource: mocks.setLlmSource,
  }),
}));
vi.mock("@/lib/llmConfigApi", () => ({
  getLlmApplyStatus: vi.fn(() => Promise.resolve({ busy: false, applying: false })),
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
  mocks.cloudAccounts = false;
  mocks.me = {
    id: "alice",
    is_admin: false,
    email: "alice@example.com",
    nick_name: null,
  };
  mocks.platformUsage = {
    items: [],
    summary: {
      request_count: 0,
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
      charged_amount_cny: "0.000000",
    },
    page: 1,
    page_size: 10,
  };
  mocks.balanceRecords = {
    items: [],
    page: 1,
    page_size: 10,
    total: 0,
    total_pages: 0,
    period: "all",
  };
  mocks.balanceRequest.mockReset();
  mocks.updateProfile.mockReset();
  mocks.sendPasswordCode.mockReset();
  mocks.changePassword.mockReset();
  mocks.modelSource = "platform";
  mocks.updateProfile.mockImplementation((nickName: string | null) =>
    Promise.resolve({
      ok: true,
      account: { ...mocks.me, nick_name: nickName },
    }),
  );
  mocks.sendPasswordCode.mockResolvedValue({ ok: true, expires_in: 300, resend_after: 60 });
  mocks.changePassword.mockResolvedValue({ ok: true });
  mocks.conversations = [];
  mocks.refreshLlm.mockReset();
  mocks.setLlmSource.mockReset();
  mocks.testLlm.mockReset();
  mocks.saveLlm.mockReset();
  mocks.testLlm.mockResolvedValue({ ok: true });
  mocks.saveLlm.mockResolvedValue({ ok: true, config: mocks.llmConfig });
});
afterEach(cleanup);

describe("SettingsPage", () => {
  it("renders the Appearance section and applies a theme on card click", () => {
    renderPage("/settings/appearance");
    expect(screen.getByRole("heading", { name: "外观" })).toBeInTheDocument();
    // System is selected (theme = "system").
    expect(screen.getByTestId("theme-system")).toHaveAttribute("aria-checked", "true");
    fireEvent.click(screen.getByTestId("theme-dark"));
    expect(mocks.setTheme).toHaveBeenCalledWith("dark");
  });

  it("defaults bare /settings to Account when accounts is on, else Appearance", async () => {
    // Accounts on → Account leads, so /settings lands on it.
    renderPage("/settings");
    await waitFor(() => expect(screen.getAllByText("alice@example.com")).not.toHaveLength(0));

    // Accounts off → no Account section; default falls back to Appearance.
    cleanup();
    mocks.accountsEnabled = false;
    renderPage("/settings");
    expect(screen.getByRole("heading", { name: "外观" })).toBeInTheDocument();
  });

  it("renders the Account section at /settings/account when auth is enabled", async () => {
    renderPage("/settings/account");
    await waitFor(() => expect(screen.getAllByText("alice@example.com")).not.toHaveLength(0));
    expect(screen.getByRole("heading", { name: "账户" })).toBeInTheDocument();

    // With accounts off, the section renders nothing even at its URL.
    cleanup();
    mocks.accountsEnabled = false;
    renderPage("/settings/account");
    expect(screen.queryByText("alice@example.com")).toBeNull();
  });

  it("updates and clears the cloud account nickname", async () => {
    mocks.cloudAccounts = true;
    renderPage("/settings/account");

    fireEvent.click(await screen.findByRole("button", { name: "编辑昵称" }));
    let input = screen.getByLabelText("昵称");
    fireEvent.change(input, { target: { value: "  研究员小王  " } });
    fireEvent.click(screen.getByRole("button", { name: "保存昵称" }));
    await waitFor(() => expect(mocks.updateProfile).toHaveBeenCalledWith("研究员小王"));
    expect(await screen.findByText("昵称已保存")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "编辑昵称" }));
    input = screen.getByLabelText("昵称");
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "保存昵称" }));
    await waitFor(() => expect(mocks.updateProfile).toHaveBeenLastCalledWith(null));
  });

  it("changes a cloud account password with a six-digit email code", async () => {
    mocks.cloudAccounts = true;
    renderPage("/settings/account");

    fireEvent.click(await screen.findByRole("button", { name: "修改密码" }));
    expect(screen.getByDisplayValue("alice@example.com")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "发送验证码" }));
    await waitFor(() => expect(mocks.sendPasswordCode).toHaveBeenCalledTimes(1));

    fireEvent.change(screen.getByPlaceholderText("6 位邮箱验证码"), {
      target: { value: "12a3456" },
    });
    fireEvent.change(screen.getByPlaceholderText("新密码"), {
      target: { value: "new-password" },
    });
    fireEvent.change(screen.getByPlaceholderText("确认新密码"), {
      target: { value: "new-password" },
    });
    fireEvent.click(screen.getByRole("button", { name: "修改密码" }));

    await waitFor(() =>
      expect(mocks.changePassword).toHaveBeenCalledWith({
        code: "123456",
        new_password: "new-password",
      }),
    );
  });

  it("labels BYOK as custom and marks the active model source", () => {
    mocks.cloudAccounts = true;
    renderPage("/settings/llm");

    const platformSource = screen.getByRole("radio", { name: /平台模型.*启用/ });
    expect(platformSource).toHaveAttribute("aria-checked", "true");
    expect(within(platformSource).getByText("启用")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "自定义" })).toBeInTheDocument();
    expect(screen.queryByText("自有 API")).toBeNull();
  });

  it("shows only settled platform charges with model and token details", async () => {
    mocks.cloudAccounts = true;
    mocks.me = {
      id: "alice",
      is_admin: false,
      email: "alice@example.com",
      nick_name: null,
      balance_cny: "19.895453",
    };
    mocks.platformUsage = {
      items: [],
      summary: {
        request_count: 1,
        prompt_tokens: 32_263,
        completion_tokens: 102,
        total_tokens: 32_365,
        charged_amount_cny: "0.104547",
      },
      page: 1,
      page_size: 10,
    };
    mocks.balanceRecords = {
      items: [
        {
          id: "usage-1",
          record_type: "usage",
          amount_cny: "-0.104547",
          balance_after_cny: "19.895453",
          note: "dashscope/private-fund-default",
          model_display_name: "Qwen3 Max",
          prompt_tokens: 32_263,
          completion_tokens: 102,
          created_at: "2026-07-30T17:59:20Z",
        },
      ],
      page: 1,
      page_size: 10,
      total: 1,
      total_pages: 1,
      period: "all",
    };

    renderPage("/settings/platform-usage");

    expect(await screen.findByText("Qwen3 Max 模型调用")).toBeInTheDocument();
    expect(screen.getByText("32,263 输入 Token · 102 输出 Token")).toBeInTheDocument();
    expect(screen.getByText("-¥0.10")).toBeInTheDocument();
    expect(screen.queryByText("gateway:succeeded")).toBeNull();
    expect(screen.getByText("32,365")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "近一周" }));
    await waitFor(() => expect(mocks.balanceRequest).toHaveBeenLastCalledWith(1, "week"));
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

  it("shows live platform model pricing and balance in cloud account mode", async () => {
    mocks.cloudAccounts = true;
    renderPage("/settings/llm");

    expect(await screen.findByText("Qwen3 Max")).toBeInTheDocument();
    expect(screen.getByText("¥12.50")).toBeInTheDocument();
    expect(screen.getByText(/¥3.20 \/ 百万/)).toBeInTheDocument();
    expect(screen.getByText(/¥12.80 \/ 百万/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "查看平台用量" })).toHaveAttribute(
      "href",
      "/settings/platform-usage",
    );
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
        true,
      ),
    );

    fireEvent.click(screen.getByRole("button", { name: "保存配置" }));
    await waitFor(() =>
      expect(mocks.saveLlm).toHaveBeenCalledWith(
        expect.objectContaining({ model: "qwen3-max", apiKey: "" }),
        true,
      ),
    );
    expect(mocks.refreshLlm).toHaveBeenCalled();
  });
});
