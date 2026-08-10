/**
 * Client for the ``accounts`` auth provider's HTTP API.
 *
 * Wraps ``POST /auth/login``, ``POST /auth/logout``, and
 * ``GET /auth/me`` in a small typed surface so the LoginPage,
 * MembersPage, and any future profile-management UI share one
 * source of truth for the request/response shapes.
 *
 * Cookie handling is done by the browser — these endpoints set /
 * clear ``__Host-ap_session`` (HTTPS) or ``ap_session`` (HTTP) via
 * Set-Cookie. We don't touch ``document.cookie`` here.
 *
 * Errors: every helper resolves with a typed error object on
 * non-2xx instead of throwing, so the UI can render specific
 * messages (wrong password vs network failure vs server error)
 * without try/catch every call site.
 */

/** Body of POST /auth/login. */
export interface LoginRequest {
  username?: string;
  email?: string;
  password: string;
}

/** Successful login response — token is also set as a cookie. */
export interface LoginSuccess {
  ok: true;
  user: CurrentAccount;
  token?: string;
  expires_in: number;
}

/** Login failure — kept opaque on purpose (don't leak which check failed). */
export interface LoginFailure {
  ok: false;
  /** Short human-readable message safe to show in the form. */
  error: string;
  /** HTTP status, in case the UI wants to distinguish 401 vs 5xx. */
  status: number;
  /** Stable server error code when one is available. */
  code?: string;
}

export type LoginResult = LoginSuccess | LoginFailure;

/** Shape of GET /auth/me when authenticated. */
export interface CurrentAccount {
  id: string;
  is_admin: boolean;
  is_platform_admin?: boolean;
  email?: string;
  nick_name?: string | null;
  status?: string;
  data_namespace?: string;
  balance_cny?: string;
  created_at?: number | string | null;
  last_login_at?: number | string | null;
}

export interface PlatformUsageSummary {
  request_count: number;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  charged_amount_cny: string;
}

export interface PlatformUsageResponse {
  items: Array<{
    id: string;
    provider: string;
    model: string;
    status: string;
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    charged_amount_cny: string;
    started_at: string;
  }>;
  summary: PlatformUsageSummary;
  page: number;
  page_size: number;
}

export interface BalanceRecord {
  id: string;
  record_type: string;
  amount_cny: string;
  balance_after_cny: string;
  note: string | null;
  llm_usage_id?: string | null;
  provider?: string | null;
  model?: string | null;
  model_display_name?: string | null;
  prompt_tokens?: number | null;
  completion_tokens?: number | null;
  total_tokens?: number | null;
  created_at: string;
}

export type BalanceRecordPeriod = "all" | "week" | "month";

export interface BalanceRecordPage {
  items: BalanceRecord[];
  page: number;
  page_size: number;
  total: number;
  total_pages: number;
  period: BalanceRecordPeriod;
}

export interface FeedbackAttachment {
  id: string;
  original_filename: string;
  content_type: string;
  size_bytes: number;
  created_at: string;
}

export interface FeedbackEntry {
  id: string;
  feedback_number: number;
  feedback_type: string;
  title: string;
  content: string;
  rating: number | null;
  status: string;
  contact_allowed: boolean;
  attachments?: FeedbackAttachment[];
  created_at: string;
  updated_at: string;
}

export interface FeedbackCreateRequest {
  feedback_type: "bug" | "experience" | "feature" | "answer_quality" | "other";
  title: string;
  content: string;
  rating: number | null;
  contact_allowed: boolean;
  client_platform?: string;
  client_version?: string;
}

export interface FeedbackFailure {
  ok: false;
  error: string;
  status: number;
  requestId?: string;
}

export type FeedbackListResult = { ok: true; items: FeedbackEntry[] } | FeedbackFailure;

export type FeedbackCreateResult = { ok: true; feedback: FeedbackEntry } | FeedbackFailure;

