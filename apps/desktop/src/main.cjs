"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { fork } = require("node:child_process");

const { app, BrowserWindow, Menu, dialog, shell } = require("electron");

const {
  buildServiceEnvironment,
  ensureDesktopConfiguration,
  readDesktopEnvironment,
  resolveDesktopPaths,
} = require("./config.cjs");
const { DesktopRuntime, findFreePort } = require("./runtime.cjs");

const APP_NAME = "Private Fund AI Research";
const smokeMode = process.env.PRIVATE_FUND_DESKTOP_SMOKE === "1";
const smokeOutput = process.env.PRIVATE_FUND_DESKTOP_SMOKE_OUTPUT;
const overriddenUserData = process.env.PRIVATE_FUND_DESKTOP_USER_DATA;

if (overriddenUserData) {
  app.setPath("userData", path.resolve(overriddenUserData));
}
app.setName(APP_NAME);

let mainWindow = null;
let runtime = null;
let paths = null;
let shutdownStarted = false;
let shutdownComplete = false;
let fatalError = null;

function writeSmokeResult(result) {
  if (!smokeOutput) return;
  const filename = path.resolve(smokeOutput);
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, `${JSON.stringify(result, null, 2)}\n`, "utf8");
}

async function requestJson(origin, pathname, init) {
  const response = await fetch(`${origin}${pathname}`, {
    cache: "no-store",
    ...init,
  });
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!response.ok) {
    throw new Error(
      `${init?.method ?? "GET"} ${pathname} returned ${String(response.status)}: ${text}`,
    );
  }
  return { status: response.status, body };
}

async function waitForRenderer(window, timeoutMilliseconds = 30_000) {
  const deadline = Date.now() + timeoutMilliseconds;
  let snapshot = null;
  while (Date.now() < deadline) {
    snapshot = await window.webContents.executeJavaScript(`({
      readyState: document.readyState,
      title: document.title,
      rootChildren: document.querySelector('#root')?.childElementCount ?? 0,
      bodyTextLength: document.body?.innerText?.length ?? 0
    })`);
    if (snapshot.rootChildren > 0 && snapshot.bodyTextLength > 0) return snapshot;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`React renderer did not become ready: ${JSON.stringify(snapshot)}`);
}

