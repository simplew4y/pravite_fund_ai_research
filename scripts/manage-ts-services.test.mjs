import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const scriptsDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptsDirectory, "..");
const manager = path.join(scriptsDirectory, "manage-ts-services.mjs");
const manifestPath = path.join(scriptsDirectory, "ts-services.manifest.json");
const fixture = path.join(
  scriptsDirectory,
  "fixtures",
  "managed-service-fixture.mjs",
);

function readJson(filename) {
  return JSON.parse(readFileSync(filename, "utf8"));
}

function runManager(command, environment, argument) {
  return spawnSync(
    process.execPath,
    [manager, command, ...(argument === undefined ? [] : [argument])],
    {
      cwd: repositoryRoot,
      env: environment,
      encoding: "utf8",
      timeout: 15_000,
    },
  );
}

test("canonical manifest contains only the TS control-plane topology", () => {
  const manifest = readJson(manifestPath);
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.architecture, "typescript-pi");
  assert.deepEqual(
    manifest.managedServices.map(({ id }) => id),
    ["api", "job-worker"],
  );
  assert(
    manifest.managedServices.every(({ runtime }) => runtime === "node"),
  );
  assert.deepEqual(
    manifest.ownedOnDemandProcesses.map(
      ({ id, runtime, owner, lifecycle }) => ({
        id,
        runtime,
        owner,
        lifecycle,
      }),
    ),
    [
      {
        id: "python-source-preview-sidecar",
        runtime: "python",
        owner: "api",
        lifecycle: "request-scoped",
      },
      {
        id: "python-compute-sidecar",
        runtime: "python",
        owner: "job-worker",
        lifecycle: "request-scoped",
      },
    ],
  );
  const forbiddenProcessPattern =
    /\b(omnigent|runner|host|tmux|litellm|fastapi)\b/i;
  for (const processDefinition of [
    ...manifest.managedServices,
    ...manifest.ownedOnDemandProcesses,
  ]) {
    assert.doesNotMatch(
      JSON.stringify(processDefinition),
      forbiddenProcessPattern,
    );
  }
});

test("root scripts make the canonical manager the default start path", () => {
  const packageJson = readJson(path.join(repositoryRoot, "package.json"));
  assert.equal(
    packageJson.scripts.start,
    "node scripts/manage-ts-services.mjs start",
  );
  assert.equal(
    packageJson.scripts["services:status"],
    "node scripts/manage-ts-services.mjs status",
  );
  assert.equal(packageJson.scripts["start:agent-worker"], undefined);
});

test("frontend development and checked-in examples cannot select an old runtime", () => {
  const viteConfig = readFileSync(
    path.join(repositoryRoot, "omnigent", "web", "vite.config.ts"),
    "utf8",
  );
  assert.match(viteConfig, /process\.env\.PRIVATE_FUND_API_URL/);
  assert.match(viteConfig, /http:\/\/localhost:6768/);
  assert.doesNotMatch(viteConfig, /process\.env\.OMNIGENT_URL/);
  assert.doesNotMatch(viteConfig, /OMNIGENT_AUTH_TOKEN/);
  assert.doesNotMatch(viteConfig, /\bdatabricks\b/);

  const environmentExample = readFileSync(
    path.join(repositoryRoot, ".env.example"),
    "utf8",
  );
  assert.match(environmentExample, /^PRIVATE_FUND_AUTH_MODE=cloud$/m);
  assert.doesNotMatch(environmentExample, /^OMNIGENT_AUTH_ENABLED=/m);
  assert.doesNotMatch(environmentExample, /^OMNIGENT_AUTH_PROVIDER=/m);
  assert.doesNotMatch(environmentExample, /manage_omnigent_services/);

  for (const readme of [
    path.join(repositoryRoot, "README.md"),
    path.join(repositoryRoot, "omnigent", "web", "README.md"),
  ]) {
    const source = readFileSync(readme, "utf8");
    assert.doesNotMatch(source, /python(?:3)?\s+-m\s+uvicorn/);
    assert.doesNotMatch(source, /run_pdf_research_web_app\.py/);
    assert.doesNotMatch(source, /VITE_PRIVATE_FUND_API_MODE=legacy/);
    assert.doesNotMatch(source, /OMNIGENT_URL=/);
  }
});

