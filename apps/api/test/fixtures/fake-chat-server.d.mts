export interface FakeChatServer {
  readonly url: string;
  close(): Promise<void>;
}

export function startFakeChatServer(): Promise<FakeChatServer>;
