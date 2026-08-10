// Process supervisor for zero-config desktop: starts/stops the private-fund
// local stack (LiteLLM, Omnigent server, host, tracking/valuation workers).
//
// Product path is ALWAYS a native bundled runtime under resources/runtime
// (Windows or macOS Python + project). No system Python is required.
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
const LLM_TEST_TIMEOUT_MS = 75000;
const LOCAL_MODEL_ALIAS = "private-fund-default";

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

function llmRuntimeEnv(config) {
  if (!config) return {};
  return {
    LITELLM_TARGET_PROVIDER: config.provider || "openai",
    LITELLM_TARGET_API_BASE: config.baseUrl || "http://127.0.0.1:9",
    LITELLM_TARGET_API_KEY: config.apiKey || "",
    LITELLM_TARGET_MODEL_NAME: config.model || "not-configured",
    LLM_PROVIDER_CONFIGURED: config.configured ? "1" : "0",
  };
}

function yamlString(value) {
  return JSON.stringify(String(value));
}

function writeGeneratedLiteLlmConfig(env) {
  const configHome = env.OMNIGENT_CONFIG_HOME || path.join(desktop.runtimeRoot(), "userData");
  const targetModel = `${env.LITELLM_TARGET_PROVIDER || "openai"}/${env.LITELLM_TARGET_MODEL_NAME || "not-configured"}`;
  const exposedNames = [
    LOCAL_MODEL_ALIAS,
    "claude-sonnet-4-6",
    "claude-sonnet-4-5",
    "claude-opus-4-6",
    "claude-haiku-4-5",
  ];
  const lines = ["model_list:"];
  for (const name of [...new Set(exposedNames)]) {
    lines.push(
      `  - model_name: ${yamlString(name)}`,
      "    litellm_params:",
      `      model: ${yamlString(targetModel)}`,
      "      api_base: os.environ/LITELLM_TARGET_API_BASE",
      "      api_key: os.environ/LITELLM_TARGET_API_KEY",
    );
  }
  lines.push("", "litellm_settings:", "  drop_params: true", "  request_timeout: 600", "");
  fs.mkdirSync(configHome, { recursive: true });
  const target = path.join(configHome, "litellm.generated.yaml");
  fs.writeFileSync(target, lines.join("\n"), "utf8");
  return target;
}

