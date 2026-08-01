// Desktop packaging mode helpers.
//
// bundled  — install-and-run: Electron owns the local private-fund stack
//            (LiteLLM + Omnigent server/host/workers) and never asks for a
//            server URL.
// thin     — upstream Omnigent behaviour: connect to a user-supplied server.

"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

/** Default loopback URL for the private-fund Omnigent server. */
const DEFAULT_SERVER_URL = "http://127.0.0.1:6767";
const DEFAULT_LITELLM_URL = "http://127.0.0.1:4000";
const DEFAULT_SERVER_PORT = 6767;
const DEFAULT_LITELLM_PORT = 4000;

/**
 * Lazy electron.app — unit tests run under plain Node without Electron.
 * @returns {import("electron").App | null}
 */
function electronApp() {
  try {
    return require("electron").app;
  } catch {
    return null;
  }
}

/**
 * Resolve packaging mode.
 * Priority: env DESKTOP_MODE → packaged build default "bundled" → "thin".
 * Override with DESKTOP_MODE=thin to force the connect-to-server flow.
 *
 * @returns {"bundled" | "thin"}
 */
function getDesktopMode() {
  const raw = String(process.env.DESKTOP_MODE || "").trim().toLowerCase();
  if (raw === "bundled" || raw === "thin") return raw;
  const app = electronApp();
  // Packaged private-fund builds ship as zero-config by default.
  if (app && app.isPackaged) return "bundled";
  // Dev (`electron .`) stays thin unless DESKTOP_MODE=bundled is set.
  return "thin";
}

function isBundledMode() {
  return getDesktopMode() === "bundled";
}

/**
 * Absolute path to the packaged runtime tree.
 * Dev: electron/resources/runtime
 * Packaged: process.resourcesPath/runtime
 *
 * @returns {string}
 */
function runtimeRoot() {
  const app = electronApp();
  if (app && app.isPackaged) {
    return path.join(process.resourcesPath, "runtime");
  }
  return path.join(__dirname, "..", "resources", "runtime");
}

/**
 * Parse KEY=VALUE lines from a desktop.env file (no shell expansion).
 * Lines starting with # and blank lines are ignored.
 *
 * @param {string} filePath
 * @returns {Record<string, string>}
 */
