import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getConfig: vi.fn(),
  getApplyStatus: vi.fn(),
}));

vi.mock("@/lib/CapabilitiesContext", () => ({
  useServerInfo: () => ({ llm_configuration_enabled: true }),
}));
vi.mock("@/lib/nativeBridge", () => ({
  supportsDesktopLlmConfiguration: () => false,
}));
vi.mock("@/lib/llmConfigApi", () => ({
  getLlmConfig: mocks.getConfig,
  getLlmApplyStatus: mocks.getApplyStatus,
  onLlmApplyStatusChanged: () => () => {},
}));

import { LlmConfigProvider, useLlmConfiguration } from "./LlmConfigContext";

function ConfigurationProbe() {
  const { requireConfiguration } = useLlmConfiguration();
  return <button onClick={() => requireConfiguration()}>Check model</button>;
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
  mocks.getConfig.mockReset();
  mocks.getApplyStatus.mockReset();
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
    expect(screen.queryByText("尚未配置模型服务")).toBeNull();
  });
});
