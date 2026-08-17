import { spawn } from "node:child_process";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(scriptDirectory, "..");
const appName = "Private Fund AI Research";
const sourceApp = path.join(
  desktopRoot,
  "dist",
  "mac-arm64",
  `${appName}.app`,
);
const temporaryRoot = await mkdtemp(path.join(tmpdir(), "private-fund-desktop-smoke-"));
const isolatedApp = path.join(temporaryRoot, `${appName}.app`);
await cp(sourceApp, isolatedApp, {
  recursive: true,
  dereference: false,
  preserveTimestamps: true,
  verbatimSymlinks: true,
});
const appExecutable = path.join(
  isolatedApp,
  "Contents",
  "MacOS",
  appName,
);
const resultPath = path.join(temporaryRoot, "result.json");
const userData = path.join(temporaryRoot, "user-data");

let stdout = "";
let stderr = "";
let timedOut = false;
const child = spawn(appExecutable, [], {
  cwd: desktopRoot,
  env: {
    ...process.env,
    PRIVATE_FUND_DESKTOP_SMOKE: "1",
    PRIVATE_FUND_DESKTOP_SMOKE_OUTPUT: resultPath,
    PRIVATE_FUND_DESKTOP_USER_DATA: userData,
  },
  stdio: ["ignore", "pipe", "pipe"],
});
child.stdout.on("data", (chunk) => {
  stdout += chunk.toString("utf8");
});
child.stderr.on("data", (chunk) => {
  stderr += chunk.toString("utf8");
});
const timer = setTimeout(() => {
  timedOut = true;
  child.kill("SIGKILL");
}, 150_000);

const { code, signal } = await new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("exit", (exitCode, exitSignal) =>
    resolve({ code: exitCode, signal: exitSignal }),
  );
});
clearTimeout(timer);

let result;
try {
  result = JSON.parse(await readFile(resultPath, "utf8"));
} catch (error) {
  throw new Error(
    `Packaged smoke did not write a result (timeout=${String(timedOut)}, code=${String(code)}, signal=${String(signal)}).\nstdout:\n${stdout}\nstderr:\n${stderr}\n${String(error)}`,
  );
}
if (timedOut || code !== 0 || result.ok !== true || result.packaged !== true) {
  throw new Error(
    `Packaged smoke failed (timeout=${String(timedOut)}, code=${String(code)}, signal=${String(signal)}).\n${JSON.stringify(result, null, 2)}\nstdout:\n${stdout}\nstderr:\n${stderr}`,
  );
}

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
await rm(temporaryRoot, { recursive: true, force: true });