function parseEnvFile(filePath) {
  /** @type {Record<string, string>} */
  const out = {};
  let text;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch {
    return out;
  }
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/**
 * Load build-injected secrets + runtime defaults for child processes.
 * Search order: resources/runtime/config/desktop.env, userData/desktop.env.
 *
 * @returns {Record<string, string>}
 */
function loadDesktopEnv() {
  const candidates = [path.join(runtimeRoot(), "config", "desktop.env")];
  const app = electronApp();
  if (app && typeof app.getPath === "function") {
    try {
      candidates.push(path.join(app.getPath("userData"), "desktop.env"));
    } catch {
      // app not ready
    }
  }
  /** @type {Record<string, string>} */
  const merged = {};
  for (const candidate of candidates) {
    Object.assign(merged, parseEnvFile(candidate));
  }
  return merged;
}

function validHexSecret(value) {
  return typeof value === "string" && /^[0-9a-f]{64,}$/i.test(value);
}

/**
 * Load or create the internal credentials used by bundled account providers.
 * Upstream model API keys are stored separately and never enter this file.
 *
 * @param {string} configHome
 * @param {boolean} [persist]
 */
function loadOrCreateRuntimeSecrets(configHome, persist = true) {
  const target = path.join(configHome, "runtime-secrets.json");
  if (persist) {
    try {
      const parsed = JSON.parse(fs.readFileSync(target, "utf8"));
      if (
        validHexSecret(parsed.cookieSecret) &&
        validHexSecret(parsed.userSecretsKey) &&
        validHexSecret(parsed.sharedHostToken)
      ) {
        return parsed;
      }
    } catch {
      // First launch or an invalid file: replace it atomically below.
    }
  }

  const secrets = {
    cookieSecret: crypto.randomBytes(32).toString("hex"),
    userSecretsKey: crypto.randomBytes(32).toString("hex"),
    sharedHostToken: crypto.randomBytes(32).toString("hex"),
  };
  if (!persist) return secrets;

  fs.mkdirSync(configHome, { recursive: true });
  const temporary = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(secrets, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  fs.renameSync(temporary, target);
  try {
    fs.chmodSync(target, 0o600);
  } catch {
    // Windows ACLs remain the effective protection when chmod is unavailable.
  }
  return secrets;
}

/**
 * Environment block for stack children (server/host/workers/litellm).
 * Prefers build-injected values; falls back to safe local defaults.
 *
 * @param {Record<string, string>} [extra]
 * @returns {NodeJS.ProcessEnv}
 */
function buildStackEnv(extra = {}) {
  const fileEnv = loadDesktopEnv();
  const app = electronApp();
  let userData = path.join(runtimeRoot(), "userData");
  let persistRuntimeSecrets = false;
  if (app && typeof app.getPath === "function") {
    try {
      userData = app.getPath("userData");
      persistRuntimeSecrets = true;
    } catch {
      // app not ready — keep fallback
    }
  }
  const dataDir = path.join(userData, "data");
  const configHome = path.join(userData, "config");
  const pythonCache = path.join(userData, "pycache", "python312");
  const projectRoot = path.join(runtimeRoot(), "project");
  const userDataRoot = path.join(dataDir, "users");

  const litellmHost = fileEnv.LITELLM_HOST || "127.0.0.1";
  const litellmPort = fileEnv.LITELLM_PORT || String(DEFAULT_LITELLM_PORT);
  const serverHost = fileEnv.OMNIGENT_SERVER_HOST || "127.0.0.1";
  const serverPort = fileEnv.OMNIGENT_SERVER_PORT || String(DEFAULT_SERVER_PORT);
  const litellmUrl = `http://${litellmHost}:${litellmPort}`;
  const serverUrl = `http://${serverHost}:${serverPort}`;
  const setting = (name, fallback = "") =>
    extra[name] ?? fileEnv[name] ?? process.env[name] ?? fallback;
  const authEnabled = setting("OMNIGENT_AUTH_ENABLED", "1");
  const authProvider = setting("OMNIGENT_AUTH_PROVIDER", "cloud_accounts");
  const isolatedAccountsEnabled =
    authEnabled === "1" && ["accounts", "cloud_accounts"].includes(authProvider);
  const runtimeSecrets = isolatedAccountsEnabled
    ? loadOrCreateRuntimeSecrets(configHome, persistRuntimeSecrets)
    : null;

  const model =
    extra.LITELLM_TARGET_MODEL_NAME ||
    fileEnv.LITELLM_TARGET_MODEL_NAME ||
    fileEnv.ANTHROPIC_MODEL ||
    "qwen3-max";
  const managedLlm = Object.prototype.hasOwnProperty.call(extra, "LLM_PROVIDER_CONFIGURED");

  return {
    ...process.env,
    ...fileEnv,
    ...extra,
    OMNIGENT_AUTH_ENABLED: authEnabled,
    OMNIGENT_AUTH_PROVIDER: authProvider,
    OMNIGENT_ACCOUNTS_ENABLED: setting("OMNIGENT_ACCOUNTS_ENABLED", "1"),
    OMNIGENT_ACCOUNTS_REGISTRATION_MODE: setting(
      "OMNIGENT_ACCOUNTS_REGISTRATION_MODE",
      "open",
    ),
    OMNIGENT_ACCOUNTS_BASE_URL: setting("OMNIGENT_ACCOUNTS_BASE_URL", serverUrl),
    OMNIGENT_CLOUD_BACKEND_URL: setting(
      "OMNIGENT_CLOUD_BACKEND_URL",
      "https://capoo.fun/private_fund/backend",
    ),
    OMNIGENT_CLOUD_REQUEST_TIMEOUT_SECONDS: setting(
      "OMNIGENT_CLOUD_REQUEST_TIMEOUT_SECONDS",
      "10",
    ),
    OMNIGENT_CLOUD_UPLOAD_TIMEOUT_SECONDS: setting(
      "OMNIGENT_CLOUD_UPLOAD_TIMEOUT_SECONDS",
      "180",
    ),
    OMNIGENT_CLOUD_REGISTRATION_ENABLED: setting(
      "OMNIGENT_CLOUD_REGISTRATION_ENABLED",
      "1",
    ),
    OMNIGENT_ACCOUNTS_COOKIE_SECRET: setting(
      "OMNIGENT_ACCOUNTS_COOKIE_SECRET",
      runtimeSecrets?.cookieSecret || "",
    ),
    OMNIGENT_USER_SECRETS_KEY: setting(
      "OMNIGENT_USER_SECRETS_KEY",
      runtimeSecrets?.userSecretsKey || "",
    ),
    OMNIGENT_SHARED_HOST_ID: setting(
      "OMNIGENT_SHARED_HOST_ID",
      "host_private_fund_service",
    ),
    OMNIGENT_SHARED_HOST_NAME: setting(
      "OMNIGENT_SHARED_HOST_NAME",
      "private-fund-service",
    ),
    OMNIGENT_SHARED_HOST_TOKEN: setting(
      "OMNIGENT_SHARED_HOST_TOKEN",
      runtimeSecrets?.sharedHostToken || "",
    ),
    OMNIGENT_HOST_ID: setting("OMNIGENT_HOST_ID", "host_private_fund_service"),
    OMNIGENT_HOST_NAME: setting("OMNIGENT_HOST_NAME", "private-fund-service"),
    OMNIGENT_HOST_TOKEN: setting(
      "OMNIGENT_HOST_TOKEN",
      runtimeSecrets?.sharedHostToken || "",
    ),
    OMNIGENT_INTERNAL_LLM_GATEWAY_URL: setting(
      "OMNIGENT_INTERNAL_LLM_GATEWAY_URL",
      `${serverUrl}/internal/private-fund/llm`,
    ),
    OMNIGENT_LOCAL_SINGLE_USER: isolatedAccountsEnabled
      ? "0"
      : setting("OMNIGENT_LOCAL_SINGLE_USER", "1"),
    OMNIGENT_NO_UPDATE_CHECK: setting("OMNIGENT_NO_UPDATE_CHECK", "1"),
    OMNIGENT_WS_ALLOWED_ORIGINS:
      fileEnv.OMNIGENT_WS_ALLOWED_ORIGINS ||
      `${serverUrl},http://localhost:${serverPort},http://127.0.0.1:${serverPort}`,
    OMNIGENT_CONFIG_HOME: fileEnv.OMNIGENT_CONFIG_HOME || configHome,
    OMNIGENT_DATA_DIR: fileEnv.OMNIGENT_DATA_DIR || dataDir,
    PYTHONPYCACHEPREFIX:
      extra.PYTHONPYCACHEPREFIX ||
      fileEnv.PYTHONPYCACHEPREFIX ||
      process.env.PYTHONPYCACHEPREFIX ||
      pythonCache,
    PRIVATE_FUND_PROJECT_ROOT: fileEnv.PRIVATE_FUND_PROJECT_ROOT || projectRoot,
    PRIVATE_FUND_USER_DATA_ROOT: setting("PRIVATE_FUND_USER_DATA_ROOT", userDataRoot),
    PRIVATE_FUND_DATASET_WORKSPACE:
      setting("PRIVATE_FUND_DATASET_WORKSPACE", userDataRoot),
    ANTHROPIC_BASE_URL: managedLlm ? litellmUrl : fileEnv.ANTHROPIC_BASE_URL || litellmUrl,
    ANTHROPIC_AUTH_TOKEN:
      managedLlm
        ? "sk-local-cc-haha"
        : fileEnv.ANTHROPIC_AUTH_TOKEN ||
          fileEnv.OMNIGENT_CLAUDE_API_TOKEN ||
          "sk-local-cc-haha",
    ANTHROPIC_MODEL: model,
    ANTHROPIC_DEFAULT_SONNET_MODEL: model,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
    ANTHROPIC_DEFAULT_OPUS_MODEL: model,
    API_TIMEOUT_MS: fileEnv.API_TIMEOUT_MS || "3000000",
    DISABLE_TELEMETRY: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    OMNIGENT_CLAUDE_NATIVE_AUTO_APPROVE:
      fileEnv.OMNIGENT_CLAUDE_NATIVE_AUTO_APPROVE || "1",
    LITELLM_HOST: litellmHost,
    LITELLM_PORT: litellmPort,
    OMNIGENT_SERVER_HOST: serverHost,
    OMNIGENT_SERVER_PORT: serverPort,
    OMNIGENT_SERVER_URL: serverUrl,
    PYTHONUTF8: "1",
    PYTHONIOENCODING: "utf-8",
  };
}

/**
 * @returns {{ serverUrl: string, litellmUrl: string, serverPort: number, litellmPort: number }}
 */
function stackEndpoints() {
  const env = buildStackEnv();
  const serverPort = Number(env.OMNIGENT_SERVER_PORT || DEFAULT_SERVER_PORT);
  const litellmPort = Number(env.LITELLM_PORT || DEFAULT_LITELLM_PORT);
  return {
    serverUrl: env.OMNIGENT_SERVER_URL || DEFAULT_SERVER_URL,
    litellmUrl: `http://${env.LITELLM_HOST || "127.0.0.1"}:${litellmPort}`,
    serverPort,
    litellmPort,
  };
}

/**
 * Bundled omnigent CLI path if present, else null.
 * @returns {string | null}
 */
function bundledCliPath() {
  const layout = nativeRuntimeLayout();
  const names = process.platform === "win32"
    ? ["omnigent.exe", "omnigent.cmd", "omnigent.bat", "omnigent"]
    : ["omnigent"];
  for (const name of names) {
    const p = path.join(layout.binDir, name);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/**
 * Describe the bundled native runtime without probing the filesystem. Keeping
 * platform-specific paths here prevents the supervisor from growing Windows
 * assumptions as new desktop targets are added.
 *
 * @param {NodeJS.Platform} [platform]
 * @param {string} [root]
 */
function nativeRuntimeLayout(platform = process.platform, root = runtimeRoot()) {
  const pythonHome = path.join(root, "python");
  const binDir = path.join(root, "bin");
  if (platform === "win32") {
    return {
      platform,
      root,
      binDir,
      pythonHome,
      python: path.join(pythonHome, "python.exe"),
      pythonBinDir: path.join(pythonHome, "Scripts"),
      sitePackages: path.join(pythonHome, "Lib", "site-packages"),
      sidecar: path.join(binDir, "claude-haha.exe"),
    };
  }
  if (platform === "darwin") {
    return {
      platform,
      root,
      binDir,
      pythonHome,
      python: path.join(pythonHome, "bin", "python3"),
      pythonBinDir: path.join(pythonHome, "bin"),
      sitePackages: path.join(pythonHome, "lib", "python3.12", "site-packages"),
      sidecar: path.join(binDir, "claude-haha"),
    };
  }
  return {
    platform,
    root,
    binDir,
    pythonHome,
    python: path.join(pythonHome, "bin", "python3"),
    pythonBinDir: path.join(pythonHome, "bin"),
    sitePackages: path.join(pythonHome, "lib", "python3.12", "site-packages"),
    sidecar: path.join(binDir, "claude-haha"),
  };
}

/**
 * Path to bundled python interpreter, or null.
 * @returns {string | null}
 */
function bundledPythonPath() {
  const layout = nativeRuntimeLayout();
  if (fs.existsSync(layout.python)) return layout.python;
  return null;
}

/** @returns {string} */
function bundledSitePackagesPath() {
  return nativeRuntimeLayout().sitePackages;
}

/** @returns {string} */
function bundledSidecarPath() {
  return nativeRuntimeLayout().sidecar;
}

/**
 * True when a usable runtime tree exists (project + python/bin/wsl-bridge).
 * @returns {boolean}
 */
function hasBundledRuntime() {
  const root = runtimeRoot();
  if (!fs.existsSync(root)) return false;
  const hasProject =
    fs.existsSync(path.join(root, "project", "FinSagent", "data_pipeline")) ||
    fs.existsSync(path.join(root, "project", "omnigent"));
  // Product zero-config requires native python.exe (not WSL).
  return hasProject && Boolean(bundledPythonPath());
}

module.exports = {
  DEFAULT_SERVER_URL,
  DEFAULT_LITELLM_URL,
  DEFAULT_SERVER_PORT,
  DEFAULT_LITELLM_PORT,
  getDesktopMode,
  isBundledMode,
  runtimeRoot,
  parseEnvFile,
  loadDesktopEnv,
  loadOrCreateRuntimeSecrets,
  buildStackEnv,
  stackEndpoints,
  nativeRuntimeLayout,
  bundledCliPath,
  bundledPythonPath,
  bundledSitePackagesPath,
  bundledSidecarPath,
  hasBundledRuntime,
};
