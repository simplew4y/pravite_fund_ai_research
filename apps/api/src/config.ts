import path from "node:path";

import { z } from "zod";

const environmentSchema = z.object({
  PRIVATE_FUND_API_HOST: z.string().default("127.0.0.1"),
  PRIVATE_FUND_API_PORT: z.coerce.number().int().min(1).max(65_535).default(6768),
  PRIVATE_FUND_DATA_ROOT: z.string().default("output/ts-platform"),
  PRIVATE_FUND_CONTROL_DB: z.string().optional(),
  PRIVATE_FUND_AUTH_MODE: z.enum(["cloud", "development"]).default("cloud"),
  PRIVATE_FUND_DEV_USER_ID: z.string().default("local"),
  PRIVATE_FUND_DEV_DATA_NAMESPACE: z
    .uuid()
    .default("00000000-0000-4000-8000-000000000001"),
  OMNIGENT_CLOUD_BACKEND_URL: z
    .url()
    .refine((value) => new URL(value).protocol === "https:", {
      message: "OMNIGENT_CLOUD_BACKEND_URL must use https",
    })
    .optional(),
  OMNIGENT_CLOUD_REQUEST_TIMEOUT_SECONDS: z.coerce.number().positive().max(120).default(10),
  OMNIGENT_CLOUD_REGISTRATION_ENABLED: z
    .enum(["0", "1", "false", "true", "no", "yes"])
    .default("1"),
  OMNIGENT_ACCOUNTS_COOKIE_SECRET: z.string().min(32).optional(),
  PRIVATE_FUND_MODEL_GATEWAY_BASE_URL: z
    .url()
    .refine((value) => {
      const url = new URL(value);
      return (
        url.protocol === "https:" &&
        url.username === "" &&
        url.password === "" &&
        url.search === "" &&
        url.hash === ""
      );
    }, "PRIVATE_FUND_MODEL_GATEWAY_BASE_URL must be a credential-free HTTPS URL")
    .optional(),
  PRIVATE_FUND_MODEL_GATEWAY_PROVIDER_ID: z
    .string()
    .regex(/^[a-z0-9][a-z0-9_-]{0,63}$/)
    .default("private_fund_gateway"),
  PRIVATE_FUND_MODEL_GATEWAY_MODEL_ID: z.string().trim().min(1).max(200).optional(),
  PRIVATE_FUND_MODEL_GATEWAY_CONTEXT_WINDOW: z.coerce
    .number()
    .int()
    .min(1_024)
    .max(10_000_000)
    .default(32_768),
  PRIVATE_FUND_MODEL_GATEWAY_MAX_TOKENS: z.coerce
    .number()
    .int()
    .positive()
    .max(1_000_000)
    .default(8_192),
  PRIVATE_FUND_AGENT_WORKER_ENTRY: z.string().optional(),
  PRIVATE_FUND_PYTHON_EXECUTABLE: z.string().min(1).optional(),
  PRIVATE_FUND_COMPUTE_WORKER_ENTRY: z.string().optional(),
  PRIVATE_FUND_SOURCE_PREVIEW_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .max(120_000)
    .default(30_000),
  PRIVATE_FUND_WEB_ROOT: z.string().min(1).optional(),
  PRIVATE_FUND_SESSION_JOURNAL_SHADOW: z.string().default("1"),
  PRIVATE_FUND_COOKIE_SECURE: z.string().optional(),
  PRIVATE_FUND_MODEL_COMMIT_BEFORE_SEND: z.string().default("1"),
  PRIVATE_FUND_AGENT_BASE_URL: z.string().url().optional(),
  PRIVATE_FUND_AGENT_API_KEY: z.string().min(8).optional(),
  PRIVATE_FUND_AGENT_MODEL: z.string().trim().min(1).max(200).optional(),
  DASHSCOPE_API_KEY: z.string().min(8).optional(),
  OPENAI_API_KEY: z.string().min(8).optional(),
  OPENAI_BASE_URL: z.string().url().optional(),
  PRIVATE_FUND_BLOB_MASTER_KEY: z.string().min(32).optional(),
  PRIVATE_FUND_BLOB_ROOT: z.string().min(1).optional(),
});

export interface ApiConfig {
  host: string;
  port: number;
  dataRoot: string;
  controlDatabase: string;
  auth:
    | {
        mode: "development";
        userId: string;
        dataNamespace: string;
      }
    | {
        mode: "cloud";
        backendUrl: string;
        timeoutMilliseconds: number;
        cookieSecret: string;
        registrationEnabled: boolean;
      };
  modelGateway?: {
    baseUrl: string;
    providerId: string;
    modelId?: string;
    contextWindow: number;
    maxTokens: number;
  };
  agentWorkerEntry: string;
  sourcePreviewCompute?: {
    pythonExecutable: string;
    workerEntry: string;
    timeoutMilliseconds: number;
  };
  webRoot?: string;
  sessionJournalShadow?: boolean;
  /** Session-cookie Secure attribute. Defaults to true in cloud auth mode. */
  cookieSecure?: boolean;
  /** Route model calls through the commit-before-send gateway (default on). */
  modelCommitBeforeSend?: boolean;
  /** Development-mode chat endpoint for the in-process agent loop. */
  agentModel?: {
    baseUrl: string;
    apiKey: string;
    model: string;
  };
  blobStore?: {
    rootDirectory: string;
    masterKey: string;
  };
}

function truthy(value: string): boolean {
  return ["1", "true", "yes"].includes(value.toLowerCase());
}

