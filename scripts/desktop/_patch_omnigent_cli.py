#!/usr/bin/env python3
"""Prefer packaged runtime/bin/omnigent in CLI resolution."""
from __future__ import annotations

from pathlib import Path

path = Path(__file__).resolve().parents[2] / "omnigent" / "web" / "electron" / "src" / "omnigent_cli.js"
text = path.read_text(encoding="utf-8")

if "bundledRuntimeCliPath" in text:
    print("already patched")
    raise SystemExit(0)

# Add helper after requires
old = 'const url = require("./url");'
new = '''const url = require("./url");

/**
 * Path to a CLI shipped inside the Electron app resources (zero-config build).
 * @returns {string | null}
 */
function bundledRuntimeCliPath() {
  try {
    const { app } = require("electron");
    const pathMod = require("path");
    const fsMod = require("fs");
    const root = app.isPackaged
      ? pathMod.join(process.resourcesPath, "runtime", "bin")
      : pathMod.join(__dirname, "..", "resources", "runtime", "bin");
    const names =
      process.platform === "win32"
        ? ["omnigent.exe", "omnigent.cmd", "omnigent.bat", "omnigent"]
        : ["omnigent"];
    for (const name of names) {
      const candidate = pathMod.join(root, name);
      if (fsMod.existsSync(candidate)) return candidate;
    }
  } catch {
    // electron app module may be unavailable in pure unit tests
  }
  return null;
}
'''
if old not in text:
    raise SystemExit("url require not found")
text = text.replace(old, new, 1)

# Patch resolveCliPath to check bundled first after configured
old_resolve = """function resolveCliPath(configuredPath, deps = {}) {
  const isExec = deps.isExecutableFile || isExecutableFile;
  const which = deps.whichOmnigent || whichOmnigent;
  const candidates = (deps.candidatePaths || candidatePaths)();

  if (configuredPath && isExec(configuredPath)) {
    return { path: configuredPath, source: "configured" };
  }
  const onPath = which();
  if (onPath && isExec(onPath)) {
    return { path: onPath, source: "path" };
  }
  for (const candidate of candidates) {
    if (isExec(candidate)) {
      return { path: candidate, source: "candidate" };
    }
  }
  return null;
}"""

new_resolve = """function resolveCliPath(configuredPath, deps = {}) {
  const isExec = deps.isExecutableFile || isExecutableFile;
  const which = deps.whichOmnigent || whichOmnigent;
  const candidates = (deps.candidatePaths || candidatePaths)();

  if (configuredPath && isExec(configuredPath)) {
    return { path: configuredPath, source: "configured" };
  }
  // Packaged private-fund builds ship the CLI under resources/runtime/bin.
  const bundled =
    typeof deps.bundledRuntimeCliPath === "function"
      ? deps.bundledRuntimeCliPath()
      : bundledRuntimeCliPath();
  if (bundled && isExec(bundled)) {
    return { path: bundled, source: "candidate" };
  }
  const onPath = which();
  if (onPath && isExec(onPath)) {
    return { path: onPath, source: "path" };
  }
  for (const candidate of candidates) {
    if (isExec(candidate)) {
      return { path: candidate, source: "candidate" };
    }
  }
  return null;
}"""

if old_resolve not in text:
    raise SystemExit("resolveCliPath not found")
text = text.replace(old_resolve, new_resolve, 1)

# export bundledRuntimeCliPath
if "bundledRuntimeCliPath," not in text:
    text = text.replace(
        "  candidatePaths,\n  resolveCliPath,",
        "  candidatePaths,\n  bundledRuntimeCliPath,\n  resolveCliPath,",
        1,
    )

path.write_text(text, encoding="utf-8")
print(f"Patched {path}")
