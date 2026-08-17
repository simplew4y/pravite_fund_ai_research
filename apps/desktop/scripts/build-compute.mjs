import { execFile } from "node:child_process";
import { chmod, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(scriptDirectory, "..");
const repositoryRoot = path.resolve(desktopRoot, "../..");
const computeRoot = path.join(repositoryRoot, "python", "compute-worker");
const python = path.join(computeRoot, ".venv", "bin", "python");
const buildRoot = path.join(desktopRoot, ".build");
const outputRoot = path.join(buildRoot, "compute");
const workRoot = path.join(buildRoot, "pyinstaller");
const executable = path.join(outputRoot, "private-fund-compute-worker");
const entrypoint = path.join(desktopRoot, "python", "desktop_compute_entry.py");
const workerScript = path.join(computeRoot, "worker.py");

async function run(command, arguments_, options = {}) {
  const result = await execFileAsync(command, arguments_, {
    cwd: repositoryRoot,
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  return result;
}

try {
  await run(python, ["-m", "PyInstaller", "--version"]);
} catch {
  throw new Error(
    "PyInstaller is unavailable. Run `npm run desktop:setup-build` before packaging.",
  );
}

await rm(outputRoot, { recursive: true, force: true });
await rm(workRoot, { recursive: true, force: true });
await mkdir(outputRoot, { recursive: true });
await mkdir(workRoot, { recursive: true });

await run(python, [
  "-m",
  "PyInstaller",
  "--noconfirm",
  "--clean",
  "--onefile",
  "--name",
  "private-fund-compute-worker",
  "--distpath",
  outputRoot,
  "--workpath",
  path.join(workRoot, "work"),
  "--specpath",
  path.join(workRoot, "spec"),
  "--paths",
  computeRoot,
  "--hidden-import",
  "fitz",
  "--hidden-import",
  "openpyxl",
  "--hidden-import",
  "reportlab",
  "--hidden-import",
  "akshare",
  entrypoint,
]);
await chmod(executable, 0o755);

const healthResult = await run(executable, [workerScript, "--health"]);
const health = JSON.parse(healthResult.stdout.trim());
if (
  health.status !== "ok" ||
  health.dependencies?.pymupdf !== true ||
  health.dependencies?.openpyxl !== true ||
  health.dependencies?.reportlab !== true ||
  health.dependencies?.akshare !== true
) {
  throw new Error(`Frozen compute worker is incomplete: ${JSON.stringify(health)}`);
}
process.stdout.write(`[desktop] compute worker ready: ${executable}\n`);
