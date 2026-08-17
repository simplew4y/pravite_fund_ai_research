"use strict";

const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

const {
  buildServiceEnvironment,
  parseDesktopEnvironment,
} = require("../src/config.cjs");

describe("desktop configuration", () => {
  it("loads only allow-listed provider and network settings", () => {
    assert.deepEqual(
      parseDesktopEnvironment(`
        # comment
        export OPENAI_API_KEY="secret"
        PRIVATE_FUND_API_PORT=9999
        HTTPS_PROXY='http://proxy.test'
        UNKNOWN=value
      `),
      {
        OPENAI_API_KEY: "secret",
        HTTPS_PROXY: "http://proxy.test",
      },
    );
  });

  it("keeps desktop-owned paths, ports and auth mode authoritative", () => {
    const environment = buildServiceEnvironment({
      ambientEnvironment: { PRIVATE_FUND_AUTH_MODE: "cloud" },
      configuredEnvironment: { OPENAI_API_KEY: "configured", NO_PROXY: "corp.test" },
      paths: {
        dataRoot: "/data",
        controlDatabase: "/data/control.sqlite3",
        agentWorkerEntry: "/runtime/agent.js",
        computeExecutable: "/compute/worker",
        computeWorkerEntry: "/compute/worker.py",
        webRoot: "/web",
      },
      apiPort: 45123,
      obsidianPort: 45124,
    });

    assert.equal(environment.PRIVATE_FUND_AUTH_MODE, "development");
    assert.equal(environment.PRIVATE_FUND_API_PORT, "45123");
    assert.equal(environment.PRIVATE_FUND_WEB_ROOT, "/web");
    assert.equal(environment.OPENAI_API_KEY, "configured");
    assert.match(environment.NO_PROXY, /corp\.test/u);
  });
});