/**
 * POST /auth/login — verify username + password, set the session
 * cookie on success.
 *
 * :param body: Login credentials.
 * :returns: Discriminated union — ``ok: true`` with the user info,
 *     or ``ok: false`` with an error message.
 */
export async function login(body: LoginRequest): Promise<LoginResult> {
  let res: Response;
  try {
    res = await fetch("/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      // Cookies are set by the response — credentials default
      // ("same-origin") is correct for our co-located deploy.
    });
  } catch {
    return {
      ok: false,
      error: "Could not reach the server. Check your connection.",
      status: 0,
    };
  }

  if (res.ok) {
    const data = (await res.json()) as Omit<LoginSuccess, "ok">;
    return { ok: true, ...data };
  }

  // The route returns 401 for both unknown-user and wrong-password.
  // Surface the server's message when it's a 4xx, generic for 5xx.
  let message = "Login failed.";
  try {
    const data = (await res.json()) as { error?: string; message?: string };
    if (data.message || data.error) {
      message = data.message ?? data.error ?? message;
    }
  } catch {
    if (res.status >= 500) message = "Server error. Try again in a moment.";
  }
  return { ok: false, error: message, status: res.status };
}

/**
 * POST /auth/logout — clear the session cookie.
 *
 * Always succeeds from the caller's POV (204 even when no cookie
 * was set), so this returns ``void``. After it resolves, navigate
 * to ``/login`` to land the user on a clean form.
 */
export async function logout(): Promise<void> {
  try {
    await fetch("/auth/logout", { method: "POST" });
  } catch {
    // Network error — the cookie is still in the browser, but the
    // next authenticated request will 401 and bounce to login.
  }
}

export function clearUserScopedBrowserState(): void {
  try {
    for (const storage of [window.localStorage, window.sessionStorage]) {
      const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index)).filter(
        (key): key is string => Boolean(key),
      );
      for (const key of keys) {
        if (
          key.startsWith("omnigent.privateFund") ||
          key.startsWith("omnigent:") ||
          key.startsWith("omnigent.")
        ) {
          storage.removeItem(key);
        }
      }
    }
  } catch {
    // Storage cleanup is best-effort; the hard navigation clears memory state.
  }
}

/**
 * GET /auth/me — fetch the current user.
 *
 * Note: there's also a generic ``GET /v1/me`` used by ``identity.ts``
 * for the initial identity probe. ``/auth/me`` is accounts-specific
 * and returns richer info (created_at, last_login_at) — use this one
 * when the consuming UI needs those fields.
 *
 * :returns: The current :class:`CurrentAccount`, or ``null`` if
 *     unauthenticated.
 */
export async function getMe(): Promise<CurrentAccount | null> {
  let res: Response;
  try {
    res = await fetch("/auth/me", { cache: "no-store" });
  } catch {
    return null;
  }
  if (res.ok) {
    return (await res.json()) as CurrentAccount;
  }
  return null;
}

/** Body of POST /auth/register. */
export interface RegisterRequest {
  invite?: string;
  username?: string;
  email?: string;
  code?: string;
  nick_name?: string | null;
  password: string;
}

/** Mask an account email before showing it in shared or shoulder-visible UI. */
export function maskedAccountEmail(value: string): string {
  const [name, domain] = value.split("@");
  if (!domain) return value.length > 3 ? `${value.slice(0, 2)}***` : value;
  return `${name.slice(0, 1)}***@${domain}`;
}

/** Prefer a user nickname and otherwise fall back to the full email or ID. */
export function accountDisplayName(account: CurrentAccount): string {
  const nickname = account.nick_name?.trim();
  return nickname || account.email || account.id;
}

export const ACCOUNT_UPDATED_EVENT = "omnigent:account-updated";

export type RegistrationCodeResult =
  | { ok: true; expires_in: number; resend_after: number }
  | { ok: false; error: string; status: number; code?: string };

