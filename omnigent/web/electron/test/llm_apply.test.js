"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { readSessionActivity } = require("../src/llm_apply");

function response(page) {
  return {
    ok: true,
    async json() {
      return page;
    },
  };
}

describe("LLM apply session guard", () => {
  it("checks every session page and reports a running response", async () => {
    const urls = [];
    const pages = [
      response({ data: [{ status: "idle" }], has_more: true, last_id: "conv-1" }),
      response({ data: [{ status: "running" }], has_more: false }),
    ];
    const result = await readSessionActivity(async (url) => {
      urls.push(url);
      return pages.shift();
    }, "http://127.0.0.1:6767/");

    assert.equal(result.busy, true);
    assert.equal(result.applying, false);
    assert.equal(urls.length, 2);
    assert.match(urls[1], /after=conv-1/);
  });

  it("fails closed when session activity cannot be confirmed", async () => {
    const result = await readSessionActivity(async () => {
      throw new Error("server unavailable");
    }, "http://127.0.0.1:6767");

    assert.equal(result.busy, true);
    assert.match(result.detail, /server unavailable/);
  });

  it("allows switching when every session is idle", async () => {
    const result = await readSessionActivity(
      async () => response({ data: [{ status: "idle" }], has_more: false }),
      "http://127.0.0.1:6767",
    );

    assert.deepEqual(result, { applying: false, busy: false });
  });
});
