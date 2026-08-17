"use strict";

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      server.close((error) => {
        if (error) reject(error);
        else if (port <= 0) reject(new Error("Could not allocate a loopback port"));
        else resolve(port);
      });
    });
  });
}

async function waitForHttp(url, timeoutMilliseconds = 60_000) {
  const deadline = Date.now() + timeoutMilliseconds;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, {
        cache: "no-store",
        signal: AbortSignal.timeout(1_500),
      });
      if (response.ok) return response;
      lastError = new Error(`${url} returned HTTP ${String(response.status)}`);
    } catch (error) {
      lastError = error;
    }
    await delay(150);
  }
  throw new Error(
    `Timed out waiting for ${url}: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}

function assertRuntimeFiles(paths) {
  const required = [
    paths.apiEntry,
    paths.jobWorkerEntry,
    paths.obsidianWorkerEntry,
    paths.agentWorkerEntry,
    paths.computeExecutable,
    paths.computeWorkerEntry,
    path.join(paths.webRoot, "index.html"),
  ];
  const missing = required.filter((filename) => !fs.existsSync(filename));
  if (missing.length > 0) {
    throw new Error(`Desktop runtime resources are missing:\n${missing.join("\n")}`);
  }
}

class ServiceProcess {
  constructor({ id, executable, arguments: childArguments, options, log, onUnexpectedExit }) {
    this.id = id;
    this.output = "";
    this.waiters = new Set();
    this.stopping = false;
    this.log = log;
    this.child = spawn(executable, childArguments, options);

    const capture = (stream, chunk) => {
      const text = chunk.toString("utf8");
      this.output = `${this.output}${text}`.slice(-2_000_000);
      this.log(id, stream, text);
      for (const waiter of [...this.waiters]) {
        if (this.output.includes(waiter.pattern)) {
          clearTimeout(waiter.timer);
          this.waiters.delete(waiter);
          waiter.resolve();
        }
      }
    };
    this.child.stdout.on("data", (chunk) => capture("stdout", chunk));
    this.child.stderr.on("data", (chunk) => capture("stderr", chunk));
    this.child.once("error", (error) => {
      this.rejectWaiters(error);
    });
    this.child.once("exit", (code, signal) => {
      const error = new Error(
        `${id} exited (code=${String(code)}, signal=${String(signal)})`,
      );
      this.rejectWaiters(error);
      if (!this.stopping) onUnexpectedExit(error);
    });
  }

  rejectWaiters(error) {
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.waiters.clear();
  }

  waitForOutput(pattern, timeoutMilliseconds = 60_000) {
    if (this.output.includes(pattern)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const waiter = {
        pattern,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.waiters.delete(waiter);
          reject(new Error(`Timed out waiting for ${this.id} output: ${pattern}`));
        }, timeoutMilliseconds),
      };
      this.waiters.add(waiter);
    });
  }

  async stop() {
    this.stopping = true;
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    const exited = new Promise((resolve) => this.child.once("exit", resolve));
    this.child.kill("SIGTERM");
    await Promise.race([exited, delay(8_000)]);
    if (this.child.exitCode === null && this.child.signalCode === null) {
      this.child.kill("SIGKILL");
      await Promise.race([exited, delay(2_000)]);
    }
  }
}

class DesktopRuntime {
  constructor({ executable, paths, environment, apiPort, obsidianPort, onFatal }) {
    this.executable = executable;
    this.paths = paths;
    this.environment = environment;
    this.apiPort = apiPort;
    this.obsidianPort = obsidianPort;
    this.onFatal = onFatal;
    this.services = [];
    this.stopping = false;
    this.started = false;
    fs.mkdirSync(paths.logDirectory, { recursive: true, mode: 0o700 });
    this.logStream = fs.createWriteStream(path.join(paths.logDirectory, "desktop.log"), {
      flags: "a",
      mode: 0o600,
    });
  }

  log(service, stream, text) {
    const prefix = `[${new Date().toISOString()}] [${service}] [${stream}] `;
    for (const line of text.split(/(?<=\n)/u)) {
      if (line) this.logStream.write(`${prefix}${line}`);
    }
  }

  spawnService(id, entry, nodeArguments = []) {
    const service = new ServiceProcess({
      id,
      executable: this.executable,
      arguments: [...nodeArguments, entry],
      options: {
        cwd: this.paths.runtimeRoot,
        env: this.environment,
        stdio: ["ignore", "pipe", "pipe"],
      },
      log: (serviceId, stream, text) => this.log(serviceId, stream, text),
      onUnexpectedExit: (error) => {
        if (!this.stopping) this.onFatal(error);
      },
    });
    this.services.push(service);
    return service;
  }

  async start() {
    assertRuntimeFiles(this.paths);
    fs.mkdirSync(this.paths.dataRoot, { recursive: true, mode: 0o700 });

    this.spawnService("api", this.paths.apiEntry, ["--enable-source-maps"]);
    await waitForHttp(`http://127.0.0.1:${String(this.apiPort)}/health`);

    const job = this.spawnService("job-worker", this.paths.jobWorkerEntry);
    await job.waitForOutput('"event":"compute_worker_ready"');

    this.spawnService("obsidian-worker", this.paths.obsidianWorkerEntry);
    await waitForHttp(
      `http://127.0.0.1:${String(this.obsidianPort)}/health/ready`,
    );

    const state = {
      schemaVersion: 1,
      pid: process.pid,
      apiOrigin: this.apiOrigin,
      obsidianHealthOrigin: `http://127.0.0.1:${String(this.obsidianPort)}`,
      startedAt: new Date().toISOString(),
      services: this.services.map((service) => ({
        id: service.id,
        pid: service.child.pid,
      })),
    };
    fs.writeFileSync(this.paths.runtimeStateFile, `${JSON.stringify(state, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    this.started = true;
  }

  get apiOrigin() {
    return `http://127.0.0.1:${String(this.apiPort)}`;
  }

  async stop() {
    if (this.stopping) return;
    this.stopping = true;
    await Promise.all([...this.services].reverse().map((service) => service.stop()));
    this.services = [];
    try {
      fs.rmSync(this.paths.runtimeStateFile, { force: true });
    } finally {
      await new Promise((resolve) => this.logStream.end(resolve));
    }
  }
}

module.exports = {
  DesktopRuntime,
  assertRuntimeFiles,
  findFreePort,
  waitForHttp,
};
