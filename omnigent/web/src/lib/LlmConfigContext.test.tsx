import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  serverInfo: { llm_configuration_enabled: true, cloud_accounts_enabled: false },
  getConfig: vi.fn(),
  getApplyStatus: vi.fn(),
  getModelServiceState: vi.fn(),
  prepareModelService: vi.fn(),
}));

vi.mock("@/lib/CapabilitiesContext", () => ({
  useServerInfo: () => mocks.serverInfo,
}));
vi.mock("@/lib/nativeBridge", () => ({
  supportsDesktopLlmConfiguration: () => false,
}));
vi.mock("@/lib/llmConfigApi", () => ({
  getLlmConfig: mocks.getConfig,
  getLlmApplyStatus: mocks.getApplyStatus,
  onLlmApplyStatusChanged: () => () => {},
}));
vi.mock("@/lib/modelServiceApi", () => ({
  getModelServiceState: mocks.getModelServiceState,
  prepareModelService: mocks.prepareModelService,
  setModelServiceSource: vi.fn(),
}));

import { LlmConfigProvider, useLlmConfiguration } from "./LlmConfigContext";

function ConfigurationProbe() {
  const { requireConfiguration } = useLlmConfiguration();
  return <button onClick={() => void requireConfiguration()}>Check model</button>;
}

function renderProvider(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <LlmConfigProvider>
        <ConfigurationProbe />
      </LlmConfigProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  mocks.getConfig.mockReset();
  mocks.getApplyStatus.mockReset();
  mocks.getModelServiceState.mockReset();
  mocks.prepareModelService.mockReset();
  mocks.serverInfo.llm_configuration_enabled = true;
  mocks.serverInfo.cloud_accounts_enabled = false;
  mocks.getConfig.mockResolvedValue({
    preset: "custom",
    provider: "custom_openai",
    baseUrl: "",
    model: "",
    hasApiKey: false,
    maskedApiKey: "",
    configured: false,
  });
  mocks.getApplyStatus.mockResolvedValue({ busy: false, applying: false });
  mocks.prepareModelService.mockResolvedValue({ ready: false, state: null });
});

afterEach(cleanup);

describe("LlmConfigProvider configuration prompt", () => {
  it("does not reopen after Later during the same login session", async () => {
    renderProvider("/");
    expect(await screen.findByText("尚未配置模型服务")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "稍后" }));
    await waitFor(() => expect(screen.queryByText("尚未配置模型服务")).toBeNull());

    cleanup();
    renderProvider("/another-page");
    await waitFor(() => expect(mocks.getConfig).toHaveBeenCalledTimes(2));
    expect(screen.queryByText("尚未配置模型服务")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Check model" }));
    expect(await screen.findByText("尚未配置模型服务")).toBeInTheDocument();
  });

  it("does not reopen the insufficient balance prompt after viewing the account", async () => {
    mocks.serverInfo.cloud_accounts_enabled = true;
    mocks.getModelServiceState.mockResolvedValue({
      userId: "user-1",
      source: "platform",
      ready: false,
      reason: "insufficient_balance",
      detail: "平台账户余额不足。",
      activeLabel: "平台模型",
      byok: null,
      platform: null,
    });

    renderProvider("/");
    expect(await screen.findByText("平台余额不足")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "查看账户" }));
    await waitFor(() => expect(screen.queryByText("平台余额不足")).toBeNull());

    const callsBeforeRemount = mocks.getModelServiceState.mock.calls.length;
    cleanup();
    renderProvider("/another-page");
    await waitFor(() =>
      expect(mocks.getModelServiceState.mock.calls.length).toBeGreaterThan(callsBeforeRemount),
    );
    expect(screen.queryByText("平台余额不足")).toBeNull();
  });
});
