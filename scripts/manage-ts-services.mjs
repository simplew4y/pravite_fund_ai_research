#!/usr/bin/env node

import {
  constants as fsConstants,
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = realpathSync(path.resolve(scriptDirectory, ".."));
const manifestPath = path.join(scriptDirectory, "ts-services.manifest.json");
const manifest = parseManifest(readFileSync(manifestPath, "utf8"));
const servicesById = new Map(
  manifest.managedServices.map((service) => [service.id, service]),
);

loadEnvironmentFile();
configureComputePython();

const stateDirectory = preparePrivateDirectory(
  process.env.PRIVATE_FUND_SERVICE_STATE_DIR ??
    path.join(repositoryRoot, "tmp", "ts-services"),
  "service state",
);
const logDirectory = preparePrivateDirectory(
  process.env.PRIVATE_FUND_SERVICE_LOG_DIR ??
    path.join(stateDirectory, "logs"),
  "service log",
);
const startupWaitMilliseconds = boundedMilliseconds(
  "PRIVATE_FUND_SERVICES_WAIT_MS",
  60_000,
  100,
  300_000,
);
const stopWaitMilliseconds = boundedMilliseconds(
  "PRIVATE_FUND_SERVICES_STOP_WAIT_MS",
  10_000,
  100,
  60_000,
);
const nodeExecutable = resolveNodeExecutable();
const fixtureMode =
  process.env.NODE_ENV === "test" &&
  process.env.PRIVATE_FUND_SERVICE_TEST_MODE === "1";
if (
  process.env.PRIVATE_FUND_SERVICE_TEST_MODE !== undefined &&
  !fixtureMode
) {
  throw new Error(
    "PRIVATE_FUND_SERVICE_TEST_MODE is accepted only with NODE_ENV=test",
  );
}
const abortController = new AbortController();
let operationInProgress = false;

function usage() {
  process.stderr.write(
    [
      "Usage: node scripts/manage-ts-services.mjs <command> [service]",
      "",
      "Commands:",
      "  start      Start the canonical TypeScript service topology.",
      "  stop       Gracefully stop the topology and its owned child processes.",
      "  restart    Stop and start the complete topology.",
      "  status     Report PID ownership and readiness for every service.",
      "  logs       Print recent logs for all services or one service.",
      "  manifest   Print the canonical machine-readable service manifest.",
      "",
    ].join("\n"),
  );
}

function parseManifest(source) {
  const parsed = JSON.parse(source);
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    parsed.schemaVersion !== 1 ||
    parsed.architecture !== "typescript-pi" ||
    !Array.isArray(parsed.managedServices) ||
    !Array.isArray(parsed.ownedOnDemandProcesses)
  ) {
    throw new Error("Invalid TypeScript service manifest");
  }

  const ids = new Set();
  for (const service of parsed.managedServices) {
    if (
      service === null ||
      typeof service !== "object" ||
      !/^[a-z][a-z0-9-]{0,63}$/.test(service.id) ||
      service.runtime !== "node" ||
      typeof service.entry !== "string" ||
      !Array.isArray(service.nodeArguments) ||
      service.nodeArguments.some((argument) => typeof argument !== "string") ||
      service.readiness === null ||
      typeof service.readiness !== "object"
    ) {
      throw new Error("Invalid managed service in TypeScript service manifest");
    }
    if (ids.has(service.id)) {
      throw new Error(`Duplicate managed service id: ${service.id}`);
    }
    ids.add(service.id);
    const entry = path.resolve(repositoryRoot, service.entry);
    if (!isWithin(repositoryRoot, entry)) {
      throw new Error(`Service entry escapes the repository: ${service.entry}`);
    }
    if (
      service.readiness.kind !== "http" &&
      service.readiness.kind !== "log"
    ) {
      throw new Error(`Unsupported readiness kind for ${service.id}`);
    }
  }
  for (const processDefinition of parsed.ownedOnDemandProcesses) {
    if (
      processDefinition === null ||
      typeof processDefinition !== "object" ||
      !/^[a-z][a-z0-9-]{0,63}$/.test(processDefinition.id) ||
      !["node", "python"].includes(processDefinition.runtime) ||
      typeof processDefinition.owner !== "string" ||
      !servicesByManifestId(parsed.managedServices).has(
        processDefinition.owner,
      ) ||
      typeof processDefinition.entry !== "string" ||
      !["session-demand", "request-scoped"].includes(
        processDefinition.lifecycle,
      ) ||
      (processDefinition.runtime === "python" &&
        processDefinition.lifecycle !== "request-scoped")
    ) {
      throw new Error(
        "Invalid owned process in TypeScript service manifest",
      );
    }
    if (ids.has(processDefinition.id)) {
      throw new Error(
        `Duplicate service or owned process id: ${processDefinition.id}`,
      );
    }
    ids.add(processDefinition.id);
    const entry = path.resolve(repositoryRoot, processDefinition.entry);
    if (!isWithin(repositoryRoot, entry)) {
      throw new Error(
        `Owned process entry escapes the repository: ${processDefinition.entry}`,
      );
    }
  }
  return parsed;
}

