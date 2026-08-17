import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  CloudAccountClient,
  CloudAuthService,
  SessionCipher,
  type CloudUser,
  type ShadowAccountStore,
} from "@private-fund/auth";
import {
  createControlRepositories,
  openControlDatabase,
  type ControlDatabase,
  type ControlRepositories,
} from "@private-fund/db";

import type {
  AgentEvent,
  AgentWorkerPort,
  StartAgentSessionInput,
} from "./agent-supervisor.js";
import { createApiApp } from "./app.js";
import type { ApiConfig } from "./config.js";
import { CloudIdentityProvider } from "./identity.js";
import { CloudModelGatewayAccessIssuer } from "./model-gateway-access.js";
import {
  RepositoryProjectService,
  RepositorySessionService,
} from "./repository-services.js";

const NOW = new Date("2026-07-31T08:00:00.000Z");
const COOKIE_NAME = "pf_cloud_session";

const USER_A = {
  id: "c7fd31fd-c47a-41d9-8f52-075c9f717edf",
  email: "researcher-a@example.com",
  nick_name: "Researcher A",
  status: "active",
  is_admin: true,
  data_namespace: "450c7d39-96e0-4277-b6bf-c50a9c132b4d",
  balance_cny: "12.500000",
  last_login_at: null,
  created_at: "2026-07-29T00:00:00+00:00",
} as const;

const USER_B = {
  id: "f3346a46-f511-435b-9256-adb05c768234",
  email: "researcher-b@example.com",
  nick_name: "Researcher B",
  status: "active",
  is_admin: false,
  data_namespace: "66434e62-af47-4db1-a7b8-a1c758a623c1",
  balance_cny: "3.000000",
  last_login_at: null,
  created_at: "2026-07-30T00:00:00+00:00",
} as const;

interface UpstreamCall {
  readonly method: string;
  readonly url: URL;
  readonly headers: Headers;
  readonly body: unknown;
  readonly redirect: RequestRedirect | undefined;
}

interface CloudHarness {
  readonly app: Awaited<ReturnType<typeof createApiApp>>;
  readonly calls: UpstreamCall[];
  readonly database: ControlDatabase;
  readonly repositories: ControlRepositories;
  readonly worker: FakeAgentWorker;
  close(): Promise<void>;
}

class FakeAgentWorker implements AgentWorkerPort {
  readonly #listeners = new Set<(event: AgentEvent) => void>();
  readonly starts: StartAgentSessionInput[] = [];

  public async start(input: StartAgentSessionInput): Promise<void> {
    this.starts.push(input);
  }

  public async prompt(
    _sessionId: string,
    _operationId: string,
    _content: string,
  ): Promise<void> {}

  public async steer(_sessionId: string, _content: string): Promise<void> {}

  public async compact(
    _sessionId: string,
    _customInstructions?: string,
  ): Promise<void> {}

  public async interrupt(_sessionId: string): Promise<void> {}

  public async dispose(_sessionId: string): Promise<void> {}

