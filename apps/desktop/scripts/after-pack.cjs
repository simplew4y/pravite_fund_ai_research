"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;
  const appBundle = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
  );
  const resources = path.join(appBundle, "Contents", "Resources");
  const compute = path.join(resources, "compute", "private-fund-compute-worker");
  const stagedModules = path.join(resources, "runtime-modules");
  const runtimeModules = path.join(resources, "runtime", "node_modules");
  if (!fs.existsSync(stagedModules)) {
    throw new Error(`Packaged production modules are missing: ${stagedModules}`);
  }
  if (fs.existsSync(runtimeModules)) {
    fs.rmSync(runtimeModules, { recursive: true, force: true });
  }
  fs.renameSync(stagedModules, runtimeModules);
  fs.chmodSync(compute, 0o755);
  execFileSync(
    "/usr/bin/codesign",
    ["--force", "--deep", "--sign", "-", appBundle],
    { stdio: "inherit" },
  );
};