/** Request a four-digit email code from the cloud accounts service. */
export async function sendRegistrationCode(email: string): Promise<RegistrationCodeResult> {
  try {
    const res = await fetch("/auth/register/send-code", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email }),
    });
    const data = (await res.json().catch(() => null)) as {
      ok?: boolean;
      expires_in?: number;
      resend_after?: number;
      error?: string;
      code?: string;
      message?: string;
    } | null;
    if (res.ok) {
      return {
        ok: true,
        expires_in: data?.expires_in ?? 600,
        resend_after: data?.resend_after ?? 60,
      };
    }
    return {
      ok: false,
      error: data?.message ?? data?.error ?? data?.code ?? "验证码发送失败。",
      status: res.status,
      code: data?.code ?? data?.error,
    };
  } catch {
    return { ok: false, error: "无法连接到账户服务。", status: 0 };
  }
}

/**
 * POST /auth/register — redeem an invite token and create the user.
 *
 * Same response shape as :func:`login` (cookie set on success) so
 * the calling page can navigate straight to ``/`` after.
 */
export async function register(body: RegisterRequest): Promise<LoginResult> {
  let res: Response;
  try {
    res = await fetch("/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    return {
      ok: false,
      error: "Could not reach the server.",
      status: 0,
    };
  }
  if (res.ok) {
    const data = (await res.json()) as Omit<LoginSuccess, "ok">;
    return { ok: true, ...data };
  }
  let message = "账户注册失败。";
  let code: string | undefined;
  try {
    const data = (await res.json()) as {
      error?: string;
      code?: string;
      message?: string;
      detail?: string;
    };
    code = data.code ?? data.error;
    message = data.message ?? data.detail ?? data.error ?? data.code ?? message;
  } catch {
    if (res.status >= 500) message = "账户服务暂时不可用，请稍后重试。";
  }
  return { ok: false, error: message, status: res.status, code };
}

/** Body used by native Accounts deployments for self-serve password changes. */
export interface LocalChangePasswordRequest {
  old_password: string;
  new_password: string;
}

export interface CloudChangePasswordRequest {
  code: string;
  new_password: string;
}

export type ChangePasswordRequest = LocalChangePasswordRequest | CloudChangePasswordRequest;

/** Result of a self-serve password change or password reset. */
export type ChangePasswordResult = { ok: true } | { ok: false; error: string };

/**
 * POST /auth/users/me/password — change the signed-in user's own password.
 *
 * Native Accounts deployments require the current password. Cloud Accounts
 * deployments require a six-digit email verification code. Returns 204 on
 * success in either mode.
 * :returns: ``{ok: true}`` or ``{ok: false, error}``.
 */