export function loadApiConfig(
  environment: NodeJS.ProcessEnv = process.env,
  workingDirectory = process.cwd(),
): ApiConfig {
  const parsed = environmentSchema.parse(environment);
  const dataRoot = path.resolve(workingDirectory, parsed.PRIVATE_FUND_DATA_ROOT);
  const auth: ApiConfig["auth"] =
    parsed.PRIVATE_FUND_AUTH_MODE === "development"
      ? {
          mode: "development",
          userId: parsed.PRIVATE_FUND_DEV_USER_ID,
          dataNamespace: parsed.PRIVATE_FUND_DEV_DATA_NAMESPACE,
        }
      : {
          mode: "cloud",
          backendUrl:
            parsed.OMNIGENT_CLOUD_BACKEND_URL ??
            (() => {
              throw new Error(
                "OMNIGENT_CLOUD_BACKEND_URL is required in cloud auth mode",
              );
            })(),
          timeoutMilliseconds:
            parsed.OMNIGENT_CLOUD_REQUEST_TIMEOUT_SECONDS * 1_000,
          cookieSecret:
            parsed.OMNIGENT_ACCOUNTS_COOKIE_SECRET ??
            (() => {
              throw new Error(
                "OMNIGENT_ACCOUNTS_COOKIE_SECRET is required in cloud auth mode",
              );
            })(),
          registrationEnabled: truthy(
            parsed.OMNIGENT_CLOUD_REGISTRATION_ENABLED,
          ),
        };

  return {
    host: parsed.PRIVATE_FUND_API_HOST,
    port: parsed.PRIVATE_FUND_API_PORT,
    dataRoot,
    controlDatabase: path.resolve(
      workingDirectory,
      parsed.PRIVATE_FUND_CONTROL_DB ?? path.join(dataRoot, "control.sqlite3"),
    ),
    auth,
    ...(parsed.PRIVATE_FUND_MODEL_GATEWAY_BASE_URL === undefined
      ? {}
      : {
          modelGateway: {
            baseUrl: parsed.PRIVATE_FUND_MODEL_GATEWAY_BASE_URL.replace(
              /\/+$/,
              "",
            ),
            providerId: parsed.PRIVATE_FUND_MODEL_GATEWAY_PROVIDER_ID,
            ...(parsed.PRIVATE_FUND_MODEL_GATEWAY_MODEL_ID === undefined
              ? {}
              : { modelId: parsed.PRIVATE_FUND_MODEL_GATEWAY_MODEL_ID }),
            contextWindow: parsed.PRIVATE_FUND_MODEL_GATEWAY_CONTEXT_WINDOW,
            maxTokens: parsed.PRIVATE_FUND_MODEL_GATEWAY_MAX_TOKENS,
          },
        }),
    agentWorkerEntry: path.resolve(
      workingDirectory,
      parsed.PRIVATE_FUND_AGENT_WORKER_ENTRY ??
        "apps/agent-worker/dist/main.js",
    ),
    sourcePreviewCompute: {
      pythonExecutable:
        parsed.PRIVATE_FUND_PYTHON_EXECUTABLE ?? "python3",
      workerEntry: path.resolve(
        workingDirectory,
        parsed.PRIVATE_FUND_COMPUTE_WORKER_ENTRY ??
          "python/compute-worker/worker.py",
      ),
      timeoutMilliseconds:
        parsed.PRIVATE_FUND_SOURCE_PREVIEW_TIMEOUT_MS,
    },
    ...(parsed.PRIVATE_FUND_WEB_ROOT === undefined
      ? {}
      : {
          webRoot: path.resolve(
            workingDirectory,
            parsed.PRIVATE_FUND_WEB_ROOT,
          ),
        }),
    sessionJournalShadow: truthy(parsed.PRIVATE_FUND_SESSION_JOURNAL_SHADOW),
    cookieSecure:
      parsed.PRIVATE_FUND_COOKIE_SECURE === undefined
        ? parsed.PRIVATE_FUND_AUTH_MODE === "cloud"
        : truthy(parsed.PRIVATE_FUND_COOKIE_SECURE),
    modelCommitBeforeSend: truthy(parsed.PRIVATE_FUND_MODEL_COMMIT_BEFORE_SEND),
    ...(() => {
      const apiKey =
        parsed.PRIVATE_FUND_AGENT_API_KEY ??
        parsed.DASHSCOPE_API_KEY ??
        parsed.OPENAI_API_KEY;
      if (apiKey === undefined) return {};
      const baseUrl =
        parsed.PRIVATE_FUND_AGENT_BASE_URL ??
        (parsed.PRIVATE_FUND_AGENT_API_KEY === undefined &&
        parsed.DASHSCOPE_API_KEY !== undefined
          ? "https://dashscope.aliyuncs.com/compatible-mode/v1"
          : parsed.OPENAI_BASE_URL);
      if (baseUrl === undefined) return {};
      return {
        agentModel: {
          baseUrl: baseUrl.replace(/\/+$/, ""),
          apiKey,
          model: parsed.PRIVATE_FUND_AGENT_MODEL ?? "qwen-plus",
        },
      };
    })(),
    ...(parsed.PRIVATE_FUND_BLOB_MASTER_KEY === undefined
      ? {}
      : {
          blobStore: {
            rootDirectory: path.resolve(
              workingDirectory,
              parsed.PRIVATE_FUND_BLOB_ROOT ?? path.join(dataRoot, "blobs"),
            ),
            masterKey: parsed.PRIVATE_FUND_BLOB_MASTER_KEY,
          },
        }),
  };
}