function testLlmConfig(config) {
  const python = desktop.bundledPythonPath();
  if (!python || !fs.existsSync(python)) {
    return Promise.resolve({ ok: false, error: "runtime", detail: "Bundled Python runtime is unavailable." });
  }
  const script = [
    "import json, sys",
    "from litellm import completion",
    "from litellm.anthropic_interface.messages import create as anthropic_create",
    "data = json.load(sys.stdin)",
    "try:",
    "    model = f\"{data['provider']}/{data['model']}\"",
    "    if data.get('preset') == 'custom':",
    "        tools = [{'name':'connection_check','description':'Return the supplied value. Use this tool before answering.','input_schema':{'type':'object','properties':{'value':{'type':'string'}},'required':['value']}}]",
    "        messages = [{'role':'user','content':'Call connection_check with value OK, then answer with its result.'}]",
    "        first = anthropic_create(model=model, api_base=data['baseUrl'], api_key=data['apiKey'], messages=messages, tools=tools, thinking={'type':'enabled','budget_tokens':128}, max_tokens=256, timeout=30, drop_params=True)",
    "        first = first if isinstance(first, dict) else first.model_dump()",
    "        blocks = first.get('content') or []",
    "        tool = next((block for block in blocks if block.get('type') == 'tool_use'), None)",
    "        if not tool: raise RuntimeError('Model did not complete the Agent tool-call compatibility check.')",
    "        messages.extend([{'role':'assistant','content':blocks},{'role':'user','content':[{'type':'tool_result','tool_use_id':tool['id'],'content':'OK'}]}])",
    "        second = anthropic_create(model=model, api_base=data['baseUrl'], api_key=data['apiKey'], messages=messages, tools=tools, thinking={'type':'enabled','budget_tokens':128}, max_tokens=256, timeout=30, drop_params=True)",
    "        second = second if isinstance(second, dict) else second.model_dump()",
    "        content = ''.join(block.get('text', '') for block in (second.get('content') or []) if block.get('type') == 'text')",
    "    else:",
    "        response = completion(model=model, api_base=data['baseUrl'], api_key=data['apiKey'], messages=[{'role':'user','content':'Reply with OK only. Do not explain or reason.'}], max_tokens=128, timeout=30, drop_params=True)",
    "        content = response.choices[0].message.content if response.choices else None",
    "    if not isinstance(content, str) or not content.strip(): raise RuntimeError('Model returned no visible text.')",
    "    print(json.dumps({'ok': True}))",
    "except Exception as exc:",
    "    status = getattr(exc, 'status_code', None)",
    "    message = str(exc)",
    "    low = message.lower()",
    "    kind = 'connection' if any(x in low for x in ('connect', 'network', 'dns', 'refused')) else 'provider'",
    "    if status in (401, 403) or any(x in low for x in ('unauthorized', 'authentication', 'invalid api key')): kind = 'authentication'",
    "    elif status == 404 or ('model' in low and any(x in low for x in ('not found', 'does not exist', 'invalid'))): kind = 'model'",
    "    elif 'timeout' in low: kind = 'timeout'",
    "    print(json.dumps({'ok': False, 'error': kind, 'detail': message[:600]}))",
  ].join("\n");
  return new Promise((resolve) => {
    const child = spawn(python, ["-c", script], {
      cwd: desktop.runtimeRoot(),
      env: { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8", LITELLM_LOG: "ERROR" },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
      finish({
        ok: false,
        error: "timeout",
        detail: `The provider did not complete the compatibility check within ${LLM_TEST_TIMEOUT_MS / 1000} seconds.`,
      });
    }, LLM_TEST_TIMEOUT_MS);
    child.stdout.on("data", (chunk) => { stdout = (stdout + chunk.toString("utf8")).slice(-8000); });
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk.toString("utf8")).slice(-2000); });
    child.on("error", (error) => finish({ ok: false, error: "runtime", detail: error.message }));
    child.on("exit", () => {
      const lines = stdout.trim().split(/\r?\n/).reverse();
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line);
          const key = config.apiKey || "";
          if (parsed.detail && key) parsed.detail = String(parsed.detail).split(key).join("***");
          finish(parsed);
          return;
        } catch { /* LiteLLM may emit non-JSON diagnostics before our result. */ }
      }
      const key = config.apiKey || "";
      const detail = key ? stderr.trim().split(key).join("***") : stderr.trim();
      finish({ ok: false, error: "runtime", detail: detail || "Model connection test failed." });
    });
    child.stdin.end(JSON.stringify(config));
  });
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
 * True when resources/runtime has a complete native stack.
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
  return Boolean(py && hasProject && fs.existsSync(marker));
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
  const layout = desktop.nativeRuntimeLayout(process.platform, root);
  const pathParts = [
    layout.binDir,
    layout.pythonHome,
    layout.pythonBinDir,
    env.PATH || "",
  ];
  const pythonPath = [
    project,
    path.join(project, "src"),
    path.join(project, "omnigent"),
    layout.sitePackages,
    env.PYTHONPATH || "",
  ]
    .filter(Boolean)
    .join(path.delimiter);

  // LiteLLM is the Anthropic-compatible gateway for Claude Code on desktop.
  const litellmHost = env.LITELLM_HOST || "127.0.0.1";
  const litellmPort = env.LITELLM_PORT || "4000";
  const litellmUrl = `http://${litellmHost}:${litellmPort}`;
  const noProxyEntries = String(env.NO_PROXY || env.no_proxy || "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  for (const loopback of ["127.0.0.1", "localhost", "::1"]) {
    if (!noProxyEntries.some((entry) => entry.toLowerCase() === loopback)) {
      noProxyEntries.push(loopback);
    }
  }
  const noProxy = noProxyEntries.join(",");
  const localOpenAiUrl = `${litellmUrl}/v1`;
  const localGatewayKey = "sk-local-cc-haha";
  const model = LOCAL_MODEL_ALIAS;

  return {
    ...env,
    PRIVATE_FUND_PROJECT_ROOT: env.PRIVATE_FUND_PROJECT_ROOT || project,
    PYTHONPATH: pythonPath,
    PATH: pathParts.join(path.delimiter),
    PYTHONUTF8: "1",
    PYTHONIOENCODING: "utf-8",
    PYTHONPYCACHEPREFIX:
      env.PYTHONPYCACHEPREFIX ||
      path.join(env.OMNIGENT_CONFIG_HOME || project, "pycache", "python312"),
    NO_PROXY: noProxy,
    no_proxy: noProxy,
    // Prevent children from trying to open a browser
    BROWSER: "none",
    // Claude Code / claude-native → LiteLLM (no Anthropic login required)
    ANTHROPIC_BASE_URL: env.ANTHROPIC_BASE_URL || litellmUrl,
    ANTHROPIC_AUTH_TOKEN:
      env.ANTHROPIC_AUTH_TOKEN || env.OMNIGENT_CLAUDE_API_TOKEN || localGatewayKey,
    ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY || "", // prefer AUTH_TOKEN; unset real key
    ANTHROPIC_MODEL: model,
    ANTHROPIC_DEFAULT_SONNET_MODEL: model,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
    ANTHROPIC_DEFAULT_OPUS_MODEL: model,
    OPENAI_BASE_URL: localOpenAiUrl,
    OPENAI_API_KEY: localGatewayKey,
    LLM_BASE_URL: localOpenAiUrl,
    LLM_API_KEY: localGatewayKey,
    LLM_MODEL_NAME: model,
    PDF_RESEARCH_LLM_BASE_URL: localOpenAiUrl,
    PDF_RESEARCH_LLM_API_KEY: localGatewayKey,
    PDF_RESEARCH_LLM_MODEL: model,
    CLAUDE_CODE_USE_BEDROCK: env.CLAUDE_CODE_USE_BEDROCK || "0",
    DISABLE_TELEMETRY: env.DISABLE_TELEMETRY || "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:
      env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC || "1",
    CLAUDE_CONFIG_DIR:
      env.CLAUDE_CONFIG_DIR || path.join(env.OMNIGENT_CONFIG_HOME || project, "cc-haha"),
    HARNESS_CC_HAHA_PATH:
      env.HARNESS_CC_HAHA_PATH || layout.sidecar,
    HARNESS_CC_HAHA_SYSTEM_PROMPT_FILE:
      env.HARNESS_CC_HAHA_SYSTEM_PROMPT_FILE || path.join(project, "omnigent", "CLAUDE.md"),
    OMNIGENT_CLAUDE_NATIVE_AUTO_APPROVE:
      env.OMNIGENT_CLAUDE_NATIVE_AUTO_APPROVE || "1",
  };
}