  public subscribe(listener: (event: AgentEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  public async stop(): Promise<void> {}
}

function jsonResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function tokenPayload(
  user: typeof USER_A | typeof USER_B,
  suffix: string,
): Record<string, unknown> {
  return {
    access_token: `access-${suffix}`,
    refresh_token: `refresh-${suffix}`,
    token_type: "bearer",
    expires_in: 900,
    user,
  };
}

function publicUser(user: typeof USER_A | typeof USER_B): CloudUser {
  return {
    id: user.id,
    email: user.email,
    nick_name: user.nick_name,
    status: "active",
    is_admin: false,
    is_platform_admin: user.is_admin,
    data_namespace: user.data_namespace,
    balance_cny: user.balance_cny,
    last_login_at: user.last_login_at,
    created_at: user.created_at,
  };
}

function responseSetCookies(
  response: Awaited<ReturnType<CloudHarness["app"]["inject"]>>,
): string[] {
  const value = response.headers["set-cookie"];
  if (value === undefined) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function sessionCookie(
  response: Awaited<ReturnType<CloudHarness["app"]["inject"]>>,
): string {
  for (const header of responseSetCookies(response)) {
    const match = new RegExp(`(?:^|;\\s*)${COOKIE_NAME}=([^;]+)`).exec(header);
    if (match?.[1]) {
      return `${COOKIE_NAME}=${match[1]}`;
    }
  }
  throw new Error("Response did not set a cloud session cookie");
}

async function createHarness(
  upstream: (call: UpstreamCall) => Promise<Response> | Response,
  options: { modelGateway?: boolean } = {},
): Promise<CloudHarness> {
  const dataRoot = await mkdtemp(
    path.join(tmpdir(), "private-fund-cloud-auth-"),
  );
  const database = openControlDatabase(path.join(dataRoot, "control.sqlite3"));
  const repositories = createControlRepositories(database, () => NOW);
  const calls: UpstreamCall[] = [];
  const fetchImplementation = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const rawBody =
      typeof init?.body === "string" && init.body.length > 0
        ? (JSON.parse(init.body) as unknown)
        : null;
    const call: UpstreamCall = {
      method: init?.method ?? "GET",
      url: new URL(String(input)),
      headers: new Headers(init?.headers),
      body: rawBody,
      redirect: init?.redirect,
    };
    calls.push(call);
    return upstream(call);
  }) as typeof fetch;
  const shadowStore: ShadowAccountStore = {
    async upsertCloudUser(user): Promise<void> {
      repositories.users.upsertCloudShadow({
        userId: user.id,
        dataNamespace: user.data_namespace,
        email: user.email,
      });
    },
  };
  const client = new CloudAccountClient({
    baseUrl: "https://cloud.example.test/private_fund/backend",
    timeoutMilliseconds: 1_000,
    fetchImplementation,
  });
  const service = new CloudAuthService({
    client,
    shadowStore,
    clock: () => NOW,
  });
  const cipher = new SessionCipher("cloud-cookie-secret-".repeat(4));
  const worker = new FakeAgentWorker();
  const sessions = new RepositorySessionService({
    repositories,
    worker,
  });
  const config: ApiConfig = {
    host: "127.0.0.1",
    port: 6768,
    dataRoot,
    controlDatabase: path.join(dataRoot, "control.sqlite3"),
    auth: {
      mode: "cloud",
      backendUrl: "https://cloud.example.test/private_fund/backend",
      timeoutMilliseconds: 1_000,
      cookieSecret: "cloud-cookie-secret-".repeat(4),
      registrationEnabled: true,
    },
    agentWorkerEntry: path.join(dataRoot, "unused-agent-worker.mjs"),
    ...(options.modelGateway
      ? {
          modelGateway: {
            baseUrl:
              "https://cloud.example.test/private_fund/backend/gateway/v1",
            providerId: "private_fund_gateway",
            modelId: "qwen3-max",
            contextWindow: 32_768,
            maxTokens: 8_192,
          },
        }
      : {}),
  };
  const modelGatewayAccessIssuer =
    config.modelGateway === undefined
      ? undefined
      : new CloudModelGatewayAccessIssuer({
          client,
          config: config.modelGateway,
          now: () => NOW.getTime(),
          leaseIdFactory: () => "model_lease_test",
        });
  const app = await createApiApp(config, {
    identityProvider: new CloudIdentityProvider(cipher, service),
    projects: new RepositoryProjectService(repositories),
    sessions,
    cloudAccounts: { client, service, cipher },
    ...(modelGatewayAccessIssuer === undefined
      ? {}
      : { modelGatewayAccessIssuer }),
  });

  let closed = false;
  return {
    app,
    calls,
    database,
    repositories,
    worker,
    async close(): Promise<void> {
      if (closed) {
        return;
      }
      closed = true;
      await app.close();
      sessions.dispose();
      database.close();
      await rm(dataRoot, { recursive: true, force: true });
    },
  };
}

describe("TypeScript cloud-account BFF acceptance", () => {
  let harness: CloudHarness | undefined;

  afterEach(async () => {
    await harness?.close();
    harness = undefined;
  });

  it("keeps the cloud model token server-side and binds it to the Pi session", async () => {
    const modelToken = `pfm_${"a".repeat(48)}`;
    harness = await createHarness((call) => {
      if (call.url.pathname.endsWith("/api/v1/auth/login")) {
        return jsonResponse(200, tokenPayload(USER_A, "model-user"));
      }
      if (call.url.pathname.endsWith("/api/v1/model-access-token")) {
        return jsonResponse(200, {
          access_token: modelToken,
          expires_in: 604_800,
          gateway_base_url:
            "https://cloud.example.test/private_fund/backend/gateway/v1",
        });
      }
      if (call.url.pathname.endsWith("/api/v1/models")) {
        return jsonResponse(200, {
          object: "list",
          available: true,
          default_model: "qwen3-max",
          data: [
            {
              id: "qwen3-max",
              display_name: "Qwen3 Max",
              default_max_tokens: 8_192,
            },
          ],
        });
      }
      return jsonResponse(404, {
        code: "unexpected_upstream_route",
        message: call.url.pathname,
      });
    }, { modelGateway: true });

    const login = await harness.app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: USER_A.email, password: "password123" },
    });
    const cookie = sessionCookie(login);
    const project = await harness.app.inject({
      method: "POST",
      url: "/v1/projects",
      headers: { cookie },
      payload: { name: "Gateway project" },
    });
    const session = await harness.app.inject({
      method: "POST",
      url: "/v1/sessions",
      headers: { cookie },
      payload: {
        projectId: project.json().id,
        title: "Gateway session",
      },
    });
    const message = await harness.app.inject({
      method: "POST",
      url: `/v1/sessions/${String(session.json().id)}/messages`,
      headers: { cookie },
      payload: { content: "Analyze the evidence" },
    });

    expect(message.statusCode).toBe(202);
    expect(message.body).not.toContain(modelToken);
    expect(harness.worker.starts).toHaveLength(1);
    expect(harness.worker.starts[0]?.modelGatewayAccess).toMatchObject({
      accessToken: modelToken,
      providerId: "private_fund_gateway",
      binding: {
        userId: USER_A.id,
        dataNamespace: USER_A.data_namespace,
        projectId: project.json().id,
        sessionId: session.json().id,
      },
    });
    const modelCalls = harness.calls.filter((call) =>
      call.url.pathname.includes("/api/v1/model"),
    );
    expect(modelCalls).toHaveLength(2);
    for (const call of modelCalls) {
      expect(call.headers.get("authorization")).toBe(
        "Bearer access-model-user",
      );
      expect(call.headers.has("cookie")).toBe(false);
    }
  });

  it("owns login, current-user, logout cookies and tenant isolation", async () => {
    harness = await createHarness((call) => {
      if (
        call.method === "POST" &&
        call.url.pathname.endsWith("/api/v1/auth/login")
      ) {
        const body = call.body as { email: string };
        return jsonResponse(
          200,
          body.email === USER_B.email
            ? tokenPayload(USER_B, "b")
            : tokenPayload(USER_A, "a"),
        );
      }
      if (call.method === "GET" && call.url.pathname.endsWith("/api/v1/me")) {
        return jsonResponse(
          200,
          call.headers.get("authorization") === "Bearer access-b"
            ? USER_B
            : USER_A,
        );
      }
      if (
        call.method === "POST" &&
        call.url.pathname.endsWith("/api/v1/auth/logout")
      ) {
        return new Response(null, { status: 204 });
      }
      return jsonResponse(404, {
        code: "unexpected_upstream_route",
        message: call.url.pathname,
      });
    });

    const info = await harness.app.inject({
      method: "GET",
      url: "/v1/info",
    });
    expect(info.statusCode).toBe(200);
    expect(info.json()).toMatchObject({
      auth_mode: "cloud",
      accounts_enabled: true,
      cloud_accounts_enabled: true,
      login_url: "/login",
      needs_setup: false,
      registration_mode: "open",
      legacy_omnigent_required: false,
    });

    const loginA = await harness.app.inject({
      method: "POST",
      url: "/auth/login",
      payload: {
        email: " Researcher-A@Example.com ",
        password: "correct horse battery staple",
      },
    });
    expect(loginA.statusCode).toBe(200);
    expect(loginA.headers["cache-control"]).toBe("private, no-store");
    expect(loginA.json().user).toEqual(publicUser(USER_A));
    expect(loginA.body).not.toContain("access-a");
    expect(loginA.body).not.toContain("refresh-a");
    const loginACookies = responseSetCookies(loginA);
    expect(loginACookies).toHaveLength(1);
    expect(loginACookies[0]).toContain(`${COOKIE_NAME}=`);
    expect(loginACookies[0]).toContain("HttpOnly");
    expect(loginACookies[0]).toContain("Secure");
    expect(loginACookies[0]).toContain("SameSite=Lax");
    expect(loginACookies[0]).toContain("Path=/");
    const cookieA = sessionCookie(loginA);

    const loginCallA = harness.calls[0];
    expect(loginCallA?.url.href).toBe(
      "https://cloud.example.test/private_fund/backend/api/v1/auth/login",
    );
    expect(loginCallA?.body).toEqual({
      email: USER_A.email,
      password: "correct horse battery staple",
    });
    expect(loginCallA?.headers.get("accept")).toBe("application/json");
    expect(loginCallA?.headers.get("content-type")).toBe("application/json");
    expect(loginCallA?.headers.has("cookie")).toBe(false);
    expect(loginCallA?.redirect).toBe("manual");

    const meA = await harness.app.inject({
      method: "GET",
      url: "/auth/me",
      headers: { cookie: cookieA },
    });
    expect(meA.statusCode).toBe(200);
    expect(meA.headers["cache-control"]).toBe("private, no-store");
    expect(meA.json()).toEqual(publicUser(USER_A));

    const projectA = await harness.app.inject({
      method: "POST",
      url: "/v1/projects",
      headers: {
        cookie: cookieA,
        "x-forwarded-email": USER_B.email,
      },
      payload: { name: "Tenant A private research" },
    });
    expect(projectA.statusCode).toBe(201);

    const loginB = await harness.app.inject({
      method: "POST",
      url: "/auth/login",
      payload: {
        email: USER_B.email,
        password: "correct horse battery staple",
      },
    });
    expect(loginB.statusCode).toBe(200);
    const cookieB = sessionCookie(loginB);

    const projectsB = await harness.app.inject({
      method: "GET",
      url: "/v1/projects",
      headers: {
        cookie: cookieB,
        "x-forwarded-email": USER_A.email,
      },
    });
    expect(projectsB.statusCode).toBe(200);
    expect(projectsB.json()).toEqual({ projects: [] });

    const projectsA = await harness.app.inject({
      method: "GET",
      url: "/v1/projects",
      headers: { cookie: cookieA },
    });
    expect(projectsA.json().projects).toHaveLength(1);
    expect(projectsA.json().projects[0].name).toBe("Tenant A private research");

    const identityB = await harness.app.inject({
      method: "GET",
      url: "/v1/me",
      headers: { cookie: cookieB },
    });
    expect(identityB.json()).toEqual({
      user_id: USER_B.id,
      data_namespace: USER_B.data_namespace,
    });

    const logoutA = await harness.app.inject({
      method: "POST",
      url: "/auth/logout",
      headers: { cookie: cookieA },
    });
    expect(logoutA.statusCode).toBe(204);
    expect(logoutA.headers["cache-control"]).toBe("private, no-store");
    expect(responseSetCookies(logoutA).join("\n")).toContain("Max-Age=0");
    const logoutCall = harness.calls.find((call) =>
      call.url.pathname.endsWith("/api/v1/auth/logout"),
    );
    expect(logoutCall?.body).toEqual({ refresh_token: "refresh-a" });
    expect(logoutCall?.headers.has("authorization")).toBe(false);
  });

  it("preserves registration, account query, feedback and password-change contracts", async () => {
    harness = await createHarness((call) => {
      if (
        call.method === "POST" &&
        call.url.pathname.endsWith("/api/v1/auth/register/send-code")
      ) {
        return jsonResponse(202, {
          ok: true,
          expires_in: 600,
          resend_after: 60,
        });
      }
      if (
        call.method === "POST" &&
        call.url.pathname.endsWith("/api/v1/auth/register")
      ) {
        return jsonResponse(201, tokenPayload(USER_A, "registered"));
      }
      if (
        call.method === "GET" &&
        call.url.pathname.endsWith("/api/v1/me/usage")
      ) {
        return jsonResponse(200, {
          items: [],
          summary: {
            request_count: 0,
            prompt_tokens: 0,
            completion_tokens: 0,
            total_tokens: 0,
            charged_amount_cny: "0.000000",
          },
          page: 2,
          page_size: 5,
        });
      }
      if (
        call.method === "GET" &&
        call.url.pathname.endsWith("/api/v1/me/balance-records")
      ) {
        return jsonResponse(200, {
          items: [{ id: "balance-1", amount_cny: "-1.000000" }],
          page: 3,
          page_size: 7,
        });
      }
      if (
        call.method === "GET" &&
        call.url.pathname.endsWith("/api/v1/feedback")
      ) {
        return jsonResponse(200, {
          items: [{ id: "feedback-1", title: "Existing feedback" }],
          page: 4,
          page_size: 9,
        });
      }
      if (
        call.method === "POST" &&
        call.url.pathname.endsWith("/api/v1/feedback")
      ) {
        return jsonResponse(201, {
          id: "feedback-2",
          ...(call.body as Record<string, unknown>),
        });
      }
      if (
        call.method === "POST" &&
        call.url.pathname.endsWith("/api/v1/me/change-password")
      ) {
        return new Response(null, { status: 204 });
      }
      return jsonResponse(404, {
        code: "unexpected_upstream_route",
        message: call.url.pathname,
      });
    });

    const code = await harness.app.inject({
      method: "POST",
      url: "/auth/register/send-code",
      payload: { email: " Researcher-A@Example.com " },
    });
    expect(code.statusCode).toBe(202);
    expect(code.headers["cache-control"]).toBe("private, no-store");
    expect(code.json()).toEqual({
      ok: true,
      expires_in: 600,
      resend_after: 60,
    });

    const registered = await harness.app.inject({
      method: "POST",
      url: "/auth/register",
      payload: {
        email: " Researcher-A@Example.com ",
        code: "0123",
        password: "password123",
        nick_name: " Researcher A ",
      },
    });
    expect(registered.statusCode).toBe(201);
    expect(registered.headers["cache-control"]).toBe("private, no-store");
    expect(registered.json().user).toEqual(publicUser(USER_A));
    expect(registered.body).not.toContain("access-registered");
    expect(registered.body).not.toContain("refresh-registered");
    const cookie = sessionCookie(registered);

    const registrationCalls = harness.calls.slice(0, 2);
    expect(registrationCalls[0]?.body).toEqual({ email: USER_A.email });
    expect(registrationCalls[1]?.body).toEqual({
      email: USER_A.email,
      code: "0123",
      password: "password123",
      nick_name: "Researcher A",
    });

    const usage = await harness.app.inject({
      method: "GET",
      url: "/v1/account/usage?page=2&page_size=5",
      headers: { cookie },
    });
    expect(usage.statusCode).toBe(200);
    expect(usage.json().summary.total_tokens).toBe(0);

    const balances = await harness.app.inject({
      method: "GET",
      url: "/v1/account/balance-records?page=3&page_size=7",
      headers: { cookie },
    });
    expect(balances.statusCode).toBe(200);
    expect(balances.json().items[0].id).toBe("balance-1");

    const feedback = await harness.app.inject({
      method: "GET",
      url: "/v1/account/feedback?page=4&page_size=9",
      headers: { cookie },
    });
    expect(feedback.statusCode).toBe(200);
    expect(feedback.json().items[0].id).toBe("feedback-1");

    const feedbackCreated = await harness.app.inject({
      method: "POST",
      url: "/v1/account/feedback",
      headers: { cookie },
      payload: {
        feedback_type: "feature",
        title: "Add an export flow",
        content: "Please support a deterministic research export.",
      },
    });
    expect(feedbackCreated.statusCode).toBe(201);
    expect(feedbackCreated.json().id).toBe("feedback-2");

    for (const call of harness.calls.slice(2)) {
      expect(call.headers.get("authorization")).toBe(
        "Bearer access-registered",
      );
      expect(call.headers.has("cookie")).toBe(false);
    }
    const usageCall = harness.calls.find((call) =>
      call.url.pathname.endsWith("/api/v1/me/usage"),
    );
    expect(usageCall?.url.search).toBe("?page=2&page_size=5");
    const balanceCall = harness.calls.find((call) =>
      call.url.pathname.endsWith("/api/v1/me/balance-records"),
    );
    expect(balanceCall?.url.search).toBe("?page=3&page_size=7");
    const feedbackListCall = harness.calls.find(
      (call) =>
        call.method === "GET" && call.url.pathname.endsWith("/api/v1/feedback"),
    );
    expect(feedbackListCall?.url.search).toBe("?page=4&page_size=9");
    const feedbackCreateCall = harness.calls.find(
      (call) =>
        call.method === "POST" &&
        call.url.pathname.endsWith("/api/v1/feedback"),
    );
    expect(feedbackCreateCall?.body).toEqual({
      feedback_type: "feature",
      title: "Add an export flow",
      content: "Please support a deterministic research export.",
      rating: null,
      contact_allowed: true,
      client_platform: process.platform,
      client_version: null,
    });

    const password = await harness.app.inject({
      method: "POST",
      url: "/auth/users/me/password",
      headers: { cookie },
      payload: {
        old_password: "password123",
        new_password: "new-password-456",
      },
    });
    expect(password.statusCode).toBe(204);
    expect(password.headers["cache-control"]).toBe("private, no-store");
    expect(responseSetCookies(password).join("\n")).toContain("Max-Age=0");
    const passwordCall = harness.calls.find((call) =>
      call.url.pathname.endsWith("/api/v1/me/change-password"),
    );
    expect(passwordCall?.body).toEqual({
      old_password: "password123",
      new_password: "new-password-456",
    });
  });

  it("refreshes rejected access once and replays rotating refresh results", async () => {
    let refreshCount = 0;
    harness = await createHarness((call) => {
      if (call.url.pathname.endsWith("/api/v1/auth/login")) {
        return jsonResponse(200, tokenPayload(USER_A, "stale"));
      }
      if (call.url.pathname.endsWith("/api/v1/auth/refresh")) {
        refreshCount += 1;
        expect(call.body).toEqual({ refresh_token: "refresh-stale" });
        return jsonResponse(200, tokenPayload(USER_A, "fresh"));
      }
      if (call.url.pathname.endsWith("/api/v1/me")) {
        if (call.headers.get("authorization") === "Bearer access-stale") {
          return jsonResponse(401, {
            code: "token_expired",
            message: "Access token expired",
          });
        }
        return jsonResponse(200, USER_A);
      }
      if (call.url.pathname.endsWith("/api/v1/me/usage")) {
        if (call.headers.get("authorization") === "Bearer access-stale") {
          return jsonResponse(401, {
            code: "token_expired",
            message: "Access token expired",
          });
        }
        return jsonResponse(200, {
          items: [],
          summary: { total_tokens: 5 },
          page: 1,
          page_size: 10,
        });
      }
      return jsonResponse(404, {
        code: "unexpected_upstream_route",
        message: call.url.pathname,
      });
    });

    const login = await harness.app.inject({
      method: "POST",
      url: "/auth/login",
      payload: {
        email: USER_A.email,
        password: "password123",
      },
    });
    const staleCookie = sessionCookie(login);

    const me = await harness.app.inject({
      method: "GET",
      url: "/auth/me",
      headers: { cookie: staleCookie },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toEqual(publicUser(USER_A));
    expect(responseSetCookies(me).join("\n")).toContain(COOKIE_NAME);

    const usage = await harness.app.inject({
      method: "GET",
      url: "/v1/account/usage?page=1&page_size=10",
      headers: { cookie: staleCookie },
    });
    expect(usage.statusCode).toBe(200);
    expect(usage.json().summary.total_tokens).toBe(5);
    expect(responseSetCookies(usage).join("\n")).toContain(COOKIE_NAME);

    const explicitRefresh = await harness.app.inject({
      method: "POST",
      url: "/auth/refresh",
      headers: { cookie: staleCookie },
    });
    expect(explicitRefresh.statusCode).toBe(200);
    expect(explicitRefresh.json()).toEqual({
      ok: true,
      user: publicUser(USER_A),
    });
    expect(explicitRefresh.body).not.toContain("access-fresh");
    expect(explicitRefresh.body).not.toContain("refresh-fresh");
    expect(refreshCount).toBe(1);

    expect(
      harness.calls.map(
        (call) =>
          `${call.method} ${call.url.pathname} ${call.headers.get("authorization") ?? ""}`,
      ),
    ).toEqual([
      "POST /private_fund/backend/api/v1/auth/login ",
      "GET /private_fund/backend/api/v1/me Bearer access-stale",
      "POST /private_fund/backend/api/v1/auth/refresh ",
      "GET /private_fund/backend/api/v1/me Bearer access-fresh",
      "GET /private_fund/backend/api/v1/me/usage Bearer access-stale",
      "GET /private_fund/backend/api/v1/me/usage Bearer access-fresh",
    ]);
  });

  it("coalesces concurrent refreshes made with one rotating cookie", async () => {
    let refreshCount = 0;
    let releaseRefresh: (() => void) | undefined;
    let announceRefresh: (() => void) | undefined;
    const refreshGate = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    const refreshStarted = new Promise<void>((resolve) => {
      announceRefresh = resolve;
    });
    harness = await createHarness(async (call) => {
      if (call.url.pathname.endsWith("/api/v1/auth/login")) {
        return jsonResponse(200, tokenPayload(USER_A, "concurrent-stale"));
      }
      if (call.url.pathname.endsWith("/api/v1/auth/refresh")) {
        refreshCount += 1;
        announceRefresh?.();
        await refreshGate;
        return jsonResponse(200, tokenPayload(USER_A, "concurrent-fresh"));
      }
      return jsonResponse(404, {
        code: "unexpected_upstream_route",
        message: call.url.pathname,
      });
    });

    const login = await harness.app.inject({
      method: "POST",
      url: "/auth/login",
      payload: {
        email: USER_A.email,
        password: "password123",
      },
    });
    const cookie = sessionCookie(login);
    const first = harness.app.inject({
      method: "POST",
      url: "/auth/refresh",
      headers: { cookie },
    });
    await refreshStarted;
    const second = harness.app.inject({
      method: "POST",
      url: "/auth/refresh",
      headers: { cookie },
    });
    releaseRefresh?.();

    const [firstResponse, secondResponse] = await Promise.all([first, second]);
    expect(firstResponse.statusCode).toBe(200);
    expect(secondResponse.statusCode).toBe(200);
    expect(firstResponse.json().user).toEqual(publicUser(USER_A));
    expect(secondResponse.json().user).toEqual(publicUser(USER_A));
    expect(refreshCount).toBe(1);
  });

  it("rejects refresh tenant switching before creating a foreign shadow", async () => {
    harness = await createHarness((call) => {
      if (call.url.pathname.endsWith("/api/v1/auth/login")) {
        return jsonResponse(200, tokenPayload(USER_A, "a"));
      }
      if (call.url.pathname.endsWith("/api/v1/auth/refresh")) {
        return jsonResponse(200, tokenPayload(USER_B, "switched"));
      }
      return jsonResponse(404, {
        code: "unexpected_upstream_route",
        message: call.url.pathname,
      });
    });

    const login = await harness.app.inject({
      method: "POST",
      url: "/auth/login",
      payload: {
        email: USER_A.email,
        password: "password123",
      },
    });
    const refresh = await harness.app.inject({
      method: "POST",
      url: "/auth/refresh",
      headers: { cookie: sessionCookie(login) },
    });
    expect(refresh.statusCode).toBe(401);
    expect(refresh.json()).toEqual({
      error: "not_authenticated",
      message: "Session expired",
    });
    expect(responseSetCookies(refresh).join("\n")).toContain("Max-Age=0");
    expect(harness.repositories.users.findById(USER_A.id)).not.toBeNull();
    expect(harness.repositories.users.findById(USER_B.id)).toBeNull();
  });

  it("maps upstream outages to 503 without deleting a valid cookie", async () => {
    harness = await createHarness((call) => {
      if (call.url.pathname.endsWith("/api/v1/auth/login")) {
        return jsonResponse(200, tokenPayload(USER_A, "a"));
      }
      if (call.url.pathname.endsWith("/api/v1/me/usage")) {
        throw new TypeError("controlled upstream network outage");
      }
      return jsonResponse(404, {
        code: "unexpected_upstream_route",
        message: call.url.pathname,
      });
    });

    const login = await harness.app.inject({
      method: "POST",
      url: "/auth/login",
      payload: {
        email: USER_A.email,
        password: "password123",
      },
    });
    const outage = await harness.app.inject({
      method: "GET",
      url: "/v1/account/usage?page=1&page_size=10",
      headers: { cookie: sessionCookie(login) },
    });
    expect(outage.statusCode).toBe(503);
    expect(outage.headers["cache-control"]).toBe("private, no-store");
    expect(outage.json()).toEqual({
      error: "cloud_service_unavailable",
      message: "controlled upstream network outage",
    });
    expect(responseSetCookies(outage)).toEqual([]);
  });
});
