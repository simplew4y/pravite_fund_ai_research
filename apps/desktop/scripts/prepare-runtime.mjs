import { spawn } from "node:child_process";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(scriptDirectory, "..");
const repositoryRoot = path.resolve(desktopRoot, "../..");
const runtimeRoot = path.join(desktopRoot, ".build", "runtime");
const activeApps = ["api", "job-worker", "obsidian-worker"];

async function copyWorkspace(source, destination, includeDist = true) {
  await mkdir(destination, { recursive: true });
  await cp(path.join(source, "package.json"), path.join(destination, "package.json"));
  if (includeDist) {
    await cp(path.join(source, "dist"), path.join(destination, "dist"), {
      recursive: true,
    });
  }
}

async function runNpmCi() {
  await new Promise((resolve, reject) => {
    const child = spawn(
      "npm",
      ["ci", "--omit=dev", "--no-audit", "--no-fund"],
      {
        cwd: runtimeRoot,
        env: process.env,
        stdio: "inherit",
      },
    );
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`npm ci failed (code=${String(code)}, signal=${String(signal)})`));
    });
  });
}

await rm(runtimeRoot, { recursive: true, force: true });
await mkdir(path.join(runtimeRoot, "apps"), { recursive: true });
await mkdir(path.join(runtimeRoot, "packages"), { recursive: true });

const rootPackage = JSON.parse(
  await readFile(path.join(repositoryRoot, "package.json"), "utf8"),
);
if (rootPackage.scripts) delete rootPackage.scripts.postinstall;
await writeFile(
  path.join(runtimeRoot, "package.json"),
  `${JSON.stringify(rootPackage, null, 2)}\n`,
  "utf8",
);
await cp(
  path.join(repositoryRoot, "package-lock.json"),
  path.join(runtimeRoot, "package-lock.json"),
);

for (const appName of activeApps) {
  await copyWorkspace(
    path.join(repositoryRoot, "apps", appName),
    path.join(runtimeRoot, "apps", appName),
  );
}
await copyWorkspace(desktopRoot, path.join(runtimeRoot, "apps", "desktop"), false);

const packageNames = (await readdir(path.join(repositoryRoot, "packages"), {
  withFileTypes: true,
}))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .filter((name) => name !== "legacy-migrator")
  .sort();
for (const packageName of packageNames) {
  await copyWorkspace(
    path.join(repositoryRoot, "packages", packageName),
    path.join(runtimeRoot, "packages", packageName),
  );
}

await runNpmCi();
await writeFile(
  path.join(runtimeRoot, "desktop-runtime-manifest.json"),
  `${JSON.stringify(
    {
      schemaVersion: 1,
      architecture: "typescript-pi-electron",
      applications: activeApps,
      packages: packageNames,
    },
    null,
    2,
  )}\n`,
  "utf8",
);
process.stdout.write(`[desktop] production Node runtime ready: ${runtimeRoot}\n`);