/**
 * @param {NodeJS.ProcessEnv} env
 * @param {{ serverUrl: string, litellmUrl: string }} endpoints
 */
async function startLiteLlm(env2, endpoints, root, project) {
  const python = desktop.bundledPythonPath();
  if (!python || !fs.existsSync(python)) {
    return { ok: false, error: "Bundled Python runtime is unavailable." };
  }
  const litellmConfig = writeGeneratedLiteLlmConfig(env2);
  if (!fs.existsSync(litellmConfig)) {
    return { ok: false, error: `LiteLLM config missing: ${litellmConfig}` };
  }
  const host = env2.LITELLM_HOST || "127.0.0.1";
  const port = env2.LITELLM_PORT || "4000";
  emitStatus("Starting LiteLLM…");
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
      String(port),
    ],
    env2,
    project || root,
  );
  if (!(await waitUntil("LiteLLM", () => litellmHealthy(endpoints.litellmUrl), DEFAULT_START_TIMEOUT_MS))) {
    return { ok: false, error: "LiteLLM did not become healthy. Check logs in app data folder." };
  }
  return { ok: true };
}

function nativeRuntimeContext(llmConfig) {
  const root = desktop.runtimeRoot();
  const project = path.join(root, "project");
  const env = desktop.buildStackEnv(llmRuntimeEnv(llmConfig));
  return {
    root,
    project,
    env: nativeChildEnv(env, root, project),
    endpoints: desktop.stackEndpoints(),
  };
}

