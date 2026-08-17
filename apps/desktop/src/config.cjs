"use strict";

const fs = require("node:fs");
const path = require("node:path");

const CONFIGURATION_KEYS = new Set([
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_BASE_URL",
  "AWS_ACCESS_KEY_ID",
  "AWS_REGION",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "LOG_LEVEL",
  "NODE_EXTRA_CA_CERTS",
  "NO_PROXY",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "PRIVATE_FUND_AGENT_SKILL_PATHS",
  "PRIVATE_FUND_AGENT_SYSTEM_PROMPT",
]);

const CONFIGURATION_TEMPLATE = `# Private Fund AI Research desktop configuration
# Restart the application after changing this file.
# Configure one supported model provider. Never share this file.

# OPENAI_API_KEY=
# OPENAI_BASE_URL=
# ANTHROPIC_API_KEY=
# ANTHROPIC_BASE_URL=
# GOOGLE_API_KEY=
# GEMINI_API_KEY=

# Optional network settings
# HTTPS_PROXY=
# HTTP_PROXY=
# NO_PROXY=127.0.0.1,localhost
`;

function unquote(value) {
  if (value.length < 2) return value;
  const first = value[0];
  const last = value[value.length - 1];
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    return value.slice(1, -1);
  }
  return value;
}

function parseDesktopEnvironment(source) {
  const result = {};
  for (const rawLine of source.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const normalized = line.startsWith("export ") ? line.slice(7).trim() : line;
    const separator = normalized.indexOf("=");
    if (separator <= 0) continue;
    const key = normalized.slice(0, separator).trim();
    if (!CONFIGURATION_KEYS.has(key)) continue;
    result[key] = unquote(normalized.slice(separator + 1).trim());
  }
  return result;
}

function ensureDesktopConfiguration(filename) {
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  if (!fs.existsSync(filename)) {
    fs.writeFileSync(filename, CONFIGURATION_TEMPLATE, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
  }
}

function readDesktopEnvironment(filename) {
  ensureDesktopConfiguration(filename);
  return parseDesktopEnvironment(fs.readFileSync(filename, "utf8"));
}

function resolveDesktopPaths({ isPackaged, resourcesPath, userData, sourceDirectory }) {
  const repositoryRoot = path.resolve(sourceDirectory, "../../..");
  const runtimeRoot = isPackaged
    ? path.join(resourcesPath, "runtime")
    : repositoryRoot;
  const webRoot = isPackaged
    ? path.join(resourcesPath, "web")
    : path.join(repositoryRoot, "omnigent", "web", "dist");
  const computeRoot = isPackaged
    ? path.join(resourcesPath, "compute")
    : path.join(repositoryRoot, "python", "compute-worker");
  const bundledCompute = path.join(computeRoot, "private-fund-compute-worker");
  const venvPython = path.join(computeRoot, ".venv", "bin", "python");

  return {
    repositoryRoot,
    runtimeRoot,
    webRoot,
    computeExecutable: isPackaged
      ? bundledCompute
      : fs.existsSync(venvPython)
        ? venvPython
        : "python3",
    computeWorkerEntry: path.join(computeRoot, "worker.py"),
    agentWorkerEntry: path.join(runtimeRoot, "apps", "agent-worker", "dist", "main.js"),
    apiEntry: path.join(runtimeRoot, "apps", "api", "dist", "main.js"),
    jobWorkerEntry: path.join(runtimeRoot, "apps", "job-worker", "dist", "main.js"),
    obsidianWorkerEntry: path.join(
      runtimeRoot,
      "apps",
      "obsidian-worker",
      "dist",
      "main.js",
    ),
    dataRoot: path.join(userData, "data"),
    controlDatabase: path.join(userData, "data", "control.sqlite3"),
    logDirectory: path.join(userData, "logs"),
    configurationFile: path.join(userData, "desktop.env"),
    runtimeStateFile: path.join(userData, "desktop-runtime.json"),
  };
}

function buildServiceEnvironment({
  ambientEnvironment,
  configuredEnvironment,
  paths,
  apiPort,
  obsidianPort,
}) {
  return {
    ...ambientEnvironment,
    ...configuredEnvironment,
    ELECTRON_RUN_AS_NODE: "1",
    PRIVATE_FUND_API_HOST: "127.0.0.1",
    PRIVATE_FUND_API_PORT: String(apiPort),
    PRIVATE_FUND_AUTH_MODE: "development",
    PRIVATE_FUND_DATA_ROOT: paths.dataRoot,
    PRIVATE_FUND_CONTROL_DB: paths.controlDatabase,
    PRIVATE_FUND_AGENT_WORKER_ENTRY: paths.agentWorkerEntry,
    PRIVATE_FUND_PYTHON_EXECUTABLE: paths.computeExecutable,
    PRIVATE_FUND_COMPUTE_WORKER_ENTRY: paths.computeWorkerEntry,
    PRIVATE_FUND_WEB_ROOT: paths.webRoot,
    PRIVATE_FUND_OBSIDIAN_HEALTH_HOST: "127.0.0.1",
    PRIVATE_FUND_OBSIDIAN_HEALTH_PORT: String(obsidianPort),
    NO_PROXY: ["127.0.0.1", "localhost", configuredEnvironment.NO_PROXY]
      .filter(Boolean)
      .join(","),
  };
}

module.exports = {
  CONFIGURATION_TEMPLATE,
  buildServiceEnvironment,
  ensureDesktopConfiguration,
  parseDesktopEnvironment,
  readDesktopEnvironment,
  resolveDesktopPaths,
};
