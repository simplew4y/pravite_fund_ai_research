// Process supervisor for zero-config desktop: starts/stops the private-fund
// local stack (LiteLLM, Omnigent server, host, tracking/valuation workers).
//
// Product path is ALWAYS native bundled runtime under resources/runtime
// (Windows embeddable Python + project). No WSL / system Python required.
//
// Optional dev fallback: DESKTOP_ALLOW_WSL_FALLBACK=1 enables the old WSL bridge.

"use strict";

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const desktop = require("./desktop_mode");

const KILL_GRACE_MS = 4000;
const HEALTH_POLL_MS = 1000;
const DEFAULT_START_TIMEOUT_MS = 180000;

/** @type {Map<string, import("child_process").ChildProcess>} */
const children = new Map();

/** @type {string | null} */
let strategy = null;

/** @type {((msg: string) => void) | null} */
let statusListener = null;

/**
 * @param {((msg: string) => void) | null} cb
 */
function onStatus(cb) {
  statusListener = typeof cb === "function" ? cb : null;
}

/**
 * @param {string} msg
 */
function emitStatus(msg) {
  if (statusListener) {
    try {
      statusListener(msg);
    } catch {
      // ignore listener errors
    }
  }
}

/**
 * @param {string} url
 * @param {number} [timeoutMs]
 * @returns {Promise<boolean>}
 */
function httpOk(url, timeoutMs = 2500) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    try {
      const req = http.get(url, { timeout: timeoutMs }, (res) => {
        res.resume();
        done(Boolean(res.statusCode && res.statusCode >= 200 && res.statusCode < 500));
      });
      req.on("error", () => done(false));
      req.on("timeout", () => {
        req.destroy();
        done(false);
      });
    } catch {
      done(false);
    }
  });
}

/**
 * @param {string} url
 * @returns {Promise<boolean>}
 */
async function litellmHealthy(url) {
  return (
    (await httpOk(`${url}/health/liveliness`)) || (await httpOk(`${url}/health`))
  );
}

/**
 * @param {string} url
 * @returns {Promise<boolean>}
 */
async function serverHealthy(url) {
  return httpOk(`${url}/health`);
}

/**
 * @param {import("child_process").ChildProcess} child
 * @returns {Promise<void>}
 */
function stopChild(child) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null) {
      resolve();
      return;
    }
    const t = setTimeout(() => {
      if (child.exitCode === null) {
        try {
          if (process.platform === "win32" && child.pid) {
            spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
              stdio: "ignore",
              windowsHide: true,
            });
          } else {
            child.kill("SIGKILL");
          }
        } catch {
          // ignore
        }
      }
    }, KILL_GRACE_MS);
    if (typeof t.unref === "function") t.unref();
    child.once("exit", () => {
      clearTimeout(t);
      resolve();
    });
    try {
      if (process.platform === "win32" && child.pid) {
        spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
          stdio: "ignore",
          windowsHide: true,
        });
      } else {
        child.kill("SIGTERM");
      }
    } catch {
      resolve();
    }
  });
}

/**
 * @param {string} name
 * @param {string} chunk
 */
function appendServiceLog(name, chunk) {
  try {
    const { app } = require("electron");
    const logDir = path.join(app.getPath("userData"), "logs");
    fs.mkdirSync(logDir, { recursive: true });
    const file = path.join(logDir, `${name}.log`);
    fs.appendFileSync(file, chunk, "utf8");
    const st = fs.statSync(file);
    if (st.size > 2 * 1024 * 1024) {
      const text = fs.readFileSync(file, "utf8");
      fs.writeFileSync(file, text.slice(-1024 * 1024), "utf8");
    }
  } catch {
    // logging is best-effort
  }
}

/**
 * @param {string} name
 * @param {string} command
 * @param {string[]} args
 * @param {NodeJS.ProcessEnv} env
 * @param {string} [cwd]
 * @returns {import("child_process").ChildProcess}
 */
function spawnTracked(name, command, args, env, cwd) {
  const child = spawn(command, args, {
    env,
    cwd: cwd || undefined,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    // Direct .exe / python.exe — no shell. .cmd only if we ever need it.
    shell: false,
  });
  children.set(name, child);
  child.stdout?.on("data", (buf) => appendServiceLog(name, buf.toString()));
  child.stderr?.on("data", (buf) => appendServiceLog(name, buf.toString()));
  child.once("exit", (code, signal) => {
    appendServiceLog(name, `\n[exit code=${code} signal=${signal}]\n`);
    if (children.get(name) === child) children.delete(name);
  });
  child.once("error", (err) => {
    appendServiceLog(name, `\n[spawn error] ${err && err.message ? err.message : err}\n`);
  });
  return child;
}

