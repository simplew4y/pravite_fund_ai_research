import { hostFetch } from "@/lib/host";
import {
  getLlmApplyStatus as getNativeLlmApplyStatus,
  getLlmConfig as getNativeLlmConfig,
  onLlmApplyStatusChanged as onNativeLlmApplyStatusChanged,
  saveLlmConfig as saveNativeLlmConfig,
  supportsDesktopLlmConfiguration,
  testLlmConfig as testNativeLlmConfig,
  type LlmApplyStatus,
  type LlmConnectionTestResult,
  type LlmProviderConfig,
  type LlmProviderInput,
  type LlmSaveResult,
} from "@/lib/nativeBridge";

export type {
  LlmApplyStatus,
  LlmConnectionTestResult,
  LlmProviderConfig,
  LlmProviderInput,
  LlmProviderPreset,
  LlmSaveResult,
} from "@/lib/nativeBridge";

async function requestJson<T>(path: string, init?: RequestInit): Promise<T | null> {
  try {
    const response = await hostFetch(path, init);
    if (!response.ok) return null;
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

export function shouldUseNativeLlmConfiguration(preferServer = false): boolean {
  return supportsDesktopLlmConfiguration() && !preferServer;
}

export async function getLlmConfig(
  preferServer = false,
): Promise<LlmProviderConfig | null> {
  if (shouldUseNativeLlmConfiguration(preferServer)) return getNativeLlmConfig();
  return requestJson<LlmProviderConfig>("/v1/private-fund/llm-config");
}

export async function testLlmConfig(
  config: LlmProviderInput,
  preferServer = false,
): Promise<LlmConnectionTestResult> {
  if (shouldUseNativeLlmConfiguration(preferServer)) return testNativeLlmConfig(config);
  return (
    (await requestJson<LlmConnectionTestResult>("/v1/private-fund/llm-config/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(config),
    })) ?? { ok: false, error: "runtime", detail: "模型配置接口不可用。" }
  );
}

export async function saveLlmConfig(
  config: LlmProviderInput,
  preferServer = false,
): Promise<LlmSaveResult> {
  if (shouldUseNativeLlmConfiguration(preferServer)) return saveNativeLlmConfig(config);
  return (
    (await requestJson<LlmSaveResult>("/v1/private-fund/llm-config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(config),
    })) ?? { ok: false, error: "runtime", detail: "模型配置接口不可用。" }
  );
}

export async function getLlmApplyStatus(preferServer = false): Promise<LlmApplyStatus> {
  if (shouldUseNativeLlmConfiguration(preferServer)) return getNativeLlmApplyStatus();
  return (
    (await requestJson<LlmApplyStatus>("/v1/private-fund/llm-config/status")) ?? {
      busy: false,
      applying: false,
    }
  );
}

export function onLlmApplyStatusChanged(
  callback: (status: LlmApplyStatus) => void,
  preferServer = false,
): () => void {
  if (!shouldUseNativeLlmConfiguration(preferServer)) return () => {};
  return onNativeLlmApplyStatusChanged(callback);
}
