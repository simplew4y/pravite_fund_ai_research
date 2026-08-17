"use strict";

const assert = require("node:assert/strict");
const http = require("node:http");
const { describe, it } = require("node:test");

const { findFreePort, waitForHttp } = require("../src/runtime.cjs");

describe("desktop runtime bootstrap", () => {
  it("allocates loopback ports and waits for HTTP readiness", async () => {
    const port = await findFreePort();
    assert.ok(Number.isInteger(port) && port > 0);
    const server = http.createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"status":"ok"}');
    });
    await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
    try {
      const response = await waitForHttp(`http://127.0.0.1:${String(port)}/health`);
      assert.equal(response.status, 200);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