export async function changePassword(body: ChangePasswordRequest): Promise<ChangePasswordResult> {
  let res: Response;
  try {
    res = await fetch("/auth/users/me/password", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    return { ok: false, error: "Could not reach the server." };
  }
  if (res.ok) return { ok: true };
  if (res.status === 401) {
    return { ok: false, error: "Current password is incorrect." };
  }
  if (res.status >= 500) {
    return { ok: false, error: "Server error. Try again in a moment." };
  }
  let message = "Could not change password.";
  try {
    const data = (await res.json()) as { error?: string; message?: string; detail?: string };
    message = data.message ?? data.detail ?? data.error ?? message;
  } catch {
    // pass
  }
  return { ok: false, error: message };
}

export async function sendChangePasswordCode(): Promise<RegistrationCodeResult> {
  return sendAccountCode("/auth/users/me/password/send-code");
}

export async function sendPasswordResetCode(email: string): Promise<RegistrationCodeResult> {
  return sendAccountCode("/auth/password/reset/send-code", { email });
}

export interface PasswordResetRequest {
  email: string;
  code: string;
  new_password: string;
}

export async function resetPassword(body: PasswordResetRequest): Promise<ChangePasswordResult> {
  try {
    const res = await fetch("/auth/password/reset", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.ok) return { ok: true };
    return { ok: false, error: await accountErrorMessage(res, "验证码无效或已过期。") };
  } catch {
    return { ok: false, error: "无法连接到账户服务。" };
  }
}

async function sendAccountCode(
  path: string,
  body?: Record<string, string>,
): Promise<RegistrationCodeResult> {
  try {
    const res = await fetch(path, {
      method: "POST",
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = (await res.clone().json().catch(() => null)) as {
      expires_in?: number;
      resend_after?: number;
    } | null;
    if (res.ok) {
      return {
        ok: true,
        expires_in: data?.expires_in ?? 300,
        resend_after: data?.resend_after ?? 60,
      };
    }
    return {
      ok: false,
      error: await accountErrorMessage(res, "验证码发送失败。"),
      status: res.status,
    };
  } catch {
    return { ok: false, error: "无法连接到账户服务。", status: 0 };
  }
}

async function accountErrorMessage(res: Response, fallback: string): Promise<string> {
  try {
    const data = (await res.json()) as {
      error?: string;
      code?: string;
      message?: string;
      detail?: string;
    };
    return data.message ?? data.detail ?? data.error ?? data.code ?? fallback;
  } catch {
    return res.status >= 500 ? "账户服务暂时不可用，请稍后重试。" : fallback;
  }
}

export async function updateAccountProfile(
  nickName: string | null,
): Promise<{ ok: true; account: CurrentAccount } | { ok: false; error: string }> {
  try {
    const res = await fetch("/auth/users/me/profile", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ nick_name: nickName }),
    });
    if (res.ok) {
      const account = (await res.json()) as CurrentAccount;
      window.dispatchEvent(
        new CustomEvent<CurrentAccount>(ACCOUNT_UPDATED_EVENT, { detail: account }),
      );
      return { ok: true, account };
    }
    const data = (await res.json().catch(() => null)) as {
      message?: string;
      detail?: string;
      error?: string;
    } | null;
    return {
      ok: false,
      error: data?.message ?? data?.detail ?? data?.error ?? "保存昵称失败",
    };
  } catch {
    return { ok: false, error: "无法连接到服务" };
  }
}

interface ApiErrorPayload {
  message?: unknown;
  detail?: unknown;
  error?: unknown;
  code?: unknown;
  request_id?: unknown;
}

function errorText(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (!Array.isArray(value)) return undefined;
  const messages = value
    .map((item) => {
      if (typeof item === "string") return item;
      if (item && typeof item === "object" && "msg" in item) {
        const message = (item as { msg?: unknown }).msg;
        return typeof message === "string" ? message : undefined;
      }
      return undefined;
    })
    .filter((item): item is string => Boolean(item));
  return messages.length > 0 ? messages.join("; ") : undefined;
}

async function readFeedbackFailure(response: Response, fallback: string): Promise<FeedbackFailure> {
  const data = (await response.json().catch(() => null)) as ApiErrorPayload | null;
  const message =
    errorText(data?.message) ??
    errorText(data?.detail) ??
    errorText(data?.error) ??
    errorText(data?.code) ??
    fallback;
  const requestId = errorText(data?.request_id) ?? errorText(response.headers.get("X-Request-ID"));
  const diagnostic = requestId
    ? `HTTP ${response.status}, request ${requestId}`
    : `HTTP ${response.status}`;
  return {
    ok: false,
    error: `${message} (${diagnostic})`,
    status: response.status,
    ...(requestId ? { requestId } : {}),
  };
}

function feedbackConnectionFailure(): FeedbackFailure {
  return {
    ok: false,
    error: "\u65e0\u6cd5\u8fde\u63a5\u5230\u670d\u52a1",
    status: 0,
  };
}
async function readJsonOrNull<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(path, { cache: "no-store" });
    return res.ok ? ((await res.json()) as T) : null;
  } catch {
    return null;
  }
}

export function getPlatformUsage(): Promise<PlatformUsageResponse | null> {
  return readJsonOrNull<PlatformUsageResponse>("/v1/account/usage?page=1&page_size=10");
}

export function getBalanceRecords(
  page = 1,
  period: BalanceRecordPeriod = "all",
): Promise<BalanceRecordPage | null> {
  const params = new URLSearchParams({
    page: String(page),
    page_size: "10",
    period,
  });
  return readJsonOrNull<BalanceRecordPage>(`/v1/account/balance-records?${params.toString()}`);
}

