import { hostFetch } from "@/lib/host";

export interface MarketplaceSkill {
  id: string;
  name: string;
  author: string;
  description: string;
  githubUrl: string;
  skillUrl: string;
  stars: number;
  updatedAt: number;
  installed: boolean;
}

export interface MarketplaceSearchResponse {
  skills: MarketplaceSkill[];
  page: number;
  limit: number;
  hasNext: boolean;
  total: number;
  source: "skillsmp" | "curated-fallback" | string;
  warning?: string | null;
  query: string;
  effectiveQuery: string;
}

export interface InstalledSkill {
  installId: string;
  name: string;
  description: string;
  marketplaceId?: string | null;
  author?: string | null;
  githubUrl?: string | null;
  skillUrl?: string | null;
  installedAt?: string | null;
  contentHash?: string | null;
  managed: boolean;
}

interface InstalledSkillsResponse {
  skills: InstalledSkill[];
  count: number;
  scope: string;
}

function apiError(payload: unknown, fallback: string): Error {
  if (payload && typeof payload === "object") {
    const record = payload as Record<string, unknown>;
    const detail = record.detail;
    if (typeof detail === "string") return new Error(detail);
    if (detail && typeof detail === "object") {
      const message = (detail as Record<string, unknown>).message;
      if (typeof message === "string") return new Error(message);
    }
    const error = record.error;
    if (error && typeof error === "object") {
      const message = (error as Record<string, unknown>).message;
      if (typeof message === "string") return new Error(message);
    }
  }
  return new Error(fallback);
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await hostFetch(path, init);
  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    // A gateway can return an empty/non-JSON error body. Preserve a useful
    // local fallback instead of surfacing JSON.parse noise to the user.
  }
  if (!response.ok) throw apiError(payload, `请求失败（${response.status}）`);
  return payload as T;
}

export function searchMarketplaceSkills(
  query: string,
  page = 1,
  limit = 12,
): Promise<MarketplaceSearchResponse> {
  const params = new URLSearchParams({ q: query, page: String(page), limit: String(limit) });
  return requestJson<MarketplaceSearchResponse>(`/v1/skills/marketplace?${params.toString()}`);
}

export async function getInstalledSkills(): Promise<InstalledSkill[]> {
  const response = await requestJson<InstalledSkillsResponse>("/v1/skills/installed");
  return response.skills;
}

export async function installMarketplaceSkill(marketplaceId: string): Promise<InstalledSkill> {
  const response = await requestJson<{ skill: InstalledSkill }>("/v1/skills/install", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ marketplaceId }),
  });
  return response.skill;
}

export function uninstallSkill(installId: string): Promise<{ status: string }> {
  return requestJson<{ status: string }>(`/v1/skills/installed/${encodeURIComponent(installId)}`, {
    method: "DELETE",
  });
}
