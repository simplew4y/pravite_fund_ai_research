"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const desktop = require("../src/desktop_mode");

describe("desktop_mode", () => {
  it("parseEnvFile reads KEY=VALUE and ignores comments", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pf-desktop-"));
    const file = path.join(dir, "desktop.env");
    fs.writeFileSync(
      file,
      ["# comment", "FOO=bar", "QUOTED=\"x y\"", "EMPTY=", "NOEQ", ""].join("\n"),
      "utf8",
    );
    const env = desktop.parseEnvFile(file);
    assert.equal(env.FOO, "bar");
    assert.equal(env.QUOTED, "x y");
    assert.equal(env.EMPTY, "");
    assert.equal(env.NOEQ, undefined);
  });

  it("getDesktopMode respects DESKTOP_MODE env", () => {
    const prev = process.env.DESKTOP_MODE;
    process.env.DESKTOP_MODE = "bundled";
    assert.equal(desktop.getDesktopMode(), "bundled");
    process.env.DESKTOP_MODE = "thin";
    assert.equal(desktop.getDesktopMode(), "thin");
    if (prev === undefined) delete process.env.DESKTOP_MODE;
    else process.env.DESKTOP_MODE = prev;
  });

  it("isBundledMode false by default under plain node", () => {
    const prev = process.env.DESKTOP_MODE;
    delete process.env.DESKTOP_MODE;
    assert.equal(desktop.isBundledMode(), false);
    if (prev !== undefined) process.env.DESKTOP_MODE = prev;
  });

  it("buildStackEnv keeps Python bytecode outside the packaged runtime", () => {
    const prev = process.env.PYTHONPYCACHEPREFIX;
    delete process.env.PYTHONPYCACHEPREFIX;
    const env = desktop.buildStackEnv();
    assert.equal(
      env.PYTHONPYCACHEPREFIX,
      path.join(desktop.runtimeRoot(), "userData", "pycache", "python312"),
    );
    if (prev !== undefined) process.env.PYTHONPYCACHEPREFIX = prev;
  });

  it("buildStackEnv preserves an explicit Python bytecode cache path", () => {
    const custom = path.join(os.tmpdir(), "custom-python-cache");
    const env = desktop.buildStackEnv({ PYTHONPYCACHEPREFIX: custom });
    assert.equal(env.PYTHONPYCACHEPREFIX, custom);
  });

  it("describes the Windows native runtime layout", () => {
    const root = path.join("C:\\", "runtime");
    const layout = desktop.nativeRuntimeLayout("win32", root);
    assert.equal(layout.python, path.join(root, "python", "python.exe"));
    assert.equal(
      layout.sitePackages,
      path.join(root, "python", "Lib", "site-packages"),
    );
    assert.equal(layout.sidecar, path.join(root, "bin", "claude-haha.exe"));
  });

  it("describes the Apple Silicon macOS native runtime layout", () => {
    const root = "/Applications/PrivateFundWorkbench.app/Contents/Resources/runtime";
    const layout = desktop.nativeRuntimeLayout("darwin", root);
    assert.equal(layout.python, path.join(root, "python", "bin", "python3"));
    assert.equal(
      layout.sitePackages,
      path.join(root, "python", "lib", "python3.12", "site-packages"),
    );
    assert.equal(layout.sidecar, path.join(root, "bin", "claude-haha"));
  });
});