function servicesByManifestId(services) {
  return new Set(services.map((service) => service.id));
}

function loadEnvironmentFile() {
  const configured = process.env.PRIVATE_FUND_ENV_FILE;
  const candidate =
    configured === undefined
      ? path.join(repositoryRoot, ".env")
      : path.resolve(configured);
  if (!existsSync(candidate)) {
    if (configured !== undefined) {
      throw new Error(`Configured environment file does not exist: ${candidate}`);
    }
    return;
  }
  const metadata = lstatSync(candidate);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`Environment file must be a regular file: ${candidate}`);
  }
  process.loadEnvFile(candidate);
}

function configureComputePython() {
  if (process.env.PRIVATE_FUND_PYTHON_EXECUTABLE !== undefined) {
    return;
  }
  const virtualEnvironmentPython = path.join(
    repositoryRoot,
    "python",
    "compute-worker",
    ".venv",
    "bin",
    "python",
  );
  if (existsSync(virtualEnvironmentPython)) {
    const metadata = statSync(virtualEnvironmentPython);
    if (!metadata.isFile() || (metadata.mode & 0o111) === 0) {
      throw new Error(
        `Compute virtual-environment Python is not executable: ${virtualEnvironmentPython}`,
      );
    }
    // Do not resolve the venv's bin/python symlink. Python uses the invoked
    // path to locate pyvenv.cfg; replacing it with the system interpreter's
    // realpath silently drops every dependency installed into the venv.
    process.env.PRIVATE_FUND_PYTHON_EXECUTABLE =
      virtualEnvironmentPython;
  }
}

function boundedMilliseconds(name, fallback, minimum, maximum) {
  const raw = process.env[name];
  const value = raw === undefined ? fallback : Number(raw);
  if (
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new Error(
      `${name} must be an integer from ${minimum} to ${maximum}`,
    );
  }
  return value;
}

function resolveNodeExecutable() {
  const configured = process.env.PRIVATE_FUND_SERVICE_NODE_EXECUTABLE;
  if (configured === undefined) {
    return process.execPath;
  }
  if (!path.isAbsolute(configured)) {
    throw new Error(
      "PRIVATE_FUND_SERVICE_NODE_EXECUTABLE must be an absolute path",
    );
  }
  const resolved = realpathSync(configured);
  const metadata = statSync(resolved);
  if (!metadata.isFile() || (metadata.mode & 0o111) === 0) {
    throw new Error(`Configured Node executable is not executable: ${resolved}`);
  }
  return resolved;
}

function isWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

function nearestExistingPath(candidate) {
  const suffix = [];
  let cursor = path.resolve(candidate);
  while (!existsSync(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) {
      throw new Error(`No existing parent for runtime path: ${candidate}`);
    }
    suffix.unshift(path.basename(cursor));
    cursor = parent;
  }
  return { existing: realpathSync(cursor), suffix };
}

