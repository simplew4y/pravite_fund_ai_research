/**
 * User identity discovery and request header injection.
 *
 * On app load, calls ``GET /v1/me`` to discover the current user, or
 * ``GET /auth/me`` in cloud-account mode to verify the cloud session too.
 * All subsequent API calls use ``authenticatedFetch`` which injects
 * the ``X-Forwarded-Email`` header so session routes know who's
 * making the request.
 *
 * When OIDC or accounts auth is active, the server returns 401 with
 * a ``login_url`` if the user is unauthenticated. The frontend
 * redirects to that URL — for accounts mode this is the SPA route
 * ``/login`` (LoginPage), for OIDC it's the server-side
 * ``/auth/login`` redirect. In header mode the server reports no
 * ``login_url`` (single-user, no login), so 401s are never turned
 * into a login redirect.
 */

import { getCachedServerInfo, resolveServerInfo } from "./capabilities";
import { getOmnigentHostConfig, hostFetch } from "./host";

// Single-user sentinel from `GET /v1/me` (server's RESERVED_USER_LOCAL);
// not a real actor, so never used as an author label.
const RESERVED_USER_LOCAL = "local";

let _currentUserId: string | null = null;
let _resolved = false;
let _resolvePromise: Promise<string | null> | null = null;
// Cache the server-provided login URL on the first /v1/me probe so
// later session-expiry redirects in authenticatedFetch hit the right
// path per provider — "/login" for accounts, "/auth/login" for OIDC.
// Hardcoding "/login" here previously sent OIDC users to an accounts
// password form that had no connection to their IdP.
let _serverLoginUrl: string | null = null;
let cloudRefreshPromise: Promise<boolean> | null = null;

async function refreshCloudSession(): Promise<boolean> {
  if (cloudRefreshPromise !== null) return cloudRefreshPromise;
  cloudRefreshPromise = (async () => {
    try {
      const response = await hostFetch("/auth/refresh", {
        method: "POST",
        cache: "no-store",
      });
      return response.ok;
    } catch {
      return false;
    }
  })().finally(() => {
    cloudRefreshPromise = null;
  });
  return cloudRefreshPromise;
}

/**
 * Whether the current page IS the login or register page, so we
 * shouldn't trigger another redirect on top of it. Without this,
 * an unauthed user landing on ``/login`` would hit /v1/me → 401 →
 * redirect to /login → reload → redirect → infinite loop. Same
 * for ``/register?invite=...`` — invitees redeeming an invite
 * arrive unauthed by design.
 *
 * Matches both the SPA routes (``/login``, ``/register``) and the
 * OIDC server-side path (``/auth/login``) so the guard covers
 * every mode.
 */
function _isOnLoginPath(): boolean {
  const path = window.location.pathname;
  return (
    path === "/login" ||
    path === "/register" ||
    path === "/forgot-password" ||
    path.startsWith("/auth/login")
  );
}

/**
 * Fetch the current user identity from the server.
 * Called once on app load; subsequent calls return the cached value.
 *
 * When the server returns 401 with a ``login_url`` (OIDC mode),
 * redirects the browser to the login page.
 */
export async function resolveIdentity(): Promise<string | null> {
  if (_resolved) return _currentUserId;
  if (_resolvePromise) return _resolvePromise;
  _resolvePromise = (async () => {
    try {
      const serverInfo = getCachedServerInfo();
      const cloudAccounts = serverInfo?.cloud_accounts_enabled === true;
      const identityPath = cloudAccounts ? "/auth/me" : "/v1/me";
      let res = await hostFetch(identityPath, { cache: "no-store" });
      if (res.status === 401) {
        const info = serverInfo ?? (await resolveServerInfo());
        if (info.cloud_accounts_enabled === true && (await refreshCloudSession())) {
          res = await hostFetch(identityPath, { cache: "no-store" });
        }
      }
      if (res.status === 401 || (cloudAccounts && res.status === 403)) {
        // OIDC / accounts mode: server requires authentication.
        // Redirect to the login URL provided in the response body —
        // unless we're already there (avoid an infinite reload loop
        // when the LoginPage itself calls resolveIdentity).
        try {
          const data = (await res.json()) as {
            user_id: null;
            login_url?: string;
          };
          const loginUrl = data.login_url ?? serverInfo?.login_url;
          if (loginUrl) {
            _serverLoginUrl = loginUrl;
            if (!_isOnLoginPath()) {
              const returnTo = encodeURIComponent(
                window.location.pathname + window.location.search,
              );
              window.location.href = `${loginUrl}?return_to=${returnTo}`;
              return null;
            }
          }
        } catch {
          // Response body was not JSON — fall through.
        }
      }
      if (res.ok) {
        const data = (await res.json()) as { id?: string; user_id?: string | null };
        _currentUserId = cloudAccounts ? (data.id ?? null) : (data.user_id ?? null);
      }
    } catch {
      // Server unreachable — leave as null.
    }
    _resolved = true;
    return _currentUserId;
  })();
  return _resolvePromise;
}