/**
 * @param {string} label
 * @param {() => Promise<boolean>} check
 * @param {number} timeoutMs
 */
async function waitUntil(label, check, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await check()) {
      emitStatus(`${label} ready`);
      return true;
    }
    emitStatus(`Waiting for ${label}…`);
    await new Promise((r) => setTimeout(r, HEALTH_POLL_MS));
  }
  return false;
}

/**
 * True when resources/runtime has Windows native stack.
 * @returns {boolean}
 */
function hasNativeRuntime() {
  const root = desktop.runtimeRoot();
  const py = desktop.bundledPythonPath();
  const project = path.join(root, "project");
  const marker = path.join(root, "NATIVE_STACK");
  const hasProject =
    fs.existsSync(path.join(project, "FinSagent", "data_pipeline")) ||
    fs.existsSync(path.join(project, "omnigent"));
  return Boolean(py && hasProject && (fs.existsSync(marker) || true));
}

/**
 * @returns {"native" | "wsl" | null}
 */
function detectStrategy() {
  if (hasNativeRuntime()) return "native";
  // Dev-only escape hatch — not used for end-user zero-config packages.
  if (
    process.env.DESKTOP_ALLOW_WSL_FALLBACK === "1" &&
    process.platform === "win32"
  ) {
    const wslScript = path.join(desktop.runtimeRoot(), "bin", "start_stack_wsl.sh");
    if (fs.existsSync(wslScript)) return "wsl";
  }
  return null;
}

/**
 * Build env for native child processes; force data under Electron userData.
 * @param {NodeJS.ProcessEnv} env
 * @param {string} root
 * @param {string} project
 */
function nativeChildEnv(env, root, project) {
  const pyHome = path.join(root, "python");
  const sitePackages = path.join(pyHome, "Lib", "site-packages");
  // claude-agent-sdk ships a Windows claude.exe under _bundled — host
  // harness readiness (claude-native) requires `claude` on PATH.
  const claudeBundled = path.join(
    sitePackages,
    "claude_agent_sdk",
    "_bundled",
  );
  const pathParts = [
    path.join(root, "bin"),
    claudeBundled,
    pyHome,
    path.join(pyHome, "Scripts"),
    env.PATH || "",
  ];
  const pythonPath = [
    project,
    path.join(project, "src"),
    path.join(project, "omnigent"),
    sitePackages,
    env.PYTHONPATH || "",
  ]
    .filter(Boolean)
    .join(path.delimiter);

  // LiteLLM is the Anthropic-compatible gateway for Claude Code on desktop.
  const litellmHost = env.LITELLM_HOST || "127.0.0.1";
  const litellmPort = env.LITELLM_PORT || "4000";
  const litellmUrl = `http://${litellmHost}:${litellmPort}`;

  return {
    ...env,
    PRIVATE_FUND_PROJECT_ROOT: env.PRIVATE_FUND_PROJECT_ROOT || project,
    PYTHONPATH: pythonPath,
    PATH: pathParts.join(path.delimiter),
    PYTHONUTF8: "1",
    PYTHONIOENCODING: "utf-8",
    // Prevent children from trying to open a browser
    BROWSER: "none",
    // Claude Code / claude-native → LiteLLM (no Anthropic login required)
    ANTHROPIC_BASE_URL: env.ANTHROPIC_BASE_URL || litellmUrl,
    ANTHROPIC_AUTH_TOKEN:
      env.ANTHROPIC_AUTH_TOKEN || env.OMNIGENT_CLAUDE_API_TOKEN || "sk-local-cc-haha",
    ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY || "", // prefer AUTH_TOKEN; unset real key
    ANTHROPIC_MODEL: env.ANTHROPIC_MODEL || env.LITELLM_TARGET_MODEL_NAME || "qwen3-max",
    ANTHROPIC_DEFAULT_SONNET_MODEL:
      env.ANTHROPIC_DEFAULT_SONNET_MODEL || env.ANTHROPIC_MODEL || "qwen3-max",
    ANTHROPIC_DEFAULT_HAIKU_MODEL:
      env.ANTHROPIC_DEFAULT_HAIKU_MODEL || env.ANTHROPIC_MODEL || "qwen3-max",
    ANTHROPIC_DEFAULT_OPUS_MODEL:
      env.ANTHROPIC_DEFAULT_OPUS_MODEL || env.ANTHROPIC_MODEL || "qwen3-max",
    CLAUDE_CODE_USE_BEDROCK: env.CLAUDE_CODE_USE_BEDROCK || "0",
    DISABLE_TELEMETRY: env.DISABLE_TELEMETRY || "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:
      env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC || "1",
    OMNIGENT_CLAUDE_NATIVE_AUTO_APPROVE:
      env.OMNIGENT_CLAUDE_NATIVE_AUTO_APPROVE || "1",
  };
}

