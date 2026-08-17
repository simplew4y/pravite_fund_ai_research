import type { z } from "zod";

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function toApiError(response: Response): Promise<ApiError> {
  let code = "http_error";
  let message = `HTTP ${String(response.status)}`;
  try {
    const body: unknown = await response.json();
    if (typeof body === "object" && body !== null) {
      const record = body as Record<string, unknown>;
      if (typeof record.error === "string") code = record.error;
      if (typeof record.message === "string") message = record.message;
    }
  } catch {
    // non-JSON error body — keep the generic message
  }
  return new ApiError(response.status, code, message);
}

export interface RequestOptions {
  method?: string;
  body?: unknown;
  form?: FormData;
  signal?: AbortSignal;
  headers?: Record<string, string>;
}

export async function request(path: string, options: RequestOptions = {}): Promise<Response> {
  const init: RequestInit = {
    method: options.method ?? "GET",
    credentials: "same-origin",
    headers: { ...options.headers },
  };
  if (options.signal) init.signal = options.signal;
  if (options.form) {
    init.body = options.form;
  } else if (options.body !== undefined) {
    init.body = JSON.stringify(options.body);
    init.headers = { "content-type": "application/json", ...options.headers };
  }
  const response = await fetch(path, init);
  if (!response.ok) throw await toApiError(response);
  return response;
}

export async function requestJson<Schema extends z.ZodType>(
  path: string,
  schema: Schema,
  options: RequestOptions = {},
): Promise<z.output<Schema>> {
  const response = await request(path, options);
  if (response.status === 204) return schema.parse(undefined);
  return schema.parse(await response.json());
}

export function query(params: Record<string, string | number | boolean | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : "";
}
