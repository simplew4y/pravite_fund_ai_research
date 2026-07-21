// Desktop packaging mode helpers.
//
// bundled  — install-and-run: Electron owns the local private-fund stack
//            (LiteLLM + Omnigent server/host/workers) and never asks for a
//            server URL.
// thin     — upstream Omnigent behaviour: connect to a user-supplied server.

"use strict";

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
  if (app && typeof app.getPath === "function") {
    try {
      userData = app.getPath("userData");
    } catch {
      // app not ready — keep fallback
    }
  }
  const dataDir = path.join(userData, "data");
  const configHome = path.join(userData, "config");
  const projectRoot = path.join(runtimeRoot(), "project");
  const datasetWorkspace = path.join(dataDir, "private_fund_datasets");

  const litellmHost = fileEnv.LITELLM_HOST || "127.0.0.1";
  const litellmPort = fileEnv.LITELLM_PORT || String(DEFAULT_LITELLM_PORT);
  const serverHost = fileEnv.OMNIGENT_SERVER_HOST || "127.0.0.1";
  const serverPort = fileEnv.OMNIGENT_SERVER_PORT || String(DEFAULT_SERVER_PORT);
  const litellmUrl = `http://${litellmHost}:${litellmPort}`;
  const serverUrl = `http://${serverHost}:${serverPort}`;

  const model =
    fileEnv.LITELLM_TARGET_MODEL_NAME ||
    fileEnv.ANTHROPIC_MODEL ||
    "qwen3-max";

  return {
    ...process.env,
    ...fileEnv,
    ...extra,
    OMNIGENT_AUTH_ENABLED: fileEnv.OMNIGENT_AUTH_ENABLED || "0",
    OMNIGENT_LOCAL_SINGLE_USER: fileEnv.OMNIGENT_LOCAL_SINGLE_USER || "1",
    OMNIGENT_NO_UPDATE_CHECK: fileEnv.OMNIGENT_NO_UPDATE_CHECK || "1",
    OMNIGENT_WS_ALLOWED_ORIGINS:
      fileEnv.OMNIGENT_WS_ALLOWED_ORIGINS ||
      `${serverUrl},http://localhost:${serverPort},http://127.0.0.1:${serverPort}`,
    OMNIGENT_CONFIG_HOME: fileEnv.OMNIGENT_CONFIG_HOME || configHome,
    OMNIGENT_DATA_DIR: fileEnv.OMNIGENT_DATA_DIR || dataDir,
    PRIVATE_FUND_PROJECT_ROOT: fileEnv.PRIVATE_FUND_PROJECT_ROOT || projectRoot,
    PRIVATE_FUND_DATASET_WORKSPACE:
      fileEnv.PRIVATE_FUND_DATASET_WORKSPACE || datasetWorkspace,
    ANTHROPIC_BASE_URL: fileEnv.ANTHROPIC_BASE_URL || litellmUrl,
    ANTHROPIC_AUTH_TOKEN:
      fileEnv.ANTHROPIC_AUTH_TOKEN ||
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
  const root = runtimeRoot();
  const names =
    process.platform === "win32"
      ? ["omnigent.exe", "omnigent.cmd", "omnigent.bat", "omnigent"]
      : ["omnigent"];
  for (const name of names) {
    const p = path.join(root, "bin", name);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/**
 * Path to bundled python interpreter, or null.
 * @returns {string | null}
 */
function bundledPythonPath() {
  const root = runtimeRoot();
  const names =
    process.platform === "win32"
      ? ["python.exe", "python"]
      : ["python3", "python"];
  for (const name of names) {
    const p = path.join(root, "python", name);
    if (fs.existsSync(p)) return p;
  }
  return null;
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
  buildStackEnv,
  stackEndpoints,
  bundledCliPath,
  bundledPythonPath,
  hasBundledRuntime,
};