/**
 * @param {NodeJS.ProcessEnv} env
 * @param {{ serverUrl: string, litellmUrl: string }} endpoints
 */
async function startNative(env, endpoints) {
  const root = desktop.runtimeRoot();
  const project = path.join(root, "project");
  const python = desktop.bundledPythonPath();
  if (!python || !fs.existsSync(python)) {
    return {
      ok: false,
      error:
        "Bundled Python runtime missing. Rebuild with scripts/desktop/assemble_win_native.sh",
    };
  }

  const env2 = nativeChildEnv(env, root, project);
  // Ensure dataset dirs under userData exist
  try {
    if (env2.PRIVATE_FUND_DATASET_WORKSPACE) {
      fs.mkdirSync(env2.PRIVATE_FUND_DATASET_WORKSPACE, { recursive: true });
    }
    if (env2.OMNIGENT_DATA_DIR) fs.mkdirSync(env2.OMNIGENT_DATA_DIR, { recursive: true });
    if (env2.OMNIGENT_CONFIG_HOME) fs.mkdirSync(env2.OMNIGENT_CONFIG_HOME, { recursive: true });
  } catch {
    // ignore
  }

  const litellmConfig = path.join(root, "config", "litellm.yaml");
  const host = env2.LITELLM_HOST || "127.0.0.1";
  const litellmPort = env2.LITELLM_PORT || "4000";
  const serverHost = env2.OMNIGENT_SERVER_HOST || "127.0.0.1";
  const serverPort = env2.OMNIGENT_SERVER_PORT || "6767";
  const omnigentCwd = fs.existsSync(path.join(project, "omnigent"))
    ? path.join(project, "omnigent")
    : project;

  emitStatus("Starting LiteLLM…");
  if (fs.existsSync(litellmConfig)) {
    // Portable embeddable Python: `python -m litellm` has no __main__.
    // `Scripts/litellm.exe` often fails under embeddable layouts.
    // Use proxy_cli (verified on Windows: /health/liveliness → "I'm alive!").
    spawnTracked(
      "litellm",
      python,
      [
        "-m",
        "litellm.proxy.proxy_cli",
        "--config",
        litellmConfig,
        "--host",
        host,
        "--port",
        String(litellmPort),
      ],
      env2,
      project,
    );
  } else {
    return { ok: false, error: `LiteLLM config missing: ${litellmConfig}` };
  }

  if (!(await waitUntil("LiteLLM", () => litellmHealthy(endpoints.litellmUrl), DEFAULT_START_TIMEOUT_MS))) {
    return {
      ok: false,
      error: "LiteLLM did not become healthy. Check logs in app data folder.",
    };
  }

  emitStatus("Starting Omnigent server…");
  spawnTracked(
    "server",
    python,
    [
      "-m",
      "omnigent",
      "server",
      "--host",
      serverHost,
      "--port",
      String(serverPort),
      "--no-open",
    ],
    env2,
    omnigentCwd,
  );

  if (!(await waitUntil("Omnigent Server", () => serverHealthy(endpoints.serverUrl), DEFAULT_START_TIMEOUT_MS))) {
    return {
      ok: false,
      error: "Omnigent server did not become healthy. Check logs in app data folder.",
    };
  }

  emitStatus("Starting background workers…");
  spawnTracked(
    "tracking",
    python,
    ["-m", "omnigent.server.private_fund_tracking_worker"],
    env2,
    omnigentCwd,
  );
  spawnTracked(
    "valuation",
    python,
    ["-m", "omnigent.server.private_fund_valuation_worker"],
    {
      ...env2,
      PDF_RESEARCH_LLM_BASE_URL: `${endpoints.litellmUrl}/v1`,
    },
    omnigentCwd,
  );

  emitStatus("Starting Omnigent host…");
  spawnTracked(
    "host",
    python,
    ["-m", "omnigent", "host", "--server", endpoints.serverUrl, "--non-interactive"],
    env2,
    omnigentCwd,
  );

  await new Promise((r) => setTimeout(r, 2000));
  return { ok: true, serverUrl: endpoints.serverUrl };
}