function preparePrivateDirectory(candidate, label) {
  const { existing, suffix } = nearestExistingPath(candidate);
  const canonicalCandidate = path.resolve(existing, ...suffix);
  if (
    canonicalCandidate === path.parse(canonicalCandidate).root ||
    canonicalCandidate === repositoryRoot
  ) {
    throw new Error(`${label} directory is too broad: ${canonicalCandidate}`);
  }
  mkdirSync(canonicalCandidate, { recursive: true, mode: 0o700 });
  const resolved = realpathSync(canonicalCandidate);
  const metadata = lstatSync(resolved);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`${label} path is not a real directory: ${resolved}`);
  }
  if (
    typeof process.getuid === "function" &&
    metadata.uid !== process.getuid()
  ) {
    throw new Error(`${label} directory is not owned by the current user`);
  }
  if ((metadata.mode & 0o077) !== 0) {
    throw new Error(
      `${label} directory must not be accessible by group or other users: ${resolved}`,
    );
  }
  return resolved;
}

function pidPath(service) {
  return path.join(stateDirectory, `${service.id}.pid.json`);
}

function logPath(service) {
  return path.join(logDirectory, `${service.id}.log`);
}

function expectedEntry(service) {
  return path.resolve(repositoryRoot, service.entry);
}

function readPidRecord(service) {
  const filename = pidPath(service);
  if (!existsSync(filename)) {
    return undefined;
  }
  const metadata = lstatSync(filename);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`Unsafe PID record for ${service.id}: ${filename}`);
  }
  const record = JSON.parse(readFileSync(filename, "utf8"));
  if (
    record === null ||
    typeof record !== "object" ||
    record.schemaVersion !== 1 ||
    record.serviceId !== service.id ||
    !Number.isSafeInteger(record.pid) ||
    record.pid <= 1 ||
    record.entry !== expectedEntry(service) ||
    !Number.isSafeInteger(record.logOffset) ||
    record.logOffset < 0 ||
    typeof record.startedAt !== "string"
  ) {
    throw new Error(`Invalid PID record for ${service.id}: ${filename}`);
  }
  return record;
}

function writePidRecord(service, pid, logOffset) {
  const destination = pidPath(service);
  const temporary = path.join(
    stateDirectory,
    `.${service.id}.${process.pid}.${Date.now()}.tmp`,
  );
  const body = `${JSON.stringify(
    {
      schemaVersion: 1,
      serviceId: service.id,
      pid,
      entry: expectedEntry(service),
      logOffset,
      startedAt: new Date().toISOString(),
    },
    null,
    2,
  )}\n`;
  writeFileSync(temporary, body, { encoding: "utf8", mode: 0o600, flag: "wx" });
  renameSync(temporary, destination);
}

function removePidRecord(service) {
  rmSync(pidPath(service), { force: true });
}

function processDetails(pid) {
  const result = spawnSync(
    "ps",
    ["-ww", "-p", String(pid), "-o", "stat=", "-o", "command="],
    { encoding: "utf8" },
  );
  if (result.status !== 0 || result.stdout.trim() === "") {
    return undefined;
  }
  const match = result.stdout.trim().match(/^(\S+)\s+([\s\S]+)$/);
  if (match === null || match[1].startsWith("Z")) {
    return undefined;
  }
  return { state: match[1], command: match[2] };
}

function isOwnedProcess(service, record) {
  if (fixtureMode) {
    try {
      process.kill(record.pid, 0);
      return !currentLog(service, record).includes(
        `fixture_failure:${service.id}`,
      );
    } catch {
      return false;
    }
  }
  const details = processDetails(record.pid);
  return (
    details !== undefined &&
    details.command.includes(record.entry) &&
    record.entry === expectedEntry(service)
  );
}

function openServiceLog(service) {
  const filename = logPath(service);
  if (existsSync(filename) && lstatSync(filename).isSymbolicLink()) {
    throw new Error(`Refusing symlink service log: ${filename}`);
  }
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  return openSync(
    filename,
    fsConstants.O_CREAT |
      fsConstants.O_WRONLY |
      fsConstants.O_APPEND |
      noFollow,
    0o600,
  );
}

