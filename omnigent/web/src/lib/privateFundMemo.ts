export interface TrustedMemoSource {
  id: string;
  conversationId: string;
  responseId: string;
  datasetId: string;
  title: string;
  content: string;
  createdAt: string;
}

export interface LocalMemoDraft {
  id: string;
  datasetId: string;
  title: string;
  sourceCount: number;
  status: "draft";
  createdAt: string;
}

export const TRUSTED_MEMO_SOURCES_UPDATED_EVENT = "omnigent:privateFundTrustedMemoSourcesUpdated";
export const LOCAL_MEMOS_UPDATED_EVENT = "omnigent:privateFundLocalMemosUpdated";

export function trustedMemoSourcesKey(conversationId: string): string {
  return `omnigent.privateFund.trustedMemoSources:${conversationId}`;
}

export function localMemosKey(conversationId: string): string {
  return `omnigent.privateFund.localMemos:${conversationId}`;
}

export function readTrustedMemoSources(conversationId: string): TrustedMemoSource[] {
  if (typeof window === "undefined" || !conversationId) return [];
  try {
    const raw = window.localStorage.getItem(trustedMemoSourcesKey(conversationId));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isTrustedMemoSource);
  } catch {
    return [];
  }
}

export function writeTrustedMemoSources(
  conversationId: string,
  sources: TrustedMemoSource[],
): void {
  if (typeof window === "undefined" || !conversationId) return;
  try {
    window.localStorage.setItem(trustedMemoSourcesKey(conversationId), JSON.stringify(sources));
  } catch {
    // Local memo state is a front-end convenience only.
  }
}

export function notifyTrustedMemoSourcesUpdated(conversationId: string): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent(TRUSTED_MEMO_SOURCES_UPDATED_EVENT, { detail: { conversationId } }),
  );
}

export function readLocalMemos(conversationId: string): LocalMemoDraft[] {
  if (typeof window === "undefined" || !conversationId) return [];
  try {
    const raw = window.localStorage.getItem(localMemosKey(conversationId));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isLocalMemoDraft);
  } catch {
    return [];
  }
}

export function writeLocalMemos(conversationId: string, memos: LocalMemoDraft[]): void {
  if (typeof window === "undefined" || !conversationId) return;
  try {
    window.localStorage.setItem(localMemosKey(conversationId), JSON.stringify(memos));
  } catch {
    // Local memo state is a front-end convenience only.
  }
}

export function notifyLocalMemosUpdated(conversationId: string): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(LOCAL_MEMOS_UPDATED_EVENT, { detail: { conversationId } }));
}

function isTrustedMemoSource(item: unknown): item is TrustedMemoSource {
  if (!item || typeof item !== "object") return false;
  const value = item as Partial<TrustedMemoSource>;
  return (
    typeof value.id === "string" &&
    typeof value.conversationId === "string" &&
    typeof value.responseId === "string" &&
    typeof value.datasetId === "string" &&
    typeof value.title === "string" &&
    typeof value.content === "string" &&
    typeof value.createdAt === "string"
  );
}

function isLocalMemoDraft(item: unknown): item is LocalMemoDraft {
  if (!item || typeof item !== "object") return false;
  const value = item as Partial<LocalMemoDraft>;
  return (
    typeof value.id === "string" &&
    typeof value.datasetId === "string" &&
    typeof value.title === "string" &&
    typeof value.sourceCount === "number" &&
    value.status === "draft" &&
    typeof value.createdAt === "string"
  );
}