async function verifyAgentWorkerBootstrap(activeRuntime) {
  return new Promise((resolve, reject) => {
    let stderr = "";
    let settled = false;
    const child = fork(paths.agentWorkerEntry, [], {
      cwd: paths.runtimeRoot,
      env: activeRuntime.environment,
      execPath: process.execPath,
      serialization: "advanced",
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeAllListeners("message");
      if (child.connected) child.disconnect();
      child.kill("SIGTERM");
      if (error) reject(error);
      else resolve({ ready: true });
    };
    const timer = setTimeout(() => {
      finish(new Error(`Packaged Pi agent worker did not become ready: ${stderr}`));
    }, 30_000);
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk.toString("utf8")}`.slice(-32_000);
    });
    child.once("error", finish);
    child.once("exit", (code, signal) => {
      finish(
        new Error(
          `Packaged Pi agent worker exited before ready (code=${String(code)}, signal=${String(signal)}): ${stderr}`,
        ),
      );
    });
    child.on("message", (message) => {
      if (message && typeof message === "object" && message.type === "worker.ready") {
        finish();
      }
    });
  });
}

async function runPackagedSmoke(window, activeRuntime) {
  const origin = activeRuntime.apiOrigin;
  const health = await requestJson(origin, "/health");
  const info = await requestJson(origin, "/v1/info");
  const projectsBefore = await requestJson(origin, "/v1/projects");
  const projectResponse = await requestJson(origin, "/v1/projects", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: "Packaged desktop smoke",
      companyName: "Local verification",
    }),
  });
  const projectId = projectResponse.body.id;
  if (typeof projectId !== "string") {
    throw new Error("Desktop smoke project response did not contain an id");
  }

  const sessionResponse = await requestJson(origin, "/v1/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectId, title: "Packaged desktop smoke" }),
  });

  const form = new FormData();
  form.append(
    "file",
    new Blob(["Private fund packaged desktop compute smoke.\n"], {
      type: "text/plain",
    }),
    "desktop-smoke.txt",
  );
  const upload = await requestJson(
    origin,
    `/v1/projects/${encodeURIComponent(projectId)}/documents/upload`,
    { method: "POST", body: form },
  );
  const jobId = upload.body?.uploads?.[0]?.job?.id;
  if (typeof jobId !== "string") {
    throw new Error("Desktop smoke upload did not return a compute job id");
  }

  const deadline = Date.now() + 60_000;
  let job = null;
  while (Date.now() < deadline) {
    job = (await requestJson(origin, `/v1/jobs/${encodeURIComponent(jobId)}`)).body;
    if (job.status === "completed") break;
    if (job.status === "failed" || job.status === "cancelled") {
      throw new Error(`Desktop smoke compute job ${job.status}: ${JSON.stringify(job)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (job?.status !== "completed") {
    throw new Error(`Desktop smoke compute job timed out: ${JSON.stringify(job)}`);
  }

  const renderer = await waitForRenderer(window);
  const agentWorker = await verifyAgentWorkerBootstrap(activeRuntime);
  const projectsAfter = await requestJson(origin, "/v1/projects");
  const obsidianHealth = await requestJson(
    `http://127.0.0.1:${String(activeRuntime.obsidianPort)}`,
    "/health/ready",
  );

  return {
    ok: true,
    appName: APP_NAME,
    appVersion: app.getVersion(),
    packaged: app.isPackaged,
    platform: process.platform,
    arch: process.arch,
    health: health.body,
    info: {
      authMode: info.body.auth_mode,
      piSdkHarness: info.body.pi_sdk_harness,
      legacyOmnigentRequired: info.body.legacy_omnigent_required,
    },
    renderer,
    project: {
      id: projectId,
      beforeCount: projectsBefore.body.projects?.length ?? projectsBefore.body.total ?? null,
      afterCount: projectsAfter.body.projects?.length ?? projectsAfter.body.total ?? null,
    },
    sessionId: sessionResponse.body.id,
    computeJob: {
      id: jobId,
      status: job.status,
      operation: job.operation,
    },
    agentWorker,
    obsidianHealth: obsidianHealth.body,
    runtimeResources: {
      web: paths.webRoot,
      compute: paths.computeExecutable,
      node: process.execPath,
    },
  };
}

function installNavigationGuards(window, allowedOrigin) {
  const openExternal = (url) => {
    try {
      const protocol = new URL(url).protocol;
      if (["http:", "https:", "mailto:"].includes(protocol)) {
        void shell.openExternal(url);
      }
    } catch {
      return;
    }
  };
  window.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    let origin;
    try {
      origin = new URL(url).origin;
    } catch {
      origin = "";
    }
    if (origin === allowedOrigin) return;
    event.preventDefault();
    openExternal(url);
  });
}

function installMenu() {
  const template = [
    {
      label: APP_NAME,
      submenu: [
        { role: "about" },
        { type: "separator" },
        {
          label: "Open Configuration…",
          click: () => {
            if (!paths) return;
            ensureDesktopConfiguration(paths.configurationFile);
            void shell.openPath(paths.configurationFile);
          },
        },
        {
          label: "Open Data Folder",
          click: () => {
            if (paths) void shell.openPath(paths.dataRoot);
          },
        },
        {
          label: "Open Log Folder",
          click: () => {
            if (paths) void shell.openPath(paths.logDirectory);
          },
        },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function createMainWindow(origin) {
  const window = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 1040,
    minHeight: 680,
    title: APP_NAME,
    show: false,
    backgroundColor: "#f5f5f2",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  window.on("page-title-updated", (event) => {
    event.preventDefault();
    window.setTitle(APP_NAME);
  });
  installNavigationGuards(window, origin);
  await window.loadURL(origin);
  if (!smokeMode) window.show();
  return window;
}

async function stopAndQuit(exitCode = 0) {
  if (shutdownStarted) return;
  shutdownStarted = true;
  try {
    await runtime?.stop();
  } finally {
    runtime = null;
    shutdownComplete = true;
    process.exitCode = exitCode;
    app.quit();
  }
}

function handleFatal(error) {
  if (fatalError) return;
  fatalError = error instanceof Error ? error : new Error(String(error));
  if (!smokeMode) {
    dialog.showErrorBox(
      `${APP_NAME} runtime stopped`,
      `${fatalError.message}\n\nLogs: ${paths?.logDirectory ?? "unavailable"}`,
    );
  }
  writeSmokeResult({ ok: false, error: fatalError.stack ?? fatalError.message });
  void stopAndQuit(1);
}

async function startApplication() {
  const userData = app.getPath("userData");
  paths = resolveDesktopPaths({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    userData,
    sourceDirectory: __dirname,
  });
  fs.mkdirSync(paths.dataRoot, { recursive: true, mode: 0o700 });
  const configuredEnvironment = readDesktopEnvironment(paths.configurationFile);
  const [apiPort, obsidianPort] = await Promise.all([findFreePort(), findFreePort()]);
  const environment = buildServiceEnvironment({
    ambientEnvironment: process.env,
    configuredEnvironment,
    paths,
    apiPort,
    obsidianPort,
  });
  runtime = new DesktopRuntime({
    executable: process.execPath,
    paths,
    environment,
    apiPort,
    obsidianPort,
    onFatal: handleFatal,
  });
  await runtime.start();
  mainWindow = await createMainWindow(runtime.apiOrigin);
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
  installMenu();

  if (smokeMode) {
    try {
      const result = await runPackagedSmoke(mainWindow, runtime);
      writeSmokeResult(result);
      await stopAndQuit(0);
    } catch (error) {
      handleFatal(error);
    }
  }
}

const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
  app.whenReady().then(startApplication).catch(handleFatal);
}

app.on("activate", () => {
  if (!mainWindow && runtime?.started) {
    void createMainWindow(runtime.apiOrigin).then((window) => {
      mainWindow = window;
    });
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin" || smokeMode) void stopAndQuit(0);
});

app.on("before-quit", (event) => {
  if (shutdownComplete || runtime === null) return;
  event.preventDefault();
  void stopAndQuit(process.exitCode ?? 0);
});

process.on("uncaughtException", handleFatal);
process.on("unhandledRejection", handleFatal);