async function swapWithRollback(stopCurrent, startNext, startPrevious) {
  await stopCurrent();
  if (await startNext()) return { ok: true };
  await stopCurrent();
  const rolledBack = await startPrevious();
  return {
    ok: false,
    rolledBack,
    error: rolledBack
      ? "The new model gateway failed to start; the previous configuration was restored."
      : "The new model gateway failed to start and the previous configuration could not be restored.",
  };
}

async function reloadLiteLlm(nextConfig, previousConfig) {
  if (strategy !== "native") {
    return { ok: false, error: "LiteLLM hot switching is only available for the bundled native stack." };
  }
  const next = nativeRuntimeContext(nextConfig);
  const previous = nativeRuntimeContext(previousConfig);
  const stopCurrent = async () => {
    const current = children.get("litellm");
    if (current) await stopChild(current);
  };
  const start = async (context) => {
    const result = await startLiteLlm(
      context.env,
      context.endpoints,
      context.root,
      context.project,
    );
    return result.ok;
  };
  return swapWithRollback(
    stopCurrent,
    () => start(next),
    () => start(previous),
  );
}

async function startNative(env, endpoints) {
  const root = desktop.runtimeRoot();
  const project = path.join(root, "project");
  const python = desktop.bundledPythonPath();
  if (!python || !fs.existsSync(python)) {
    return {
      ok: false,
      error:
        "Bundled Python runtime missing. Rebuild the native desktop runtime for this platform.",
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
    if (env2.PYTHONPYCACHEPREFIX) {
      fs.mkdirSync(env2.PYTHONPYCACHEPREFIX, { recursive: true });
    }
    if (env2.CLAUDE_CONFIG_DIR) fs.mkdirSync(env2.CLAUDE_CONFIG_DIR, { recursive: true });
  } catch {
    // ignore
  }

  const serverHost = env2.OMNIGENT_SERVER_HOST || "127.0.0.1";
  const serverPort = env2.OMNIGENT_SERVER_PORT || "6767";
  const omnigentCwd = fs.existsSync(path.join(project, "omnigent"))
    ? path.join(project, "omnigent")
    : project;

  const litellmResult = await startLiteLlm(env2, endpoints, root, project);
  if (!litellmResult.ok) return litellmResult;

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
    {
      ...env2,
      // The desktop supervisor launches a dedicated valuation worker below.
      PRIVATE_FUND_VALUATION_BACKGROUND_WORKER: "0",
    },
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
async function ensureStackRunning(llmConfig = null) {
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

  const env = desktop.buildStackEnv(llmRuntimeEnv(llmConfig));
  try {
    if (env.OMNIGENT_DATA_DIR) fs.mkdirSync(env.OMNIGENT_DATA_DIR, { recursive: true });
    if (env.OMNIGENT_CONFIG_HOME) fs.mkdirSync(env.OMNIGENT_CONFIG_HOME, { recursive: true });
    if (env.PYTHONPYCACHEPREFIX) {
      fs.mkdirSync(env.PYTHONPYCACHEPREFIX, { recursive: true });
    }
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
        "No bundled native runtime found (Python + project + runtime marker). " +
        "Rebuild the desktop package with the native runtime assembly script for this platform.",
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

async function restartStack(llmConfig = null) {
  await shutdownStack();
  return ensureStackRunning(llmConfig);
}

module.exports = {
  ensureStackRunning,
  restartStack,
  reloadLiteLlm,
  shutdownStack,
  testLlmConfig,
  llmRuntimeEnv,
  nativeChildEnv,
  writeGeneratedLiteLlmConfig,
  onStatus,
  httpOk,
  litellmHealthy,
  serverHealthy,
  detectStrategy,
  hasNativeRuntime,
  _children: children,
  _swapWithRollback: swapWithRollback,
  LOCAL_MODEL_ALIAS,
};