test("setup excludes legacy process managers and legacy launchers are permanently retired", () => {
  const setup = readFileSync(
    path.join(scriptsDirectory, "setup_full_system.sh"),
    "utf8",
  );
  assert.match(setup, /\bnpm install\b/);
  assert.match(setup, /\bnpm run build\b/);
  assert.match(setup, /python\/compute-worker/);
  assert.doesNotMatch(setup, /\bgit submodule\b/);
  assert.doesNotMatch(setup, /\buv sync\b/);
  assert.doesNotMatch(setup, /\bbun install\b/);
  assert.doesNotMatch(
    setup,
    /scripts\/manage_omnigent_services\.sh\s+start/,
  );

  for (const script of [
    "manage_omnigent_services.sh",
    "run_omnigent_cc_haha.sh",
    "start_litellm_dashscope.sh",
  ]) {
    const source = readFileSync(path.join(scriptsDirectory, script), "utf8");
    assert.doesNotMatch(source, /PRIVATE_FUND_ENABLE_LEGACY_RUNTIME/);
    assert.doesNotMatch(source, /\b(?:exec|tmux|uvx?)\b/);
    for (const optInValue of [undefined, "1"]) {
      const environment = { ...process.env };
      if (optInValue === undefined) {
        delete environment.PRIVATE_FUND_ENABLE_LEGACY_RUNTIME;
      } else {
        environment.PRIVATE_FUND_ENABLE_LEGACY_RUNTIME = optInValue;
      }
      const result = spawnSync(
        "bash",
        [path.join(scriptsDirectory, script), "start"],
        {
          cwd: repositoryRoot,
          env: environment,
          encoding: "utf8",
          timeout: 2_000,
        },
      );
      assert.equal(result.status, 78, `${script}\n${result.stderr}`);
      assert.match(result.stderr, /PERMANENTLY RETIRED/);
    }
  }
});

test("manager supports lifecycle commands and rolls back partial startup", () => {
  chmodSync(fixture, 0o755);
  const temporaryRoot = mkdtempSync(
    path.join(tmpdir(), "private-fund-ts-services-"),
  );
  const stateDirectory = path.join(temporaryRoot, "state");
  const logDirectory = path.join(temporaryRoot, "logs");
  const environment = {
    ...process.env,
    NODE_ENV: "test",
    PRIVATE_FUND_SERVICE_TEST_MODE: "1",
    PRIVATE_FUND_SERVICE_NODE_EXECUTABLE: fixture,
    PRIVATE_FUND_SERVICE_STATE_DIR: stateDirectory,
    PRIVATE_FUND_SERVICE_LOG_DIR: logDirectory,
    PRIVATE_FUND_SERVICES_WAIT_MS: "3000",
    PRIVATE_FUND_SERVICES_STOP_WAIT_MS: "1000",
    PRIVATE_FUND_API_HOST: "127.0.0.1",
    PRIVATE_FUND_API_PORT: "46768",
    PRIVATE_FUND_OBSIDIAN_HEALTH_HOST: "127.0.0.1",
    PRIVATE_FUND_OBSIDIAN_HEALTH_PORT: "46791",
  };

  try {
    const start = runManager("start", environment);
    assert.equal(start.status, 0, start.stderr);
    assert.match(start.stdout, /api: ready/);
    assert.match(start.stdout, /job-worker: ready/);
    assert.equal(statSync(stateDirectory).mode & 0o077, 0);
    assert.equal(statSync(logDirectory).mode & 0o077, 0);

    const status = runManager("status", environment);
    assert.equal(status.status, 0, status.stderr);
    assert.equal((status.stdout.match(/: ready \(pid /g) ?? []).length, 2);

    const logs = runManager("logs", environment);
    assert.equal(logs.status, 0, logs.stderr);
    assert.match(logs.stdout, /fixture_ready:api/);
    assert.match(logs.stdout, /"event":"compute_worker_ready"/);
    const computeVenvPython = path.join(
      repositoryRoot,
      "python",
      "compute-worker",
      ".venv",
      "bin",
      "python",
    );
    if (existsSync(computeVenvPython)) {
      assert.ok(
        logs.stdout.includes(
          `"pythonExecutable":${JSON.stringify(computeVenvPython)}`,
        ),
        logs.stdout,
      );
    }

    const restart = runManager("restart", environment);
    assert.equal(restart.status, 0, restart.stderr);
    assert.equal((restart.stdout.match(/: stopped/g) ?? []).length, 2);
    assert.equal((restart.stdout.match(/: ready \(pid /g) ?? []).length, 2);

    const stop = runManager("stop", environment);
    assert.equal(stop.status, 0, stop.stderr);
    assert.equal((stop.stdout.match(/: stopped/g) ?? []).length, 2);
    assert.equal(
      readdirSync(stateDirectory).filter((name) =>
        name.endsWith(".pid.json"),
      ).length,
      0,
    );

    const stoppedStatus = runManager("status", environment);
    assert.equal(stoppedStatus.status, 1);
    assert.equal((stoppedStatus.stdout.match(/: stopped/g) ?? []).length, 2);

    const failedStart = runManager("start", {
      ...environment,
      PRIVATE_FUND_SERVICE_FIXTURE_FAIL: "job-worker",
    });
    assert.equal(failedStart.status, 1);
    assert.match(failedStart.stderr, /Startup failed; rolling back 2/);
    assert.equal(
      readdirSync(stateDirectory).filter((name) =>
        name.endsWith(".pid.json"),
      ).length,
      0,
    );
  } finally {
    runManager("stop", environment);
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});
