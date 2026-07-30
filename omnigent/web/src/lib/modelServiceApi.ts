import { hostFetch } from "@/lib/host";
import type { LlmProviderConfig } from "@/lib/llmConfigApi";

export type ModelServiceSource = "platform" | "byok";

export interface PlatformModelInfo {
  id: string;
  displayName: string;
  provider: string;
  inputPriceCnyPerMillion: string;
  outputPriceCnyPerMillion: string;
  defaultMaxTokens: number;
  maxOutputTokens: number;
}

export interface ModelServiceState {
  userId: string;
  source: ModelServiceSource;
  ready: boolean;
  reason?: string | null;
  detail?: string | null;
  activeLabel: string;
  platform: {
    available: boolean;
    balanceCny: string;
    defaultModel: string;
    models: PlatformModelInfo[];
    tokenExpiresAt?: number | null;
  };
  byok: LlmProviderConfig;
}

export interface ModelServicePrepareResult {
  ready: boolean;
  reason?: string | null;
  detail?: string | null;
  state: ModelServiceState | null;
}

async function requestState(path: string, init?: RequestInit): Promise<ModelServiceState> {
  const response = await hostFetch(path, {
    ...init,
    headers: {
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
    cache: "no-store",
  });
  const payload = (await response.json().catch(() => null)) as
    | ModelServiceState
    | { detail?: string; message?: string; error?: string }
    | null;
  if (!response.ok) {
    const detail = payload && "detail" in payload ? payload.detail : undefined;
    const message = payload && "message" in payload ? payload.message : undefined;
    const error = payload && "error" in payload ? payload.error : undefined;
    throw new Error(detail || message || error || "模型服务状态不可用。");
  }
  return payload as ModelServiceState;
}

export function getModelServiceState(): Promise<ModelServiceState> {
  return requestState("/v1/private-fund/model-service");
}

export function setModelServiceSource(source: ModelServiceSource): Promise<ModelServiceState> {
  return requestState("/v1/private-fund/model-service/source", {
    method: "PUT",
    body: JSON.stringify({ source }),
  });
}

export async function prepareModelService(): Promise<ModelServicePrepareResult> {
  try {
    const state = await requestState("/v1/private-fund/model-service/prepare", {
      method: "POST",
    });
    return {
      ready: state.ready,
      reason: state.reason,
      detail: state.detail,
      state,
    };
  } catch (error) {
    return {
      ready: false,
      reason: "platform_unavailable",
      detail: error instanceof Error ? error.message : "模型服务状态不可用。",
      state: null,
    };
  }
}