export async function getFeedback(): Promise<FeedbackListResult> {
  try {
    const response = await fetch("/v1/account/feedback?page=1&page_size=50", {
      cache: "no-store",
    });
    if (!response.ok) {
      return readFeedbackFailure(response, "\u52a0\u8f7d\u53cd\u9988\u8bb0\u5f55\u5931\u8d25");
    }
    const data = (await response.json()) as { items?: unknown };
    if (!Array.isArray(data.items)) {
      return {
        ok: false,
        error: "\u53cd\u9988\u670d\u52a1\u8fd4\u56de\u4e86\u65e0\u6548\u6570\u636e (HTTP 502)",
        status: 502,
      };
    }
    return { ok: true, items: data.items as FeedbackEntry[] };
  } catch {
    return feedbackConnectionFailure();
  }
}

export async function createFeedback(
  body: FeedbackCreateRequest,
  attachments: File[] = [],
): Promise<FeedbackCreateResult> {
  try {
    let response: Response;
    if (attachments.length > 0) {
      const form = new FormData();
      form.append("metadata", JSON.stringify(body));
      attachments.forEach((file) => form.append("files", file, file.name));
      response = await fetch("/v1/account/feedback/with-attachments", {
        method: "POST",
        body: form,
      });
    } else {
      response = await fetch("/v1/account/feedback", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    }
    if (!response.ok) {
      return readFeedbackFailure(response, "\u63d0\u4ea4\u53cd\u9988\u5931\u8d25");
    }
    const feedback = (await response.json()) as FeedbackEntry;
    if (!feedback || typeof feedback.feedback_number !== "number") {
      return {
        ok: false,
        error: "\u53cd\u9988\u670d\u52a1\u8fd4\u56de\u4e86\u65e0\u6548\u6570\u636e (HTTP 502)",
        status: 502,
      };
    }
    return { ok: true, feedback };
  } catch {
    return feedbackConnectionFailure();
  }
}

/** Body of POST /auth/setup (first-run admin claim). */
export interface SetupRequest {
  username: string;
  password: string;
}

/**
 * POST /auth/setup — claim the first admin on a fresh instance.
 *
 * Only valid while no account exists (the server 409s once one does).
 * Same success shape as :func:`login` (cookie set on success) so the
 * page can navigate to ``/`` after.
 */
export async function setup(body: SetupRequest): Promise<LoginResult> {
  let res: Response;
  try {
    res = await fetch("/auth/setup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    return { ok: false, error: "Could not reach the server.", status: 0 };
  }
  if (res.ok) {
    const data = (await res.json()) as Omit<LoginSuccess, "ok">;
    return { ok: true, ...data };
  }
  if (res.status === 409) {
    return {
      ok: false,
      error: "This server already has an admin. Sign in instead.",
      status: 409,
    };
  }
  let message = "Could not create the admin account.";
  if (res.status >= 500) {
    message = "Server error. Try again in a moment.";
  } else {
    try {
      const data = (await res.json()) as { error?: string };
      if (data.error) message = data.error;
    } catch {
      // pass
    }
  }
  return { ok: false, error: message, status: res.status };
}

// ── Admin: members management ──────────────────────────────────────

/**
 * A user row as returned by ``GET /auth/users``.
 *
 * Same shape as :class:`CurrentAccount` plus ``has_password``
 * (so the UI can render a "External login" badge for header/OIDC
 * rows that haven't been converted to accounts).
 */
export interface AccountListEntry {
  id: string;
  is_admin: boolean;
  created_at: number | null;
  last_login_at: number | null;
  has_password: boolean;
}

/** Successful response from ``POST /auth/invite``. */
export interface InviteCreated {
  ok: true;
  token: string;
  register_url: string;
  expires_at: number;
  is_admin: boolean;
}

/** Successful response from ``POST /auth/users/{id}/reset``. */
export interface PasswordReset {
  ok: true;
  id: string;
  new_password: string;
}

/** Generic admin operation failure. */
export interface AdminFailure {
  ok: false;
  error: string;
  status: number;
}

/**
 * Wrap a generic admin response, mapping non-2xx to typed failure.
 *
 * Centralized so each admin call site has the same error shape.
 * Network failures collapse to ``status: 0`` per the convention
 * already established by :func:`login`.
 */
async function _admin<T extends { ok: true }>(
  doFetch: () => Promise<Response>,
  toSuccess: (body: unknown) => Omit<T, "ok">,
): Promise<T | AdminFailure> {
  let res: Response;
  try {
    res = await doFetch();
  } catch {
    return { ok: false, error: "Could not reach the server.", status: 0 };
  }
  if (res.ok) {
    const body = await res.json();
    return { ok: true, ...toSuccess(body) } as T;
  }
  let message = `Request failed (${res.status}).`;
  if (res.status === 403) message = "Admin permission required.";
  else if (res.status === 404) message = "Not found.";
  try {
    const data = (await res.json()) as { error?: string };
    if (data.error) message = data.error;
  } catch {
    // Body wasn't JSON; keep the generic message.
  }
  return { ok: false, error: message, status: res.status };
}

/**
 * GET /auth/users — admin-only listing of every account.
 *
 * Returns ``null`` on 403 / network error so the caller can fall
 * back gracefully (e.g. hide the members page entirely for
 * non-admins instead of throwing).
 */
export async function listUsers(): Promise<AccountListEntry[] | null> {
  let res: Response;
  try {
    res = await fetch("/auth/users", { cache: "no-store" });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  const data = (await res.json()) as { users: AccountListEntry[] };
  return data.users;
}

/**
 * POST /auth/invite — mint a single-use invite token (admin only).
 *
 * :param isAdmin: Whether the resulting user is created with admin
 *     rights. Defaults false; the modal flips it via a checkbox.
 * :returns: The new token + the URL to share, or a typed failure.
 */
export async function createInvite(isAdmin: boolean): Promise<InviteCreated | AdminFailure> {
  return _admin<InviteCreated>(
    () =>
      fetch("/auth/invite", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ is_admin: isAdmin }),
      }),
    (body) => {
      const b = body as {
        token: string;
        register_url: string;
        expires_at: number;
        is_admin: boolean;
      };
      return {
        token: b.token,
        register_url: b.register_url,
        expires_at: b.expires_at,
        is_admin: b.is_admin,
      };
    },
  );
}