/** Return the cached user ID (null before resolveIdentity completes). */
export function getCurrentUserId(): string | null {
  return _currentUserId;
}

/**
 * Viewer id for labeling own optimistic bubbles, the client analog of
 * the server's `attribution_user`. Returns null before identity
 * resolves and for the `"local"` sentinel, so those stay unlabeled.
 */
export function getCurrentAuthorId(): string | null {
  if (_currentUserId === null || _currentUserId === RESERVED_USER_LOCAL) {
    return null;
  }
  return _currentUserId;
}

/**
 * Fetch wrapper that injects ``X-Forwarded-Email`` on every request.
 * Drop-in replacement for ``window.fetch`` — same signature.
 *
 * When a request returns 401 (session expired in OIDC mode),
 * redirects to the login page.
 */
export async function authenticatedFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const headers = new Headers(init?.headers);
  if (
    _currentUserId &&
    _currentUserId !== RESERVED_USER_LOCAL &&
    !headers.has("X-Forwarded-Email")
  ) {
    headers.set("X-Forwarded-Email", _currentUserId);
  }
  // Bypass the browser HTTP cache for all API calls. Session
  // endpoints (GET /v1/sessions/{id}) carry volatile in-memory state
  // (pending_elicitations) that changes between fetches without any
  // URL change. Without no-store the browser may serve a stale
  // cached response — e.g. one captured before an elicitation was
  // published — causing the ApprovalCard to vanish on navigate-back.
  const requestUrl = typeof input === "string" ? input : input.toString();
  let res = await hostFetch(requestUrl, {
    ...init,
    headers,
    cache: "no-store",
  });

  if (
    res.status === 401 &&
    getCachedServerInfo()?.cloud_accounts_enabled === true &&
    !requestUrl.includes("/auth/") &&
    !requestUrl.includes("/v1/me")
  ) {
    const refreshed = await refreshCloudSession();
    if (refreshed) {
      res = await hostFetch(requestUrl, {
        ...init,
        headers,
        cache: "no-store",
      });
    }
  }

  if (
    // When embedded, the host owns auth (e.g. cookie/session via
    // workspaceFetch) and a 401 should surface to the caller, not
    // trigger web's standalone OIDC redirect.
    !getOmnigentHostConfig().fetcher &&
    res.status === 401 &&
    !requestUrl.includes("/v1/me") &&
    !requestUrl.includes("/auth/") &&
    !_isOnLoginPath()
  ) {
    // Session expired or cookie invalid — redirect to login IFF the
    // server actually has a login page. Don't redirect on /auth/*
    // paths (the LoginPage POSTs /auth/login and handles 401 itself)
    // or when we're already on a login page (avoid the loop).
    //
    // Source the login URL from the capabilities probe (/v1/info →
    // login_url): "/login" for accounts, "/auth/login" for OIDC, and
    // **null for header mode (no login)**. In header mode a stray 401
    // must NOT bounce the user to a phantom /login form — header is
    // the default for a bare local server, so we surface the 401 to
    // the caller instead. (_serverLoginUrl from the /v1/me probe is a
    // fallback for the brief window before capabilities resolves.)
    const loginUrl = getCachedServerInfo()?.login_url ?? _serverLoginUrl;
    if (loginUrl) {
      window.location.href = `${loginUrl}?return_to=${encodeURIComponent(window.location.pathname + window.location.search)}`;
    }
  }
  return res;
}