/**
 * Optional WSL bridge — only if DESKTOP_ALLOW_WSL_FALLBACK=1.
 * @param {NodeJS.ProcessEnv} env
 * @param {{ serverUrl: string, litellmUrl: string }} endpoints
 */
async function startWsl(env, endpoints) {
  const distro = env.DESKTOP_WSL_DISTRO || "Ubuntu";
  const projectRoot =
    env.DESKTOP_WSL_PROJECT_ROOT || "/home/code/pravite_fund_ai_research";
  const manage = `${projectRoot}/scripts/manage_omnigent_services.sh`;
  const remote = [
    "set -euo pipefail",
    `export PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"`,
    `cd ${JSON.stringify(projectRoot)}`,
    `bash ${JSON.stringify(manage)} start`,
  ].join("; ");
  emitStatus("Starting services via WSL (dev fallback)…");
  const child = spawnTracked(
    "wsl-stack",
    "wsl.exe",
    ["-d", distro, "-e", "bash", "-lc", remote],
    { ...env, OMNIGENT_SERVER_URL: endpoints.serverUrl },
  );
  await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), DEFAULT_START_TIMEOUT_MS);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(undefined);
    });
  });
  if (!(await waitUntil("Omnigent Server", () => serverHealthy(endpoints.serverUrl), DEFAULT_START_TIMEOUT_MS))) {
    return {
      ok: false,
      error: "WSL fallback stack did not become healthy.",
    };
  }
  return { ok: true, serverUrl: endpoints.serverUrl };
}

/**
 * Ensure the local stack is up. Idempotent if already healthy.
 * @returns {Promise<{ ok: boolean, serverUrl?: string, error?: string, strategy?: string }>}
 */
async function ensureStackRunning() {
  const endpoints = desktop.stackEndpoints();
  // Only reuse an already-running server if WE started it (or user opts in).
  // Otherwise a leftover WSL/dev stack on :6767 would show foreign data and
  // look like a "silent fallback" — which is not zero-config native mode.
  const reuseExisting =
    process.env.DESKTOP_REUSE_EXISTING_SERVER === "1" || children.size > 0;
  if (reuseExisting && (await serverHealthy(endpoints.serverUrl))) {
    emitStatus("Server already running (owned by this app)");
    strategy = strategy || "existing";
    return { ok: true, serverUrl: endpoints.serverUrl, strategy };
  }
  if (!reuseExisting && (await serverHealthy(endpoints.serverUrl))) {
    emitStatus(
      "Port busy with another local server; starting owned stack may fail if ports clash…",
    );
  }

  const env = desktop.buildStackEnv();
  try {
    if (env.OMNIGENT_DATA_DIR) fs.mkdirSync(env.OMNIGENT_DATA_DIR, { recursive: true });
    if (env.OMNIGENT_CONFIG_HOME) fs.mkdirSync(env.OMNIGENT_CONFIG_HOME, { recursive: true });
    if (env.PRIVATE_FUND_DATASET_WORKSPACE) {
      fs.mkdirSync(env.PRIVATE_FUND_DATASET_WORKSPACE, { recursive: true });
    }
  } catch {
    // ignore
  }

  strategy = detectStrategy();
  if (!strategy) {
    return {
      ok: false,
      error:
        "No bundled native runtime found (python.exe + project). " +
        "This package must be built with scripts/desktop/assemble_win_native.sh. " +
        "A clean PC does not need WSL/Python — rebuild the installer with the native stack.",
    };
  }

  emitStatus(`Using start strategy: ${strategy}`);
  if (strategy === "wsl") {
    return { ...(await startWsl(env, endpoints)), strategy };
  }
  return { ...(await startNative(env, endpoints)), strategy };
}

/**
 * Stop everything this supervisor started.
 * @returns {Promise<void>}
 */
async function shutdownStack() {
  emitStatus("Stopping services…");
  const names = [...children.keys()];
  await Promise.all(names.map((n) => stopChild(children.get(n))));
  children.clear();
  strategy = null;
}

module.exports = {
  ensureStackRunning,
  shutdownStack,
  onStatus,
  httpOk,
  litellmHealthy,
  serverHealthy,
  detectStrategy,
  hasNativeRuntime,
  _children: children,
};