/**
 * DELETE /auth/users/{id} — remove a user (admin only).
 *
 * Server rejects self-delete and bootstrap-admin delete — those
 * surface as 400 with explanatory ``error`` strings, propagated
 * through :type:`AdminFailure`.
 */
export async function deleteUser(userId: string): Promise<{ ok: true } | AdminFailure> {
  let res: Response;
  try {
    res = await fetch(`/auth/users/${encodeURIComponent(userId)}`, {
      method: "DELETE",
    });
  } catch {
    return { ok: false, error: "Could not reach the server.", status: 0 };
  }
  if (res.status === 204) return { ok: true };
  let message = `Delete failed (${res.status}).`;
  try {
    const data = (await res.json()) as { error?: string };
    if (data.error) message = data.error;
  } catch {
    // pass
  }
  return { ok: false, error: message, status: res.status };
}

/**
 * POST /auth/users/{id}/reset — admin-issued password reset.
 *
 * Returns the freshly generated plaintext exactly once. The admin
 * is responsible for DM-ing it to the user out-of-band.
 */
export async function resetUserPassword(userId: string): Promise<PasswordReset | AdminFailure> {
  return _admin<PasswordReset>(
    () =>
      fetch(`/auth/users/${encodeURIComponent(userId)}/reset`, {
        method: "POST",
      }),
    (body) => {
      const b = body as { id: string; new_password: string };
      return { id: b.id, new_password: b.new_password };
    },
  );
}