function startProcess(service) {
  const logDescriptor = openServiceLog(service);
  try {
    const logOffset = fstatSync(logDescriptor).size;
    writeFileSync(
      logDescriptor,
      `\n[service-manager] ${new Date().toISOString()} starting ${service.id}\n`,
    );
    const child = spawn(
      nodeExecutable,
      [...service.nodeArguments, expectedEntry(service)],
      {
        cwd: repositoryRoot,
        env: process.env,
        detached: true,
        stdio: ["ignore", logDescriptor, logDescriptor],
      },
    );
    if (child.pid === undefined) {
      throw new Error(`Failed to obtain PID for ${service.id}`);
    }
    child.once("error", (error) => {
      process.stderr.write(
        `${service.id} process error: ${
          error instanceof Error ? error.message : String(error)
        }\n`,
      );
    });
    child.unref();
    try {
      writePidRecord(service, child.pid, logOffset);
    } catch (error) {
      signalOwnedGroup(child.pid, "SIGTERM");
      throw error;
    }
    return child.pid;
  } finally {
    closeSync(logDescriptor);
  }
}

function readinessUrl(readiness) {
  const host =
    process.env[readiness.hostEnvironment] ?? readiness.defaultHost;
  const portRaw =
    process.env[readiness.portEnvironment] ?? readiness.defaultPort;
  const port = Number(portRaw);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error(
      `${readiness.portEnvironment} must be an integer from 1 to 65535`,
    );
  }
  const url = new URL("http://127.0.0.1");
  url.hostname = host;
  url.port = String(port);
  url.pathname = readiness.path;
  return url.toString();
}

function currentLog(service, record) {
  const filename = logPath(service);
  if (!existsSync(filename)) {
    return "";
  }
  return readFileSync(filename).subarray(record.logOffset).toString("utf8");
}

async function isReady(service) {
  const record = readPidRecord(service);
  if (record === undefined || !isOwnedProcess(service, record)) {
    return false;
  }
  if (fixtureMode && service.readiness.kind === "http") {
    return currentLog(service, record).includes(
      `fixture_ready:${service.id}`,
    );
  }
  if (service.readiness.kind === "log") {
    return currentLog(service, record).includes(service.readiness.pattern);
  }
  try {
    const response = await fetch(readinessUrl(service.readiness), {
      signal: AbortSignal.timeout(1_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

function delay(milliseconds) {
  return new Promise((resolve, reject) => {
    if (abortController.signal.aborted) {
      reject(new Error("Service operation interrupted"));
      return;
    }
    const timer = setTimeout(resolve, milliseconds);
    abortController.signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new Error("Service operation interrupted"));
      },
      { once: true },
    );
  });
}

async function waitUntilReady(service) {
  const deadline = Date.now() + startupWaitMilliseconds;
  while (Date.now() < deadline) {
    if (await isReady(service)) {
      return;
    }
    const record = readPidRecord(service);
    if (record === undefined || !isOwnedProcess(service, record)) {
      throw new Error(
        `${service.id} exited before readiness; inspect ${logPath(service)}`,
      );
    }
    await delay(100);
  }
  throw new Error(
    `${service.id} was not ready within ${startupWaitMilliseconds}ms; inspect ${logPath(service)}`,
  );
}

async function startServices() {
  const started = [];
  try {
    for (const service of manifest.managedServices) {
      const existing = readPidRecord(service);
      if (existing !== undefined && isOwnedProcess(service, existing)) {
        if (!(await isReady(service))) {
          throw new Error(
            `${service.id} is running but unhealthy; restart the topology`,
          );
        }
        process.stdout.write(
          `${service.id}: already ready (pid ${existing.pid})\n`,
        );
        continue;
      }
      if (existing !== undefined) {
        process.stderr.write(
          `${service.id}: removing stale PID record ${existing.pid}\n`,
        );
        removePidRecord(service);
      }
      const pid = startProcess(service);
      started.push(service);
      await waitUntilReady(service);
      process.stdout.write(`${service.id}: ready (pid ${pid})\n`);
    }
  } catch (error) {
    process.stderr.write(
      `Startup failed; rolling back ${started.length} newly started service(s).\n`,
    );
    for (const service of started.reverse()) {
      await stopService(service, { quiet: true });
    }
    throw error;
  }
}

function signalOwnedGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") {
      process.kill(pid, signal);
    }
  }
}

async function stopService(service, options = {}) {
  const record = readPidRecord(service);
  if (record === undefined) {
    if (!options.quiet) {
      process.stdout.write(`${service.id}: stopped\n`);
    }
    return;
  }
  if (!isOwnedProcess(service, record)) {
    removePidRecord(service);
    if (!options.quiet) {
      process.stdout.write(
        `${service.id}: removed stale PID record ${record.pid}\n`,
      );
    }
    return;
  }

  signalOwnedGroup(record.pid, "SIGTERM");
  const deadline = Date.now() + stopWaitMilliseconds;
  while (Date.now() < deadline && isOwnedProcess(service, record)) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (isOwnedProcess(service, record)) {
    signalOwnedGroup(record.pid, "SIGKILL");
    const killDeadline = Date.now() + 2_000;
    while (Date.now() < killDeadline && isOwnedProcess(service, record)) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  if (isOwnedProcess(service, record)) {
    throw new Error(`Could not stop owned ${service.id} process ${record.pid}`);
  }
  removePidRecord(service);
  if (!options.quiet) {
    process.stdout.write(`${service.id}: stopped\n`);
  }
}

async function stopServices() {
  for (const service of [...manifest.managedServices].reverse()) {
    await stopService(service);
  }
}

async function statusServices() {
  let healthy = true;
  for (const service of manifest.managedServices) {
    const record = readPidRecord(service);
    if (record === undefined) {
      process.stdout.write(`${service.id}: stopped\n`);
      healthy = false;
      continue;
    }
    if (!isOwnedProcess(service, record)) {
      process.stdout.write(`${service.id}: stale pid ${record.pid}\n`);
      healthy = false;
      continue;
    }
    const ready = await isReady(service);
    process.stdout.write(
      `${service.id}: ${ready ? "ready" : "unhealthy"} (pid ${record.pid})\n`,
    );
    healthy &&= ready;
  }
  if (!healthy) {
    process.exitCode = 1;
  }
}

function tail(filename, maximumLines = 80) {
  if (!existsSync(filename)) {
    return "(no log file)";
  }
  const lines = readFileSync(filename, "utf8").split(/\r?\n/);
  return lines.slice(Math.max(0, lines.length - maximumLines)).join("\n");
}

function printLogs(serviceId) {
  const selected =
    serviceId === undefined
      ? manifest.managedServices
      : [servicesById.get(serviceId)].filter(Boolean);
  if (selected.length === 0) {
    throw new Error(`Unknown service: ${serviceId}`);
  }
  for (const service of selected) {
    process.stdout.write(`===== ${service.id} =====\n`);
    process.stdout.write(`${tail(logPath(service))}\n`);
  }
}

function acquireLock() {
  const lockDirectory = path.join(stateDirectory, ".operation.lock");
  try {
    mkdirSync(lockDirectory, { mode: 0o700 });
  } catch (error) {
    if (error?.code !== "EEXIST") {
      throw error;
    }
    const ownerPath = path.join(lockDirectory, "owner.json");
    let owner;
    try {
      owner = JSON.parse(readFileSync(ownerPath, "utf8"));
    } catch {
      owner = undefined;
    }
    if (
      owner !== undefined &&
      Number.isSafeInteger(owner.pid) &&
      owner.pid > 1 &&
      processDetails(owner.pid) !== undefined
    ) {
      throw new Error(
        `Another service operation is active (pid ${owner.pid})`,
      );
    }
    rmSync(lockDirectory, { recursive: true, force: true });
    mkdirSync(lockDirectory, { mode: 0o700 });
  }
  writeFileSync(
    path.join(lockDirectory, "owner.json"),
    `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`,
    { encoding: "utf8", mode: 0o600, flag: "wx" },
  );
  return () => {
    rmSync(lockDirectory, { recursive: true, force: true });
  };
}

async function withOperationLock(operation) {
  const release = acquireLock();
  operationInProgress = true;
  try {
    await operation();
  } finally {
    operationInProgress = false;
    release();
  }
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    if (operationInProgress) {
      abortController.abort();
    } else {
      process.exitCode = 130;
    }
  });
}

const command = process.argv[2];
const argument = process.argv[3];

try {
  switch (command) {
    case "start":
      await withOperationLock(startServices);
      break;
    case "stop":
      await withOperationLock(stopServices);
      break;
    case "restart":
      await withOperationLock(async () => {
        await stopServices();
        await startServices();
      });
      break;
    case "status":
      await statusServices();
      break;
    case "logs":
      printLogs(argument);
      break;
    case "manifest":
      process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
      break;
    default:
      usage();
      process.exitCode = 2;
  }
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}
